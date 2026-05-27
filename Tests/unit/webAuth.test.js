"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { createWebAuth } = require("../../src/webAuth");

describe("web auth security headers", () => {
  test("uses nonce based CSP without unsafe inline fallback", () => {
    const webAuth = createWebAuth({
      secureStore: {
        verifyAdminPassword: () => true,
        hasAdminPassword: () => true,
      },
    });
    const headers = new Map();
    const res = {
      locals: {},
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
    };

    webAuth.securityHeaders({ headers: {} }, res, () => {});

    const csp = headers.get("content-security-policy");
    assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
    assert.match(csp, /style-src 'self' 'nonce-[^']+'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(typeof res.locals.cspNonce, "string");
    assert.ok(res.locals.cspNonce.length > 10);
  });
});
