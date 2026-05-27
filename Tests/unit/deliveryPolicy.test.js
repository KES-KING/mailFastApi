"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { classifyDomain, createDeliveryPolicy, getRecipientDomains } = require("../../src/deliveryPolicy");

describe("delivery policy", () => {
  test("classifies common mailbox providers", () => {
    assert.equal(classifyDomain("gmail.com"), "gmail");
    assert.equal(classifyDomain("outlook.com"), "outlook");
    assert.equal(classifyDomain("yahoo.com"), "yahoo");
    assert.equal(classifyDomain("corp.example.com"), "corporate");
  });

  test("extracts unique recipient domains", () => {
    assert.deepEqual(getRecipientDomains(["A@Gmail.com", "b@gmail.com", "c@example.com"]), [
      "gmail.com",
      "example.com",
    ]);
  });

  test("blocks send when per-minute quota is exceeded", () => {
    const store = {
      countDeliveryEvents: ({ domain }) => (domain === "gmail.com" ? 60 : 0),
    };
    const policy = createDeliveryPolicy({ env: {}, store });

    const result = policy.checkSendPermission({
      tenantId: "tenant_a",
      smtpAccount: "default",
      to: "user@gmail.com",
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, "minute_quota_exceeded");
    assert.equal(result.domain, "gmail.com");
  });

  test("counts SMTP attempts, not queued or deferred jobs, for provider quota", () => {
    const calls = [];
    const store = {
      countDeliveryEvents: (filter) => {
        calls.push(filter);
        return 0;
      },
    };
    const policy = createDeliveryPolicy({ env: {}, store });

    const result = policy.checkSendPermission({
      tenantId: "tenant_a",
      smtpAccount: "default",
      to: "user@gmail.com",
    });

    assert.equal(result.allowed, true);
    assert.deepEqual(calls[0].events, ["sent", "failed", "bounced", "retrying"]);
  });
});
