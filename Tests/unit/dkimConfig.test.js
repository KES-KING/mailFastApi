"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { createDkimResolver, validateDkimProductionConfig } = require("../../src/dkimConfig");

describe("dkim config", () => {
  test("returns no-op resolver when signing is disabled", () => {
    const resolver = createDkimResolver({ DKIM_SIGNING_ENABLED: "false" });

    assert.equal(resolver.enabled, false);
    assert.equal(resolver.getDkimOptions({}), null);
  });

  test("loads default DKIM key from environment", () => {
    const resolver = createDkimResolver({
      DKIM_SIGNING_ENABLED: "true",
      DKIM_DOMAIN: "example.com",
      DKIM_SELECTOR: "mail",
      DKIM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nunit\\n-----END PRIVATE KEY-----",
    });

    const options = resolver.getDkimOptions({ from: "Sender <sender@example.com>" });
    assert.equal(options.domainName, "example.com");
    assert.equal(options.keySelector, "mail");
    assert.match(options.privateKey, /BEGIN PRIVATE KEY/);
  });

  test("production validation rejects missing DKIM config", () => {
    const errors = validateDkimProductionConfig({ DKIM_SIGNING_ENABLED: "false" });

    assert.ok(errors.some((item) => item.includes("DKIM_SIGNING_ENABLED=true")));
  });
});
