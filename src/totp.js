"use strict";

const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD_SEC = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_ALGORITHM = "sha1";

function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function buildOtpAuthUrl(options = {}) {
  const secret = normalizeBase32(options.secret);
  const issuer = clean(options.issuer || "MailFastApi");
  const accountName = clean(options.accountName || "admin");
  if (!secret) {
    throw new Error("TOTP secret is required.");
  }
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function generateTotp(secret, timeMs = Date.now(), options = {}) {
  const period = toPositiveInt(options.periodSec, DEFAULT_PERIOD_SEC);
  const digits = toPositiveInt(options.digits, DEFAULT_DIGITS);
  const algorithm = clean(options.algorithm || DEFAULT_ALGORITHM).toLowerCase();
  const counter = Math.floor(Math.floor(Number(timeMs) / 1000) / period);
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac(algorithm, key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const token = binary % 10 ** digits;
  return String(token).padStart(digits, "0");
}

function verifyTotp(token, secret, options = {}) {
  const normalizedToken = normalizeTotpToken(token);
  if (!normalizedToken) {
    return false;
  }

  const period = toPositiveInt(options.periodSec, DEFAULT_PERIOD_SEC);
  const window = toNonNegativeInt(options.window, 1);
  const now = Number.isFinite(Number(options.timeMs)) ? Number(options.timeMs) : Date.now();

  for (let offset = -window; offset <= window; offset += 1) {
    const candidateTimeMs = now + offset * period * 1000;
    if (candidateTimeMs < 0) {
      continue;
    }
    const expected = generateTotp(secret, candidateTimeMs, options);
    if (safeEqual(expected, normalizedToken)) {
      return true;
    }
  }
  return false;
}

function base32Encode(buffer) {
  const source = Buffer.from(buffer);
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of source) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(value) {
  const input = normalizeBase32(value);
  if (!input) {
    throw new Error("TOTP secret is required.");
  }

  let bits = 0;
  let buffer = 0;
  const bytes = [];

  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("TOTP secret contains invalid base32 characters.");
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function normalizeBase32(value) {
  return String(value || "")
    .replace(/[=\s-]/g, "")
    .toUpperCase();
}

function normalizeTotpToken(value) {
  const token = String(value || "").replace(/\s/g, "");
  return /^\d{6}$/.test(token) ? token : "";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function clean(value) {
  return String(value || "").trim();
}

module.exports = {
  generateTotpSecret,
  buildOtpAuthUrl,
  generateTotp,
  verifyTotp,
  base32Encode,
  base32Decode,
};
