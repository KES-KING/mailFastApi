"use strict";

const dns = require("node:dns/promises");

async function checkDomainHealth(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const selectors = normalizeSelectors(options.selectors || ["default", "mail"]);
  const resolver = options.resolver || dns.resolveTxt;

  const spf = await checkTxt(normalizedDomain, resolver, (record) =>
    record.toLowerCase().startsWith("v=spf1"),
  );
  const dmarc = await checkTxt(`_dmarc.${normalizedDomain}`, resolver, (record) =>
    record.toLowerCase().startsWith("v=dmarc1"),
  );
  const dkim = [];
  for (const selector of selectors) {
    dkim.push({
      selector,
      ...(await checkTxt(`${selector}._domainkey.${normalizedDomain}`, resolver, (record) =>
        record.toLowerCase().startsWith("v=dkim1") || /\bp=/i.test(record),
      )),
    });
  }

  const dmarcPolicy = parseDmarcPolicy(dmarc.matching[0] || "");
  return {
    domain: normalizedDomain,
    checkedAt: new Date().toISOString(),
    ok: spf.ok && dmarc.ok && dmarcPolicy !== "none" && dkim.some((entry) => entry.ok),
    spf,
    dmarc: {
      ...dmarc,
      policy: dmarcPolicy || null,
      productionReady: dmarcPolicy === "quarantine" || dmarcPolicy === "reject",
    },
    dkim,
  };
}

async function checkTxt(name, resolver, predicate) {
  try {
    const records = await resolver(name);
    const flattened = records.map((parts) => parts.join(""));
    const matching = flattened.filter(predicate);
    return { ok: matching.length > 0, records: flattened, matching };
  } catch (error) {
    return {
      ok: false,
      records: [],
      matching: [],
      error: error && error.code ? error.code : error && error.message ? error.message : "TXT_LOOKUP_FAILED",
    };
  }
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (
    !domain ||
    domain.length > 253 ||
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  ) {
    const error = new Error("A valid domain is required.");
    error.code = "INVALID_DOMAIN";
    throw error;
  }
  return domain;
}

function normalizeSelectors(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const selectors = raw
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(item));
  return selectors.length > 0 ? [...new Set(selectors)] : ["default"];
}

function parseDmarcPolicy(record) {
  const match = String(record || "").toLowerCase().match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/);
  return match ? match[1] : "";
}

module.exports = {
  checkDomainHealth,
  normalizeDomain,
  normalizeSelectors,
  parseDmarcPolicy,
};
