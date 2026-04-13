"use strict";

const { createClient } = require("redis");

function createRedisMailQueue(options = {}) {
  const redisUrl = options.redisUrl || "redis://127.0.0.1:6379";
  const queueKey = options.queueKey || "mailfastapi:mail_jobs";
  const commandTimeoutMs = Math.max(1000, toInt(options.commandTimeoutMs, 5000));
  const logger = options.logger;

  const pushClient = createClient({
    url: redisUrl,
    socket: { connectTimeout: commandTimeoutMs },
  });

  const popClient = pushClient.duplicate();
  const depthClient = pushClient.duplicate();

  const state = {
    closed: false,
    started: false,
    polling: false,
    localBuffer: [],
    waiters: [],
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

    emitInfo("redis mail queue started", { queueKey, redisUrl });
    startPollingLoop();
  }

  async function stop() {
    if (state.closed) {
      return;
    }

    state.closed = true;
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
    while (true) {
      if (state.localBuffer.length > 0) {
        return state.localBuffer.shift();
      }

      if (state.closed) {
        return null;
      }

      await new Promise((resolve) => state.waiters.push(resolve));
    }
  }

  async function getDepth() {
    if (state.closed) {
      return state.localBuffer.length;
    }

    const remoteDepth = await depthClient.lLen(queueKey);
    return Number(remoteDepth || 0) + state.localBuffer.length;
  }

  function startPollingLoop() {
    if (state.polling) {
      return;
    }

    state.polling = true;
    void pollLoop();
  }

  async function pollLoop() {
    while (!state.closed) {
      try {
        const result = await popClient.brPop(queueKey, 1);
        if (!result || !result.element) {
          continue;
        }

        const parsed = parseJob(result.element);
        if (!parsed) {
          emitWarn("invalid redis queue payload skipped", {});
          continue;
        }

        state.localBuffer.push(parsed);
        wakeOne();
      } catch (error) {
        if (state.closed) {
          break;
        }
        emitWarn("redis polling error", { message: safeError(error) });
        await wait(200);
      }
    }

    state.polling = false;
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
    getDepth,
    close: () => {
      state.closed = true;
      while (state.waiters.length) {
        const waiter = state.waiters.shift();
        waiter();
      }
    },
    get length() {
      return state.localBuffer.length;
    },
  };
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
