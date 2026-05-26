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
const { createSecureStore } = require("./secureStore");
const { createWebAuth } = require("./webAuth");

const APP_ROOT = path.resolve(__dirname, "..");
const CORE_PORT = toInt(process.env.PORT, 3000);
const WEB_PORT = 8080;
const WEB_HOST = String(process.env.WEB_HOST || "").trim();
const WEB_SHUTDOWN_TIMEOUT_MS = Math.max(1000, toInt(process.env.WEB_SHUTDOWN_TIMEOUT_MS, 12000));

const CORE_MONITOR_PATH = normalizePath(process.env.MONITOR_PATH || "/monitor");
const CORE_MONITOR_STATS_PATH =
  CORE_MONITOR_PATH === "/" ? "/stats" : `${CORE_MONITOR_PATH}/stats`;
const CORE_MONITOR_STREAM_PATH =
  CORE_MONITOR_PATH === "/" ? "/stream" : `${CORE_MONITOR_PATH}/stream`;

const MONITOR_PATH = "/";
const MONITOR_STATS_PATH = "/stats";
const MONITOR_STREAM_PATH = "/stream";
const MONITOR_METRICS_VIEW_PATH = "/metrics-view";
const MONITOR_RAW_VIEW_PATH = "/raw-view";
const MONITOR_LOGO_ASSET_PATH = "/assets/logo.webp";
const MONITOR_UPDATE_CHECK_PATH = "/update/check";
const MONITOR_UPDATE_APPLY_PATH = "/update/apply";

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
const secureStore = createSecureStore();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

const webAuth = createWebAuth({ secureStore });
const updateAuth = createUpdateAuthMiddleware(WEB_UPDATE_TOKEN);
app.use(webAuth.securityHeaders);

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

app.get("/setup", (req, res) => {
  if (secureStore.hasAdminPassword()) {
    return res.redirect(302, "/login");
  }
  const formToken = webAuth.createFormToken(req, res);
  return res.status(200).type("html").send(
    renderAuthPageHtml({
      mode: "setup",
      action: "/setup",
      formToken,
      error: req.query && req.query.error ? String(req.query.error) : "",
    }),
  );
});

app.post("/setup", (req, res) => {
  if (secureStore.hasAdminPassword()) {
    return res.redirect(302, "/login");
  }
  if (!webAuth.verifyFormToken(req, req.body || {})) {
    return res.redirect(302, "/setup?error=Invalid%20form%20token");
  }

  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const confirm = req.body && typeof req.body.confirm === "string" ? req.body.confirm : "";
  if (password !== confirm) {
    return res.redirect(302, "/setup?error=Passwords%20do%20not%20match");
  }

  try {
    secureStore.setAdminPassword(password);
    webAuth.login(req, res, password);
    return res.redirect(302, "/smtp");
  } catch (error) {
    return res.redirect(302, `/setup?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.get("/login", (req, res) => {
  if (!secureStore.hasAdminPassword()) {
    return res.redirect(302, "/setup");
  }
  const formToken = webAuth.createFormToken(req, res);
  return res.status(200).type("html").send(
    renderAuthPageHtml({
      mode: "login",
      action: "/login",
      formToken,
      error: req.query && req.query.error ? String(req.query.error) : "",
    }),
  );
});

app.post("/login", (req, res) => {
  if (!secureStore.hasAdminPassword()) {
    return res.redirect(302, "/setup");
  }
  if (!webAuth.verifyFormToken(req, req.body || {})) {
    return res.redirect(302, "/login?error=Invalid%20form%20token");
  }
  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";

  try {
    webAuth.login(req, res, password);
    return res.redirect(302, "/");
  } catch (error) {
    return res.redirect(302, `/login?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.post("/logout", webAuth.requireAuth, webAuth.requireCsrf, (req, res) => {
  webAuth.destroySession(req, res);
  res.redirect(302, "/login");
});

app.get(MONITOR_LOGO_ASSET_PATH, webAuth.requireAuth, (req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  res.sendFile(LOGO_FILE_PATH, (error) => {
    if (!error) {
      return;
    }
    next(error);
  });
});

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/monitor", webAuth.requireAuth, (req, res) => {
  res.redirect(302, "/");
});

app.get(MONITOR_PATH, webAuth.requireAuth, (req, res) => {
  const tokenSuffix = "";
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
    csrfToken: webAuth.getCsrfToken(req),
    logoutPath: "/logout",
    smtpSettingsPath: "/smtp",
  });

  res.status(200).type("html").send(html);
});

app.get("/smtp", webAuth.requireAuth, (req, res) => {
  const status = req.query && req.query.status ? String(req.query.status) : "";
  const error = req.query && req.query.error ? String(req.query.error) : "";
  res.status(200).type("html").send(
    renderSmtpSettingsPageHtml({
      accounts: secureStore.listPublicSmtpAccounts(),
      csrfToken: webAuth.getCsrfToken(req),
      status,
      error,
    }),
  );
});

app.post("/smtp/accounts", webAuth.requireAuth, webAuth.requireCsrf, (req, res) => {
  try {
    secureStore.upsertSmtpAccount(parseSmtpAccountForm(req.body || {}));
    res.redirect(302, "/smtp?status=saved");
  } catch (error) {
    res.redirect(302, `/smtp?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.post("/smtp/accounts/delete", webAuth.requireAuth, webAuth.requireCsrf, (req, res) => {
  try {
    secureStore.deleteSmtpAccount(req.body && req.body.name);
    res.redirect(302, "/smtp?status=deleted");
  } catch (error) {
    res.redirect(302, `/smtp?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.post("/smtp/default", webAuth.requireAuth, webAuth.requireCsrf, (req, res) => {
  try {
    secureStore.setDefaultSmtpAccountName(req.body && req.body.name);
    res.redirect(302, "/smtp?status=default-updated");
  } catch (error) {
    res.redirect(302, `/smtp?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.get(MONITOR_METRICS_VIEW_PATH, webAuth.requireAuth, (req, res) => {
  const tokenSuffix = "";
  const html = renderMonitorMetricsPageHtml({
    title: "mailFastApi Prometheus Metrics View",
    metricsPath: `${METRICS_PATH}${tokenSuffix}`,
    monitorPath: `${MONITOR_PATH}${tokenSuffix}`,
    rawViewPath: `${MONITOR_RAW_VIEW_PATH}${tokenSuffix}`,
  });
  res.status(200).type("html").send(html);
});

app.get(MONITOR_RAW_VIEW_PATH, webAuth.requireAuth, (req, res) => {
  const tokenSuffix = "";
  const html = renderMonitorRawPageHtml({
    title: "mailFastApi Raw Snapshot View",
    statsPath: `${MONITOR_STATS_PATH}${tokenSuffix}`,
    monitorPath: `${MONITOR_PATH}${tokenSuffix}`,
    metricsViewPath: `${MONITOR_METRICS_VIEW_PATH}${tokenSuffix}`,
  });
  res.status(200).type("html").send(html);
});

app.get(MONITOR_STATS_PATH, webAuth.requireAuth, async (req, res, next) => {
  try {
    const response = await fetch(buildCoreUrl(req, CORE_MONITOR_STATS_PATH), {
      headers: buildCoreHeaders(req),
      cache: "no-store",
    });
    await forwardResponse(response, res, "application/json");
  } catch (error) {
    next(error);
  }
});

app.get(METRICS_PATH, webAuth.requireAuth, async (req, res, next) => {
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

app.get(MONITOR_STREAM_PATH, webAuth.requireAuth, async (req, res, next) => {
  const controller = new AbortController();
  req.on("close", () => {
    controller.abort();
  });

  try {
    const response = await fetch(buildCoreUrl(req, CORE_MONITOR_STREAM_PATH), {
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

app.get(MONITOR_UPDATE_CHECK_PATH, webAuth.requireAuth, updateAuth, async (req, res, next) => {
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

app.post(
  MONITOR_UPDATE_APPLY_PATH,
  webAuth.requireAuth,
  webAuth.requireCsrf,
  updateAuth,
  async (req, res, next) => {
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
  },
);

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
    secureStore.close();
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

function renderAuthPageHtml(options = {}) {
  const mode = options.mode === "setup" ? "setup" : "login";
  const isSetup = mode === "setup";
  const title = isSetup ? "Create Web Panel Password" : "Web Panel Login";
  const submitText = isSetup ? "Create Password" : "Login";
  const action = escapeHtml(options.action || (isSetup ? "/setup" : "/login"));
  const formToken = escapeHtml(options.formToken || "");
  const error = String(options.error || "").trim();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Tahoma, "Segoe UI", Arial, sans-serif;
      background: #dedede;
      color: #1c1c1c;
      display: grid;
      place-items: center;
      padding: 16px;
    }
    main {
      width: min(420px, 100%);
      border: 1px solid #c6cbd3;
      background: #efefef;
      border-radius: 4px;
      padding: 18px;
    }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 14px; color: #444; font-size: 13px; line-height: 1.45; }
    label { display: block; font-weight: 700; font-size: 12px; margin: 12px 0 6px; }
    input {
      width: 100%;
      min-height: 38px;
      border: 1px solid #888;
      background: #fff;
      color: #111;
      padding: 8px 10px;
      font-size: 14px;
    }
    button {
      width: 100%;
      min-height: 38px;
      margin-top: 16px;
      border: 1px solid #888;
      background: #111827;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    .error {
      border: 1px solid #e24d42;
      background: #fff5f5;
      color: #991b1b;
      padding: 8px 10px;
      margin-bottom: 12px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${isSetup ? "First secure setup. Create the web panel password." : "Enter the web panel password."}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="${action}" autocomplete="off">
      <input type="hidden" name="_csrf" value="${formToken}" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" minlength="12" required autofocus />
      ${
        isSetup
          ? '<label for="confirm">Confirm Password</label><input id="confirm" name="confirm" type="password" minlength="12" required />'
          : ""
      }
      <button type="submit">${escapeHtml(submitText)}</button>
    </form>
  </main>
</body>
</html>`;
}

function renderSmtpSettingsPageHtml(options = {}) {
  const accounts = Array.isArray(options.accounts) ? options.accounts : [];
  const csrfToken = escapeHtml(options.csrfToken || "");
  const status = String(options.status || "").trim();
  const error = String(options.error || "").trim();
  const rows = accounts.length
    ? accounts
        .map(
          (account) => `<tr>
            <td>${escapeHtml(account.name)}${account.isDefault ? " (default)" : ""}</td>
            <td>${escapeHtml(account.from || "-")}</td>
            <td>${escapeHtml(account.host || "-")}:${escapeHtml(account.port || "-")}</td>
            <td>${account.secure ? "TLS" : "STARTTLS/plain"}</td>
            <td>${escapeHtml(account.user || "-")}</td>
            <td>
              <form method="post" action="/smtp/default">
                <input type="hidden" name="_csrf" value="${csrfToken}" />
                <input type="hidden" name="name" value="${escapeHtml(account.name)}" />
                <button type="submit"${account.isDefault ? " disabled" : ""}>Default</button>
              </form>
              <form method="post" action="/smtp/accounts/delete" onsubmit="return confirm('Delete SMTP account?');">
                <input type="hidden" name="_csrf" value="${csrfToken}" />
                <input type="hidden" name="name" value="${escapeHtml(account.name)}" />
                <button type="submit">Delete</button>
              </form>
            </td>
          </tr>`,
        )
        .join("")
    : "<tr><td colspan='6' class='empty'>No SMTP accounts saved yet.</td></tr>";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMTP Accounts</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Tahoma, "Segoe UI", Arial, sans-serif;
      background: #dedede;
      color: #1c1c1c;
      padding: 10px;
    }
    .topbar, .panel {
      border: 1px solid #c6cbd3;
      background: #efefef;
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .topbar { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    h1 { margin: 0; font-size: 20px; }
    h2 { margin: 0 0 10px; font-size: 14px; text-transform: uppercase; }
    a, button {
      border: 1px solid #888;
      background: #f4f5f7;
      color: #111;
      text-decoration: none;
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: inline-block;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .nav { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .notice {
      border: 1px solid #7eb26d;
      background: #f0fff4;
      color: #166534;
      padding: 8px 10px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .error {
      border: 1px solid #e24d42;
      background: #fff5f5;
      color: #991b1b;
      padding: 8px 10px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 10px;
    }
    label { display: block; font-weight: 700; font-size: 12px; margin-bottom: 5px; }
    input, select {
      width: 100%;
      min-height: 36px;
      border: 1px solid #888;
      background: #fff;
      color: #111;
      padding: 7px 9px;
    }
    .full { grid-column: 1 / -1; }
    .table-wrap { overflow: auto; border: 1px solid #c6cbd3; background: #fff; }
    table { width: 100%; min-width: 900px; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; border-bottom: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #d9d9d9; text-transform: uppercase; font-size: 11px; }
    td form { display: inline-block; margin-right: 6px; margin-bottom: 4px; }
    .empty { color: #444; padding: 12px; }
    @media (max-width: 860px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .form-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <h1>SMTP Accounts</h1>
    <div class="nav">
      <a href="/">Monitor</a>
      <form method="post" action="/logout">
        <input type="hidden" name="_csrf" value="${csrfToken}" />
        <button type="submit">Logout</button>
      </form>
    </div>
  </header>

  ${status ? `<div class="notice">${escapeHtml(status)}</div>` : ""}
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}

  <section class="panel">
    <h2>Add or Update Account</h2>
    <form method="post" action="/smtp/accounts" autocomplete="off">
      <input type="hidden" name="_csrf" value="${csrfToken}" />
      <div class="form-grid">
        <div><label for="name">Account Name</label><input id="name" name="name" pattern="[A-Za-z0-9_-]+" required /></div>
        <div><label for="from">From</label><input id="from" name="from" placeholder="Info <info@example.com>" required /></div>
        <div><label for="host">SMTP Host</label><input id="host" name="host" required /></div>
        <div><label for="port">Port</label><input id="port" name="port" type="number" min="1" max="65535" value="587" required /></div>
        <div><label for="secure">Secure</label><select id="secure" name="secure"><option value="false">false / STARTTLS</option><option value="true">true / TLS 465</option></select></div>
        <div><label for="user">User</label><input id="user" name="user" autocomplete="off" /></div>
        <div><label for="pass">Password</label><input id="pass" name="pass" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing" /></div>
        <div><label for="rateLimit">Rate Limit</label><input id="rateLimit" name="rateLimit" type="number" min="1" value="10" /></div>
        <div><label for="maxConnections">Max Connections</label><input id="maxConnections" name="maxConnections" type="number" min="1" value="5" /></div>
        <div><label for="maxMessages">Max Messages</label><input id="maxMessages" name="maxMessages" type="number" min="1" value="100" /></div>
        <div><label for="rateDelta">Rate Delta Ms</label><input id="rateDelta" name="rateDelta" type="number" min="1" value="1000" /></div>
        <div class="full"><button type="submit">Save Encrypted</button></div>
      </div>
    </form>
  </section>

  <section class="panel">
    <h2>Saved Accounts</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Account</th><th>From</th><th>Server</th><th>Secure</th><th>User</th><th>Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
</body>
</html>`;
}

function parseSmtpAccountForm(body) {
  return {
    name: body.name,
    from: body.from,
    host: body.host,
    port: body.port,
    secure: body.secure,
    user: body.user,
    pass: body.pass,
    maxConnections: body.maxConnections,
    maxMessages: body.maxMessages,
    rateLimit: body.rateLimit,
    rateDelta: body.rateDelta,
  };
}

function getErrorMessage(error) {
  return error && error.message ? error.message : "Unknown error";
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
  if (MONITOR_TOKEN) {
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

    if (key === "token" || key === "updateToken") {
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

  return url;
}

async function forwardResponse(sourceResponse, targetRes, fallbackContentType) {
  const contentType = sourceResponse.headers.get("content-type") || fallbackContentType;
  const text = await sourceResponse.text();
  targetRes.status(sourceResponse.status || 502);
  targetRes.setHeader("Content-Type", contentType);
  targetRes.send(text);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
