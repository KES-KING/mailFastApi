"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { resolveSmtpAccount } = require("../../src/mailer");

describe("mailer SMTP account routing", () => {
  test("resolves account explicitly or by matching from address", () => {
    const accounts = [
      {
        name: "2fa",
        identityEmails: ["security@example.com"],
      },
      {
        name: "info",
        identityEmails: ["info@example.com"],
      },
    ];
    const config = {
      accounts,
      byName: new Map(accounts.map((account) => [account.name, account])),
      defaultAccountName: "2fa",
    };

    assert.equal(resolveSmtpAccount(config, "info").name, "info");
    assert.equal(resolveSmtpAccount(config, undefined, "Info Team <info@example.com>").name, "info");
    assert.equal(resolveSmtpAccount(config, undefined, "unknown@example.com").name, "2fa");
  });

  test("rejects unknown explicit SMTP account", () => {
    const accounts = [{ name: "default", identityEmails: ["default@example.com"] }];
    const config = {
      accounts,
      byName: new Map(accounts.map((account) => [account.name, account])),
      defaultAccountName: "default",
    };

    assert.throws(
      () => resolveSmtpAccount(config, "missing"),
      (error) => error && error.code === "UNKNOWN_SMTP_ACCOUNT",
    );
  });

  test("rejects sending when no SMTP accounts are configured", () => {
    const config = {
      accounts: [],
      byName: new Map(),
      defaultAccountName: "",
    };

    assert.throws(
      () => resolveSmtpAccount(config),
      (error) => error && error.code === "NO_SMTP_ACCOUNTS_CONFIGURED",
    );
  });
});
