"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function createSystemLogger(options) {
  const {
    store,
    logDir = "logs",
    logFileName = "system.log",
    flushIntervalMs = 300,
    maxBufferedEntries = 10000,
  } = options;

  if (!store || typeof store.insertLogEntries !== "function") {
    throw new Error("A valid `store` is required for system logger.");
  }

  const resolvedLogDir = path.resolve(logDir);
  const logFilePath = path.resolve(resolvedLogDir, logFileName);

  const state = {
    buffer: [],
    flushing: false,
    closed: false,
  };

  let flushTimer;

  async function start() {
    await fs.mkdir(resolvedLogDir, { recursive: true });
    flushTimer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    flushTimer.unref();
  }

  function log(level, event, details, context) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: String(level || "INFO").toUpperCase(),
      event: String(event || "event"),
      details: details && typeof details === "object" ? details : {},
      source:
        context && typeof context === "object" && context.source
          ? String(context.source)
          : "app",
      traceId:
        context && typeof context === "object" && context.traceId
          ? String(context.traceId)
          : null,
      createdAtMs: Date.now(),
    };

    if (state.buffer.length >= maxBufferedEntries) {
      state.buffer.shift();
    }
    state.buffer.push(entry);

    const detailsText = Object.keys(entry.details).length
      ? ` ${JSON.stringify(entry.details)}`
      : "";
    console.log(`[${entry.timestamp}] [${entry.level}] ${entry.event}${detailsText}`);

    if (state.buffer.length >= 100) {
      void flush();
    }
  }

  async function flush(force) {
    if ((state.closed && !force) || state.flushing || state.buffer.length === 0) {
      return;
    }

    state.flushing = true;
    const entries = state.buffer.splice(0, state.buffer.length);

    try {
      const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await fs.appendFile(logFilePath, lines, "utf8");
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [ERROR] log file write failed`, {
        message: error && error.message ? error.message : "Unknown log file error",
      });
    }

    try {
      store.insertLogEntries(entries);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [ERROR] sqlite log write failed`, {
        message: error && error.message ? error.message : "Unknown sqlite log error",
      });
    }

    state.flushing = false;
  }

  async function close() {
    state.closed = true;
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
    await flush(true);
  }

  function info(event, details, context) {
    log("INFO", event, details, context);
  }

  function warn(event, details, context) {
    log("WARN", event, details, context);
  }

  function error(event, details, context) {
    log("ERROR", event, details, context);
  }

  function debug(event, details, context) {
    log("DEBUG", event, details, context);
  }

  function getLogFilePath() {
    return logFilePath;
  }

  return {
    start,
    log,
    info,
    warn,
    error,
    debug,
    flush,
    close,
    getLogFilePath,
  };
}

module.exports = { createSystemLogger };
