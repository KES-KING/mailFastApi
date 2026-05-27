"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  checkDomainHealth,
  normalizeDomain,
  normalizeSelectors,
  parseDmarcPolicy,
} = require("../../src/domainHealth");

describe("domain health checks", () => {
  test("validates SPF, DKIM, and production-ready DMARC policy", async () => {
    const records = new Map([
      ["example.com", [["v=spf1 include:_spf.example.com -all"]]],
      ["_dmarc.example.com", [["v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"]]],
      ["default._domainkey.example.com", [["v=DKIM1; k=rsa; p=abc123"]]],
      ["_mta-sts.example.com", [["v=STSv1; id=20260527"]]],
      ["_smtp._tls.example.com", [["v=TLSRPTv1; rua=mailto:tls@example.com"]]],
    ]);

    const result = await checkDomainHealth("Example.com", {
      selectors: ["default"],
      resolver: createResolver(records),
      mxResolver: async () => [{ exchange: "mx.example.com", priority: 10 }],
    });

    assert.equal(result.domain, "example.com");
    assert.equal(result.ok, true);
    assert.equal(result.spf.ok, true);
    assert.equal(result.dmarc.policy, "quarantine");
    assert.equal(result.dkim[0].ok, true);
    assert.equal(result.mx.ok, true);
    assert.equal(result.mtaSts.ok, true);
    assert.equal(result.tlsRpt.ok, true);
  });

  test("treats DMARC p=none as not production-ready", async () => {
    const records = new Map([
      ["example.com", [["v=spf1 -all"]]],
      ["_dmarc.example.com", [["v=DMARC1; p=none"]]],
      ["default._domainkey.example.com", [["v=DKIM1; p=abc123"]]],
    ]);

    const result = await checkDomainHealth("example.com", {
      selectors: ["default"],
      resolver: createResolver(records),
      mxResolver: async () => [{ exchange: "mx.example.com", priority: 10 }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.dmarc.productionReady, false);
  });

  test("normalizes domains, selectors, and DMARC policies", () => {
    assert.equal(normalizeDomain("Mail.Example.COM."), "mail.example.com");
    assert.deepEqual(normalizeSelectors("default, mail,default,INVALID!"), ["default", "mail"]);
    assert.equal(parseDmarcPolicy("v=DMARC1; p=reject"), "reject");
    assert.throws(() => normalizeDomain("not a domain"), /valid domain/);
  });
});

function createResolver(records) {
  return async (name) => {
    const record = records.get(name);
    if (record) {
      return record;
    }
    const error = new Error("not found");
    error.code = "ENOTFOUND";
    throw error;
  };
}
