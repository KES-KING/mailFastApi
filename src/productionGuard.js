"use strict";

const DEFAULT_SECURE_STORE_KEY = "change_me_with_at_least_32_random_characters";

function validateProductionSafety(env = process.env) {
  const enabled = toBoolean(env.PRODUCTION_MODE, false);
  const errors = [];
  const warnings = [];

  if (!enabled) {
    return { ok: true, enabled, errors, warnings };
  }

  const authMode = clean(env.AUTH_MODE || "jwt").toLowerCase();
  const queueBackend = clean(env.QUEUE_BACKEND || "redis").toLowerCase();
  const serviceRole = clean(env.MAILFASTAPI_ROLE || "all").toLowerCase();
  const webUpdaterEnabled = toBoolean(env.WEB_ENABLE_UPDATER, true);

  if (authMode === "none") {
    errors.push("AUTH_MODE=none is forbidden in production.");
  }
  if (queueBackend === "memory") {
    errors.push("QUEUE_BACKEND=memory is forbidden in production.");
  }
  if (serviceRole === "all") {
    errors.push("MAILFASTAPI_ROLE=all is forbidden in production; run api and worker separately.");
  }
  if (toBoolean(env.MONITOR_ENABLED, true) && !clean(env.MONITOR_TOKEN)) {
    errors.push("MONITOR_TOKEN is required when MONITOR_ENABLED=true in production.");
  }
  if (webUpdaterEnabled) {
    if (clean(env.UPDATER_RELEASE_MODE || "branch").toLowerCase() !== "tag") {
      errors.push("UPDATER_RELEASE_MODE=tag is required for production web updater.");
    }
    if (!toBoolean(env.UPDATER_REQUIRE_SIGNED_TAG, false)) {
      errors.push("UPDATER_REQUIRE_SIGNED_TAG=true is required for production web updater.");
    }
  }

  requireSecret(errors, "SECURE_STORE_KEY", env.SECURE_STORE_KEY, [DEFAULT_SECURE_STORE_KEY]);
  if (authMode === "jwt") {
    requireSecret(errors, "JWT_SECRET", env.JWT_SECRET);
    if (!clean(env.AUTH_CLIENT_SECRET) && !clean(env.JWT_CLIENTS_JSON)) {
      errors.push("AUTH_CLIENT_SECRET or JWT_CLIENTS_JSON is required in production JWT mode.");
    }
  }
  if (authMode === "api_key") {
    requireSecret(errors, "API_KEY", env.API_KEY);
  }
  if (toBoolean(env.SUPPRESSION_ENABLED, true) && !clean(env.OPERATIONAL_DB_PATH)) {
    warnings.push("OPERATIONAL_DB_PATH is not set; using local SQLite operational store.");
  }

  return {
    ok: errors.length === 0,
    enabled,
    errors,
    warnings,
  };
}

function assertProductionSafety(env = process.env) {
  const result = validateProductionSafety(env);
  if (!result.ok) {
    const error = new Error(`Production safety check failed: ${result.errors.join(" ")}`);
    error.code = "PRODUCTION_SAFETY_CHECK_FAILED";
    error.details = result;
    throw error;
  }
  return result;
}

function requireSecret(errors, name, value, forbidden = []) {
  const secret = clean(value);
  if (secret.length < 32) {
    errors.push(`${name} must be at least 32 characters in production.`);
    return;
  }
  if (secret.startsWith("change_me") || forbidden.includes(secret)) {
    errors.push(`${name} must be changed from the example value.`);
  }
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
  assertProductionSafety,
  validateProductionSafety,
};
