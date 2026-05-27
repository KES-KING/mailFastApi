"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const { createSecureStore } = require("../../src/secureStore");

const TEST_SECURE_STORE_KEY = "tests_secure_store_secret_key_32_chars_minimum";

function createTestPort() {
  const min = 3200;
  const max = 4200;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function startTestServer(overrides = {}) {
  const port = overrides.port || createTestPort();
  const useRealSmtp = Boolean(overrides.useRealSmtp);
  const rootDir = path.resolve(__dirname, "..", "..");
  const secureStoreDbPath = path.join(rootDir, "data", `test-secure-store-${port}.sqlite`);
  const operationalDbPath = path.join(rootDir, "data", `test-operational-${port}.sqlite`);

  const env = {
    ...process.env,
    PORT: String(port),
    QUEUE_BACKEND: "memory",
    QUEUE_MAX_SIZE: "10000",
    LOG_DB_PATH: `data/test-mailfastapi-${port}.sqlite`,
    OPERATIONAL_DB_PATH: operationalDbPath,
    LOG_DIR: `logs/tests/${port}`,
    LOG_FILE_NAME: "system.log",
    LOG_FLUSH_INTERVAL_MS: "100",
    AUTH_MODE: "jwt",
    JWT_SECRET: "tests_super_secret_key_change_in_real_env",
    JWT_ISSUER: "mailFastApiTests",
    JWT_AUDIENCE: "mailfastapi-tests",
    JWT_EXPIRES_IN: "10m",
    AUTH_CLIENT_ID: "test-client",
    AUTH_CLIENT_SECRET: "test-client-secret",
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX: "10000",
    TOKEN_RATE_LIMIT_WINDOW_MS: "60000",
    TOKEN_RATE_LIMIT_MAX: "10000",
    RETRY_ATTEMPTS: "1",
    RETRY_DELAY_MS: "10",
    SECURE_STORE_KEY: TEST_SECURE_STORE_KEY,
    SECURE_STORE_DB_PATH: secureStoreDbPath,
    BOUNCE_WEBHOOK_TOKEN: "test-webhook-token",
    ...overrides.env,
  };

  seedSecureStore({
    dbPath: secureStoreDbPath,
    useRealSmtp,
    rootDir,
  });

  const child = spawn(process.execPath, ["src/app.js"], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString("utf8");
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 12000);

  return {
    baseUrl,
    child,
    getLogs: () => logs,
    stop: async () => stopTestServer(child),
  };
}

function seedSecureStore({ dbPath, useRealSmtp, rootDir }) {
  const store = createSecureStore({
    dbPath,
    secretKey: TEST_SECURE_STORE_KEY,
  });

  try {
    const account = useRealSmtp
      ? resolveRealSmtpAccount(rootDir)
      : {
          name: "default",
          host: "127.0.0.1",
          port: "2525",
          secure: "false",
          user: "default@example.com",
          pass: "",
          from: "Default <default@example.com>",
        };

    store.upsertSmtpAccount(account);
    store.setDefaultSmtpAccountName("default");
  } finally {
    store.close();
  }
}

function resolveRealSmtpAccount(rootDir) {
  const account = readRealSmtpAccountFromSecureStore(rootDir);
  if (account) {
    return account;
  }
  throw new Error(
    "mailsend mode requires SECURE_STORE_KEY and an encrypted SMTP account in data/mailfastapi-secure.sqlite.",
  );
}

function readRealSmtpAccountFromSecureStore(rootDir) {
  const secretKey = String(process.env.SECURE_STORE_KEY || "").trim();
  if (!secretKey) {
    return null;
  }

  const sourceDbPath = process.env.SECURE_STORE_DB_PATH
    ? path.resolve(process.env.SECURE_STORE_DB_PATH)
    : path.join(rootDir, "data", "mailfastapi-secure.sqlite");
  if (!fs.existsSync(sourceDbPath)) {
    return null;
  }

  let sourceStore;
  try {
    sourceStore = createSecureStore({
      dbPath: sourceDbPath,
      secretKey,
    });
    const accountName = process.env.TEST_SMTP_ACCOUNT || sourceStore.getDefaultSmtpAccountName();
    const account = accountName ? sourceStore.getSmtpAccount(accountName) : null;
    if (!account) {
      return null;
    }
    return {
      ...account,
      name: "default",
    };
  } catch (error) {
    return null;
  } finally {
    if (sourceStore) {
      sourceStore.close();
    }
  }
}

async function stopTestServer(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await waitForExit(child, 5000);
  if (!exited) {
    child.kill("SIGKILL");
    await waitForExit(child, 5000);
  }
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      // Server is not ready yet; retry.
    }
    await delay(100);
  }

  throw new Error(`Server did not become healthy within ${timeoutMs}ms.`);
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(false);
      }
    }, timeoutMs);

    child.once("exit", () => {
      if (!finished) {
        clearTimeout(timer);
        finished = true;
        resolve(true);
      }
    });
  });
}

module.exports = {
  startTestServer,
  stopTestServer,
};
