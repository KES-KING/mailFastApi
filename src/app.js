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

const PORT = toInt(process.env.PORT, 3000);
const WORKER_CONCURRENCY = toInt(process.env.WORKER_CONCURRENCY, 2);
const RETRY_ATTEMPTS = Math.max(1, toInt(process.env.RETRY_ATTEMPTS, 3));
const RETRY_DELAY_MS = Math.max(0, toInt(process.env.RETRY_DELAY_MS, 250));
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, toInt(process.env.SHUTDOWN_TIMEOUT_MS, 20000));
const MAIL_FROM =
  process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@mailfastapi.local";
const SEND_SCOPE = "mail:send";

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

const authConfig = loadAuthConfig(process.env);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const transporter = getTransporter();
const store = createSystemStore({ dbPath: LOG_DB_PATH });
const logger = createSystemLogger({
  store,
  logDir: LOG_DIR,
  logFileName: LOG_FILE_NAME,
  flushIntervalMs: LOG_FLUSH_INTERVAL_MS,
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
    const queueDepth = await queue.getDepth();
    res.status(200).json({
      status: "ok",
      uptimeSec: Number(process.uptime().toFixed(2)),
      queueDepth,
      activeJobs: worker.getActiveJobs(),
      authMode: authConfig.mode,
      queueBackend: queue.backend,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/send", createSendAuthMiddleware(authConfig), async (req, res, next) => {
  const validationError = validateSendPayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
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
      to: req.body.to,
      authSub: req.auth ? req.auth.sub : undefined,
    },
    { traceId, source: "api" },
  );

  try {
    await queue.enqueue({
      id: jobId,
      to: req.body.to.trim(),
      subject: req.body.subject.trim(),
      html: req.body.html,
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
    return "Request body must be a JSON object.";
  }

  if (typeof body.to !== "string" || body.to.trim() === "") {
    return "`to` is required.";
  }

  if (!isValidEmail(body.to.trim())) {
    return "`to` must be a valid email address.";
  }

  if (typeof body.subject !== "string" || body.subject.trim() === "") {
    return "`subject` is required.";
  }

  if (typeof body.html !== "string" || body.html.trim() === "") {
    return "`html` is required.";
  }

  return null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
