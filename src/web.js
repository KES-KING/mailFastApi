"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const express = require("express");

const {
  renderMonitorPageHtml,
  renderMonitorMetricsPageHtml,
  renderMonitorRawPageHtml,
} = require("./monitor");

const APP_ROOT = path.resolve(__dirname, "..");
const CORE_PORT = toInt(process.env.PORT, 3000);
const WEB_PORT = toInt(process.env.WEB_PORT, 3300);
const WEB_HOST = String(process.env.WEB_HOST || "").trim();
const WEB_SHUTDOWN_TIMEOUT_MS = Math.max(1000, toInt(process.env.WEB_SHUTDOWN_TIMEOUT_MS, 12000));

const MONITOR_PATH = normalizePath(process.env.MONITOR_PATH || "/monitor");
const MONITOR_STATS_PATH = MONITOR_PATH === "/" ? "/stats" : `${MONITOR_PATH}/stats`;
const MONITOR_STREAM_PATH = MONITOR_PATH === "/" ? "/stream" : `${MONITOR_PATH}/stream`;
const MONITOR_METRICS_VIEW_PATH =
  MONITOR_PATH === "/" ? "/metrics-view" : `${MONITOR_PATH}/metrics-view`;
const MONITOR_RAW_VIEW_PATH = MONITOR_PATH === "/" ? "/raw-view" : `${MONITOR_PATH}/raw-view`;
const MONITOR_LOGO_ASSET_PATH =
  MONITOR_PATH === "/" ? "/assets/logo.webp" : `${MONITOR_PATH}/assets/logo.webp`;
const MONITOR_UPDATE_CHECK_PATH =
  MONITOR_PATH === "/" ? "/update/check" : `${MONITOR_PATH}/update/check`;
const MONITOR_UPDATE_APPLY_PATH =
  MONITOR_PATH === "/" ? "/update/apply" : `${MONITOR_PATH}/update/apply`;

const METRICS_PATH = normalizePath(process.env.METRICS_PATH || "/metrics");
const MONITOR_TOKEN = String(process.env.MONITOR_TOKEN || "").trim();
const MONITOR_HELP_URL = String(
  process.env.MONITOR_HELP_URL || "https://github.com/KES-KING/mailFastApi",
).trim();

const WEB_CORE_BASE_URL = normalizeBaseUrl(
  process.env.WEB_CORE_BASE_URL || `http://127.0.0.1:${CORE_PORT}`,
);
const WEB_ENABLE_UPDATER = toBoolean(process.env.WEB_ENABLE_UPDATER, true);
const WEB_UPDATE_TOKEN = String(process.env.WEB_UPDATE_TOKEN || "").trim();
const WEB_UPDATE_TIMEOUT_MS = Math.max(5000, toInt(process.env.WEB_UPDATE_TIMEOUT_MS, 180000));
const WEB_UPDATE_SCRIPT = resolveSafeUpdaterPath(process.env.WEB_UPDATE_SCRIPT || "./updater.sh");

const LOGO_FILE_PATH = path.resolve(APP_ROOT, "MailFastApi_Logo.webp");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const monitorAuth = createMonitorAuthMiddleware(MONITOR_TOKEN);
const updateAuth = createUpdateAuthMiddleware(WEB_UPDATE_TOKEN);

app.get("/health", async (req, res) => {
  const coreHealth = await checkCoreHealth();
  res.status(200).json({
    status: "ok",
    service: "web",
    port: WEB_PORT,
    coreBaseUrl: WEB_CORE_BASE_URL,
    coreReachable: coreHealth.ok,
    coreStatus: coreHealth.status,
    uptimeSec: Number(process.uptime().toFixed(2)),
  });
});

app.get(MONITOR_LOGO_ASSET_PATH, monitorAuth, (req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  res.sendFile(LOGO_FILE_PATH, (error) => {
    if (!error) {
      return;
    }
    next(error);
  });
});

app.get(MONITOR_PATH, monitorAuth, (req, res) => {
  const tokenSuffix = MONITOR_TOKEN ? `?token=${encodeURIComponent(MONITOR_TOKEN)}` : "";
  const html = renderMonitorPageHtml({
    title: "mailFastApi Live Monitor",
    statsPath: `${MONITOR_STATS_PATH}${tokenSuffix}`,
    streamPath: `${MONITOR_STREAM_PATH}${tokenSuffix}`,
    metricsPath: `${METRICS_PATH}${tokenSuffix}`,
    metricsViewPath: `${MONITOR_METRICS_VIEW_PATH}${tokenSuffix}`,
    rawViewPath: `${MONITOR_RAW_VIEW_PATH}${tokenSuffix}`,
    logoPath: `${MONITOR_LOGO_ASSET_PATH}${tokenSuffix}`,
    helpUrl: MONITOR_HELP_URL,
    updateCheckPath: `${MONITOR_UPDATE_CHECK_PATH}${tokenSuffix}`,
    updateApplyPath: `${MONITOR_UPDATE_APPLY_PATH}${tokenSuffix}`,
  });

  res.status(200).type("html").send(html);
});

app.get(MONITOR_METRICS_VIEW_PATH, monitorAuth, (req, res) => {
  const tokenSuffix = MONITOR_TOKEN ? `?token=${encodeURIComponent(MONITOR_TOKEN)}` : "";
  const html = renderMonitorMetricsPageHtml({
    title: "mailFastApi Prometheus Metrics View",
    metricsPath: `${METRICS_PATH}${tokenSuffix}`,
    monitorPath: `${MONITOR_PATH}${tokenSuffix}`,
    rawViewPath: `${MONITOR_RAW_VIEW_PATH}${tokenSuffix}`,
  });
  res.status(200).type("html").send(html);
});

app.get(MONITOR_RAW_VIEW_PATH, monitorAuth, (req, res) => {
  const tokenSuffix = MONITOR_TOKEN ? `?token=${encodeURIComponent(MONITOR_TOKEN)}` : "";
  const html = renderMonitorRawPageHtml({
    title: "mailFastApi Raw Snapshot View",
    statsPath: `${MONITOR_STATS_PATH}${tokenSuffix}`,
    monitorPath: `${MONITOR_PATH}${tokenSuffix}`,
    metricsViewPath: `${MONITOR_METRICS_VIEW_PATH}${tokenSuffix}`,
  });
  res.status(200).type("html").send(html);
});

app.get(MONITOR_STATS_PATH, monitorAuth, async (req, res, next) => {
  try {
    const response = await fetch(buildCoreUrl(req, MONITOR_STATS_PATH), {
      headers: buildCoreHeaders(req),
      cache: "no-store",
    });
    await forwardResponse(response, res, "application/json");
  } catch (error) {
    next(error);
  }
});

app.get(METRICS_PATH, monitorAuth, async (req, res, next) => {
  try {
    const response = await fetch(buildCoreUrl(req, METRICS_PATH), {
      headers: buildCoreHeaders(req),
      cache: "no-store",
    });
    await forwardResponse(response, res, "text/plain; version=0.0.4; charset=utf-8");
  } catch (error) {
    next(error);
  }
});

app.get(MONITOR_STREAM_PATH, monitorAuth, async (req, res, next) => {
  const controller = new AbortController();
  req.on("close", () => {
    controller.abort();
  });

  try {
    const response = await fetch(buildCoreUrl(req, MONITOR_STREAM_PATH), {
      headers: {
        ...buildCoreHeaders(req),
        Accept: "text/event-stream",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      res.status(response.status || 502).type("text/plain").send(text || "Upstream SSE error");
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      if (res.writableEnded || res.destroyed) {
        break;
      }
      res.write(Buffer.from(value));
    }

    if (!res.writableEnded) {
      res.end();
    }
  } catch (error) {
    if (error && error.name === "AbortError") {
      return;
    }
    next(error);
  }
});

app.get(MONITOR_UPDATE_CHECK_PATH, monitorAuth, updateAuth, async (req, res, next) => {
  if (!WEB_ENABLE_UPDATER) {
    return res.status(403).json({
      ok: false,
      code: "UPDATER_DISABLED",
      message: "Updater feature is disabled.",
    });
  }

  try {
    const result = await runUpdater(["--check", "--json"]);
    const payload = parseJsonOutput(result);
    if (result.code !== 0) {
      return res.status(500).json({
        ok: false,
        code: "UPDATER_CHECK_FAILED",
        message: payload.message || "Update check failed.",
        details: payload,
      });
    }
    return res.status(200).json(payload);
  } catch (error) {
    next(error);
  }
});

app.post(MONITOR_UPDATE_APPLY_PATH, monitorAuth, updateAuth, async (req, res, next) => {
  if (!WEB_ENABLE_UPDATER) {
    return res.status(403).json({
      ok: false,
      code: "UPDATER_DISABLED",
      message: "Updater feature is disabled.",
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const confirm = body.confirm === true;
  const allowDirty = body.allowDirty === true;

  if (!confirm) {
    return res.status(400).json({
      ok: false,
      code: "CONFIRM_REQUIRED",
      message: "Update apply requires { confirm: true }.",
    });
  }

  try {
    const args = ["--apply", "--yes", "--json"];
    if (allowDirty) {
      args.push("--allow-dirty");
    }
    const result = await runUpdater(args);
    const payload = parseJsonOutput(result);
    if (result.code !== 0) {
      return res.status(500).json({
        ok: false,
        code: "UPDATER_APPLY_FAILED",
        message: payload.message || "Update apply failed.",
        details: payload,
      });
    }
    return res.status(200).json(payload);
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  const message = err && err.message ? err.message : "Unknown web service error";
  console.error(`[${new Date().toISOString()}] [web:error] ${message}`);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ error: "Internal web service error." });
});

const server = http.createServer(app);
let isShuttingDown = false;

bootstrap().catch((error) => {
  const message = error && error.message ? error.message : "Unknown startup error";
  console.error(`[${new Date().toISOString()}] [web:fatal] ${message}`);
  process.exit(1);
});

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

module.exports = { app };

async function bootstrap() {
  await listenServer(server, WEB_PORT, WEB_HOST || undefined);
  console.log(
    `[${new Date().toISOString()}] [web] started port=${WEB_PORT} host=${WEB_HOST || "0.0.0.0"} core=${WEB_CORE_BASE_URL}`,
  );
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`[${new Date().toISOString()}] [web] shutdown started signal=${signal}`);

  const forceExit = setTimeout(() => {
    console.error(`[${new Date().toISOString()}] [web] forced shutdown`);
    process.exit(1);
  }, WEB_SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await closeServer(server);
    process.exit(0);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [web] shutdown failed: ${
        error && error.message ? error.message : "unknown"
      }`,
    );
    process.exit(1);
  }
}

async function checkCoreHealth() {
  try {
    const response = await fetch(new URL("/health", WEB_CORE_BASE_URL), { cache: "no-store" });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0 };
  }
}

function buildCoreHeaders(req) {
  const headers = {};
  const incomingToken = req.header("x-monitor-token");
  if (incomingToken) {
    headers["x-monitor-token"] = incomingToken;
  } else if (MONITOR_TOKEN) {
    headers["x-monitor-token"] = MONITOR_TOKEN;
  }
  return headers;
}

function buildCoreUrl(req, targetPath) {
  const url = new URL(targetPath, WEB_CORE_BASE_URL);
  const query = req && req.query && typeof req.query === "object" ? req.query : {};

  for (const [key, raw] of Object.entries(query)) {
    if (raw === null || raw === undefined) {
      continue;
    }

    if (Array.isArray(raw)) {
      for (const value of raw) {
        url.searchParams.append(key, String(value));
      }
      continue;
    }

    url.searchParams.set(key, String(raw));
  }

  if (!url.searchParams.has("token") && MONITOR_TOKEN) {
    url.searchParams.set("token", MONITOR_TOKEN);
  }

  return url;
}

async function forwardResponse(sourceResponse, targetRes, fallbackContentType) {
  const contentType = sourceResponse.headers.get("content-type") || fallbackContentType;
  const text = await sourceResponse.text();
  targetRes.status(sourceResponse.status || 502);
  targetRes.setHeader("Content-Type", contentType);
  targetRes.send(text);
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

function createUpdateAuthMiddleware(requiredToken) {
  if (!requiredToken) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const headerToken = req.header("x-update-token");
    const queryToken = req.query && typeof req.query.updateToken === "string"
      ? req.query.updateToken
      : "";
    const provided = headerToken || queryToken;
    if (provided && safeEqualStrings(provided, requiredToken)) {
      return next();
    }
    return res.status(401).json({ error: "Unauthorized update access." });
  };
}

function runUpdater(args) {
  if (!WEB_UPDATE_SCRIPT) {
    throw new Error("WEB_UPDATE_SCRIPT is not configured.");
  }

  if (!fs.existsSync(WEB_UPDATE_SCRIPT)) {
    throw new Error(`Updater script not found: ${WEB_UPDATE_SCRIPT}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("bash", [WEB_UPDATE_SCRIPT, ...args], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        MAILFASTAPI_UPDATER_CALLER: "web",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        // noop
      }
    }, WEB_UPDATE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: Number.isFinite(Number(code)) ? Number(code) : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function parseJsonOutput(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, message: "Invalid updater result." };
  }

  const payloadText = result.stdout || result.stderr || "";
  if (!payloadText) {
    return {
      ok: result.code === 0,
      code: result.code === 0 ? "OK" : "FAILED",
      message: result.code === 0 ? "Updater finished." : "Updater failed with empty output.",
    };
  }

  try {
    return JSON.parse(payloadText);
  } catch (error) {
    return {
      ok: result.code === 0,
      code: result.code === 0 ? "OK_NON_JSON" : "FAILED_NON_JSON",
      message: payloadText,
    };
  }
}

function listenServer(instance, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      instance.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      instance.off("error", onError);
      resolve();
    };

    instance.once("error", onError);
    instance.once("listening", onListening);

    if (host) {
      instance.listen(port, host);
      return;
    }

    instance.listen(port);
  });
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

function resolveSafeUpdaterPath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(APP_ROOT, raw);
  const rootWithSep = APP_ROOT.endsWith(path.sep) ? APP_ROOT : `${APP_ROOT}${path.sep}`;

  if (resolved === APP_ROOT || resolved.startsWith(rootWithSep)) {
    return resolved;
  }

  throw new Error(`WEB_UPDATE_SCRIPT must stay inside project root: ${APP_ROOT}`);
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

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return `http://127.0.0.1:${CORE_PORT}`;
  }

  const url = new URL(raw);
  if (url.pathname && url.pathname !== "/") {
    url.pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  }
  return url;
}

function safeEqualStrings(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
