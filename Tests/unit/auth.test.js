"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { loadAuthConfig, issueAccessToken, verifyJwt } = require("../../src/auth");

describe("auth module", () => {
  test("issues and verifies JWT with required scope", () => {
    const config = loadAuthConfig({
      AUTH_MODE: "jwt",
      JWT_SECRET: "unit_test_secret",
      JWT_ISSUER: "unit-tests",
      JWT_AUDIENCE: "unit-audience",
      JWT_EXPIRES_IN: "5m",
      AUTH_CLIENT_ID: "client-a",
      AUTH_CLIENT_SECRET: "secret-a",
    });

    const issued = issueAccessToken(config, "client-a", ["mail:send"]);
    assert.equal(issued.token_type, "Bearer");
    assert.equal(typeof issued.access_token, "string");
    assert.ok(issued.access_token.length > 20);

    const payload = verifyJwt(config, issued.access_token, "mail:send");
    assert.equal(payload.sub, "client-a");
  });

  test("rejects token when scope is missing", () => {
    const config = loadAuthConfig({
      AUTH_MODE: "jwt",
      JWT_SECRET: "unit_test_secret",
      JWT_ISSUER: "unit-tests",
      JWT_AUDIENCE: "unit-audience",
      JWT_EXPIRES_IN: "5m",
      AUTH_CLIENT_ID: "client-a",
      AUTH_CLIENT_SECRET: "secret-a",
    });

    const issued = issueAccessToken(config, "client-a", ["mail:send"]);
    assert.throws(() => verifyJwt(config, issued.access_token, "admin:all"), (error) => {
      assert.equal(error.code, "INSUFFICIENT_SCOPE");
      return true;
    });
  });
});
