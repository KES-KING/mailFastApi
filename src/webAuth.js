"use strict";

const crypto = require("node:crypto");

const SESSION_COOKIE = "mailfastapi_session";
const FORM_COOKIE = "mailfastapi_form";
const SESSION_TTL_MS = Math.max(
  5 * 60 * 1000,
  toInt(process.env.WEB_SESSION_IDLE_TIMEOUT_MS, 8 * 60 * 60 * 1000),
);
const SESSION_ABSOLUTE_TTL_MS = Math.max(
  SESSION_TTL_MS,
  toInt(process.env.WEB_SESSION_ABSOLUTE_TIMEOUT_MS, 12 * 60 * 60 * 1000),
);
const FORM_TTL_MS = 10 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const SESSION_BIND_IP = toBoolean(process.env.WEB_SESSION_BIND_IP, true);

function createWebAuth(options) {
  const { secureStore } = options || {};
  if (!secureStore || typeof secureStore.verifyAdminPassword !== "function") {
    throw new Error("A secure store is required for web auth.");
  }

  const sessions = new Map();
  const formTokens = new Map();
  const failuresByIp = new Map();

  function securityHeaders(req, res, next) {
    const cspNonce = crypto.randomBytes(16).toString("base64url");
    res.locals.cspNonce = cspNonce;
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "img-src 'self' data:",
        `script-src 'self' 'nonce-${cspNonce}'`,
        `style-src 'self' 'nonce-${cspNonce}'`,
        "style-src-attr 'none'",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    );
    next();
  }

  function createFormToken(req, res) {
    pruneExpired();
    const token = crypto.randomBytes(32).toString("base64url");
    formTokens.set(token, {
      expiresAt: Date.now() + FORM_TTL_MS,
      ip: getClientIp(req),
    });
    setCookie(res, FORM_COOKIE, token, FORM_TTL_MS, req, { httpOnly: true });
    return token;
  }

  function verifyFormToken(req, body) {
    const cookies = parseCookies(req.headers.cookie || "");
    const cookieToken = cookies[FORM_COOKIE] || "";
    const bodyToken = body && typeof body._csrf === "string" ? body._csrf : "";
    if (!cookieToken || !bodyToken || cookieToken !== bodyToken) {
      return false;
    }

    const record = formTokens.get(cookieToken);
    if (!record || record.expiresAt < Date.now()) {
      formTokens.delete(cookieToken);
      return false;
    }

    formTokens.delete(cookieToken);
    return true;
  }

  function createSession(req, res) {
    pruneExpired();
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, {
      csrfToken,
      role: "admin",
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      ip: getClientIp(req),
    });
    setCookie(res, SESSION_COOKIE, token, SESSION_TTL_MS, req, { httpOnly: true });
    return { token, csrfToken };
  }

  function destroySession(req, res) {
    const cookies = parseCookies(req.headers.cookie || "");
    if (cookies[SESSION_COOKIE]) {
      sessions.delete(cookies[SESSION_COOKIE]);
    }
    clearCookie(res, SESSION_COOKIE, req);
  }

  function getSession(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies[SESSION_COOKIE] || "";
    const session = token ? sessions.get(token) : null;
    if (!session || session.expiresAt < Date.now() || session.createdAt + SESSION_ABSOLUTE_TTL_MS < Date.now()) {
      if (token) sessions.delete(token);
      return null;
    }
    if (SESSION_BIND_IP && session.ip !== getClientIp(req)) {
      sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  function requireAuth(req, res, next) {
    if (!secureStore.hasAdminPassword()) {
      if (wantsHtml(req)) {
        return res.redirect(302, "/setup");
      }
      return res.status(503).json({ error: "Web panel setup required." });
    }

    const session = getSession(req);
    if (!session) {
      if (wantsHtml(req)) {
        return res.redirect(302, "/login");
      }
      return res.status(401).json({ error: "Unauthorized web session." });
    }

    req.webSession = session;
    return next();
  }

  function requireCsrf(req, res, next) {
    const session = req.webSession || getSession(req);
    const provided =
      req.header("x-csrf-token") ||
      (req.body && typeof req.body._csrf === "string" ? req.body._csrf : "");
    if (!session || !provided || !safeEqual(provided, session.csrfToken)) {
      return res.status(403).json({ error: "Invalid CSRF token." });
    }
    req.webSession = session;
    return next();
  }

  function requireRole(...roles) {
    const allowed = roles.flat().map((role) => String(role || "").trim()).filter(Boolean);
    return (req, res, next) => {
      const session = req.webSession || getSession(req);
      if (!session) {
        return res.status(401).json({ error: "Unauthorized web session." });
      }
      if (allowed.length > 0 && !allowed.includes(session.role)) {
        return res.status(403).json({ error: "Insufficient web role." });
      }
      req.webSession = session;
      return next();
    };
  }

  function login(req, res, password, mfaCode) {
    const ip = getClientIp(req);
    const lock = getLoginLock(ip);
    if (lock.locked) {
      const error = new Error("Too many failed login attempts. Try again later.");
      error.code = "LOGIN_LOCKED";
      throw error;
    }

    if (!secureStore.verifyAdminPassword(password)) {
      recordLoginFailure(ip);
      const error = new Error("Invalid password.");
      error.code = "INVALID_PASSWORD";
      throw error;
    }

    if (isMfaEnabled() && !secureStore.verifyAdminMfaCode(mfaCode)) {
      recordLoginFailure(ip);
      const error = new Error("Invalid MFA verification code.");
      error.code = mfaCode ? "INVALID_MFA_CODE" : "MFA_REQUIRED";
      throw error;
    }

    failuresByIp.delete(ip);
    return createSession(req, res);
  }

  function getCsrfToken(req) {
    const session = req.webSession || getSession(req);
    return session ? session.csrfToken : "";
  }

  function revokeAllSessions() {
    const count = sessions.size;
    sessions.clear();
    return count;
  }

  function isMfaEnabled() {
    return (
      typeof secureStore.hasAdminTotp === "function" &&
      secureStore.hasAdminTotp() === true &&
      typeof secureStore.verifyAdminMfaCode === "function"
    );
  }

  function pruneExpired() {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt < now) sessions.delete(token);
    }
    for (const [token, record] of formTokens.entries()) {
      if (record.expiresAt < now) formTokens.delete(token);
    }
    for (const [ip, record] of failuresByIp.entries()) {
      if (record.windowStart + LOGIN_WINDOW_MS < now && record.lockedUntil < now) {
        failuresByIp.delete(ip);
      }
    }
  }

  function getLoginLock(ip) {
    const record = failuresByIp.get(ip);
    if (!record || record.lockedUntil < Date.now()) {
      return { locked: false };
    }
    return { locked: true, until: record.lockedUntil };
  }

  function recordLoginFailure(ip) {
    const now = Date.now();
    const current = failuresByIp.get(ip);
    const record =
      current && current.windowStart + LOGIN_WINDOW_MS >= now
        ? current
        : { count: 0, windowStart: now, lockedUntil: 0 };
    record.count += 1;
    if (record.count >= LOGIN_MAX_FAILURES) {
      record.lockedUntil = now + LOGIN_LOCK_MS;
    }
    failuresByIp.set(ip, record);
  }

  return {
    securityHeaders,
    createFormToken,
    verifyFormToken,
    requireAuth,
    requireRole,
    requireCsrf,
    login,
    destroySession,
    getCsrfToken,
    revokeAllSessions,
    isMfaEnabled,
  };
}

function setCookie(res, name, value, maxAgeMs, req, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", appendCookie(res, parts.join("; ")));
}

function clearCookie(res, name, req) {
  const parts = [`${name}=`, "Path=/", "Max-Age=0", "SameSite=Lax", "HttpOnly"];
  if (isSecureRequest(req)) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", appendCookie(res, parts.join("; ")));
}

function appendCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) return value;
  if (Array.isArray(existing)) return existing.concat(value);
  return [existing, value];
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch (error) {
      out[key] = value;
    }
  }
  return out;
}

function isSecureRequest(req) {
  return Boolean(
    req.secure ||
      String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() ===
        "https",
  );
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return req.method === "GET" && accept.includes("text/html");
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

module.exports = {
  createWebAuth,
  parseCookies,
};
