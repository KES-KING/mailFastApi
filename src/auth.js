"use strict";

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

function loadAuthConfig(env) {
  const mode = normalizeAuthMode(env.AUTH_MODE);
  const issuer = env.JWT_ISSUER || "mailFastApi";
  const audience = env.JWT_AUDIENCE || "mailfastapi-clients";
  const expiresIn = env.JWT_EXPIRES_IN || "5m";
  const jwtSecret = env.JWT_SECRET || "";
  const apiKey = env.API_KEY || "";
  const tokenRateLimitWindowMs = Math.max(1000, toInt(env.TOKEN_RATE_LIMIT_WINDOW_MS, 60000));
  const tokenRateLimitMax = Math.max(1, toInt(env.TOKEN_RATE_LIMIT_MAX, 30));

  const clients = parseClients(env);

  if (mode === "jwt") {
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is required when AUTH_MODE=jwt.");
    }
    if (clients.length === 0) {
      throw new Error(
        "At least one client is required for JWT mode. Set AUTH_CLIENT_ID/AUTH_CLIENT_SECRET or JWT_CLIENTS_JSON.",
      );
    }
  }

  if (mode === "api_key" && !apiKey) {
    throw new Error("API_KEY is required when AUTH_MODE=api_key.");
  }

  return {
    mode,
    issuer,
    audience,
    expiresIn,
    jwtSecret,
    clients,
    apiKey,
    tokenRateLimitWindowMs,
    tokenRateLimitMax,
  };
}

function issueAccessToken(config, clientId, scopes) {
  const scopeList = Array.isArray(scopes) && scopes.length > 0 ? scopes : ["mail:send"];

  const token = jwt.sign(
    {
      sub: clientId,
      scope: scopeList.join(" "),
    },
    config.jwtSecret,
    {
      algorithm: "HS256",
      issuer: config.issuer,
      audience: config.audience,
      expiresIn: config.expiresIn,
      jwtid: crypto.randomUUID(),
    },
  );

  const decoded = jwt.decode(token);
  let expiresInSeconds = null;
  if (decoded && typeof decoded === "object" && decoded.exp && decoded.iat) {
    expiresInSeconds = decoded.exp - decoded.iat;
  }

  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresInSeconds,
  };
}

function verifyJwt(config, rawToken, requiredScope) {
  const payload = jwt.verify(rawToken, config.jwtSecret, {
    algorithms: ["HS256"],
    issuer: config.issuer,
    audience: config.audience,
  });

  if (requiredScope) {
    const scopes = normalizeScopes(payload.scope);
    if (!scopes.includes(requiredScope)) {
      const error = new Error("Insufficient scope.");
      error.code = "INSUFFICIENT_SCOPE";
      throw error;
    }
  }

  return payload;
}

function authenticateClient(config, clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    return null;
  }

  for (const client of config.clients) {
    if (!safeEqual(client.clientId, clientId)) {
      continue;
    }

    if (safeEqual(client.clientSecret, clientSecret)) {
      return client;
    }
  }

  return null;
}

function parseClients(env) {
  const clients = [];

  if (env.AUTH_CLIENT_ID && env.AUTH_CLIENT_SECRET) {
    clients.push({
      clientId: env.AUTH_CLIENT_ID,
      clientSecret: env.AUTH_CLIENT_SECRET,
      scopes: ["mail:send"],
    });
  }

  if (env.JWT_CLIENTS_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.JWT_CLIENTS_JSON);
    } catch (error) {
      throw new Error("JWT_CLIENTS_JSON must be valid JSON.");
    }

    if (!Array.isArray(parsed)) {
      throw new Error("JWT_CLIENTS_JSON must be an array.");
    }

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      if (typeof entry.clientId !== "string" || typeof entry.clientSecret !== "string") {
        continue;
      }

      clients.push({
        clientId: entry.clientId,
        clientSecret: entry.clientSecret,
        scopes: Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes : ["mail:send"],
      });
    }
  }

  return clients;
}

function normalizeScopes(scopeClaim) {
  if (Array.isArray(scopeClaim)) {
    return scopeClaim.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(" ")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeAuthMode(value) {
  const mode = String(value || "jwt").trim().toLowerCase();
  if (mode === "jwt" || mode === "api_key" || mode === "none") {
    return mode;
  }
  return "jwt";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  loadAuthConfig,
  issueAccessToken,
  verifyJwt,
  authenticateClient,
};
