"use strict";

const nodemailer = require("nodemailer");

let transporter;

function getTransporter() {
  if (!transporter) {
    const smtpConfig = buildSmtpConfig();
    transporter = nodemailer.createTransport(smtpConfig);
  }

  return transporter;
}

async function verifyTransporter(log) {
  try {
    await getTransporter().verify();
    if (typeof log === "function") {
      log("INFO", "smtp connection verified");
    }
  } catch (error) {
    if (typeof log === "function") {
      log("WARN", "smtp verify failed", {
        message: error && error.message ? error.message : "Unknown SMTP verify error",
      });
    }
  }
}

async function closeTransporter() {
  if (transporter && typeof transporter.close === "function") {
    transporter.close();
  }
  transporter = undefined;
}

function buildSmtpConfig() {
  const secure = toBoolean(process.env.SMTP_SECURE, false);
  const port = toInt(process.env.SMTP_PORT, secure ? 465 : 587);

  const config = {
    host: process.env.SMTP_HOST || "localhost",
    port,
    secure,
    pool: true,
    maxConnections: toInt(process.env.SMTP_MAX_CONNECTIONS, 5),
    maxMessages: toInt(process.env.SMTP_MAX_MESSAGES, 100),
    rateLimit: toInt(process.env.SMTP_RATE_LIMIT, 10),
    rateDelta: toInt(process.env.SMTP_RATE_DELTA, 1000),
  };

  if (process.env.SMTP_USER || process.env.SMTP_PASS) {
    config.auth = {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    };
  }

  return config;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

module.exports = {
  getTransporter,
  verifyTransporter,
  closeTransporter,
};
