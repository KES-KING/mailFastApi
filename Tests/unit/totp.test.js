"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  base32Decode,
  base32Encode,
  buildOtpAuthUrl,
  generateTotp,
  verifyTotp,
} = require("../../src/totp");

describe("totp", () => {
  test("matches RFC 6238 SHA1 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.equal(generateTotp(secret, 59_000, { digits: 8 }), "94287082");
    assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890", "ascii"));
  });

  test("verifies token inside configured time window", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const now = 0;
    const token = generateTotp(secret, now);

    assert.equal(verifyTotp(token, secret, { timeMs: now }), true);
    assert.equal(verifyTotp(token, secret, { timeMs: now + 31_000, window: 0 }), false);
  });

  test("builds otpauth URI for authenticator apps", () => {
    const uri = buildOtpAuthUrl({
      issuer: "MailFastApi",
      accountName: "admin@example.com",
      secret: "JBSWY3DPEHPK3PXP",
    });

    assert.match(uri, /^otpauth:\/\/totp\/MailFastApi%3Aadmin%40example\.com\?/);
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
    assert.match(uri, /issuer=MailFastApi/);
  });
});
