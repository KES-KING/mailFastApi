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
const WEB_MFA_REQUIRED = toBoolean(
  process.env.WEB_MFA_REQUIRED,
  toBoolean(process.env.PRODUCTION_MODE, false),
);
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
const MONITOR_UPDATE_PAGE_PATH = "/update";
const MONITOR_UPDATE_CHECK_PATH = "/update/check";
const MONITOR_UPDATE_APPLY_PATH = "/update/apply";
const MONITOR_UPDATE_START_PATH = "/update/start";
const MONITOR_UPDATE_STATUS_PATH = "/update/status";

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
const WEB_UPDATE_SCRIPT = resolveSafeUpdaterPath(
  process.env.WEB_UPDATE_SCRIPT || "./scripts/updater.js",
);

const LOGO_FILE_PATH = path.resolve(APP_ROOT, "MailFastApi_Logo.webp");
const secureStore = createSecureStore();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

const webAuth = createWebAuth({ secureStore, mfaRequired: WEB_MFA_REQUIRED });
const updateAuth = createUpdateAuthMiddleware(WEB_UPDATE_TOKEN);
let updateJob = createIdleUpdateJob();
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
    return res.redirect(302, shouldRequireMfaSetup() ? "/mfa/setup" : "/login");
  }
  const formToken = webAuth.createFormToken(req, res);
  return res.status(200).type("html").send(
    renderAuthPageHtml({
      mode: "setup",
      action: "/setup",
      formToken,
      error: req.query && req.query.error ? String(req.query.error) : "",
      cspNonce: getCspNonce(res),
    }),
  );
});

app.post("/setup", (req, res) => {
  if (secureStore.hasAdminPassword()) {
    return res.redirect(302, shouldRequireMfaSetup() ? "/mfa/setup" : "/login");
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
    if (!WEB_MFA_REQUIRED) {
      webAuth.login(req, res, password);
      return res.redirect(302, "/smtp");
    }

    const enrollment = secureStore.beginAdminTotpEnrollment();
    const formToken = webAuth.createFormToken(req, res);
    return res.status(200).type("html").send(
      renderMfaSetupPageHtml({
        enrollment,
        formToken,
        status: "Password created. Enroll MFA before opening the panel.",
        cspNonce: getCspNonce(res),
      }),
    );
  } catch (error) {
    return res.redirect(302, `/setup?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.get("/mfa/setup", (req, res) => {
  if (!WEB_MFA_REQUIRED) {
    return res.redirect(302, "/login");
  }
  if (!secureStore.hasAdminPassword()) {
    return res.redirect(302, "/setup");
  }
  if (secureStore.hasAdminTotp()) {
    return res.redirect(302, "/login");
  }

  const enrollment =
    secureStore.getPendingAdminTotpEnrollment() || secureStore.beginAdminTotpEnrollment();
  const formToken = webAuth.createFormToken(req, res);
  return res.status(200).type("html").send(
    renderMfaSetupPageHtml({
      enrollment,
      formToken,
      status: req.query && req.query.status ? String(req.query.status) : "",
      error: req.query && req.query.error ? String(req.query.error) : "",
      cspNonce: getCspNonce(res),
    }),
  );
});

app.post("/mfa/setup", (req, res) => {
  if (!WEB_MFA_REQUIRED) {
    return res.redirect(302, "/login");
  }
  if (!secureStore.hasAdminPassword()) {
    return res.redirect(302, "/setup");
  }
  if (secureStore.hasAdminTotp()) {
    return res.redirect(302, "/login");
  }
  if (!webAuth.verifyFormToken(req, req.body || {})) {
    return res.redirect(302, "/mfa/setup?error=Invalid%20form%20token");
  }

  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const code = req.body && typeof req.body.mfaCode === "string" ? req.body.mfaCode : "";

  if (!secureStore.verifyAdminPassword(password)) {
    return res.redirect(302, "/mfa/setup?error=Invalid%20password");
  }

  try {
    const result = secureStore.confirmAdminTotpEnrollment(code);
    webAuth.login(req, res, password, code);
    return res.status(200).type("html").send(
      renderMfaRecoveryCodesPageHtml({
        recoveryCodes: result.recoveryCodes,
        cspNonce: getCspNonce(res),
      }),
    );
  } catch (error) {
    return res.redirect(302, `/mfa/setup?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.get("/login", (req, res) => {
  if (!secureStore.hasAdminPassword()) {
    return res.redirect(302, "/setup");
  }
  if (shouldRequireMfaSetup()) {
    return res.redirect(302, "/mfa/setup");
  }
  const formToken = webAuth.createFormToken(req, res);
  return res.status(200).type("html").send(
    renderAuthPageHtml({
      mode: "login",
      action: "/login",
      formToken,
      mfaRequired: WEB_MFA_REQUIRED && secureStore.hasAdminTotp(),
      error: req.query && req.query.error ? String(req.query.error) : "",
      cspNonce: getCspNonce(res),
    }),
  );
});

app.post("/login", (req, res) => {
  if (!secureStore.hasAdminPassword()) {
    return res.redirect(302, "/setup");
  }
  if (shouldRequireMfaSetup()) {
    return res.redirect(302, "/mfa/setup");
  }
  if (!webAuth.verifyFormToken(req, req.body || {})) {
    return res.redirect(302, "/login?error=Invalid%20form%20token");
  }
  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const mfaCode = req.body && typeof req.body.mfaCode === "string" ? req.body.mfaCode : "";

  try {
    webAuth.login(req, res, password, mfaCode);
    return res.redirect(302, "/");
  } catch (error) {
    return res.redirect(302, `/login?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.post("/logout", webAuth.requireAuth, webAuth.requireCsrf, (req, res) => {
  webAuth.destroySession(req, res);
  res.redirect(302, "/login");
});

app.post("/sessions/revoke", webAuth.requireAuth, webAuth.requireRole("admin"), webAuth.requireCsrf, (req, res) => {
  const revoked = webAuth.revokeAllSessions();
  res.status(200).json({ ok: true, revoked });
});

app.get(MONITOR_LOGO_ASSET_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer", "smtp-manager"), (req, res, next) => {
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

app.get("/monitor", webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer", "smtp-manager"), (req, res) => {
  res.redirect(302, "/");
});

app.get(MONITOR_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer", "smtp-manager"), (req, res) => {
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
    domainHealthPath: "/domain-health",
    updatePagePath: `${MONITOR_UPDATE_PAGE_PATH}${tokenSuffix}`,
    updateCheckPath: `${MONITOR_UPDATE_CHECK_PATH}${tokenSuffix}`,
    updateApplyPath: `${MONITOR_UPDATE_APPLY_PATH}${tokenSuffix}`,
    csrfToken: webAuth.getCsrfToken(req),
    cspNonce: getCspNonce(res),
    logoutPath: "/logout",
    smtpSettingsPath: "/smtp",
    webMfaRequired: WEB_MFA_REQUIRED,
  });

  res.status(200).type("html").send(html);
});

app.get("/smtp", webAuth.requireAuth, webAuth.requireRole("admin", "smtp-manager"), (req, res) => {
  const status = req.query && req.query.status ? String(req.query.status) : "";
  const error = req.query && req.query.error ? String(req.query.error) : "";
  res.status(200).type("html").send(
    renderSmtpSettingsPageHtml({
      accounts: secureStore.listPublicSmtpAccounts(),
      csrfToken: webAuth.getCsrfToken(req),
      status,
      error,
      cspNonce: getCspNonce(res),
    }),
  );
});

app.get(MONITOR_UPDATE_PAGE_PATH, webAuth.requireAuth, webAuth.requireRole("admin"), (req, res) => {
  res.status(200).type("html").send(
    renderUpdatePageHtml({
      csrfToken: webAuth.getCsrfToken(req),
      checkPath: MONITOR_UPDATE_CHECK_PATH,
      startPath: MONITOR_UPDATE_START_PATH,
      statusPath: MONITOR_UPDATE_STATUS_PATH,
      monitorPath: MONITOR_PATH,
      smtpSettingsPath: "/smtp",
      logoutPath: "/logout",
      cspNonce: getCspNonce(res),
    }),
  );
});

app.post("/smtp/accounts", webAuth.requireAuth, webAuth.requireRole("admin", "smtp-manager"), webAuth.requireCsrf, (req, res) => {
  try {
    secureStore.upsertSmtpAccount(parseSmtpAccountForm(req.body || {}));
    res.redirect(302, "/smtp?status=saved");
  } catch (error) {
    res.redirect(302, `/smtp?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.post("/smtp/accounts/delete", webAuth.requireAuth, webAuth.requireRole("admin", "smtp-manager"), webAuth.requireCsrf, (req, res) => {
  try {
    secureStore.deleteSmtpAccount(req.body && req.body.name);
    res.redirect(302, "/smtp?status=deleted");
  } catch (error) {
    res.redirect(302, `/smtp?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.post("/smtp/default", webAuth.requireAuth, webAuth.requireRole("admin", "smtp-manager"), webAuth.requireCsrf, (req, res) => {
  try {
    secureStore.setDefaultSmtpAccountName(req.body && req.body.name);
    res.redirect(302, "/smtp?status=default-updated");
  } catch (error) {
    res.redirect(302, `/smtp?error=${encodeURIComponent(getErrorMessage(error))}`);
  }
});

app.get(MONITOR_METRICS_VIEW_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer"), (req, res) => {
  const tokenSuffix = "";
  const html = renderMonitorMetricsPageHtml({
    title: "mailFastApi Prometheus Metrics View",
    metricsPath: `${METRICS_PATH}${tokenSuffix}`,
    monitorPath: `${MONITOR_PATH}${tokenSuffix}`,
    rawViewPath: `${MONITOR_RAW_VIEW_PATH}${tokenSuffix}`,
    cspNonce: getCspNonce(res),
  });
  res.status(200).type("html").send(html);
});

app.get(MONITOR_RAW_VIEW_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer"), (req, res) => {
  const tokenSuffix = "";
  const html = renderMonitorRawPageHtml({
    title: "mailFastApi Raw Snapshot View",
    statsPath: `${MONITOR_STATS_PATH}${tokenSuffix}`,
    monitorPath: `${MONITOR_PATH}${tokenSuffix}`,
    metricsViewPath: `${MONITOR_METRICS_VIEW_PATH}${tokenSuffix}`,
    cspNonce: getCspNonce(res),
  });
  res.status(200).type("html").send(html);
});

app.get(MONITOR_STATS_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer"), async (req, res, next) => {
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

app.get(METRICS_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer"), async (req, res, next) => {
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

app.get(
  "/domain-health/:domain",
  webAuth.requireAuth,
  webAuth.requireRole("admin", "operator", "viewer"),
  async (req, res, next) => {
    try {
      const domain = encodeURIComponent(String(req.params.domain || ""));
      const response = await fetch(buildCoreUrl(req, `/domain-health/${domain}`), {
        headers: buildCoreHeaders(req),
        cache: "no-store",
      });
      await forwardResponse(response, res, "application/json");
    } catch (error) {
      next(error);
    }
  },
);

app.get(MONITOR_STREAM_PATH, webAuth.requireAuth, webAuth.requireRole("admin", "operator", "viewer"), async (req, res, next) => {
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

app.get(MONITOR_UPDATE_CHECK_PATH, webAuth.requireAuth, webAuth.requireRole("admin"), updateAuth, async (req, res, next) => {
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
  MONITOR_UPDATE_START_PATH,
  webAuth.requireAuth,
  webAuth.requireRole("admin"),
  webAuth.requireCsrf,
  updateAuth,
  (req, res, next) => {
  if (!WEB_ENABLE_UPDATER) {
    return res.status(403).json({
      ok: false,
      code: "UPDATER_DISABLED",
      message: "Updater feature is disabled.",
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (body.confirm !== true) {
    return res.status(400).json({
      ok: false,
      code: "CONFIRM_REQUIRED",
      message: "Update start requires { confirm: true }.",
    });
  }

  try {
    const snapshot = startUpdateJob();
    return res.status(202).json(snapshot);
  } catch (error) {
    next(error);
  }
  },
);

app.get(MONITOR_UPDATE_STATUS_PATH, webAuth.requireAuth, webAuth.requireRole("admin"), updateAuth, (req, res) => {
  res.status(200).json(getUpdateJobSnapshot());
});

app.post(
  MONITOR_UPDATE_APPLY_PATH,
  webAuth.requireAuth,
  webAuth.requireRole("admin"),
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

  if (!confirm) {
    return res.status(400).json({
      ok: false,
      code: "CONFIRM_REQUIRED",
      message: "Update apply requires { confirm: true }.",
    });
  }

  try {
    const args = ["--apply", "--yes", "--json", "--defer-restart"];
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

function shouldRequireMfaSetup() {
  return WEB_MFA_REQUIRED && !secureStore.hasAdminTotp();
}

function renderAuthPageHtml(options = {}) {
  const mode = options.mode === "setup" ? "setup" : "login";
  const isSetup = mode === "setup";
  const title = isSetup ? "Create Web Panel Password" : "Web Panel Login";
  const submitText = isSetup ? "Create Password" : "Login";
  const action = escapeHtml(options.action || (isSetup ? "/setup" : "/login"));
  const formToken = escapeHtml(options.formToken || "");
  const error = String(options.error || "").trim();
  const mfaRequired = options.mfaRequired === true;
  const nonceAttr = formatNonceAttr(options.cspNonce);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style${nonceAttr}>
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
    <p>${
      isSetup
        ? "First secure setup. Create the web panel password."
        : mfaRequired
          ? "Enter the web panel password and MFA code."
          : "Enter the web panel password."
    }</p>
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
      ${
        mfaRequired
          ? '<label for="mfaCode">MFA code</label><input id="mfaCode" name="mfaCode" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9A-Za-z -]{6,24}" required />'
          : ""
      }
      <button type="submit">${escapeHtml(submitText)}</button>
    </form>
  </main>
</body>
</html>`;
}

function renderMfaSetupPageHtml(options = {}) {
  const enrollment = options.enrollment || {};
  const formToken = escapeHtml(options.formToken || "");
  const secret = escapeHtml(enrollment.secret || "");
  const otpauthUrl = escapeHtml(enrollment.otpauthUrl || "");
  const error = String(options.error || "").trim();
  const status = String(options.status || "").trim();
  const nonceAttr = formatNonceAttr(options.cspNonce);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Enroll MFA</title>
  <style${nonceAttr}>
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
      width: min(620px, 100%);
      border: 1px solid #c6cbd3;
      background: #efefef;
      border-radius: 4px;
      padding: 18px;
    }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 14px; color: #444; font-size: 13px; line-height: 1.45; }
    label { display: block; font-weight: 700; font-size: 12px; margin: 12px 0 6px; }
    input, textarea {
      width: 100%;
      min-height: 38px;
      border: 1px solid #888;
      background: #fff;
      color: #111;
      padding: 8px 10px;
      font-size: 14px;
      font-family: Consolas, "Courier New", monospace;
    }
    textarea { min-height: 82px; resize: vertical; }
    code {
      display: block;
      border: 1px solid #888;
      background: #fff;
      padding: 8px 10px;
      overflow-wrap: anywhere;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
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
    .error, .status {
      border: 1px solid #888;
      background: #fff;
      padding: 8px 10px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    .error { border-color: #e24d42; background: #fff5f5; color: #991b1b; }
    .status { border-color: #1f7a43; background: #f0fff5; color: #14532d; }
  </style>
</head>
<body>
  <main>
    <h1>Enroll MFA</h1>
    <p>Add this TOTP secret to an authenticator app, then confirm with the current six digit code.</p>
    ${status ? `<div class="status">${escapeHtml(status)}</div>` : ""}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <label>TOTP secret</label>
    <code>${secret}</code>
    <label for="otpauthUrl">Authenticator URI</label>
    <textarea id="otpauthUrl" readonly>${otpauthUrl}</textarea>
    <form method="post" action="/mfa/setup" autocomplete="off">
      <input type="hidden" name="_csrf" value="${formToken}" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" minlength="12" required />
      <label for="mfaCode">MFA code</label>
      <input id="mfaCode" name="mfaCode" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required autofocus />
      <button type="submit">Enable MFA</button>
    </form>
  </main>
</body>
</html>`;
}

function renderMfaRecoveryCodesPageHtml(options = {}) {
  const recoveryCodes = Array.isArray(options.recoveryCodes) ? options.recoveryCodes : [];
  const nonceAttr = formatNonceAttr(options.cspNonce);
  const listItems = recoveryCodes
    .map((code) => `<li><code>${escapeHtml(code)}</code></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MFA Recovery Codes</title>
  <style${nonceAttr}>
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
      width: min(520px, 100%);
      border: 1px solid #c6cbd3;
      background: #efefef;
      border-radius: 4px;
      padding: 18px;
    }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 14px; color: #444; font-size: 13px; line-height: 1.45; }
    ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
    code {
      display: block;
      border: 1px solid #888;
      background: #fff;
      padding: 8px 10px;
      font-family: Consolas, "Courier New", monospace;
      font-size: 14px;
    }
    a {
      display: inline-block;
      margin-top: 16px;
      border: 1px solid #888;
      background: #111827;
      color: #fff;
      padding: 10px 14px;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <h1>MFA enabled</h1>
    <p>Store these recovery codes in a secure offline location. Each code can be used once.</p>
    <ul>${listItems}</ul>
    <a href="/">Continue</a>
  </main>
</body>
</html>`;
}

function renderSmtpSettingsPageHtml(options = {}) {
  const accounts = Array.isArray(options.accounts) ? options.accounts : [];
  const csrfToken = escapeHtml(options.csrfToken || "");
  const status = String(options.status || "").trim();
  const error = String(options.error || "").trim();
  const nonceAttr = formatNonceAttr(options.cspNonce);
  const rows = accounts.length
    ? accounts
        .map(
          (account) => `<tr>
            <td>${escapeHtml(account.name)}${account.isDefault ? " (default)" : ""}</td>
            <td>${escapeHtml(inferAccountProfile(account))}</td>
            <td>${escapeHtml(account.from || "-")}</td>
            <td>${escapeHtml(account.host || "-")}:${escapeHtml(account.port || "-")}</td>
            <td>${account.secure ? "TLS" : "STARTTLS/plain"}</td>
            <td>${escapeHtml(account.user || "-")}</td>
            <td>${escapeHtml(formatAccountLimits(account))}</td>
            <td>${account.hasPassword ? "masked" : "empty"}</td>
            <td>
              <button
                type="button"
                data-edit-account
                data-name="${escapeHtml(account.name)}"
                data-from="${escapeHtml(account.from || "")}"
                data-host="${escapeHtml(account.host || "")}"
                data-port="${escapeHtml(account.port || "")}"
                data-secure="${account.secure ? "true" : "false"}"
                data-user="${escapeHtml(account.user || "")}"
                data-rate-limit="${escapeHtml(account.rateLimit || "")}"
                data-max-connections="${escapeHtml(account.maxConnections || "")}"
                data-max-messages="${escapeHtml(account.maxMessages || "")}"
                data-rate-delta="${escapeHtml(account.rateDelta || "")}"
              >Edit</button>
              <form method="post" action="/smtp/default">
                <input type="hidden" name="_csrf" value="${csrfToken}" />
                <input type="hidden" name="name" value="${escapeHtml(account.name)}" />
                <button type="submit"${account.isDefault ? " disabled" : ""}>Default</button>
              </form>
              <form method="post" action="/smtp/accounts/delete" data-confirm="Delete SMTP account?">
                <input type="hidden" name="_csrf" value="${csrfToken}" />
                <input type="hidden" name="name" value="${escapeHtml(account.name)}" />
                <button type="submit">Delete</button>
              </form>
            </td>
          </tr>`,
        )
        .join("")
    : "<tr><td colspan='9' class='empty'>No SMTP accounts saved yet.</td></tr>";
  const defaultAccount = accounts.find((account) => account.isDefault);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMTP Accounts</title>
  <style${nonceAttr}>
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
    p { margin: 0 0 10px; color: #444; font-size: 12px; line-height: 1.45; }
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
    .summary-grid, .profile-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .profile-grid { grid-template-columns: repeat(3, minmax(180px, 1fr)); }
    .summary-card, .profile-card {
      border: 1px solid #c6cbd3;
      background: #f7f7f7;
      padding: 9px;
      min-height: 72px;
    }
    .summary-card .k, .profile-card .k {
      font-size: 11px;
      text-transform: uppercase;
      color: #444;
      margin-bottom: 6px;
      letter-spacing: 0.35px;
    }
    .summary-card .v, .profile-card .v {
      font-size: 17px;
      font-weight: 700;
      color: #111;
      overflow-wrap: anywhere;
    }
    .profile-card .v {
      font-size: 13px;
      line-height: 1.35;
      font-weight: 600;
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
    table { width: 100%; min-width: 1180px; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; border-bottom: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #d9d9d9; text-transform: uppercase; font-size: 11px; }
    td form { display: inline-block; margin-right: 6px; margin-bottom: 4px; }
    .empty { color: #444; padding: 12px; }
    @media (max-width: 860px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .form-grid { grid-template-columns: 1fr; }
      .summary-grid, .profile-grid { grid-template-columns: 1fr; }
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
    <h2>Account Overview</h2>
    <div class="summary-grid">
      <div class="summary-card"><div class="k">Saved Accounts</div><div class="v">${escapeHtml(accounts.length)}</div></div>
      <div class="summary-card"><div class="k">Default Account</div><div class="v">${escapeHtml(defaultAccount ? defaultAccount.name : "-")}</div></div>
      <div class="summary-card"><div class="k">Encrypted Store</div><div class="v">active</div></div>
      <div class="summary-card"><div class="k">Dev MFA</div><div class="v">${WEB_MFA_REQUIRED ? "enabled" : "disabled"}</div></div>
    </div>
    <div class="profile-grid">
      <div class="profile-card"><div class="k">Security / 2FA</div><div class="v">Use category security and a dedicated sender account.</div></div>
      <div class="profile-card"><div class="k">Notifications</div><div class="v">Use category notification or transactional for bilgi mailleri.</div></div>
      <div class="profile-card"><div class="k">Marketing / Bulk</div><div class="v">Use category marketing/bulk so suppression and unsubscribe controls apply.</div></div>
    </div>
  </section>

  <section class="panel">
    <h2>Add or Update Account</h2>
    <p>Saved credentials remain encrypted in the SQLite secure store. Leaving password blank keeps the existing password for the same account.</p>
    <form method="post" action="/smtp/accounts" autocomplete="off">
      <input type="hidden" name="_csrf" value="${csrfToken}" />
      <div class="form-grid">
        <div><label for="name">Account Name</label><input id="name" name="name" maxlength="64" placeholder="info@example.com or 2FA Mail" required /></div>
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
          <tr>
            <th>Account</th>
            <th>Profile</th>
            <th>From</th>
            <th>Server</th>
            <th>Secure</th>
            <th>User</th>
            <th>Limits</th>
            <th>Password</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
  <script${nonceAttr}>
    for (const form of document.querySelectorAll("[data-confirm]")) {
      form.addEventListener("submit", (event) => {
        if (!window.confirm(form.getAttribute("data-confirm") || "Continue?")) {
          event.preventDefault();
        }
      });
    }
    for (const button of document.querySelectorAll("[data-edit-account]")) {
      button.addEventListener("click", () => {
        setValue("name", button.dataset.name);
        setValue("from", button.dataset.from);
        setValue("host", button.dataset.host);
        setValue("port", button.dataset.port);
        setValue("secure", button.dataset.secure);
        setValue("user", button.dataset.user);
        setValue("rateLimit", button.dataset.rateLimit);
        setValue("maxConnections", button.dataset.maxConnections);
        setValue("maxMessages", button.dataset.maxMessages);
        setValue("rateDelta", button.dataset.rateDelta);
        const pass = document.getElementById("pass");
        if (pass) pass.value = "";
        const name = document.getElementById("name");
        if (name) name.focus();
      });
    }
    function setValue(id, value) {
      const element = document.getElementById(id);
      if (element) element.value = value || "";
    }
  </script>
</body>
</html>`;
}

function renderUpdatePageHtml(options = {}) {
  const csrfToken = escapeHtml(options.csrfToken || "");
  const checkPath = escapeHtml(options.checkPath || MONITOR_UPDATE_CHECK_PATH);
  const startPath = escapeHtml(options.startPath || MONITOR_UPDATE_START_PATH);
  const statusPath = escapeHtml(options.statusPath || MONITOR_UPDATE_STATUS_PATH);
  const monitorPath = escapeHtml(options.monitorPath || MONITOR_PATH);
  const smtpSettingsPath = escapeHtml(options.smtpSettingsPath || "/smtp");
  const logoutPath = escapeHtml(options.logoutPath || "/logout");
  const nonceAttr = formatNonceAttr(options.cspNonce);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Update Control</title>
  <style${nonceAttr}>
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
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .nav { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .inline-form { margin: 0; }
    .nav-spaced { margin-top: 12px; }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .cell {
      border: 1px solid #c6cbd3;
      background: #fff;
      padding: 8px;
      min-height: 58px;
    }
    .k { font-size: 11px; color: #444; text-transform: uppercase; margin-bottom: 4px; }
    .v { font-size: 13px; font-weight: 700; word-break: break-word; }
    .progress-shell {
      border: 1px solid #888;
      background: #fff;
      height: 28px;
      width: 100%;
      overflow: hidden;
      margin: 12px 0 8px;
    }
    .progress-bar {
      appearance: none;
      border: 0;
      height: 100%;
      width: 100%;
      display: block;
      background: #fff;
    }
    .progress-bar::-webkit-progress-bar { background: #fff; }
    .progress-bar::-webkit-progress-value { background: #2166ad; }
    .progress-bar::-moz-progress-bar {
      background: #2166ad;
      transition: width 280ms ease;
    }
    .progress-meta {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
      color: #333;
    }
    .message {
      border: 1px solid #c6cbd3;
      background: #fff;
      min-height: 40px;
      padding: 9px 10px;
      font-size: 13px;
      margin-top: 10px;
    }
    .message.ok { border-color: #7eb26d; background: #f0fff4; color: #166534; }
    .message.err { border-color: #e24d42; background: #fff5f5; color: #991b1b; }
    .steps {
      list-style: none;
      padding: 0;
      margin: 0;
      border: 1px solid #c6cbd3;
      background: #fff;
      max-height: 360px;
      overflow: auto;
    }
    .steps li {
      display: grid;
      grid-template-columns: 140px 90px 1fr;
      gap: 8px;
      border-bottom: 1px solid #e5e7eb;
      padding: 8px;
      font-size: 12px;
    }
    .steps li:last-child { border-bottom: 0; }
    .badge {
      border: 1px solid #999;
      background: #f4f5f7;
      padding: 2px 6px;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 10px;
      width: fit-content;
    }
    .badge.ok { border-color: #16a34a; color: #166534; background: #f0fff4; }
    .badge.warn, .badge.skipped, .badge.deferred { border-color: #d97706; color: #92400e; background: #fffbeb; }
    .badge.err, .badge.failed { border-color: #dc2626; color: #991b1b; background: #fff5f5; }
    .empty { color: #555; padding: 10px; font-size: 12px; }
    @media (max-width: 860px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .status-grid { grid-template-columns: 1fr; }
      .steps li { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <h1>Update Control</h1>
    <div class="nav">
      <a href="${monitorPath}">Monitor</a>
      <a href="${smtpSettingsPath}">SMTP Accounts</a>
      <form method="post" action="${logoutPath}" class="inline-form">
        <input type="hidden" name="_csrf" value="${csrfToken}" />
        <button type="submit">Logout</button>
      </form>
    </div>
  </header>

  <section class="panel">
    <h2>Update Status</h2>
    <div class="progress-shell" aria-label="Update progress">
      <progress id="progressBar" class="progress-bar" max="100" value="0"></progress>
    </div>
    <div class="progress-meta">
      <span id="progressLabel">Hazir</span>
      <span id="progressPercent">0%</span>
    </div>
    <div id="message" class="message">Guncelleme durumu denetleniyor.</div>
    <div class="status-grid">
      <div class="cell"><div class="k">Mode</div><div id="mode" class="v">-</div></div>
      <div class="cell"><div class="k">Target</div><div id="target" class="v">-</div></div>
      <div class="cell"><div class="k">Commit</div><div id="commit" class="v">-</div></div>
      <div class="cell"><div class="k">Restart</div><div id="restart" class="v">-</div></div>
    </div>
    <div class="nav nav-spaced">
      <button id="checkBtn" type="button">Tekrar Denetle</button>
      <button id="startBtn" type="button" disabled>Guncellemeyi Baslat</button>
    </div>
  </section>

  <section class="panel">
    <h2>Steps</h2>
    <ul id="steps" class="steps"><li class="empty">Henuz islem yok.</li></ul>
  </section>

  <script${nonceAttr}>
    const updateCheckPath = "${checkPath}";
    const updateStartPath = "${startPath}";
    const updateStatusPath = "${statusPath}";
    const csrfToken = "${csrfToken}";
    const ids = {
      progressBar: document.getElementById("progressBar"),
      progressLabel: document.getElementById("progressLabel"),
      progressPercent: document.getElementById("progressPercent"),
      message: document.getElementById("message"),
      mode: document.getElementById("mode"),
      target: document.getElementById("target"),
      commit: document.getElementById("commit"),
      restart: document.getElementById("restart"),
      steps: document.getElementById("steps"),
      checkBtn: document.getElementById("checkBtn"),
      startBtn: document.getElementById("startBtn"),
    };
    let pollTimer = null;
    let updateAvailable = false;

    ids.checkBtn.addEventListener("click", () => {
      void checkForUpdate();
    });
    ids.startBtn.addEventListener("click", () => {
      void startUpdate();
    });

    void boot();

    async function boot() {
      const status = await fetchStatus();
      if (status && status.status === "running") {
        applyJob(status);
        startPolling();
        return;
      }
      await checkForUpdate();
    }

    async function checkForUpdate() {
      stopPolling();
      updateAvailable = false;
      ids.startBtn.disabled = true;
      setProgress(8, "Denetleniyor");
      setMessage("Remote repository denetleniyor.", "");
      renderSteps([]);

      try {
        const response = await fetch(updateCheckPath, {
          cache: "no-store",
          headers: { "Accept": "application/json" },
        });
        const payload = await parseJsonSafely(response);
        if (!response.ok) {
          throw new Error((payload && payload.message) || "Guncelleme denetimi basarisiz.");
        }

        fillTarget(payload);
        updateAvailable = payload && payload.updateAvailable === true;
        if (updateAvailable) {
          setProgress(25, "Yeni surum hazir");
          setMessage("Yeni surum bulundu. Baslat dugmesi ile ilerleyin.", "ok");
          ids.startBtn.disabled = false;
          return;
        }

        setProgress(100, "Guncel");
        setMessage("Sistem guncel. Yeni commit/tag bulunmuyor.", "ok");
      } catch (error) {
        setProgress(0, "Hata");
        setMessage(error && error.message ? error.message : "Guncelleme denetimi basarisiz.", "err");
      }
    }

    async function startUpdate() {
      if (!updateAvailable) return;
      ids.checkBtn.disabled = true;
      ids.startBtn.disabled = true;
      setProgress(32, "Baslatiliyor");
      setMessage("Updater islemi baslatiliyor.", "");

      try {
        const response = await fetch(updateStartPath, {
          method: "POST",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ confirm: true }),
        });
        const payload = await parseJsonSafely(response);
        if (!response.ok) {
          throw new Error((payload && payload.message) || "Guncelleme baslatilamadi.");
        }
        applyJob(payload);
        startPolling();
      } catch (error) {
        ids.checkBtn.disabled = false;
        ids.startBtn.disabled = false;
        setProgress(0, "Hata");
        setMessage(error && error.message ? error.message : "Guncelleme baslatilamadi.", "err");
      }
    }

    function startPolling() {
      stopPolling();
      pollTimer = setInterval(async () => {
        const status = await fetchStatus();
        if (!status) return;
        applyJob(status);
        if (status.status === "succeeded" || status.status === "failed") {
          stopPolling();
          ids.checkBtn.disabled = false;
          ids.startBtn.disabled = true;
          if (status.restartDeferred) {
            setTimeout(() => {
              window.location.reload();
            }, 3500);
          }
        }
      }, 900);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    async function fetchStatus() {
      try {
        const response = await fetch(updateStatusPath, {
          cache: "no-store",
          headers: { "Accept": "application/json" },
        });
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        return null;
      }
    }

    function applyJob(job) {
      const percent = clamp(Number(job.percent || 0), 0, 100);
      setProgress(percent, job.label || job.status || "Calisiyor");
      setMessage(job.message || "Guncelleme islemi suruyor.", job.status === "failed" ? "err" : "");
      renderSteps(job.steps || []);
      ids.restart.textContent = job.restartDeferred ? "Deferred" : "-";
      if (job.latest) {
        fillTarget({ latest: job.latest, releaseMode: job.releaseMode, upstream: job.upstream });
      }
      if (job.status === "succeeded") {
        setProgress(100, "Tamamlandi");
        setMessage(job.message || "Guncelleme tamamlandi.", "ok");
      }
      if (job.status === "failed") {
        setMessage(job.error || job.message || "Guncelleme basarisiz.", "err");
      }
    }

    function fillTarget(payload) {
      const latest = (payload && payload.latest) || {};
      ids.mode.textContent = payload && payload.releaseMode ? payload.releaseMode : "-";
      ids.target.textContent = payload && payload.upstream ? payload.upstream : "-";
      ids.commit.textContent = latest.shortSha || latest.sha || "-";
    }

    function renderSteps(steps) {
      if (!Array.isArray(steps) || steps.length === 0) {
        ids.steps.innerHTML = '<li class="empty">Henuz islem yok.</li>';
        return;
      }

      ids.steps.innerHTML = steps.map((step) => {
        const status = escapeHtml(step.status || "");
        return '<li><span>' + escapeHtml(step.name || "-") + '</span><span class="badge ' +
          status + '">' + status + '</span><span>' + escapeHtml(step.message || "") + '</span></li>';
      }).join("");
      ids.steps.scrollTop = ids.steps.scrollHeight;
    }

    function setProgress(percent, label) {
      const value = clamp(Number(percent || 0), 0, 100);
      ids.progressBar.value = value;
      ids.progressPercent.textContent = Math.round(value) + "%";
      ids.progressLabel.textContent = label || "-";
    }

    function setMessage(message, kind) {
      ids.message.className = "message" + (kind ? " " + kind : "");
      ids.message.textContent = message || "";
    }

    async function parseJsonSafely(response) {
      try {
        return await response.json();
      } catch (error) {
        return null;
      }
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
  </script>
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

function inferAccountProfile(account = {}) {
  const haystack = `${account.name || ""} ${account.from || ""}`.toLowerCase();
  if (/\b(2fa|mfa|otp|security|guvenlik)\b/.test(haystack)) {
    return "Security / 2FA";
  }
  if (/\b(marketing|bulk|campaign|kampanya)\b/.test(haystack)) {
    return "Marketing / Bulk";
  }
  if (/\b(info|bilgi|notification|notify|duyuru)\b/.test(haystack)) {
    return "Notification";
  }
  return "Transactional";
}

function formatAccountLimits(account = {}) {
  const parts = [
    `conn ${account.maxConnections || "-"}`,
    `msg ${account.maxMessages || "-"}`,
    `rate ${account.rateLimit || "-"}/${account.rateDelta || "-"}ms`,
  ];
  return parts.join(" | ");
}

function getErrorMessage(error) {
  return error && error.message ? error.message : "Unknown error";
}

function getCspNonce(res) {
  return res && res.locals ? res.locals.cspNonce || "" : "";
}

function formatNonceAttr(value) {
  const nonce = escapeHtml(value || "");
  return nonce ? ` nonce="${nonce}"` : "";
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
    if (headerToken && safeEqualStrings(headerToken, requiredToken)) {
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
    const command = buildUpdaterCommand(WEB_UPDATE_SCRIPT, args);
    const child = spawn(command.bin, command.args, {
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

function buildUpdaterCommand(scriptPath, args) {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === ".js") {
    return { bin: process.execPath, args: [scriptPath, ...args] };
  }
  if (ext === ".ps1") {
    return {
      bin: process.platform === "win32" ? "powershell.exe" : "pwsh",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    };
  }
  if (ext === ".sh") {
    return { bin: process.platform === "win32" ? "bash.exe" : "bash", args: [scriptPath, ...args] };
  }
  return { bin: scriptPath, args };
}

function startUpdateJob() {
  if (updateJob && updateJob.status === "running") {
    return getUpdateJobSnapshot();
  }

  if (!WEB_UPDATE_SCRIPT) {
    throw new Error("WEB_UPDATE_SCRIPT is not configured.");
  }

  if (!fs.existsSync(WEB_UPDATE_SCRIPT)) {
    throw new Error(`Updater script not found: ${WEB_UPDATE_SCRIPT}`);
  }

  const job = {
    id: crypto.randomUUID(),
    status: "running",
    label: "Baslatiliyor",
    percent: 2,
    message: "Updater process baslatildi.",
    steps: [],
    latest: null,
    releaseMode: "",
    upstream: "",
    restartDeferred: false,
    result: null,
    error: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    pid: null,
  };
  updateJob = job;

  const args = ["--apply", "--yes", "--json", "--progress-jsonl", "--defer-restart"];
  const command = buildUpdaterCommand(WEB_UPDATE_SCRIPT, args);
  const child = spawn(command.bin, command.args, {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      MAILFASTAPI_UPDATER_CALLER: "web",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = child.pid || null;

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      handleUpdaterProgressLine(job, line);
    }
  });

  child.stderr.on("data", (chunk) => {
    job.stderr = `${job.stderr}${chunk.toString("utf8")}`.slice(-6000);
  });

  child.once("error", (error) => {
    markUpdateJobFailed(job, error && error.message ? error.message : "Updater process failed.");
  });

  child.once("close", (code) => {
    if (stdoutBuffer.trim()) {
      handleUpdaterProgressLine(job, stdoutBuffer.trim());
      stdoutBuffer = "";
    }

    job.finishedAt = new Date().toISOString();
    job.exitCode = Number.isFinite(Number(code)) ? Number(code) : 1;

    if (job.result) {
      job.restartDeferred = Boolean(job.result.restartDeferred);
      job.releaseMode = job.result.releaseMode || job.releaseMode;
      job.upstream = job.result.upstream || job.upstream;
      job.latest = job.result.latest || job.latest;
      job.message = job.result.message || job.message;
      job.percent = job.result.ok ? 100 : Math.max(job.percent, 1);
      job.status = job.result.ok ? "succeeded" : "failed";
      if (!job.result.ok) {
        job.error = job.result.message || job.error || "Update failed.";
      }
      return;
    }

    if (job.exitCode === 0) {
      job.status = "succeeded";
      job.percent = 100;
      job.message = "Guncelleme tamamlandi.";
      return;
    }

    markUpdateJobFailed(job, job.stderr || "Updater process failed.");
  });

  return getUpdateJobSnapshot();
}

function handleUpdaterProgressLine(job, line) {
  const text = String(line || "").trim();
  if (!text) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    job.message = text;
    return;
  }

  if (payload.type === "step" && payload.step) {
    job.steps.push(payload.step);
    job.percent = Math.max(job.percent, Number(payload.progressPercent || 0));
    job.label = payload.step.name || job.label;
    job.message = payload.step.message || job.message;
    return;
  }

  if (payload.type === "result" && payload.result) {
    job.result = payload.result;
    job.steps = Array.isArray(payload.result.steps) ? payload.result.steps : job.steps;
    job.percent = Number(payload.result.progressPercent || job.percent);
    job.latest = payload.result.latest || job.latest;
    job.releaseMode = payload.result.releaseMode || job.releaseMode;
    job.upstream = payload.result.upstream || job.upstream;
    job.restartDeferred = Boolean(payload.result.restartDeferred);
    job.message = payload.result.message || job.message;
    return;
  }
}

function markUpdateJobFailed(job, message) {
  job.status = "failed";
  job.percent = Math.max(job.percent || 0, 1);
  job.error = message;
  job.message = message;
  job.finishedAt = new Date().toISOString();
}

function getUpdateJobSnapshot() {
  const job = updateJob || createIdleUpdateJob();
  return {
    id: job.id,
    status: job.status,
    label: job.label,
    percent: job.percent,
    message: job.message,
    steps: Array.isArray(job.steps) ? job.steps.slice(-50) : [],
    latest: job.latest || null,
    releaseMode: job.releaseMode || "",
    upstream: job.upstream || "",
    restartDeferred: Boolean(job.restartDeferred),
    result: job.result || null,
    error: job.error || "",
    stderr: job.stderr || "",
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    pid: job.pid || null,
  };
}

function createIdleUpdateJob() {
  return {
    id: null,
    status: "idle",
    label: "Hazir",
    percent: 0,
    message: "Guncelleme bekleniyor.",
    steps: [],
    latest: null,
    releaseMode: "",
    upstream: "",
    restartDeferred: false,
    result: null,
    error: "",
    stderr: "",
    startedAt: "",
    finishedAt: "",
    pid: null,
  };
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
