"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { assertProductionSafety, validateProductionSafety } = require("../../src/productionGuard");

describe("production safety guard", () => {
  test("does not block local development mode", () => {
    const result = validateProductionSafety({
      PRODUCTION_MODE: "false",
      AUTH_MODE: "none",
      QUEUE_BACKEND: "memory",
    });

    assert.equal(result.ok, true);
    assert.equal(result.enabled, false);
  });

  test("rejects insecure production settings", () => {
    const result = validateProductionSafety({
      PRODUCTION_MODE: "true",
      AUTH_MODE: "none",
      QUEUE_BACKEND: "memory",
      MAILFASTAPI_ROLE: "all",
      MONITOR_ENABLED: "true",
      WEB_MFA_REQUIRED: "false",
      SECURE_STORE_KEY: "change_me_with_at_least_32_random_characters",
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((item) => item.includes("AUTH_MODE=none")));
    assert.ok(result.errors.some((item) => item.includes("QUEUE_BACKEND=memory")));
    assert.ok(result.errors.some((item) => item.includes("MAILFASTAPI_ROLE=all")));
    assert.ok(result.errors.some((item) => item.includes("WEB_MFA_REQUIRED=false")));
  });

  test("accepts separated production api role with durable queue and signed updater", () => {
    assert.doesNotThrow(() =>
      assertProductionSafety({
        PRODUCTION_MODE: "true",
        AUTH_MODE: "jwt",
        QUEUE_BACKEND: "redis",
        MAILFASTAPI_ROLE: "api",
        MONITOR_ENABLED: "true",
        MONITOR_TOKEN: "monitor_token_with_32_chars_minimum",
        SECURE_STORE_KEY: "secure_store_key_with_32_chars_min",
        JWT_SECRET: "jwt_secret_with_at_least_32_chars",
        AUTH_CLIENT_SECRET: "client_secret_with_at_least_32_chars",
        BOUNCE_WEBHOOK_TOKEN: "bounce_webhook_token_with_32_chars",
        BOUNCE_DOMAIN: "bounces.example.com",
        DKIM_SIGNING_ENABLED: "true",
        DKIM_DOMAIN: "example.com",
        DKIM_SELECTOR: "mail",
        DKIM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nunit-test\\n-----END PRIVATE KEY-----",
        WEB_ENABLE_UPDATER: "true",
        UPDATER_RELEASE_MODE: "tag",
        UPDATER_REQUIRE_SIGNED_TAG: "true",
        OPERATIONAL_DB_PATH: "data/ops.sqlite",
      }),
    );
  });
});
