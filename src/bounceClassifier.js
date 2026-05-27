"use strict";

const HARD_BOUNCE_PATTERNS = [
  /user unknown/i,
  /unknown user/i,
  /no such user/i,
  /mailbox unavailable/i,
  /recipient address rejected/i,
  /account disabled/i,
  /does not exist/i,
];

const SOFT_BOUNCE_PATTERNS = [
  /mailbox full/i,
  /over quota/i,
  /temporary failure/i,
  /try again later/i,
  /rate limit/i,
  /throttl/i,
  /timeout/i,
];

const GREYLIST_PATTERNS = [/greylist/i, /grey list/i, /temporarily deferred/i, /deferred/i];

function classifyBounce(input = {}) {
  const normalized = normalizeInput(input);
  const text = `${normalized.code} ${normalized.enhancedCode} ${normalized.message}`.trim();

  if (normalized.type === "complaint" || /complaint|abuse|spam/i.test(text)) {
    return createResult("complaint", "complaint", true, false, text);
  }

  if (GREYLIST_PATTERNS.some((pattern) => pattern.test(text))) {
    return createResult("soft", "greylisted", false, true, text);
  }

  if (isHardStatus(normalized) || HARD_BOUNCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return createResult("hard", "hard_bounce", true, false, text);
  }

  if (isSoftStatus(normalized) || SOFT_BOUNCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return createResult("soft", "soft_bounce", false, true, text);
  }

  return createResult("unknown", "unknown", false, true, text);
}

function normalizeInput(input) {
  const responseCode =
    input.responseCode || input.statusCode || input.smtpCode || input.code || input.status || "";
  const enhancedCode = input.enhancedStatusCode || input.enhancedCode || input.smtpEnhancedCode || "";
  const response = input.response || input.message || input.reason || "";
  const type = String(input.type || input.eventType || "").trim().toLowerCase();
  return {
    code: String(responseCode || "").trim(),
    enhancedCode: String(enhancedCode || "").trim(),
    message: String(response || "").trim(),
    type,
  };
}

function isHardStatus(input) {
  return /^5\d\d$/.test(input.code) || /^5\./.test(input.enhancedCode);
}

function isSoftStatus(input) {
  return /^4\d\d$/.test(input.code) || /^4\./.test(input.enhancedCode);
}

function createResult(type, reason, suppress, retryable, raw) {
  return {
    type,
    reason,
    suppress,
    retryable,
    raw: raw || "",
  };
}

module.exports = {
  classifyBounce,
};
