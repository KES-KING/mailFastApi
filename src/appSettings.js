"use strict";

const { createSecureStore } = require("./secureStore");

const SETTING_DEFINITIONS = Object.freeze([
  group("Runtime", [
    select("PRODUCTION_MODE", "Production mode", ["false", "true"], "false", "both", "Enables production safety checks."),
    select("MAILFASTAPI_ROLE", "Runtime role", ["all", "api", "worker"], "all", "core", "Separates API and worker processes."),
    integer("PORT", "Core API port", 3000, 1, 65535, "core", "HTTP port for the core service."),
    integer("WORKER_CONCURRENCY", "Worker concurrency", 2, 1, 512, "core", "Parallel worker jobs per process."),
    integer("RETRY_ATTEMPTS", "Retry attempts", 3, 1, 50, "core", "Maximum worker retry attempts."),
    integer("RETRY_DELAY_MS", "Retry base delay ms", 250, 0, 3600000, "core", "Base delay for exponential retry."),
    integer("SHUTDOWN_TIMEOUT_MS", "Shutdown timeout ms", 20000, 1000, 600000, "core", "Graceful shutdown timeout."),
  ]),
  group("Queue", [
    select("QUEUE_BACKEND", "Queue backend", ["memory", "redis"], "redis", "core", "Memory is local/dev only; Redis is required in production."),
    integer("QUEUE_MAX_SIZE", "Memory queue max size", 50000, 1, 10000000, "core", "Maximum local queue size."),
    secret("REDIS_URL", "Redis URL", "redis://127.0.0.1:6379", "core", "Redis connection URL."),
    text("REDIS_QUEUE_KEY", "Redis queue key", "mailfastapi:mail_jobs", "core", "Redis key prefix for mail jobs."),
    integer("REDIS_COMMAND_TIMEOUT_MS", "Redis command timeout ms", 5000, 1000, 600000, "core", "Redis command timeout."),
    integer("QUEUE_VISIBILITY_TIMEOUT_MS", "Visibility timeout ms", 300000, 5000, 86400000, "core", "Lease timeout before requeue."),
    integer("QUEUE_RECLAIM_INTERVAL_MS", "Reclaim interval ms", 30000, 1000, 3600000, "core", "Expired lease reclaimer interval."),
  ]),
  group("API limits", [
    text("REQUEST_BODY_LIMIT", "Request body limit", "10mb", "core", "Express body limit for send requests."),
    integer("MAX_ATTACHMENTS", "Max attachments", 10, 0, 1000, "core", "Maximum attachment count."),
    integer("MAX_ATTACHMENT_TOTAL_BYTES", "Max attachment bytes", 8388608, 0, 1073741824, "core", "Maximum total base64 attachment bytes."),
    integer("RATE_LIMIT_WINDOW_MS", "API rate window ms", 60000, 1000, 3600000, "core", "API rate limit window."),
    integer("RATE_LIMIT_MAX", "API rate max", 120, 1, 1000000, "core", "Requests per rate window."),
    integer("TOKEN_RATE_LIMIT_WINDOW_MS", "Token rate window ms", 60000, 1000, 3600000, "core", "Token endpoint rate limit window."),
    integer("TOKEN_RATE_LIMIT_MAX", "Token rate max", 30, 1, 1000000, "core", "Token requests per rate window."),
  ]),
  group("Authentication", [
    select("AUTH_MODE", "API auth mode", ["jwt", "api_key", "none"], "jwt", "core", "Production forbids none."),
    secret("JWT_SECRET", "JWT secret", "", "core", "HS256 signing secret."),
    text("JWT_ISSUER", "JWT issuer", "mailFastApi", "core", "JWT issuer claim."),
    text("JWT_AUDIENCE", "JWT audience", "mailfastapi-clients", "core", "JWT audience claim."),
    text("JWT_EXPIRES_IN", "JWT expires in", "5m", "core", "jsonwebtoken expiresIn value."),
    text("AUTH_CLIENT_ID", "Default client id", "", "core", "Single JWT client id."),
    secret("AUTH_CLIENT_SECRET", "Default client secret", "", "core", "Single JWT client secret."),
    json("JWT_CLIENTS_JSON", "JWT clients JSON", "", "core", "Array of JWT clients with scopes and roles."),
    secret("API_KEY", "API key", "", "core", "API key used when AUTH_MODE=api_key."),
  ]),
  group("Web panel", [
    text("WEB_HOST", "Web bind host", "", "web", "Optional bind host. Empty means all interfaces."),
    text("WEB_CORE_BASE_URL", "Core base URL", "http://127.0.0.1:3000", "web", "Core API URL used by the web panel."),
    select("WEB_MFA_REQUIRED", "Require web MFA", ["false", "true"], "false", "web", "Development can disable MFA; production guard requires it."),
    select("WEB_SESSION_BIND_IP", "Bind session to IP", ["true", "false"], "true", "web", "Rejects sessions if client IP changes."),
    integer("WEB_SESSION_IDLE_TIMEOUT_MS", "Session idle timeout ms", 28800000, 300000, 604800000, "web", "Idle session timeout."),
    integer("WEB_SESSION_ABSOLUTE_TIMEOUT_MS", "Session absolute timeout ms", 43200000, 300000, 604800000, "web", "Absolute session lifetime."),
    integer("WEB_SHUTDOWN_TIMEOUT_MS", "Web shutdown timeout ms", 12000, 1000, 600000, "web", "Web graceful shutdown timeout."),
  ]),
  group("Monitor", [
    select("MONITOR_ENABLED", "Monitor enabled", ["true", "false"], "true", "core", "Enables monitor endpoints."),
    select("MONITOR_UI_ENABLED", "Core monitor UI enabled", ["false", "true"], "false", "core", "Core service monitor UI. Web panel remains on port 8080."),
    text("MONITOR_PATH", "Core monitor path", "/monitor", "both", "Core monitor base path."),
    text("METRICS_PATH", "Metrics path", "/metrics", "both", "Prometheus metrics path."),
    text("MONITOR_HELP_URL", "Help URL", "https://github.com/KES-KING/mailFastApi", "both", "Help link target."),
    text("MONITOR_HOST", "Monitor bind host", "", "core", "Optional separate monitor bind host."),
    integer("MONITOR_PORT", "Monitor port", 0, 0, 65535, "core", "Separate monitor port. 0 means core API port."),
    integer("MONITOR_SSE_INTERVAL_MS", "SSE interval ms", 1000, 500, 600000, "core", "Monitor stream update interval."),
    secret("MONITOR_TOKEN", "Monitor token", "", "both", "Token used between web and core monitor endpoints."),
    integer("MONITOR_MAX_RECENT_ENTRIES", "Recent entries", 400, 50, 50000, "core", "Monitor recent log buffer."),
    integer("MONITOR_MAX_TIMELINE_MINUTES", "Timeline minutes", 180, 10, 10080, "core", "Monitor timeline retention."),
  ]),
  group("Delivery and suppression", [
    select("SUPPRESSION_ENABLED", "Suppression enabled", ["true", "false"], "true", "core", "Checks suppression before queueing."),
    csv("SUPPRESSION_APPLIES_TO", "Suppression categories", "marketing,bulk", "core", "Comma separated categories."),
    select("IDEMPOTENCY_ENABLED", "Idempotency enabled", ["true", "false"], "true", "core", "Prevents duplicate queue writes."),
    text("IDEMPOTENCY_HEADER", "Idempotency header", "idempotency-key", "core", "Client idempotency header name."),
    integer("IDEMPOTENCY_TTL_MS", "Idempotency TTL ms", 86400000, 60000, 2592000000, "core", "Idempotency record TTL."),
    text("PUBLIC_BASE_URL", "Public base URL", "", "core", "Base URL for unsubscribe links."),
    secret("UNSUBSCRIBE_SECRET", "Unsubscribe secret", "", "core", "HMAC secret for unsubscribe tokens."),
    select("BOUNCE_WEBHOOK_ENABLED", "Bounce webhooks", ["true", "false"], "true", "core", "Enables bounce/complaint webhook ingestion."),
    secret("BOUNCE_WEBHOOK_TOKEN", "Bounce webhook token", "", "core", "Token required by bounce/complaint webhooks."),
    text("BOUNCE_DOMAIN", "Bounce domain", "", "core", "Dedicated Return-Path domain."),
  ]),
  group("Policies and deliverability", [
    select("DELIVERY_POLICY_ENABLED", "Delivery policy enabled", ["true", "false"], "true", "core", "Enables domain/account throttling."),
    json("DOMAIN_POLICIES_JSON", "Domain policies JSON", "", "core", "Provider/domain quota policy overrides."),
    json("SMTP_ACCOUNT_POLICIES_JSON", "SMTP account policies JSON", "", "core", "SMTP account quota policy overrides."),
    csv("DOMAIN_HEALTH_DKIM_SELECTORS", "DKIM selectors", "default,mail", "both", "Default selectors used by domain health checks."),
    select("DKIM_SIGNING_ENABLED", "DKIM signing", ["false", "true"], "false", "core", "Signs outgoing messages when enabled."),
    text("DKIM_DOMAIN", "DKIM domain", "", "core", "Default DKIM domain."),
    text("DKIM_SELECTOR", "DKIM selector", "", "core", "Default DKIM selector."),
    text("DKIM_PRIVATE_KEY_PATH", "DKIM private key path", "", "core", "Filesystem path to private key."),
    secret("DKIM_PRIVATE_KEY", "DKIM private key", "", "core", "Inline private key. Prefer file path or secret mount."),
    json("DKIM_KEYS_JSON", "DKIM keys JSON", "", "core", "Multiple DKIM key definitions."),
  ]),
  group("Logging and updater", [
    text("LOG_DB_PATH", "Log DB path", "data/mailfastapi.sqlite", "core", "System log SQLite path."),
    text("OPERATIONAL_DB_PATH", "Operational DB path", "data/mailfastapi-operational.sqlite", "both", "Operational state SQLite path."),
    text("LOG_DIR", "Log directory", "logs", "core", "JSONL log directory."),
    text("LOG_FILE_NAME", "Log file name", "system.log", "core", "JSONL log file name."),
    integer("LOG_FLUSH_INTERVAL_MS", "Log flush interval ms", 300, 100, 600000, "core", "Logger flush interval."),
    select("WEB_ENABLE_UPDATER", "Web updater enabled", ["true", "false"], "true", "web", "Enables update control screen."),
    text("WEB_UPDATE_SCRIPT", "Update script", "./scripts/updater.js", "web", "Updater script path inside project root."),
    secret("WEB_UPDATE_TOKEN", "Update token", "", "web", "Optional extra update endpoint token."),
    integer("WEB_UPDATE_TIMEOUT_MS", "Update timeout ms", 180000, 5000, 3600000, "web", "Update command timeout."),
    select("UPDATER_RELEASE_MODE", "Updater release mode", ["branch", "tag"], "branch", "web", "Branch or signed-tag update mode."),
    text("UPDATER_ALLOWED_TAG_PATTERN", "Allowed tag pattern", "^v?\\d+\\.\\d+\\.\\d+$", "web", "Regex for allowed release tags."),
    select("UPDATER_REQUIRE_SIGNED_TAG", "Require signed tag", ["false", "true"], "false", "web", "Requires signed annotated tags in tag mode."),
    text("UPDATER_NPM_BIN", "npm binary", "", "web", "Explicit npm path for service accounts."),
    select("UPDATER_RUN_TESTS", "Run tests during update", ["true", "false"], "true", "web", "Runs tests during updater apply."),
  ]),
]);

const FLAT_DEFINITIONS = Object.freeze(SETTING_DEFINITIONS.flatMap((section) => section.settings));
const DEFINITION_BY_KEY = Object.freeze(
  Object.fromEntries(FLAT_DEFINITIONS.map((definition) => [definition.key, definition])),
);

function applyManagedSettingsToEnv(options = {}) {
  const store = options.secureStore;
  let ownedStore = null;

  try {
    const activeStore = store || (ownedStore = createSecureStore());
    const values = activeStore.getAppSettings();
    return applySettingsValuesToEnv(values, options.env || process.env);
  } catch (error) {
    if (options.strict) {
      throw error;
    }
    return { applied: 0, skipped: FLAT_DEFINITIONS.length, error };
  } finally {
    if (ownedStore) {
      ownedStore.close();
    }
  }
}

function applySettingsValuesToEnv(values, env = process.env) {
  const normalized = sanitizeStoredSettings(values);
  let applied = 0;
  for (const [key, value] of Object.entries(normalized)) {
    env[key] = value;
    applied += 1;
  }
  return { applied, skipped: FLAT_DEFINITIONS.length - applied };
}

function buildSettingsModel(env = process.env, persisted = {}) {
  const values = sanitizeStoredSettings(persisted);
  return SETTING_DEFINITIONS.map((section) => ({
    ...section,
    settings: section.settings.map((definition) => buildSettingEntry(definition, env, values)),
  }));
}

function parseSettingsForm(body = {}, currentValues = {}, options = {}) {
  const nextValues = sanitizeStoredSettings(currentValues);
  const env = options.env || process.env;
  const changed = [];
  const cleared = [];
  const errors = [];

  for (const definition of FLAT_DEFINITIONS) {
    const clearKey = `clear_${definition.key}`;
    if (body[clearKey] === "on" || body[clearKey] === "true") {
      if (Object.prototype.hasOwnProperty.call(nextValues, definition.key)) {
        delete nextValues[definition.key];
        cleared.push(definition.key);
      }
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(body, definition.key)) {
      continue;
    }

    const raw = body[definition.key];
    const hadCurrent = Object.prototype.hasOwnProperty.call(nextValues, definition.key);
    if (definition.sensitive && String(raw || "") === "") {
      continue;
    }

    try {
      const normalized = normalizeSettingValue(definition, raw);
      const fallback = getFallbackSettingValue(definition, env);
      if (!hadCurrent && normalized === fallback) {
        continue;
      }
      if (hadCurrent && nextValues[definition.key] === normalized) {
        continue;
      }
      nextValues[definition.key] = normalized;
      changed.push(definition.key);
    } catch (error) {
      errors.push(`${definition.key}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    const error = new Error(errors.join("; "));
    error.code = "INVALID_APP_SETTINGS";
    error.details = errors;
    throw error;
  }

  return { values: nextValues, changed, cleared };
}

function getSettingDefinitions() {
  return SETTING_DEFINITIONS;
}

function sanitizeStoredSettings(values = {}) {
  const output = {};
  if (!values || typeof values !== "object") {
    return output;
  }

  for (const [key, value] of Object.entries(values)) {
    const definition = DEFINITION_BY_KEY[key];
    if (!definition || value === undefined || value === null) {
      continue;
    }
    output[key] = String(value);
  }
  return output;
}

function buildSettingEntry(definition, env, persisted) {
  const hasPersisted = Object.prototype.hasOwnProperty.call(persisted, definition.key);
  const hasEnv = env[definition.key] !== undefined && env[definition.key] !== null;
  const effective = hasPersisted
    ? persisted[definition.key]
    : hasEnv
      ? String(env[definition.key])
      : String(definition.defaultValue ?? "");
  return {
    ...definition,
    effectiveValue: definition.sensitive ? maskSensitiveValue(effective) : effective,
    inputValue: definition.sensitive ? "" : effective,
    persistedValue: hasPersisted ? persisted[definition.key] : "",
    hasPersisted,
    hasEffectiveSecret: definition.sensitive && effective !== "",
    source: hasPersisted ? "secure store" : hasEnv ? ".env/process" : "default",
  };
}

function normalizeSettingValue(definition, raw) {
  const value = String(raw === undefined || raw === null ? "" : raw).trim();

  if (definition.type === "boolean" || definition.type === "select") {
    if (!definition.options.includes(value)) {
      throw new Error(`must be one of: ${definition.options.join(", ")}`);
    }
    return value;
  }

  if (definition.type === "integer") {
    if (!/^-?\d+$/.test(value)) {
      throw new Error("must be an integer");
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed < definition.min || parsed > definition.max) {
      throw new Error(`must be between ${definition.min} and ${definition.max}`);
    }
    return String(parsed);
  }

  if (definition.type === "json") {
    if (value !== "") {
      JSON.parse(value);
    }
    return value;
  }

  if (definition.type === "csv") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(",");
  }

  if (definition.maxLength && value.length > definition.maxLength) {
    throw new Error(`must be at most ${definition.maxLength} characters`);
  }

  return value;
}

function getFallbackSettingValue(definition, env = process.env) {
  if (env[definition.key] !== undefined && env[definition.key] !== null) {
    return String(env[definition.key]);
  }
  return String(definition.defaultValue ?? "");
}

function maskSensitiveValue(value) {
  if (!value) {
    return "not set";
  }
  return "set (hidden)";
}

function group(name, settings) {
  return { name, settings };
}

function text(key, label, defaultValue, restart, description) {
  return baseDefinition({ key, label, type: "text", defaultValue, restart, description });
}

function csv(key, label, defaultValue, restart, description) {
  return baseDefinition({ key, label, type: "csv", defaultValue, restart, description });
}

function json(key, label, defaultValue, restart, description) {
  return baseDefinition({ key, label, type: "json", defaultValue, restart, description });
}

function secret(key, label, defaultValue, restart, description) {
  return baseDefinition({
    key,
    label,
    type: "secret",
    defaultValue,
    restart,
    description,
    sensitive: true,
    maxLength: 20000,
  });
}

function select(key, label, options, defaultValue, restart, description) {
  return baseDefinition({
    key,
    label,
    type: "select",
    options,
    defaultValue,
    restart,
    description,
  });
}

function integer(key, label, defaultValue, min, max, restart, description) {
  return baseDefinition({
    key,
    label,
    type: "integer",
    defaultValue,
    min,
    max,
    restart,
    description,
  });
}

function baseDefinition(definition) {
  return Object.freeze({
    sensitive: false,
    maxLength: 4096,
    ...definition,
  });
}

module.exports = {
  applyManagedSettingsToEnv,
  applySettingsValuesToEnv,
  buildSettingsModel,
  getSettingDefinitions,
  parseSettingsForm,
  sanitizeStoredSettings,
};
