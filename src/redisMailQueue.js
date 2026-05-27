"use strict";

const { createClient } = require("redis");

function createRedisMailQueue(options = {}) {
  const redisUrl = options.redisUrl || "redis://127.0.0.1:6379";
  const queueKey = options.queueKey || "mailfastapi:mail_jobs";
  const processingKey = options.processingKey || `${queueKey}:processing`;
  const leaseKey = options.leaseKey || `${processingKey}:leases`;
  const delayedKey = options.delayedKey || `${queueKey}:delayed`;
  const commandTimeoutMs = Math.max(1000, toInt(options.commandTimeoutMs, 5000));
  const visibilityTimeoutMs = Math.max(5000, toInt(options.visibilityTimeoutMs, 5 * 60 * 1000));
  const reclaimIntervalMs = Math.max(1000, toInt(options.reclaimIntervalMs, 30 * 1000));
  const delayedPromotionIntervalMs = Math.min(1000, reclaimIntervalMs);
  const logger = options.logger;

  const pushClient = createClient({
    url: redisUrl,
    socket: { connectTimeout: commandTimeoutMs },
  });

  const popClient = pushClient.duplicate();
  const depthClient = pushClient.duplicate();

  const state = {
    closed: false,
    consumerClosed: false,
    started: false,
    polling: false,
    waiters: [],
    reclaimTimer: null,
    delayedTimer: null,
  };

  pushClient.on("error", (error) => {
    emitWarn("redis push client error", { message: safeError(error) });
  });
  popClient.on("error", (error) => {
    emitWarn("redis pop client error", { message: safeError(error) });
  });
  depthClient.on("error", (error) => {
    emitWarn("redis depth client error", { message: safeError(error) });
  });

  async function start() {
    if (state.started) {
      return;
    }

    await pushClient.connect();
    await popClient.connect();
    await depthClient.connect();
    state.started = true;
    state.closed = false;
    state.consumerClosed = false;

    await ensureProcessingLeases();
    emitInfo("redis mail queue started", {
      queueKey,
      processingKey,
      delayedKey,
      redisUrl,
      visibilityTimeoutMs,
    });
    startReclaimLoop();
    startDelayedLoop();
  }

  async function stop() {
    if (state.closed && !pushClient.isOpen && !popClient.isOpen && !depthClient.isOpen) {
      return;
    }

    state.closed = true;
    state.consumerClosed = true;
    if (state.reclaimTimer) {
      clearInterval(state.reclaimTimer);
      state.reclaimTimer = null;
    }
    if (state.delayedTimer) {
      clearInterval(state.delayedTimer);
      state.delayedTimer = null;
    }
    while (state.waiters.length) {
      const waiter = state.waiters.shift();
      waiter();
    }

    await Promise.allSettled([
      safeQuit(pushClient),
      safeQuit(popClient),
      safeQuit(depthClient),
    ]);

    emitInfo("redis mail queue stopped", { queueKey });
  }

  async function enqueue(job) {
    if (state.closed) {
      const error = new Error("Queue is closed.");
      error.code = "QUEUE_CLOSED";
      throw error;
    }

    const payload = JSON.stringify(job);
    const depth = await pushClient.rPush(queueKey, payload);
    return depth;
  }

  async function dequeue() {
    while (!state.consumerClosed && !state.closed) {
      try {
        await promoteDueDelayed();
        const raw = await popClient.brPopLPush(queueKey, processingKey, 1);
        if (!raw) {
          continue;
        }
        await setLease(raw);
        const parsed = parseJob(raw);
        if (!parsed) {
          await ackRaw(raw);
          emitWarn("invalid redis queue payload skipped", {});
          continue;
        }
        attachQueueToken(parsed, raw);
        return parsed;
      } catch (error) {
        if (state.consumerClosed || state.closed) {
          break;
        }
        emitWarn("redis dequeue error", { message: safeError(error) });
        await wait(200);
      }
    }
    return null;
  }

  async function ack(job) {
    const raw = getQueueToken(job);
    if (!raw) {
      return false;
    }
    return ackRaw(raw);
  }

  async function touch(job, leaseMs = visibilityTimeoutMs) {
    const raw = getQueueToken(job);
    if (!raw || state.closed) {
      return false;
    }
    await pushClient.zAdd(leaseKey, {
      score: Date.now() + Math.max(5000, Number(leaseMs) || visibilityTimeoutMs),
      value: raw,
    });
    return true;
  }

  async function defer(job, delayMs) {
    if (state.closed) {
      const error = new Error("Queue is closed.");
      error.code = "QUEUE_CLOSED";
      throw error;
    }

    const raw = getQueueToken(job);
    const dueAtMs = Date.now() + Math.max(0, Number(delayMs) || 0);
    if (!raw) {
      await pushClient.zAdd(delayedKey, {
        score: dueAtMs,
        value: JSON.stringify(job),
      });
      return true;
    }

    const moved = await pushClient.sendCommand([
      "EVAL",
      [
        "if redis.call('LREM', KEYS[1], 1, ARGV[1]) > 0 then",
        "  redis.call('ZREM', KEYS[2], ARGV[1])",
        "  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])",
        "  return 1",
        "end",
        "return 0",
      ].join("\n"),
      "3",
      processingKey,
      leaseKey,
      delayedKey,
      raw,
      String(dueAtMs),
    ]);

    if (Number(moved) !== 1) {
      const error = new Error("Deferred job was not in processing queue.");
      error.code = "QUEUE_DEFER_FAILED";
      throw error;
    }
    return true;
  }

  async function ackRaw(raw) {
    await Promise.allSettled([pushClient.lRem(processingKey, 1, raw), pushClient.zRem(leaseKey, raw)]);
    return true;
  }

  async function setLease(raw) {
    await popClient.zAdd(leaseKey, {
      score: Date.now() + visibilityTimeoutMs,
      value: raw,
    });
  }

  async function ensureProcessingLeases() {
    try {
      const processingItems = await depthClient.lRange(processingKey, 0, -1);
      if (!Array.isArray(processingItems) || processingItems.length === 0) {
        return;
      }
      const now = Date.now();
      for (const raw of processingItems) {
        const score = await depthClient.zScore(leaseKey, raw);
        if (score === null || score === undefined) {
          await depthClient.zAdd(leaseKey, { score: now - 1, value: raw });
        }
      }
    } catch (error) {
      emitWarn("redis processing lease scan failed", { message: safeError(error) });
    }
  }

  function startReclaimLoop() {
    if (state.reclaimTimer) {
      return;
    }

    state.reclaimTimer = setInterval(() => {
      void reclaimExpiredLeases();
    }, reclaimIntervalMs);
    state.reclaimTimer.unref();
    void reclaimExpiredLeases();
  }

  function startDelayedLoop() {
    if (state.delayedTimer) {
      return;
    }

    state.delayedTimer = setInterval(() => {
      void promoteDueDelayed();
    }, delayedPromotionIntervalMs);
    state.delayedTimer.unref();
    void promoteDueDelayed();
  }

  async function reclaimExpiredLeases() {
    if (state.closed) {
      return;
    }

    let expired = [];
    try {
      expired = await depthClient.sendCommand([
        "ZRANGEBYSCORE",
        leaseKey,
        "-inf",
        String(Date.now()),
        "LIMIT",
        "0",
        "100",
      ]);
    } catch (error) {
      emitWarn("redis lease lookup failed", { message: safeError(error) });
      return;
    }

    if (!Array.isArray(expired) || expired.length === 0) {
      return;
    }

    for (const raw of expired) {
      try {
        const moved = await depthClient.sendCommand([
          "EVAL",
          [
            "if redis.call('LREM', KEYS[1], 1, ARGV[1]) > 0 then",
            "  redis.call('ZREM', KEYS[2], ARGV[1])",
            "  redis.call('RPUSH', KEYS[3], ARGV[1])",
            "  return 1",
            "end",
            "redis.call('ZREM', KEYS[2], ARGV[1])",
            "return 0",
          ].join("\n"),
          "3",
          processingKey,
          leaseKey,
          queueKey,
          raw,
        ]);
        if (Number(moved) === 1) {
          emitWarn("redis queue visibility timeout expired, job requeued", {
            queueKey,
            processingKey,
          });
        }
      } catch (error) {
        emitWarn("redis lease reclaim failed", { message: safeError(error) });
      }
    }
  }

  async function promoteDueDelayed() {
    if (state.closed) {
      return;
    }

    let due = [];
    try {
      due = await depthClient.sendCommand([
        "ZRANGEBYSCORE",
        delayedKey,
        "-inf",
        String(Date.now()),
        "LIMIT",
        "0",
        "100",
      ]);
    } catch (error) {
      emitWarn("redis delayed queue lookup failed", { message: safeError(error) });
      return;
    }

    if (!Array.isArray(due) || due.length === 0) {
      return;
    }

    for (const raw of due) {
      try {
        const moved = await depthClient.sendCommand([
          "EVAL",
          [
            "if redis.call('ZREM', KEYS[1], ARGV[1]) > 0 then",
            "  redis.call('RPUSH', KEYS[2], ARGV[1])",
            "  return 1",
            "end",
            "return 0",
          ].join("\n"),
          "2",
          delayedKey,
          queueKey,
          raw,
        ]);
        if (Number(moved) === 1) {
          emitInfo("redis delayed job promoted", { queueKey, delayedKey });
        }
      } catch (error) {
        emitWarn("redis delayed queue promotion failed", { message: safeError(error) });
      }
    }
  }

  async function getDepth() {
    if (state.closed && !depthClient.isOpen) {
        return null;
      }

    const [remoteDepth, delayedDepth] = await Promise.all([
      depthClient.lLen(queueKey),
      depthClient.zCard(delayedKey),
    ]);
    return Number(remoteDepth || 0) + Number(delayedDepth || 0);
  }

  async function getProcessingDepth() {
    if (state.closed && !depthClient.isOpen) {
      return null;
    }
    const remoteDepth = await depthClient.lLen(processingKey);
    return Number(remoteDepth || 0);
  }

  async function getDelayedDepth() {
    if (state.closed && !depthClient.isOpen) {
      return null;
    }
    const remoteDepth = await depthClient.zCard(delayedKey);
    return Number(remoteDepth || 0);
  }

  function wakeOne() {
    const waiter = state.waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  function emitInfo(event, details) {
    if (logger && typeof logger.info === "function") {
      logger.info(event, details, { source: "queue" });
    }
  }

  function emitWarn(event, details) {
    if (logger && typeof logger.warn === "function") {
      logger.warn(event, details, { source: "queue" });
    }
  }

  return {
    backend: "redis",
    start,
    stop,
    enqueue,
    dequeue,
    ack,
    touch,
    defer,
    getDepth,
    getProcessingDepth,
    getDelayedDepth,
    close: () => {
      state.consumerClosed = true;
      while (state.waiters.length) {
        const waiter = state.waiters.shift();
        waiter();
      }
    },
    get length() {
      return 0;
    },
  };
}

function attachQueueToken(job, raw) {
  Object.defineProperty(job, "__mailfastapiQueueToken", {
    value: raw,
    enumerable: false,
    configurable: true,
  });
}

function getQueueToken(job) {
  if (!job || typeof job !== "object") {
    return "";
  }
  return typeof job.__mailfastapiQueueToken === "string" ? job.__mailfastapiQueueToken : "";
}

function parseJob(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

async function safeQuit(client) {
  try {
    if (client && client.isOpen) {
      await client.quit();
    }
  } catch (error) {
    try {
      client.destroy();
    } catch (destroyError) {
      // noop
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeError(error) {
  return error && error.message ? error.message : "Unknown redis error";
}

module.exports = { createRedisMailQueue };
