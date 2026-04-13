"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

function createTestPort() {
  const min = 3200;
  const max = 4200;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function startTestServer(overrides = {}) {
  const port = overrides.port || createTestPort();
  const useRealSmtp = Boolean(overrides.useRealSmtp);
  const rootDir = path.resolve(__dirname, "..", "..");

  const env = {
    ...process.env,
    PORT: String(port),
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
    ...overrides.env,
  };

  if (!useRealSmtp) {
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = "2525";
    env.SMTP_SECURE = "false";
  }

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
