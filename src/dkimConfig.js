"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createDkimResolver(env = process.env) {
  const enabled = toBoolean(env.DKIM_SIGNING_ENABLED, false);
  if (!enabled) {
    return {
      enabled: false,
      getDkimOptions: () => null,
      summary: () => ({ enabled: false }),
    };
  }

  const keys = loadKeys(env);
  if (keys.length === 0) {
    const error = new Error(
      "DKIM signing is enabled but no DKIM key is configured. Set DKIM_DOMAIN, DKIM_SELECTOR, and DKIM_PRIVATE_KEY_PATH.",
    );
    error.code = "DKIM_CONFIG_MISSING";
    throw error;
  }

  function getDkimOptions(job = {}) {
    const fromDomain = extractEmailDomain(job.from) || "";
    const key =
      keys.find((entry) => entry.domainName === fromDomain) ||
      keys.find((entry) => entry.domainName === "*") ||
      keys[0];
    return {
      domainName: key.domainName === "*" ? fromDomain : key.domainName,
      keySelector: key.keySelector,
      privateKey: key.privateKey,
    };
  }

  function summary() {
    return {
      enabled: true,
      domains: keys.map((entry) => entry.domainName).sort(),
    };
  }

  return {
    enabled: true,
    getDkimOptions,
    summary,
  };
}

function validateDkimProductionConfig(env = process.env) {
  const enabled = toBoolean(env.DKIM_SIGNING_ENABLED, false);
  const errors = [];
  if (!enabled) {
    errors.push("DKIM_SIGNING_ENABLED=true is required in production.");
    return errors;
  }
  try {
    createDkimResolver(env);
  } catch (error) {
    errors.push(error && error.message ? error.message : "DKIM configuration is invalid.");
  }
  return errors;
}

function loadKeys(env) {
  const jsonKeys = parseJsonArray(env.DKIM_KEYS_JSON);
  const keys = [];
  for (const entry of jsonKeys) {
    const normalized = normalizeKeyEntry(entry);
    if (normalized) {
      keys.push(normalized);
    }
  }

  const defaultEntry = normalizeKeyEntry({
    domainName: env.DKIM_DOMAIN,
    keySelector: env.DKIM_SELECTOR,
    privateKey: env.DKIM_PRIVATE_KEY,
    privateKeyPath: env.DKIM_PRIVATE_KEY_PATH,
  });
  if (defaultEntry) {
    keys.push(defaultEntry);
  }

  return keys;
}

function normalizeKeyEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const domainName = clean(entry.domainName || entry.domain || entry.d);
  const keySelector = clean(entry.keySelector || entry.selector || entry.s);
  const privateKey = readPrivateKey(entry);
  if (!domainName || !keySelector || !privateKey) {
    return null;
  }
  if (domainName !== "*" && !isValidDomain(domainName)) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(keySelector)) {
    return null;
  }
  return {
    domainName: domainName.toLowerCase(),
    keySelector,
    privateKey,
  };
}

function readPrivateKey(entry) {
  const raw = clean(entry.privateKey || entry.key || "");
  if (raw) {
    return raw.replace(/\\n/g, "\n");
  }
  const keyPath = clean(entry.privateKeyPath || entry.keyPath || "");
  if (!keyPath) {
    return "";
  }
  const resolved = path.resolve(keyPath);
  return fs.readFileSync(resolved, "utf8");
}

function extractEmailDomain(value) {
  const text = clean(value).toLowerCase();
  const match = text.match(/@([^>\s]+)>?$/);
  return match ? match[1].replace(/\.$/, "") : "";
}

function parseJsonArray(value) {
  const raw = clean(value);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function isValidDomain(value) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
    clean(value),
  );
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clean(value) {
  return String(value || "").trim();
}

module.exports = {
  createDkimResolver,
  validateDkimProductionConfig,
};
