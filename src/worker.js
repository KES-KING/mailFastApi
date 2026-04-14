"use strict";

const { setTimeout: delay } = require("node:timers/promises");

function createWorker(options) {
  const {
    queue,
    transporter,
    from,
    concurrency = 2,
    retryAttempts = 3,
    retryDelayMs = 250,
    logger = defaultLogger,
  } = options;

  if (!queue) {
    throw new Error("`queue` is required.");
  }

  if (!transporter || typeof transporter.sendMail !== "function") {
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
        const mailOptions = {
          from: job.from || from || undefined,
          to: job.to,
          subject: job.subject,
          html: job.html,
        };
        if (typeof job.text === "string" && job.text.trim() !== "") {
          mailOptions.text = job.text;
        }

        const attachments = normalizeAttachments(job.attachments);
        if (attachments.length > 0) {
          mailOptions.attachments = attachments;
        }

        const info = await transporter.sendMail(mailOptions);

        logger("INFO", "mail sent", {
          jobId: job.id,
          to: job.to,
          attempt,
          attachmentCount: attachments.length,
          messageId: info.messageId,
          queueLatencyMs: jobQueuedLatency,
          dispatchLatencyMs: Date.now() - sendStart,
        });

        return;
      } catch (error) {
        const isLastAttempt = attempt >= maxAttempts;

        if (isLastAttempt) {
          logger("ERROR", "mail failed", {
            jobId: job.id,
            to: job.to,
            attempt,
            message: error && error.message ? error.message : "Unknown SMTP error",
          });
          return;
        }

        logger("WARN", "mail send failed, retrying", {
          jobId: job.id,
          to: job.to,
          attempt,
          nextAttemptInMs: baseRetryDelay * attempt,
          message: error && error.message ? error.message : "Unknown SMTP error",
        });

        await delay(baseRetryDelay * attempt);
      }
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
