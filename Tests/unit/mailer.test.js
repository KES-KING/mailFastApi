"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { loadSmtpAccounts, resolveSmtpAccount } = require("../../src/mailer");

describe("mailer SMTP account config", () => {
  test("loads legacy single-account SMTP settings as the default account", () => {
    const config = loadSmtpAccounts({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "default@example.com",
      SMTP_PASS: "default-secret",
      SMTP_SECURE: "false",
      MAIL_FROM: "Default <default@example.com>",
    });

    assert.equal(config.defaultAccountName, "default");
    assert.equal(config.accounts.length, 1);
    assert.equal(config.accounts[0].name, "default");
    assert.equal(config.accounts[0].from, "Default <default@example.com>");
    assert.equal(config.accounts[0].transport.host, "smtp.example.com");
    assert.equal(config.accounts[0].transport.port, 587);
    assert.deepEqual(config.accounts[0].transport.auth, {
      user: "default@example.com",
      pass: "default-secret",
    });
  });

  test("loads multiple SMTP accounts with shared host settings and per-account auth", () => {
    const config = loadSmtpAccounts({
      SMTP_ACCOUNTS: "2fa,info",
      SMTP_DEFAULT_ACCOUNT: "2fa",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_2FA_USER: "security@example.com",
      SMTP_2FA_PASS: "security-secret",
      SMTP_2FA_FROM: "Security <security@example.com>",
      SMTP_INFO_USER: "info@example.com",
      SMTP_INFO_PASS: "info-secret",
      SMTP_INFO_FROM: "Info <info@example.com>",
    });

    const twoFactor = config.byName.get("2fa");
    const info = config.byName.get("info");

    assert.equal(config.defaultAccountName, "2fa");
    assert.equal(twoFactor.transport.host, "smtp.example.com");
    assert.equal(twoFactor.transport.secure, true);
    assert.deepEqual(twoFactor.transport.auth, {
      user: "security@example.com",
      pass: "security-secret",
    });
    assert.equal(info.from, "Info <info@example.com>");
    assert.deepEqual(info.transport.auth, {
      user: "info@example.com",
      pass: "info-secret",
    });
  });

  test("resolves account explicitly or by matching from address", () => {
    const config = loadSmtpAccounts({
      SMTP_ACCOUNTS: "2fa,info",
      SMTP_HOST: "smtp.example.com",
      SMTP_2FA_USER: "security@example.com",
      SMTP_2FA_FROM: "Security <security@example.com>",
      SMTP_INFO_USER: "info@example.com",
      SMTP_INFO_FROM: "Info <info@example.com>",
    });

    assert.equal(resolveSmtpAccount(config, "info").name, "info");
    assert.equal(resolveSmtpAccount(config, undefined, "Info Team <info@example.com>").name, "info");
    assert.equal(resolveSmtpAccount(config, undefined, "unknown@example.com").name, "2fa");
  });

  test("rejects unknown explicit SMTP account", () => {
    const config = loadSmtpAccounts({
      SMTP_ACCOUNTS: "default",
      SMTP_HOST: "smtp.example.com",
    });

    assert.throws(
      () => resolveSmtpAccount(config, "missing"),
      (error) => error && error.code === "UNKNOWN_SMTP_ACCOUNT",
    );
  });
});
