"use strict";

const nodemailer = require("nodemailer");

const DEFAULT_ACCOUNT_NAME = "default";

let accountsCache;
const transporters = new Map();

function getTransporter(accountName) {
  const account = getSmtpAccount(accountName);
  let transporter = transporters.get(account.name);

  if (!transporter) {
    transporter = nodemailer.createTransport(account.transport);
    transporters.set(account.name, transporter);
  }

  return transporter;
}

async function verifyTransporters(log) {
  const { accounts } = getSmtpAccounts();

  for (const account of accounts) {
    try {
      await getTransporter(account.name).verify();
      if (typeof log === "function") {
        log("INFO", "smtp connection verified", {
          smtpAccount: account.name,
          host: account.transport.host,
          port: account.transport.port,
        });
      }
    } catch (error) {
      if (typeof log === "function") {
        log("WARN", "smtp verify failed", {
          smtpAccount: account.name,
          host: account.transport.host,
          port: account.transport.port,
          message: error && error.message ? error.message : "Unknown SMTP verify error",
        });
      }
    }
  }
}

async function closeTransporters() {
  for (const transporter of transporters.values()) {
    if (transporter && typeof transporter.close === "function") {
      transporter.close();
    }
  }
  transporters.clear();
}

function getSmtpAccounts() {
  if (!accountsCache) {
    accountsCache = loadSmtpAccounts(process.env);
  }

  return accountsCache;
}

function getSmtpAccount(accountName) {
  const config = getSmtpAccounts();
  const requested = accountName || config.defaultAccountName;
  const name = normalizeSmtpAccountName(requested);
  const account = config.byName.get(name);

  if (!account) {
    const error = new Error(`Unknown SMTP account: ${String(requested)}`);
    error.code = "UNKNOWN_SMTP_ACCOUNT";
    error.smtpAccount = requested;
    throw error;
  }

  return account;
}

function getSmtpAccountNames() {
  return getSmtpAccounts().accounts.map((account) => account.name);
}

function getSmtpAccountSummaries() {
  return getSmtpAccounts().accounts.map((account) => ({
    name: account.name,
    from: account.from,
    identityEmails: account.identityEmails.slice(),
  }));
}

function getDefaultSmtpAccountName() {
  return getSmtpAccounts().defaultAccountName;
}

function getDefaultFromForAccount(accountName) {
  return getSmtpAccount(accountName).from;
}

function resolveSmtpAccountName(requestedAccount, from) {
  return resolveSmtpAccount(getSmtpAccounts(), requestedAccount, from).name;
}

function resolveSmtpAccount(accountsConfig, requestedAccount, from) {
  if (!accountsConfig || !(accountsConfig.byName instanceof Map)) {
    throw new Error("A valid SMTP account config is required.");
  }

  if (
    requestedAccount !== undefined &&
    requestedAccount !== null &&
    String(requestedAccount).trim()
  ) {
    const name = normalizeSmtpAccountName(requestedAccount);
    const account = accountsConfig.byName.get(name);
    if (!account) {
      const error = new Error(`Unknown SMTP account: ${String(requestedAccount)}`);
      error.code = "UNKNOWN_SMTP_ACCOUNT";
      error.smtpAccount = requestedAccount;
      throw error;
    }
    return account;
  }

  const fromEmail = extractEmailAddress(from);
  if (fromEmail) {
    const matches = accountsConfig.accounts.filter((account) =>
      account.identityEmails.includes(fromEmail),
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return accountsConfig.byName.get(accountsConfig.defaultAccountName);
}

function loadSmtpAccounts(env) {
  const explicitAccountNames = parseAccountNames(env.SMTP_ACCOUNTS);
  const defaultAccountName = normalizeSmtpAccountName(
    env.SMTP_DEFAULT_ACCOUNT || explicitAccountNames[0] || DEFAULT_ACCOUNT_NAME,
  );

  if (explicitAccountNames.length > 0 && !explicitAccountNames.includes(defaultAccountName)) {
    throw new Error(
      `SMTP_DEFAULT_ACCOUNT must be listed in SMTP_ACCOUNTS (${defaultAccountName}).`,
    );
  }

  const accountNames = explicitAccountNames.length > 0 ? explicitAccountNames : [defaultAccountName];
  const accounts = accountNames.map((name) =>
    buildSmtpAccountConfig(env, name, {
      explicitAccounts: explicitAccountNames.length > 0,
    }),
  );
  const byName = new Map(accounts.map((account) => [account.name, account]));

  return {
    accounts,
    byName,
    defaultAccountName,
  };
}

function parseAccountNames(value) {
  if (!value || !String(value).trim()) {
    return [];
  }

  const names = [];
  const seen = new Set();

  for (const item of String(value).split(",")) {
    if (!String(item).trim()) {
      continue;
    }
    const name = normalizeSmtpAccountName(item);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }

  return names;
}

function buildSmtpAccountConfig(env, name, options = {}) {
  const explicitAccounts = Boolean(options.explicitAccounts);
  const envPrefix = `SMTP_${toEnvToken(name)}_`;
  const allowLegacyAuthFallback = !explicitAccounts || name === DEFAULT_ACCOUNT_NAME;
  const secure = toBoolean(readEnv(env, `${envPrefix}SECURE`, env.SMTP_SECURE), false);
  const port = toInt(readEnv(env, `${envPrefix}PORT`, env.SMTP_PORT), secure ? 465 : 587);
  const user = readEnv(
    env,
    `${envPrefix}USER`,
    allowLegacyAuthFallback ? env.SMTP_USER : undefined,
  );
  const pass = readEnv(
    env,
    `${envPrefix}PASS`,
    allowLegacyAuthFallback ? env.SMTP_PASS : undefined,
  );
  const from =
    readEnv(env, `${envPrefix}FROM`, allowLegacyAuthFallback ? env.MAIL_FROM : undefined) ||
    user ||
    (allowLegacyAuthFallback ? env.SMTP_USER : "") ||
    "no-reply@mailfastapi.local";

  const transport = {
    host: readEnv(env, `${envPrefix}HOST`, env.SMTP_HOST) || "localhost",
    port,
    secure,
    pool: true,
    maxConnections: toInt(
      readEnv(env, `${envPrefix}MAX_CONNECTIONS`, env.SMTP_MAX_CONNECTIONS),
      5,
    ),
    maxMessages: toInt(readEnv(env, `${envPrefix}MAX_MESSAGES`, env.SMTP_MAX_MESSAGES), 100),
    rateLimit: toInt(readEnv(env, `${envPrefix}RATE_LIMIT`, env.SMTP_RATE_LIMIT), 10),
    rateDelta: toInt(readEnv(env, `${envPrefix}RATE_DELTA`, env.SMTP_RATE_DELTA), 1000),
  };

  if (user || pass) {
    transport.auth = {
      user: user || "",
      pass: pass || "",
    };
  }

  return {
    name,
    from,
    identityEmails: uniqueEmails([from, user]),
    transport,
  };
}

function readEnv(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback === undefined || fallback === null ? "" : String(fallback).trim();
  }
  return String(value).trim();
}

function normalizeSmtpAccountName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) {
    throw new Error("SMTP account name cannot be empty.");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("SMTP account names may contain only letters, numbers, underscores and dashes.");
  }
  return name;
}

function toEnvToken(value) {
  return normalizeSmtpAccountName(value).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function uniqueEmails(values) {
  const emails = [];
  const seen = new Set();

  for (const value of values) {
    const email = extractEmailAddress(value);
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    emails.push(email);
  }

  return emails;
}

function extractEmailAddress(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const text = value.trim();
  const angleMatch = text.match(/<([^<>]+)>/);
  const candidate = angleMatch ? angleMatch[1].trim() : text;
  if (isValidEmail(candidate)) {
    return candidate.toLowerCase();
  }

  const emailMatch = text.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  if (!emailMatch) {
    return "";
  }

  const email = emailMatch[0].trim();
  return isValidEmail(email) ? email.toLowerCase() : "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

module.exports = {
  getTransporter,
  verifyTransporter: verifyTransporters,
  verifyTransporters,
  closeTransporter: closeTransporters,
  closeTransporters,
  getSmtpAccountNames,
  getSmtpAccountSummaries,
  getDefaultSmtpAccountName,
  getDefaultFromForAccount,
  resolveSmtpAccountName,
  resolveSmtpAccount,
  loadSmtpAccounts,
};
