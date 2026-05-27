"use strict";

const { setTimeout: delay } = require("node:timers/promises");

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

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const sendStart = Date.now();

      try {
        await touchJob(job);
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

        await ackJob(job);
        return;
      } catch (error) {
        const isLastAttempt = attempt >= maxAttempts;

        if (isLastAttempt) {
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
            message: error && error.message ? error.message : "Unknown SMTP error",
          });
          await ackJob(job);
          return;
        }

        const nextAttemptInMs = calculateRetryDelay(attempt);
        logger("WARN", "mail send failed, retrying", {
          jobId: job.id,
          smtpAccount: job.smtpAccount || defaultAccount,
          to: job.to,
          attempt,
          nextAttemptInMs,
          message: error && error.message ? error.message : "Unknown SMTP error",
        });

        await delay(nextAttemptInMs);
      }
    }
  }

  function calculateRetryDelay(attempt) {
    if (baseRetryDelay <= 0) {
      return 0;
    }
    const exponentialDelay = baseRetryDelay * 2 ** Math.max(0, attempt - 1);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseRetryDelay / 2)));
    return exponentialDelay + jitter;
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
