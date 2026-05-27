"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  applySettingsValuesToEnv,
  buildSettingsModel,
  parseSettingsForm,
  sanitizeStoredSettings,
} = require("../../src/appSettings");

describe("application settings", () => {
  test("parses form values, keeps blank secrets, and clears overrides", () => {
    const current = {
      JWT_SECRET: "existing-secret",
      PORT: "3000",
      WEB_MFA_REQUIRED: "false",
    };

    const result = parseSettingsForm(
      {
        PORT: "3100",
        JWT_SECRET: "",
        WEB_MFA_REQUIRED: "true",
        clear_PORT: "on",
      },
      current,
    );

    assert.equal(result.values.JWT_SECRET, "existing-secret");
    assert.equal(result.values.PORT, undefined);
    assert.equal(result.values.WEB_MFA_REQUIRED, "true");
    assert.deepEqual(result.cleared, ["PORT"]);
    assert.ok(result.changed.includes("WEB_MFA_REQUIRED"));
  });

  test("rejects invalid integer, select, and json values", () => {
    assert.throws(
      () => parseSettingsForm({ PORT: "not-a-port" }, {}),
      /PORT: must be an integer/,
    );
    assert.throws(
      () => parseSettingsForm({ AUTH_MODE: "invalid" }, {}),
      /AUTH_MODE: must be one of/,
    );
    assert.throws(
      () => parseSettingsForm({ JWT_CLIENTS_JSON: "{bad-json" }, {}),
      /JWT_CLIENTS_JSON/,
    );
  });

  test("applies only known stored settings to env", () => {
    const env = {};
    const result = applySettingsValuesToEnv(
      {
        PORT: "3200",
        UNKNOWN_SETTING: "ignored",
      },
      env,
    );

    assert.equal(env.PORT, "3200");
    assert.equal(env.UNKNOWN_SETTING, undefined);
    assert.equal(result.applied, 1);
  });

  test("does not persist unchanged env/default values from full form posts", () => {
    const result = parseSettingsForm(
      {
        PORT: "3000",
        WEB_MFA_REQUIRED: "false",
        QUEUE_BACKEND: "redis",
      },
      {},
      {
        env: {
          PORT: "3000",
        },
      },
    );

    assert.deepEqual(result.values, {});
    assert.deepEqual(result.changed, []);
  });

  test("builds model with secure-store source and masked secrets", () => {
    const sections = buildSettingsModel(
      { JWT_SECRET: "env-secret", PORT: "3000" },
      { JWT_SECRET: "stored-secret", WEB_MFA_REQUIRED: "false" },
    );
    const settings = sections.flatMap((section) => section.settings);
    const jwtSecret = settings.find((setting) => setting.key === "JWT_SECRET");
    const port = settings.find((setting) => setting.key === "PORT");

    assert.equal(jwtSecret.source, "secure store");
    assert.equal(jwtSecret.effectiveValue, "set (hidden)");
    assert.equal(jwtSecret.inputValue, "");
    assert.equal(port.source, ".env/process");
    assert.equal(port.effectiveValue, "3000");
  });

  test("drops unknown persisted keys", () => {
    assert.deepEqual(sanitizeStoredSettings({ PORT: 3000, BAD: "x" }), { PORT: "3000" });
  });
});
