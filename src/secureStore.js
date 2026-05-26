"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_STORE_PATH = "data/mailfastapi-secure.sqlite";
const SECRET_ENV_NAME = "SECURE_STORE_KEY";
const DEFAULT_INSECURE_SECRET = "change_me_with_at_least_32_random_characters";
const SMTP_NAMESPACE = "smtp_account";
const SETTINGS_NAMESPACE = "settings";
const ADMIN_NAMESPACE = "web_admin";
const DEFAULT_ACCOUNT_SETTING = "smtp_default_account";
const ADMIN_PASSWORD_SETTING = "password";
const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;
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
  const secretKey = validateSecretKey(options.secretKey || process.env[SECRET_ENV_NAME]);

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

  return {
    listSmtpAccounts,
    getSmtpAccount,
    upsertSmtpAccount,
    deleteSmtpAccount,
    getDefaultSmtpAccountName,
    setDefaultSmtpAccountName,
    listPublicSmtpAccounts,
    hasAdminPassword,
    setAdminPassword,
    verifyAdminPassword,
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
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("SMTP account names may contain only letters, numbers, underscores and dashes.");
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

module.exports = {
  createSecureStore,
  normalizeSmtpAccount,
  redactSmtpAccount,
  validatePassword,
  SECRET_ENV_NAME,
  DEFAULT_INSECURE_SECRET,
};
