"use strict";

const { setTimeout: delay } = require("node:timers/promises");
const { classifyBounce } = require("./bounceClassifier");
const { getRecipientDomains } = require("./deliveryPolicy");

function createWorker(options) {
  const {
    queue,
    transporter,
    getTransporter,
    from,
    getFrom,
    defaultAccount = "default",
    concurrency = 2,
    retryAttempts = 3,
    retryDelayMs = 250,
    deadLetterSink,
    lifecycleSink,
    deliveryEventSink,
    suppressionSink,
    deliveryPolicy,
    getDkimOptions,
    logger = defaultLogger,
  } = options;

  if (!queue) {
    throw new Error("`queue` is required.");
  }

  if (
    typeof getTransporter !== "function" &&
    (!transporter || typeof transporter.sendMail !== "function")
  ) {
    throw new Error("A valid nodemailer transporter is required.");
  }

  const workerCount = Math.max(1, Number(concurrency) || 1);
  const maxAttempts = Math.max(1, Number(retryAttempts) || 1);
  const baseRetryDelay = Math.max(0, Number(retryDelayMs) || 0);

  const runners = [];
  let started = false;
  let activeJobs = 0;

  async function runner(index) {
    logger("INFO", "worker runner started", { runner: index });

    while (true) {
      const job = await queue.dequeue();
      if (!job) {
        break;
      }

      activeJobs += 1;
      try {
        await processJob(job);
      } catch (error) {
        logger("ERROR", "worker job crashed", {
          jobId: job && job.id ? job.id : undefined,
          message: error && error.message ? error.message : "Unknown worker error",
        });
      } finally {
        activeJobs -= 1;
      }
    }

    logger("INFO", "worker runner stopped", { runner: index });
  }

  async function processJob(job) {
    const jobQueuedLatency = Date.now() - job.queuedAt;
    recordLifecycle(job, "processing");
    const maxAttemptsForJob =
      deliveryPolicy && typeof deliveryPolicy.getMaxRetryAttempts === "function"
        ? deliveryPolicy.getMaxRetryAttempts(job, maxAttempts)
        : maxAttempts;

    for (let attempt = 1; attempt <= maxAttemptsForJob; attempt += 1) {
      const sendStart = Date.now();

      try {
        await touchJob(job);
        const permission = checkSendPermission(job);
        if (!permission.allowed) {
          const retryAfterMs = Math.min(
            Math.max(1000, Number(permission.retryAfterMs) || 60000),
            24 * 60 * 60 * 1000,
          );
          const deferredDetails = {
            ...permission,
            retryAfterMs,
          };
          recordLifecycle(job, "deferred", {
            reason: permission.reason,
            domain: permission.domain,
            retryAfterMs,
          });
          recordDeliveryEvent("deferred", job, deferredDetails);
          logger("WARN", "mail deferred", {
            jobId: job.id,
            smtpAccount: job.smtpAccount || defaultAccount,
            to: job.to,
            reason: permission.reason,
            domain: permission.domain,
            retryAfterMs,
          });

          if (typeof queue.defer === "function") {
            try {
              await queue.defer(job, retryAfterMs);
              return;
            } catch (deferError) {
              logger("ERROR", "mail defer requeue failed", {
                jobId: job.id,
                smtpAccount: job.smtpAccount || defaultAccount,
                message:
                  deferError && deferError.message
                    ? deferError.message
                    : "Unknown defer requeue error",
              });
            }
          }

          await delay(retryAfterMs);
          attempt -= 1;
          continue;
        }
        const smtpAccount = job.smtpAccount || defaultAccount;
        const selectedTransporter =
          typeof getTransporter === "function" ? getTransporter(smtpAccount) : transporter;
        if (!selectedTransporter || typeof selectedTransporter.sendMail !== "function") {
          throw new Error(`A valid transporter is required for SMTP account: ${smtpAccount}`);
        }

        const accountFrom =
          typeof getFrom === "function" ? getFrom(smtpAccount) : undefined;
        const mailOptions = {
          from: job.from || accountFrom || from || undefined,
          to: job.to,
          subject: job.subject,
          html: job.html,
        };
        if (typeof job.text === "string" && job.text.trim() !== "") {
          mailOptions.text = job.text;
        }

        if (job.unsubscribeUrl) {
          mailOptions.headers = {
            "List-Unsubscribe": `<${job.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          };
        }
        if (job.returnPath) {
          mailOptions.envelope = {
            from: job.returnPath,
            to: job.to,
          };
        }
        if (typeof getDkimOptions === "function") {
          const dkim = getDkimOptions({ ...job, from: mailOptions.from });
          if (dkim) {
            mailOptions.dkim = dkim;
          }
        }

        const attachments = normalizeAttachments(job.attachments);
        if (attachments.length > 0) {
          mailOptions.attachments = attachments;
        }

        const info = await selectedTransporter.sendMail(mailOptions);

        logger("INFO", "mail sent", {
          jobId: job.id,
          smtpAccount,
          from: mailOptions.from,
          to: job.to,
          attempt,
          attachmentCount: attachments.length,
          messageId: info.messageId,
          queueLatencyMs: jobQueuedLatency,
          dispatchLatencyMs: Date.now() - sendStart,
        });

        recordLifecycle(job, "delivered", { messageId: info.messageId, attempt });
        recordDeliveryEvent("sent", job, { messageId: info.messageId, attempt });
        await ackJob(job);
        return;
      } catch (error) {
        const classification = classifyBounce(error || {});
        const isHardBounce = classification.type === "hard";
        const isLastAttempt = attempt >= maxAttemptsForJob || isHardBounce;

        if (isLastAttempt) {
          if (isHardBounce) {
            suppressRecipients(job, classification);
            recordLifecycle(job, "bounced", {
              reason: classification.reason,
              raw: classification.raw,
              attempt,
            });
            recordDeliveryEvent("bounced", job, {
              reason: classification.reason,
              raw: classification.raw,
              attempt,
            });
          }
          if (typeof deadLetterSink === "function") {
            try {
              await Promise.resolve(deadLetterSink(job, error));
            } catch (sinkError) {
              logger("ERROR", "dead letter sink failed", {
                jobId: job.id,
                message: sinkError && sinkError.message ? sinkError.message : "Unknown sink error",
              });
            }
          }

          logger("ERROR", "mail failed", {
            jobId: job.id,
            smtpAccount: job.smtpAccount || defaultAccount,
            to: job.to,
            attempt,
            reason: classification.reason,
            message: error && error.message ? error.message : "Unknown SMTP error",
          });
          recordLifecycle(job, "failed", {
            reason: classification.reason,
            message: error && error.message ? error.message : "Unknown SMTP error",
            attempt,
          });
          recordLifecycle(job, "dead-lettered", {
            reason: classification.reason,
            attempt,
          });
          recordDeliveryEvent("failed", job, {
            reason: classification.reason,
            attempt,
          });
          await ackJob(job);
          return;
        }

        const nextAttemptInMs = calculateRetryDelay(attempt, classification, job);
        recordLifecycle(job, "retrying", {
          reason: classification.reason,
          attempt,
          nextAttemptInMs,
        });
        recordDeliveryEvent("retrying", job, {
          reason: classification.reason,
          attempt,
          nextAttemptInMs,
        });
        logger("WARN", "mail send failed, retrying", {
          jobId: job.id,
          smtpAccount: job.smtpAccount || defaultAccount,
          to: job.to,
          attempt,
          nextAttemptInMs,
          reason: classification.reason,
          message: error && error.message ? error.message : "Unknown SMTP error",
        });

        await delay(nextAttemptInMs);
      }
    }
  }

  function calculateRetryDelay(attempt, classification, job) {
    if (baseRetryDelay <= 0) {
      return 0;
    }
    if (classification && classification.reason === "greylisted") {
      const domain = getRecipientDomains(job && job.to)[0] || "";
      if (deliveryPolicy && typeof deliveryPolicy.getGreylistDelayMs === "function") {
        return Math.min(deliveryPolicy.getGreylistDelayMs(domain), 30 * 60 * 1000);
      }
    }
    const exponentialDelay = baseRetryDelay * 2 ** Math.max(0, attempt - 1);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseRetryDelay / 2)));
    return exponentialDelay + jitter;
  }

  function checkSendPermission(job) {
    if (deliveryPolicy && typeof deliveryPolicy.checkSendPermission === "function") {
      return deliveryPolicy.checkSendPermission(job);
    }
    return { allowed: true };
  }

  function recordLifecycle(job, state, details = {}) {
    if (typeof lifecycleSink === "function") {
      lifecycleSink(job, state, details);
    }
  }

  function recordDeliveryEvent(event, job, details = {}) {
    if (typeof deliveryEventSink === "function") {
      deliveryEventSink(event, job, details);
    }
  }

  function suppressRecipients(job, classification) {
    if (typeof suppressionSink !== "function") {
      return;
    }
    const recipients = normalizeRecipients(job && job.to).map((item) => item.address);
    for (const recipient of recipients) {
      suppressionSink(recipient, {
        tenantId: job && job.tenantId,
        reason: classification.reason,
        source: "smtp",
        actor: "worker",
      });
    }
  }

  async function ackJob(job) {
    if (queue && typeof queue.ack === "function") {
      await queue.ack(job);
    }
  }

  async function touchJob(job) {
    if (queue && typeof queue.touch === "function") {
      await queue.touch(job);
    }
  }

  function start() {
    if (started) {
      return;
    }

    started = true;
    logger("INFO", "worker started", {
      concurrency: workerCount,
      retryAttempts: maxAttempts,
      retryDelayMs: baseRetryDelay,
    });

    for (let i = 1; i <= workerCount; i += 1) {
      runners.push(runner(i));
    }
  }

  async function stop(options = {}) {
    if (!started) {
      return;
    }

    const drainTimeoutMs = Math.max(0, Number(options.drainTimeoutMs) || 0);
    const waitUntil = Date.now() + drainTimeoutMs;

    while ((queue.length > 0 || activeJobs > 0) && Date.now() < waitUntil) {
      await delay(25);
    }

    queue.close();
    await Promise.allSettled(runners);

    logger("INFO", "worker stopped", {
      remainingQueueDepth: queue.length,
      activeJobs,
    });
  }

  function getActiveJobs() {
    return activeJobs;
  }

  return {
    start,
    stop,
    getActiveJobs,
  };
}

function normalizeRecipients(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    .map((address) => ({ address }));
}

function defaultLogger(level, message, meta) {
  const timestamp = new Date().toISOString();
  const details = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${timestamp}] [${level}] ${message}${details}`);
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const filename = typeof item.filename === "string" ? item.filename.trim() : "";
    const contentBase64 = typeof item.content === "string" ? item.content.trim() : "";
    if (!filename || !contentBase64) continue;

    let contentBuffer;
    try {
      contentBuffer = Buffer.from(contentBase64, "base64");
    } catch (error) {
      continue;
    }
    if (!contentBuffer || contentBuffer.length === 0) continue;

    const normalized = {
      filename,
      content: contentBuffer,
    };
    if (typeof item.content_id === "string" && item.content_id.trim() !== "") {
      normalized.cid = item.content_id.trim();
    }
    if (typeof item.content_type === "string" && item.content_type.trim() !== "") {
      normalized.contentType = item.content_type.trim();
    }
    out.push(normalized);
  }

  return out;
}

module.exports = { createWorker };
