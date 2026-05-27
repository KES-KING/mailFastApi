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

  test("enforces RBAC middleware and supports session revoke", () => {
    const webAuth = createWebAuth({
      secureStore: {
        verifyAdminPassword: (password) => password === "correct-password",
        hasAdminPassword: () => true,
      },
    });
    const req = {
      headers: {},
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = createResponse();
    const session = webAuth.login(req, res, "correct-password");
    req.headers.cookie = String(res.headers.get("set-cookie")).split(";")[0];

    let nextCalled = false;
    webAuth.requireAuth(req, createResponse(), () => {
      webAuth.requireRole("admin")(req, createResponse(), () => {
        nextCalled = true;
      });
    });

    assert.equal(nextCalled, true);
    assert.equal(session.csrfToken.length > 10, true);
    assert.equal(webAuth.revokeAllSessions(), 1);

    const deniedRes = createResponse();
    webAuth.requireAuth(req, deniedRes, () => {});
    assert.equal(deniedRes.statusCode, 401);
  });

  test("requires MFA code when admin TOTP is enabled", () => {
    const webAuth = createWebAuth({
      secureStore: {
        verifyAdminPassword: (password) => password === "correct-password",
        hasAdminPassword: () => true,
        hasAdminTotp: () => true,
        verifyAdminMfaCode: (code) => code === "123456",
      },
    });
    const req = {
      headers: {},
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    };

    assert.throws(
      () => webAuth.login(req, createResponse(), "correct-password"),
      /Invalid MFA verification code/,
    );

    const res = createResponse();
    const session = webAuth.login(req, res, "correct-password", "123456");

    assert.equal(session.csrfToken.length > 10, true);
    assert.match(String(res.headers.get("set-cookie")), /mailfastapi_session=/);
  });

  test("skips MFA check when MFA is disabled for development", () => {
    const webAuth = createWebAuth({
      mfaRequired: false,
      secureStore: {
        verifyAdminPassword: (password) => password === "correct-password",
        hasAdminPassword: () => true,
        hasAdminTotp: () => true,
        verifyAdminMfaCode: () => false,
      },
    });
    const req = {
      headers: {},
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = createResponse();

    const session = webAuth.login(req, res, "correct-password");

    assert.equal(session.csrfToken.length > 10, true);
    assert.equal(webAuth.isMfaEnabled(), false);
  });
});

function createResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    locals: {},
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    redirect(code, location) {
      this.statusCode = code;
      this.location = location;
      return this;
    },
  };
}
