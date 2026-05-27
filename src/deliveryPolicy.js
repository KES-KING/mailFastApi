"use strict";

const DEFAULT_POLICIES = Object.freeze({
  gmail: {
    domains: ["gmail.com", "googlemail.com"],
    perMinute: 60,
    perHour: 1500,
    perDay: 20000,
    concurrentConnections: 5,
    maxRetryAttempts: 3,
    bounceThreshold: 0.02,
    complaintThreshold: 0.001,
    greylistDelayMs: 15 * 60 * 1000,
  },
  outlook: {
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    perMinute: 50,
    perHour: 1200,
    perDay: 18000,
    concurrentConnections: 4,
    maxRetryAttempts: 3,
    bounceThreshold: 0.02,
    complaintThreshold: 0.001,
    greylistDelayMs: 20 * 60 * 1000,
  },
  yahoo: {
    domains: ["yahoo.com", "ymail.com", "rocketmail.com", "aol.com"],
    perMinute: 40,
    perHour: 900,
    perDay: 15000,
    concurrentConnections: 3,
    maxRetryAttempts: 3,
    bounceThreshold: 0.015,
    complaintThreshold: 0.001,
    greylistDelayMs: 20 * 60 * 1000,
  },
  corporate: {
    domains: [],
    perMinute: 200,
    perHour: 6000,
    perDay: 100000,
    concurrentConnections: 10,
    maxRetryAttempts: 4,
    bounceThreshold: 0.03,
    complaintThreshold: 0.002,
    greylistDelayMs: 10 * 60 * 1000,
  },
});

const SMTP_ATTEMPT_EVENTS = Object.freeze(["sent", "failed", "bounced", "retrying"]);

function createDeliveryPolicy(options = {}) {
  const env = options.env || process.env;
  const store = options.store || null;
  const enabled = toBoolean(env.DELIVERY_POLICY_ENABLED, true);
  const policies = mergePolicies(DEFAULT_POLICIES, parseJsonObject(env.DOMAIN_POLICIES_JSON));
  const accountPolicies = parseJsonObject(env.SMTP_ACCOUNT_POLICIES_JSON);
  const defaultPolicyName = "corporate";

  function checkSendPermission(job) {
    if (!enabled || !store || typeof store.countDeliveryEvents !== "function") {
      return { allowed: true };
    }

    const smtpAccount = clean(job && job.smtpAccount) || "default";
    const tenantId = clean(job && job.tenantId) || "global";
    const recipientDomains = getRecipientDomains(job && job.to);
    const accountPolicy = accountPolicies[smtpAccount] || {};
    const now = Date.now();

    for (const domain of recipientDomains) {
      const policy = {
        ...getDomainPolicy(domain),
        ...accountPolicy,
      };
      const checks = [
        ["minute", policy.perMinute, now - 60 * 1000],
        ["hour", policy.perHour, now - 60 * 60 * 1000],
        ["day", policy.perDay, now - 24 * 60 * 60 * 1000],
      ];

      for (const [windowName, limit, sinceMs] of checks) {
        if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) {
          continue;
        }
        const count = store.countDeliveryEvents({
          tenantId,
          smtpAccount,
          domain,
          events: SMTP_ATTEMPT_EVENTS,
          sinceMs,
        });
        if (count >= Number(limit)) {
          return {
            allowed: false,
            reason: `${windowName}_quota_exceeded`,
            domain,
            policyName: classifyDomain(domain, policies, defaultPolicyName),
            retryAfterMs: retryAfterForWindow(windowName),
          };
        }
      }
    }

    return { allowed: true };
  }

  function getDomainPolicy(domain) {
    const name = classifyDomain(domain, policies, defaultPolicyName);
    return policies[name] || policies[defaultPolicyName];
  }

  function getMaxRetryAttempts(job, fallback) {
    const recipientDomains = getRecipientDomains(job && job.to);
    const limits = recipientDomains.map((domain) => getDomainPolicy(domain).maxRetryAttempts);
    const configured = limits
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    return configured.length > 0 ? Math.min(Number(fallback) || 1, ...configured) : fallback;
  }

  function getGreylistDelayMs(domain) {
    return Number(getDomainPolicy(domain).greylistDelayMs) || 10 * 60 * 1000;
  }

  function snapshot() {
    return {
      enabled,
      policies,
      accountPolicyNames: Object.keys(accountPolicies).sort(),
    };
  }

  return {
    checkSendPermission,
    getDomainPolicy,
    getMaxRetryAttempts,
    getGreylistDelayMs,
    snapshot,
  };
}

function classifyDomain(domain, policies = DEFAULT_POLICIES, fallback = "corporate") {
  const normalized = clean(domain).toLowerCase();
  for (const [name, policy] of Object.entries(policies)) {
    const domains = Array.isArray(policy.domains) ? policy.domains : [];
    if (domains.map((item) => clean(item).toLowerCase()).includes(normalized)) {
      return name;
    }
  }
  return fallback;
}

function getRecipientDomains(value) {
  return [...new Set(normalizeRecipients(value).map((email) => email.split("@").pop()).filter(Boolean))];
}

function normalizeRecipients(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}

function mergePolicies(base, overrides) {
  const merged = {};
  for (const [name, policy] of Object.entries(base)) {
    merged[name] = { ...policy };
  }
  for (const [name, policy] of Object.entries(overrides || {})) {
    if (!policy || typeof policy !== "object") {
      continue;
    }
    merged[name] = { ...(merged[name] || {}), ...policy };
  }
  return merged;
}

function retryAfterForWindow(windowName) {
  if (windowName === "day") return 60 * 60 * 1000;
  if (windowName === "hour") return 10 * 60 * 1000;
  return 60 * 1000;
}

function parseJsonObject(value) {
  const raw = clean(value);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clean(value) {
  return String(value || "").trim();
}

module.exports = {
  createDeliveryPolicy,
  classifyDomain,
  getRecipientDomains,
};
