"use strict";

const { createMemoryMailQueue } = require("./memoryMailQueue");
const { createRedisMailQueue } = require("./redisMailQueue");

function createMailQueue(options) {
  const backend = normalizeBackend(options && options.backend);

  if (backend === "memory") {
    return createMemoryMailQueue({
      maxSize: options && options.maxSize,
    });
  }

  return createRedisMailQueue({
    redisUrl: options && options.redisUrl,
    queueKey: options && options.queueKey,
    commandTimeoutMs: options && options.commandTimeoutMs,
    logger: options && options.logger,
  });
}

function normalizeBackend(value) {
  const normalized = String(value || "redis").trim().toLowerCase();
  if (normalized === "memory") {
    return "memory";
  }
  return "redis";
}

module.exports = { createMailQueue };
