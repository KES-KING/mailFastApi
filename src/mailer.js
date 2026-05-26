"use strict";

const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

const { createSecureStore } = require("./secureStore");

let secureStore;
const transporters = new Map();

function getTransporter(accountName) {
  const account = getSmtpAccount(accountName);
  const fingerprint = fingerprintAccount(account);
  const cached = transporters.get(account.name);

  if (cached && cached.fingerprint === fingerprint) {
    return cached.transporter;
  }

  if (cached && cached.transporter && typeof cached.transporter.close === "function") {
    cached.transporter.close();
  }

  const transporter = nodemailer.createTransport(buildTransportConfig(account));
  transporters.set(account.name, { fingerprint, transporter });
  return transporter;
}

async function verifyTransporters(log) {
  const accounts = getSmtpAccounts().accounts;
  if (accounts.length === 0) {
    if (typeof log === "function") {
      log("WARN", "smtp accounts not configured");
    }
    return;
  }

  for (const account of accounts) {
    try {
      await getTransporter(account.name).verify();
      if (typeof log === "function") {
        log("INFO", "smtp connection verified", {
          smtpAccount: account.name,
          host: account.host,
          port: account.port,
        });
      }
    } catch (error) {
      if (typeof log === "function") {
        log("WARN", "smtp verify failed", {
          smtpAccount: account.name,
          host: account.host,
          port: account.port,
          message: error && error.message ? error.message : "Unknown SMTP verify error",
        });
      }
    }
  }
}

async function closeTransporters() {
  for (const cached of transporters.values()) {
    if (cached && cached.transporter && typeof cached.transporter.close === "function") {
      cached.transporter.close();
    }
  }
  transporters.clear();
  if (secureStore && typeof secureStore.close === "function") {
    secureStore.close();
  }
  secureStore = undefined;
}

function getSmtpAccounts() {
  const accounts = getSecureStore().listSmtpAccounts().map(toRuntimeAccount);
  const byName = new Map(accounts.map((account) => [account.name, account]));
  const defaultAccountName = getSecureStore().getDefaultSmtpAccountName();

  return {
    accounts,
    byName,
    defaultAccountName,
  };
}

function getSmtpAccount(accountName) {
  const config = getSmtpAccounts();
  const requested = accountName || config.defaultAccountName;
  if (!requested) {
    const error = new Error("No SMTP accounts configured.");
    error.code = "NO_SMTP_ACCOUNTS_CONFIGURED";
    throw error;
  }

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

  if (accountsConfig.accounts.length === 0) {
    const error = new Error("No SMTP accounts configured.");
    error.code = "NO_SMTP_ACCOUNTS_CONFIGURED";
    throw error;
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

  return accountsConfig.byName.get(accountsConfig.defaultAccountName) || accountsConfig.accounts[0];
}

function getSecureStore() {
  if (!secureStore) {
    secureStore = createSecureStore();
  }
  return secureStore;
}

function toRuntimeAccount(account) {
  return {
    ...account,
    identityEmails: uniqueEmails([account.from, account.user]),
  };
}

function buildTransportConfig(account) {
  const config = {
    host: account.host,
    port: account.port,
    secure: account.secure,
    pool: true,
    maxConnections: account.maxConnections,
    maxMessages: account.maxMessages,
    rateLimit: account.rateLimit,
    rateDelta: account.rateDelta,
  };

  if (account.user || account.pass) {
    config.auth = {
      user: account.user || "",
      pass: account.pass || "",
    };
  }

  return config;
}

function fingerprintAccount(account) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(account))
    .digest("hex");
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
};
