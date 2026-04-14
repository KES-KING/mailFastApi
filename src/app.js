"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const http = require("node:http");
const express = require("express");

const { getTransporter, closeTransporter, verifyTransporter } = require("./mailer");
const { createWorker } = require("./worker");
const { loadAuthConfig, authenticateClient, issueAccessToken, verifyJwt } = require("./auth");
const { createSystemStore } = require("./systemStore");
const { createSystemLogger } = require("./systemLogger");
const { createMailQueue } = require("./mailQueueFactory");
const { createMonitor, renderMonitorPageHtml } = require("./monitor");

const PORT = toInt(process.env.PORT, 3000);
const WORKER_CONCURRENCY = toInt(process.env.WORKER_CONCURRENCY, 2);
const RETRY_ATTEMPTS = Math.max(1, toInt(process.env.RETRY_ATTEMPTS, 3));
const RETRY_DELAY_MS = Math.max(0, toInt(process.env.RETRY_DELAY_MS, 250));
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, toInt(process.env.SHUTDOWN_TIMEOUT_MS, 20000));
const MAIL_FROM =
  process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@mailfastapi.local";
const SEND_SCOPE = "mail:send";
const REQUEST_BODY_LIMIT = String(process.env.REQUEST_BODY_LIMIT || "10mb").trim() || "10mb";
const MAX_ATTACHMENTS = Math.max(0, toInt(process.env.MAX_ATTACHMENTS, 10));
const MAX_ATTACHMENT_TOTAL_BYTES = Math.max(
  0,
  toInt(process.env.MAX_ATTACHMENT_TOTAL_BYTES, 8 * 1024 * 1024),
);

const RATE_LIMIT_WINDOW_MS = Math.max(1000, toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000));
const RATE_LIMIT_MAX = Math.max(1, toInt(process.env.RATE_LIMIT_MAX, 120));

const QUEUE_BACKEND = String(process.env.QUEUE_BACKEND || "redis").trim().toLowerCase();
const QUEUE_MAX_SIZE = Math.max(1, toInt(process.env.QUEUE_MAX_SIZE, 50000));
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_QUEUE_KEY = process.env.REDIS_QUEUE_KEY || "mailfastapi:mail_jobs";
const REDIS_COMMAND_TIMEOUT_MS = Math.max(1000, toInt(process.env.REDIS_COMMAND_TIMEOUT_MS, 5000));

const LOG_DB_PATH = process.env.LOG_DB_PATH || "data/mailfastapi.sqlite";
const LOG_DIR = process.env.LOG_DIR || "logs";
const LOG_FILE_NAME = process.env.LOG_FILE_NAME || "system.log";
const LOG_FLUSH_INTERVAL_MS = Math.max(100, toInt(process.env.LOG_FLUSH_INTERVAL_MS, 300));
const MONITOR_ENABLED = toBoolean(process.env.MONITOR_ENABLED, true);
const MONITOR_PATH = normalizePath(process.env.MONITOR_PATH || "/monitor");
const MONITOR_STATS_PATH = MONITOR_PATH === "/" ? "/stats" : `${MONITOR_PATH}/stats`;
const MONITOR_STREAM_PATH = MONITOR_PATH === "/" ? "/stream" : `${MONITOR_PATH}/stream`;
const METRICS_PATH = normalizePath(process.env.METRICS_PATH || "/metrics");
const MONITOR_SSE_INTERVAL_MS = Math.max(
  500,
  toInt(process.env.MONITOR_SSE_INTERVAL_MS, 1000),
);
const MONITOR_TOKEN = String(process.env.MONITOR_TOKEN || "").trim();
const MONITOR_MAX_RECENT_ENTRIES = Math.max(
  50,
  toInt(process.env.MONITOR_MAX_RECENT_ENTRIES, 400),
);
const MONITOR_MAX_TIMELINE_MINUTES = Math.max(
  10,
  toInt(process.env.MONITOR_MAX_TIMELINE_MINUTES, 180),
);

const authConfig = loadAuthConfig(process.env);
const monitor = createMonitor({
  maxRecentEntries: MONITOR_MAX_RECENT_ENTRIES,
  maxTimelineMinutes: MONITOR_MAX_TIMELINE_MINUTES,
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

const transporter = getTransporter();
const store = createSystemStore({ dbPath: LOG_DB_PATH });
const logger = createSystemLogger({
  store,
  logDir: LOG_DIR,
  logFileName: LOG_FILE_NAME,
  flushIntervalMs: LOG_FLUSH_INTERVAL_MS,
  onEntry: (entry) => {
    monitor.ingestLogEntry(entry);
  },
});

const queue = createMailQueue({
  backend: QUEUE_BACKEND,
  maxSize: QUEUE_MAX_SIZE,
  redisUrl: REDIS_URL,
  queueKey: REDIS_QUEUE_KEY,
  commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
  logger,
});

const worker = createWorker({
  queue,
  transporter,
  from: MAIL_FROM,
  concurrency: WORKER_CONCURRENCY,
  retryAttempts: RETRY_ATTEMPTS,
  retryDelayMs: RETRY_DELAY_MS,
  logger: runtimeLog,
});

app.use(createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX));

if (authConfig.mode === "jwt") {
  app.post(
    "/auth/token",
    createRateLimiter(authConfig.tokenRateLimitWindowMs, authConfig.tokenRateLimitMax),
    (req, res) => {
      const payload = req.body || {};
      if (typeof payload.clientId !== "string" || typeof payload.clientSecret !== "string") {
        return res.status(400).json({ error: "`clientId` and `clientSecret` are required." });
      }

      const client = authenticateClient(
        authConfig,
        payload.clientId.trim(),
        payload.clientSecret.trim(),
      );

      if (!client) {
        logger.warn("auth token request denied", {
          clientId: payload.clientId,
          ip: req.ip,
        });
        return res.status(401).json({ error: "Invalid client credentials." });
      }

      const tokenResponse = issueAccessToken(authConfig, client.clientId, client.scopes);
      logger.info("auth token issued", {
        clientId: client.clientId,
        scope: client.scopes.join(" "),
      });

      return res.status(200).json(tokenResponse);
    },
  );
}

app.get("/health", async (req, res, next) => {
  try {
    const runtime = await collectRuntimeMetrics();
    res.status(200).json({
      status: "ok",
      uptimeSec: Number(process.uptime().toFixed(2)),
      queueDepth: runtime.queueDepth,
      activeJobs: runtime.activeJobs,
      authMode: runtime.authMode,
      queueBackend: runtime.queueBackend,
    });
  } catch (error) {
    next(error);
  }
});

if (MONITOR_ENABLED) {
  const monitorAuth = createMonitorAuthMiddleware(MONITOR_TOKEN);

  app.get(MONITOR_PATH, monitorAuth, (req, res) => {
    const suffix = MONITOR_TOKEN ? `?token=${encodeURIComponent(MONITOR_TOKEN)}` : "";
    const html = renderMonitorPageHtml({
      title: "mailFastApi Live Monitor",
      statsPath: `${MONITOR_STATS_PATH}${suffix}`,
      streamPath: `${MONITOR_STREAM_PATH}${suffix}`,
      metricsPath: `${METRICS_PATH}${suffix}`,
    });
    res.status(200).type("html").send(html);
  });

  app.get(MONITOR_STATS_PATH, monitorAuth, async (req, res, next) => {
    try {
      const snapshot = await collectMonitorSnapshot();
      res.status(200).json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.get(MONITOR_STREAM_PATH, monitorAuth, async (req, res, next) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    let closed = false;

    const publishSnapshot = async () => {
      if (closed) return;
      const snapshot = await collectMonitorSnapshot();
      sendSseEvent(res, "snapshot", snapshot);
    };

    try {
      await publishSnapshot();
    } catch (error) {
      return next(error);
    }

    const snapshotTimer = setInterval(() => {
      void publishSnapshot();
    }, MONITOR_SSE_INTERVAL_MS);

    const heartbeatTimer = setInterval(() => {
      if (closed) return;
      res.write(": ping\n\n");
    }, 15000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(snapshotTimer);
      clearInterval(heartbeatTimer);
      try {
        res.end();
      } catch (error) {
        // noop
      }
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  app.get(METRICS_PATH, monitorAuth, async (req, res, next) => {
    try {
      const runtime = await collectRuntimeMetrics();
      const text = monitor.toPrometheus(runtime);
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.status(200).send(text);
    } catch (error) {
      next(error);
    }
  });
}

app.post("/send", createSendAuthMiddleware(authConfig), async (req, res, next) => {
  const { error: validationError, payload: normalizedPayload } = validateSendPayload(req.body);
  if (validationError || !normalizedPayload) {
    return res.status(400).json({ error: validationError || "Invalid payload." });
  }

  const traceId = req.header("x-request-id") || crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = Date.now();

  logger.info(
    "request received",
    {
      path: req.path,
      method: req.method,
      traceId,
      jobId,
      to: normalizedPayload.to,
      authSub: req.auth ? req.auth.sub : undefined,
    },
    { traceId, source: "api" },
  );

  try {
    await queue.enqueue({
      id: jobId,
      to: normalizedPayload.to,
      from: normalizedPayload.from || undefined,
      subject: normalizedPayload.subject,
      html: normalizedPayload.html,
      text: normalizedPayload.text || undefined,
      attachments: normalizedPayload.attachments || undefined,
      queuedAt: now,
    });
  } catch (error) {
    if (error && error.code === "QUEUE_FULL") {
      logger.error(
        "mail queue full",
        { traceId, jobId, queueBackend: queue.backend },
        { traceId, source: "api" },
      );
      return res.status(503).json({ error: "Queue is full. Try again later." });
    }
    return next(error);
  }

  let queueDepth;
  try {
    queueDepth = await queue.getDepth();
  } catch (error) {
    queueDepth = null;
  }

  logger.info(
    "mail queued",
    {
      traceId,
      jobId,
      queueDepth,
      queueBackend: queue.backend,
    },
    { traceId, source: "api" },
  );

  return res.status(202).json({ status: "queued" });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON payload." });
  }

  logger.error("internal error", {
    message: err && err.message ? err.message : "Unknown error",
    stack: err && err.stack ? err.stack : undefined,
  });

  return res.status(500).json({ error: "Internal server error." });
});

const server = http.createServer(app);
let isShuttingDown = false;

bootstrap().catch(async (error) => {
  const message = error && error.message ? error.message : "Unknown startup error";
  try {
    logger.error("startup failed", { message });
    await logger.close();
  } catch (closeError) {
    // noop
  }
  try {
    store.close();
  } catch (storeError) {
    // noop
  }
  console.error(`[${new Date().toISOString()}] [ERROR] startup failed`, { message });
  process.exit(1);
});

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

module.exports = { app };

async function bootstrap() {
  await logger.start();
  await queue.start();

  worker.start();
  verifyTransporter(runtimeLog);

  server.listen(PORT, () => {
    logger.info("mailFastApi started", {
      port: PORT,
      workerConcurrency: WORKER_CONCURRENCY,
      authMode: authConfig.mode,
      queueBackend: queue.backend,
      queueMaxSize: QUEUE_MAX_SIZE,
      redisQueueKey: queue.backend === "redis" ? REDIS_QUEUE_KEY : undefined,
      logFilePath: logger.getLogFilePath(),
      logDbPath: store.getDbPath(),
    });
  });
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info("shutdown started", { signal });

  const forceExit = setTimeout(() => {
    logger.error("forced shutdown", { reason: "shutdown timeout reached" });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await closeServer(server);
    await worker.stop({ drainTimeoutMs: SHUTDOWN_TIMEOUT_MS });
    await queue.stop();
    await closeTransporter();
    await logger.close();
    store.close();
    process.exit(0);
  } catch (error) {
    logger.error("shutdown failed", {
      message: error && error.message ? error.message : "Unknown shutdown error",
    });
    try {
      await logger.close();
    } catch (closeError) {
      // noop
    }
    try {
      store.close();
    } catch (storeError) {
      // noop
    }
    process.exit(1);
  }
}

function runtimeLog(level, event, details) {
  logger.log(level, event, details, { source: "runtime" });
}

async function collectMonitorSnapshot() {
  const runtime = await collectRuntimeMetrics();
  return monitor.getSnapshot(runtime);
}

async function collectRuntimeMetrics() {
  let queueDepth = null;
  try {
    queueDepth = await queue.getDepth();
  } catch (error) {
    queueDepth = null;
  }

  return {
    queueDepth,
    activeJobs: worker.getActiveJobs(),
    authMode: authConfig.mode,
    queueBackend: queue.backend,
    port: PORT,
  };
}

function createMonitorAuthMiddleware(requiredToken) {
  if (!requiredToken) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const headerToken = req.header("x-monitor-token");
    const queryToken = req.query && typeof req.query.token === "string" ? req.query.token : "";
    const provided = headerToken || queryToken;
    if (provided && safeEqualStrings(provided, requiredToken)) {
      return next();
    }
    return res.status(401).json({ error: "Unauthorized monitor access." });
  };
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createSendAuthMiddleware(config) {
  if (config.mode === "none") {
    return (req, res, next) => next();
  }

  if (config.mode === "api_key") {
    return (req, res, next) => {
      const provided = req.header("x-api-key");
      if (!provided || provided !== config.apiKey) {
        return res.status(401).json({ error: "Unauthorized." });
      }
      return next();
    };
  }

  return (req, res, next) => {
    const header = req.header("authorization") || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing bearer token." });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ error: "Missing bearer token." });
    }

    try {
      const payload = verifyJwt(config, token, SEND_SCOPE);
      req.auth = payload;
      return next();
    } catch (error) {
      if (error && error.code === "INSUFFICIENT_SCOPE") {
        return res.status(403).json({ error: "Insufficient scope." });
      }
      return res.status(401).json({ error: "Invalid or expired token." });
    }
  };
}

function validateSendPayload(body) {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object." };
  }

  const recipients = normalizeRecipients(body.to);
  if (!recipients || recipients.length === 0) {
    return { error: "`to` is required." };
  }

  if (!recipients.every(isValidEmail)) {
    return { error: "`to` must be a valid email address (string or list)." };
  }

  if (typeof body.subject !== "string" || body.subject.trim() === "") {
    return { error: "`subject` is required." };
  }

  if (typeof body.html !== "string" || body.html.trim() === "") {
    return { error: "`html` is required." };
  }

  let from;
  if (body.from !== undefined) {
    if (typeof body.from !== "string" || body.from.trim() === "") {
      return { error: "`from` must be a non-empty string when provided." };
    }
    from = body.from.trim();
  }

  let text;
  if (body.text !== undefined) {
    if (typeof body.text !== "string") {
      return { error: "`text` must be a string when provided." };
    }
    text = body.text;
  }

  const attachmentResult = normalizeAttachments(body.attachments);
  if (attachmentResult.error) {
    return { error: attachmentResult.error };
  }

  return {
    error: null,
    payload: {
      to: recipients.length === 1 ? recipients[0] : recipients,
      from,
      subject: body.subject.trim(),
      html: body.html,
      text,
      attachments: attachmentResult.attachments,
    },
  };
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeRecipients(value) {
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts : null;
  }

  return null;
}

function normalizeAttachments(value) {
  if (value === undefined) {
    return { attachments: undefined, error: null };
  }

  if (!Array.isArray(value)) {
    return { attachments: undefined, error: "`attachments` must be an array when provided." };
  }

  if (value.length > MAX_ATTACHMENTS) {
    return {
      attachments: undefined,
      error: `Maximum ${MAX_ATTACHMENTS} attachments are allowed.`,
    };
  }

  const attachments = [];
  let totalBytes = 0;

  for (const item of value) {
    if (!item || typeof item !== "object") {
      return { attachments: undefined, error: "Each attachment must be an object." };
    }

    const filename = typeof item.filename === "string" ? item.filename.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const contentId = typeof item.content_id === "string" ? item.content_id.trim() : "";
    const contentType =
      typeof item.content_type === "string" ? item.content_type.trim() : "";

    if (!filename || !content) {
      return {
        attachments: undefined,
        error: "Attachment `filename` and `content` are required.",
      };
    }

    if (!isValidBase64(content)) {
      return {
        attachments: undefined,
        error: `Attachment content is not valid base64 (${filename}).`,
      };
    }

    const rawBytes = Buffer.from(content.replace(/\s+/g, ""), "base64").length;
    if (!Number.isFinite(rawBytes) || rawBytes <= 0) {
      return {
        attachments: undefined,
        error: `Attachment content could not be decoded (${filename}).`,
      };
    }

    totalBytes += rawBytes;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      return {
        attachments: undefined,
        error: `Total attachment size exceeds ${MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
      };
    }

    const normalized = {
      filename,
      content: content.replace(/\s+/g, ""),
    };

    if (contentId) {
      normalized.content_id = contentId;
    }
    if (contentType) {
      normalized.content_type = contentType;
    }

    attachments.push(normalized);
  }

  return {
    attachments: attachments.length > 0 ? attachments : undefined,
    error: null,
  };
}

function isValidBase64(value) {
  if (typeof value !== "string") return false;
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return false;
  try {
    const decoded = Buffer.from(compact, "base64");
    return decoded.length > 0;
  } catch (error) {
    return false;
  }
}

function createRateLimiter(windowMs, maxRequests) {
  const requestsByIp = new Map();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    const record = requestsByIp.get(ip);
    if (!record || now - record.windowStart >= windowMs) {
      requestsByIp.set(ip, { count: 1, windowStart: now });
      return next();
    }

    if (record.count >= maxRequests) {
      return res.status(429).json({ error: "Too many requests." });
    }

    record.count += 1;

    if (requestsByIp.size > 10000) {
      for (const [storedIp, storedRecord] of requestsByIp.entries()) {
        if (now - storedRecord.windowStart >= windowMs) {
          requestsByIp.delete(storedIp);
        }
      }
    }

    return next();
  };
}

function closeServer(instance) {
  return new Promise((resolve, reject) => {
    instance.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  if (prefixed.length > 1 && prefixed.endsWith("/")) {
    return prefixed.slice(0, -1);
  }
  return prefixed;
}

function safeEqualStrings(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
