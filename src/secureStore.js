"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { buildOtpAuthUrl, generateTotpSecret, verifyTotp } = require("./totp");

const DEFAULT_STORE_PATH = "data/mailfastapi-secure.sqlite";
const SECRET_ENV_NAME = "SECURE_STORE_KEY";
const DEFAULT_INSECURE_SECRET = "change_me_with_at_least_32_random_characters";
const SMTP_NAMESPACE = "smtp_account";
const SETTINGS_NAMESPACE = "settings";
const ADMIN_NAMESPACE = "web_admin";
const DEFAULT_ACCOUNT_SETTING = "smtp_default_account";
const ADMIN_PASSWORD_SETTING = "password";
const ADMIN_TOTP_SETTING = "totp";
const ADMIN_TOTP_PENDING_SETTING = "totp_pending";
const APP_SETTINGS_SETTING = "app_settings";
const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;
const MAX_ACCOUNT_NAME_LENGTH = 64;
const RECOVERY_CODE_COUNT = 8;
const SCRYPT_OPTIONS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

function createSecureStore(options = {}) {
  const dbPath = path.resolve(
    options.dbPath || process.env.SECURE_STORE_DB_PATH || DEFAULT_STORE_PATH,
  );
  const secretKey = validateSecretKey(resolveSecretKey(options));

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS secure_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secure_items (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    );

    CREATE INDEX IF NOT EXISTS idx_secure_items_namespace ON secure_items(namespace);
  `);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch (error) {
    // Best effort; Windows ACLs and some filesystems do not support POSIX modes.
  }

  const metaGetStmt = db.prepare("SELECT value FROM secure_meta WHERE key = ?");
  const metaSetStmt = db.prepare(
    "INSERT OR REPLACE INTO secure_meta (key, value) VALUES (?, ?)",
  );
  const itemGetStmt = db.prepare(
    "SELECT namespace, key, iv, tag, ciphertext FROM secure_items WHERE namespace = ? AND key = ?",
  );
  const itemListStmt = db.prepare(
    "SELECT namespace, key, iv, tag, ciphertext FROM secure_items WHERE namespace = ? ORDER BY key ASC",
  );
  const itemUpsertStmt = db.prepare(`
    INSERT OR REPLACE INTO secure_items (
      namespace, key, iv, tag, ciphertext, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const itemDeleteStmt = db.prepare(
    "DELETE FROM secure_items WHERE namespace = ? AND key = ?",
  );

  const masterKey = deriveMasterKey(secretKey, getOrCreateDbSalt());

  function getOrCreateDbSalt() {
    const existing = metaGetStmt.get("db_salt");
    if (existing && existing.value) {
      return Buffer.from(existing.value, "base64");
    }

    const salt = crypto.randomBytes(32);
    metaSetStmt.run("db_salt", salt.toString("base64"));
    return salt;
  }

  function listSmtpAccounts() {
    return listEncrypted(SMTP_NAMESPACE).map((account) => normalizeSmtpAccount(account));
  }

  function getSmtpAccount(name) {
    if (!name) {
      return null;
    }
    const account = readEncrypted(SMTP_NAMESPACE, normalizeAccountName(name));
    return account ? normalizeSmtpAccount(account) : null;
  }

  function upsertSmtpAccount(account) {
    const name = normalizeAccountName(account && account.name);
    const existing = getSmtpAccount(name);
    const normalized = normalizeSmtpAccount(account, existing);
    writeEncrypted(SMTP_NAMESPACE, normalized.name, normalized);

    if (!getDefaultSmtpAccountName()) {
      setDefaultSmtpAccountName(normalized.name);
    }

    return redactSmtpAccount(normalized);
  }

  function deleteSmtpAccount(name) {
    const accountName = normalizeAccountName(name);
    itemDeleteStmt.run(SMTP_NAMESPACE, accountName);

    if (getDefaultSmtpAccountName() === accountName) {
      const remaining = listSmtpAccounts();
      if (remaining.length > 0) {
        setDefaultSmtpAccountName(remaining[0].name);
      } else {
        writeEncrypted(SETTINGS_NAMESPACE, DEFAULT_ACCOUNT_SETTING, { name: "" });
      }
    }
  }

  function getDefaultSmtpAccountName() {
    const value = readEncrypted(SETTINGS_NAMESPACE, DEFAULT_ACCOUNT_SETTING);
    if (value && typeof value.name === "string" && value.name.trim()) {
      return normalizeAccountName(value.name);
    }

    const accounts = listSmtpAccounts();
    return accounts.length > 0 ? accounts[0].name : "";
  }

  function setDefaultSmtpAccountName(name) {
    const accountName = normalizeAccountName(name);
    if (!getSmtpAccount(accountName)) {
      const error = new Error(`Unknown SMTP account: ${accountName}`);
      error.code = "UNKNOWN_SMTP_ACCOUNT";
      throw error;
    }
    writeEncrypted(SETTINGS_NAMESPACE, DEFAULT_ACCOUNT_SETTING, { name: accountName });
  }

  function listPublicSmtpAccounts() {
    const defaultName = getDefaultSmtpAccountName();
    return listSmtpAccounts().map((account) => ({
      ...redactSmtpAccount(account),
      isDefault: account.name === defaultName,
    }));
  }

  function getAppSettings() {
    const record = readEncrypted(SETTINGS_NAMESPACE, APP_SETTINGS_SETTING);
    if (!record || !record.values || typeof record.values !== "object") {
      return {};
    }
    return { ...record.values };
  }

  function setAppSettings(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Application settings must be an object.");
    }

    const normalized = {};
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(key)) {
        const error = new Error(`Invalid application setting key: ${key}`);
        error.code = "INVALID_APP_SETTING_KEY";
        throw error;
      }
      normalized[key] = String(value === undefined || value === null ? "" : value);
    }

    writeEncrypted(SETTINGS_NAMESPACE, APP_SETTINGS_SETTING, {
      version: 1,
      updatedAtMs: Date.now(),
      values: normalized,
    });

    return { ...normalized };
  }

  function hasAdminPassword() {
    return Boolean(readEncrypted(ADMIN_NAMESPACE, ADMIN_PASSWORD_SETTING));
  }

  function setAdminPassword(password) {
    validatePassword(password);
    const salt = crypto.randomBytes(32);
    const hash = hashPassword(password, salt);
    writeEncrypted(ADMIN_NAMESPACE, ADMIN_PASSWORD_SETTING, {
      version: 1,
      algorithm: "scrypt",
      params: {
        N: SCRYPT_OPTIONS.N,
        r: SCRYPT_OPTIONS.r,
        p: SCRYPT_OPTIONS.p,
      },
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      updatedAtMs: Date.now(),
    });
  }

  function verifyAdminPassword(password) {
    if (typeof password !== "string" || password.length === 0) {
      return false;
    }

    const record = readEncrypted(ADMIN_NAMESPACE, ADMIN_PASSWORD_SETTING);
    if (!record || record.algorithm !== "scrypt" || !record.salt || !record.hash) {
      return false;
    }

    const expected = Buffer.from(record.hash, "base64");
    const actual = hashPassword(password, Buffer.from(record.salt, "base64"));
    if (actual.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(actual, expected);
  }

  function hasAdminTotp() {
    const record = readEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_SETTING);
    return Boolean(record && record.enabled === true && record.secret);
  }

  function getAdminMfaStatus() {
    return {
      totpEnabled: hasAdminTotp(),
      totpPending: Boolean(readEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_PENDING_SETTING)),
    };
  }

  function beginAdminTotpEnrollment(options = {}) {
    const issuer = cleanString(options.issuer || "MailFastApi");
    const accountName = cleanString(options.accountName || "admin@mailfastapi.local");
    const record = {
      version: 1,
      type: "totp",
      issuer,
      accountName,
      secret: generateTotpSecret(),
      createdAtMs: Date.now(),
    };
    writeEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_PENDING_SETTING, record);
    return publicTotpEnrollment(record);
  }

  function getPendingAdminTotpEnrollment() {
    const record = readEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_PENDING_SETTING);
    return record ? publicTotpEnrollment(record) : null;
  }

  function confirmAdminTotpEnrollment(code) {
    const pending = readEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_PENDING_SETTING);
    if (!pending || !pending.secret) {
      const error = new Error("TOTP enrollment has not been started.");
      error.code = "MFA_ENROLLMENT_REQUIRED";
      throw error;
    }
    if (!verifyTotp(code, pending.secret)) {
      const error = new Error("Invalid MFA verification code.");
      error.code = "INVALID_MFA_CODE";
      throw error;
    }

    const recoveryCodes = generateRecoveryCodes();
    writeEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_SETTING, {
      version: 1,
      type: "totp",
      enabled: true,
      issuer: pending.issuer,
      accountName: pending.accountName,
      secret: pending.secret,
      recoveryCodes: recoveryCodes.map(hashRecoveryCode),
      createdAtMs: pending.createdAtMs,
      enabledAtMs: Date.now(),
    });
    itemDeleteStmt.run(ADMIN_NAMESPACE, ADMIN_TOTP_PENDING_SETTING);
    return { enabled: true, recoveryCodes };
  }

  function verifyAdminMfaCode(code) {
    const record = readEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_SETTING);
    if (!record || record.enabled !== true || !record.secret) {
      return false;
    }
    if (verifyTotp(code, record.secret)) {
      return true;
    }
    return consumeRecoveryCode(record, code);
  }

  function close() {
    db.close();
  }

  function getDbPath() {
    return dbPath;
  }

  function readEncrypted(namespace, key) {
    const row = itemGetStmt.get(namespace, key);
    return row ? decryptRow(row) : null;
  }

  function listEncrypted(namespace) {
    return itemListStmt.all(namespace).map(decryptRow);
  }

  function writeEncrypted(namespace, key, value) {
    const encrypted = encryptValue(namespace, key, value);
    itemUpsertStmt.run(
      namespace,
      key,
      encrypted.iv,
      encrypted.tag,
      encrypted.ciphertext,
      Date.now(),
    );
  }

  function encryptValue(namespace, key, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
    cipher.setAAD(Buffer.from(`${namespace}:${key}`, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  function decryptRow(row) {
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        masterKey,
        Buffer.from(row.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(`${row.namespace}:${row.key}`, "utf8"));
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch (error) {
      const wrapped = new Error(
        "Secure store decryption failed. Check SECURE_STORE_KEY and database integrity.",
      );
      wrapped.code = "SECURE_STORE_DECRYPT_FAILED";
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS);
  }

  function publicTotpEnrollment(record) {
    return {
      issuer: record.issuer,
      accountName: record.accountName,
      secret: record.secret,
      otpauthUrl: buildOtpAuthUrl({
        issuer: record.issuer,
        accountName: record.accountName,
        secret: record.secret,
      }),
    };
  }

  function consumeRecoveryCode(record, code) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized || !Array.isArray(record.recoveryCodes)) {
      return false;
    }

    const matchIndex = record.recoveryCodes.findIndex((entry) =>
      verifyRecoveryCodeHash(normalized, entry),
    );
    if (matchIndex < 0) {
      return false;
    }

    const nextRecoveryCodes = record.recoveryCodes.filter((_, index) => index !== matchIndex);
    writeEncrypted(ADMIN_NAMESPACE, ADMIN_TOTP_SETTING, {
      ...record,
      recoveryCodes: nextRecoveryCodes,
      lastRecoveryCodeUsedAtMs: Date.now(),
    });
    return true;
  }

  return {
    listSmtpAccounts,
    getSmtpAccount,
    upsertSmtpAccount,
    deleteSmtpAccount,
    getDefaultSmtpAccountName,
    setDefaultSmtpAccountName,
    listPublicSmtpAccounts,
    getAppSettings,
    setAppSettings,
    hasAdminPassword,
    setAdminPassword,
    verifyAdminPassword,
    hasAdminTotp,
    getAdminMfaStatus,
    beginAdminTotpEnrollment,
    getPendingAdminTotpEnrollment,
    confirmAdminTotpEnrollment,
    verifyAdminMfaCode,
    close,
    getDbPath,
  };
}

function validateSecretKey(value) {
  const secret = String(value || "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${SECRET_ENV_NAME} must be set to at least ${MIN_SECRET_LENGTH} characters.`,
    );
  }
  if (secret === DEFAULT_INSECURE_SECRET) {
    throw new Error(`${SECRET_ENV_NAME} must be changed from the example value.`);
  }
  return secret;
}

function resolveSecretKey(options = {}) {
  if (options.secretKey) {
    return options.secretKey;
  }
  const filePath = String(process.env.SECURE_STORE_KEY_FILE || "").trim();
  if (filePath) {
    return fs.readFileSync(path.resolve(filePath), "utf8").trim();
  }
  return process.env[SECRET_ENV_NAME];
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    const error = new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    error.code = "WEAK_PASSWORD";
    throw error;
  }
}

function deriveMasterKey(secretKey, salt) {
  return crypto.scryptSync(secretKey, salt, 32, SCRYPT_OPTIONS);
}

function normalizeSmtpAccount(account, existing) {
  if (!account || typeof account !== "object") {
    throw new Error("SMTP account must be an object.");
  }

  const name = normalizeAccountName(account.name || (existing && existing.name));
  const secure = toBoolean(account.secure, existing ? existing.secure : false);
  const port = toPort(account.port, existing ? existing.port : secure ? 465 : 587);
  const host = cleanString(account.host || (existing && existing.host));
  const user = cleanString(account.user !== undefined ? account.user : existing && existing.user);
  const pass = cleanString(account.pass !== undefined ? account.pass : existing && existing.pass);
  const from = cleanString(
    account.from || (existing && existing.from) || user || "no-reply@mailfastapi.local",
  );

  if (!host) {
    const error = new Error("SMTP host is required.");
    error.code = "INVALID_SMTP_ACCOUNT";
    throw error;
  }

  if (!isValidFromAddress(from)) {
    const error = new Error("SMTP from address must contain a valid email address.");
    error.code = "INVALID_SMTP_ACCOUNT";
    throw error;
  }

  return {
    name,
    host,
    port,
    secure,
    user,
    pass,
    from,
    maxConnections: toPositiveInt(account.maxConnections, existing && existing.maxConnections, 5),
    maxMessages: toPositiveInt(account.maxMessages, existing && existing.maxMessages, 100),
    rateLimit: toPositiveInt(account.rateLimit, existing && existing.rateLimit, 10),
    rateDelta: toPositiveInt(account.rateDelta, existing && existing.rateDelta, 1000),
  };
}

function redactSmtpAccount(account) {
  return {
    name: account.name,
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    from: account.from,
    maxConnections: account.maxConnections,
    maxMessages: account.maxMessages,
    rateLimit: account.rateLimit,
    rateDelta: account.rateDelta,
    hasPassword: Boolean(account.pass),
  };
}

function normalizeAccountName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) {
    throw new Error("SMTP account name is required.");
  }
  if (name.length > MAX_ACCOUNT_NAME_LENGTH) {
    throw new Error(`SMTP account names may be at most ${MAX_ACCOUNT_NAME_LENGTH} characters.`);
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _@.+-]*$/u.test(name)) {
    throw new Error(
      "SMTP account names may contain only letters, numbers, spaces, underscores, dashes, dots, plus signs and @.",
    );
  }
  return name;
}

function cleanString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return Boolean(fallback);
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return Boolean(fallback);
}

function toPort(value, fallback) {
  const parsed = Number.parseInt(String(value === undefined ? fallback : value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    const error = new Error("SMTP port must be between 1 and 65535.");
    error.code = "INVALID_SMTP_ACCOUNT";
    throw error;
  }
  return parsed;
}

function toPositiveInt(value, existing, fallback) {
  const source = value === undefined || value === null || value === "" ? existing : value;
  const parsed = Number.parseInt(String(source === undefined ? fallback : source), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isValidFromAddress(value) {
  return Boolean(extractEmailAddress(value));
}

function extractEmailAddress(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  const text = value.trim();
  const angleMatch = text.match(/<([^<>]+)>/);
  const candidate = angleMatch ? angleMatch[1].trim() : text;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
    return candidate.toLowerCase();
  }
  const emailMatch = text.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return emailMatch ? emailMatch[0].toLowerCase() : "";
}

function generateRecoveryCodes() {
  const codes = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const raw = crypto.randomBytes(8).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`);
  }
  return codes;
}

function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  const salt = crypto.randomBytes(16);
  return {
    salt: salt.toString("base64"),
    hash: crypto.createHash("sha256").update(salt).update(normalized).digest("base64"),
  };
}

function verifyRecoveryCodeHash(normalizedCode, entry) {
  if (!entry || !entry.salt || !entry.hash) {
    return false;
  }
  const salt = Buffer.from(entry.salt, "base64");
  const expected = Buffer.from(entry.hash, "base64");
  const actual = crypto.createHash("sha256").update(salt).update(normalizedCode).digest();
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function normalizeRecoveryCode(value) {
  return String(value || "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
}

module.exports = {
  createSecureStore,
  normalizeSmtpAccount,
  redactSmtpAccount,
  validatePassword,
  SECRET_ENV_NAME,
  DEFAULT_INSECURE_SECRET,
};
