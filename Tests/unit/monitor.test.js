"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { createMonitor, renderMonitorPageHtml } = require("../../src/monitor");

describe("monitor SMTP account summaries", () => {
  test("tracks configured and active SMTP account counters", () => {
    const monitor = createMonitor();

    monitor.ingestLogEntry({
      timestamp: "2026-05-26T12:00:00.000Z",
      createdAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      level: "INFO",
      event: "request received",
      source: "api",
      details: {
        path: "/send",
        smtpAccount: "2fa",
        from: "Security <security@example.com>",
        to: "user@example.com",
      },
    });
    monitor.ingestLogEntry({
      timestamp: "2026-05-26T12:00:01.000Z",
      createdAtMs: Date.parse("2026-05-26T12:00:01.000Z"),
      level: "INFO",
      event: "mail queued",
      source: "api",
      details: {
        smtpAccount: "2fa",
        from: "Security <security@example.com>",
        to: "user@example.com",
      },
    });
    monitor.ingestLogEntry({
      timestamp: "2026-05-26T12:00:02.000Z",
      createdAtMs: Date.parse("2026-05-26T12:00:02.000Z"),
      level: "INFO",
      event: "mail sent",
      source: "runtime",
      details: {
        smtpAccount: "2fa",
        from: "Security <security@example.com>",
        to: "user@example.com",
        messageId: "message-1",
      },
    });

    const snapshot = monitor.getSnapshot({
      smtpAccounts: ["2fa", "info"],
      defaultSmtpAccount: "info",
    });
    const twoFactor = snapshot.accounts.find((account) => account.name === "2fa");
    const info = snapshot.accounts.find((account) => account.name === "info");

    assert.equal(twoFactor.sendRequests, 1);
    assert.equal(twoFactor.queued, 1);
    assert.equal(twoFactor.sent, 1);
    assert.equal(twoFactor.failed, 0);
    assert.equal(twoFactor.successRate, 100);
    assert.deepEqual(twoFactor.fromAddresses, ["security@example.com"]);
    assert.equal(info.isDefault, true);
    assert.equal(info.sent, 0);
  });

  test("renders SMTP account filters in live monitor HTML", () => {
    const html = renderMonitorPageHtml();

    assert.match(html, /id="accountFilter"/);
    assert.match(html, /id="eventAccountFilter"/);
    assert.match(html, /id="accountsBody"/);
  });

  test("renders stable legacy monitor toolbar layout", () => {
    const html = renderMonitorPageHtml({ updatePagePath: "/update" });

    assert.match(html, /Guncelleme Ekrani/);
    assert.match(html, /href="\/update"/);
    assert.match(html, /\.topbar-right form/);
    assert.match(html, /@media \(max-width: 560px\)/);
  });
});
