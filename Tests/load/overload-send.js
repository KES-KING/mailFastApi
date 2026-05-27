"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const SEND_SCOPE = "mail:send";

main().catch((error) => {
  console.error(`[overload] ${error && error.message ? error.message : "Unknown error"}`);
  process.exit(1);
});

async function main() {
  const config = loadConfig(process.env);
  printPlan(config);

  if (!config.confirmRealSend) {
    console.log("");
    console.log("DRY RUN: real mail was not sent.");
    console.log("To execute: OVERLOAD_CONFIRM_REAL_SEND=true npm run test:overload");
    return;
  }

  const token = await resolveAuthHeader(config);
  const startedAt = new Date();
  const startedMs = performance.now();
  const results = await runOverload(config, token);
  const durationMs = performance.now() - startedMs;
  const report = buildReport(config, results, startedAt, durationMs);
  writeReport(config.reportPath, report);
  printSummary(report);

  if (report.statusCounts["202"] === 0) {
    process.exitCode = 2;
  }
}

function loadConfig(env) {
  const rateLimitMax = toInt(env.RATE_LIMIT_MAX, 120);
  const rateLimitWindowMs = toInt(env.RATE_LIMIT_WINDOW_MS, 60000);
  const queueMaxSize = toInt(env.QUEUE_MAX_SIZE, 50000);
  const workerConcurrency = toInt(env.WORKER_CONCURRENCY, 2);
  const profile = clean(env.OVERLOAD_PROFILE || "api-limit").toLowerCase();

  const recommendedTotal = resolveRecommendedTotal(profile, rateLimitMax);
  const recommendedConcurrency = resolveRecommendedConcurrency(profile, workerConcurrency);

  const total = toInt(env.OVERLOAD_TOTAL, recommendedTotal);
  const concurrency = Math.max(1, toInt(env.OVERLOAD_CONCURRENCY, recommendedConcurrency));
  const batchDelayMs = Math.max(0, toInt(env.OVERLOAD_BATCH_DELAY_MS, 0));
  const timeoutMs = Math.max(1000, toInt(env.OVERLOAD_REQUEST_TIMEOUT_MS, 15000));
  const testRecipient = clean(env.OVERLOAD_TEST_MAIL_TO || env.TEST_MAIL_TO);
  const htmlBytes = resolveHtmlBytes(env);

  if (!testRecipient) {
    throw new Error("TEST_MAIL_TO or OVERLOAD_TEST_MAIL_TO is required.");
  }

  if (total > queueMaxSize) {
    throw new Error(`OVERLOAD_TOTAL (${total}) cannot exceed QUEUE_MAX_SIZE (${queueMaxSize}).`);
  }

  return {
    baseUrl: normalizeBaseUrl(env.BASE_URL || env.MAILFASTAPI_BASE_URL || DEFAULT_BASE_URL),
    profile,
    total,
    concurrency,
    batchDelayMs,
    timeoutMs,
    testRecipient,
    smtpAccount: clean(env.SMTP_ACCOUNT || env.OVERLOAD_SMTP_ACCOUNT),
    category: clean(env.MAIL_CATEGORY || env.OVERLOAD_MAIL_CATEGORY || "transactional"),
    tenantId: clean(env.TENANT_ID || env.OVERLOAD_TENANT_ID || "overload_test"),
    subjectPrefix: clean(env.OVERLOAD_SUBJECT_PREFIX || "MailFastApi overload test"),
    htmlBytes,
    htmlMb: Math.round((htmlBytes / 1024 / 1024) * 100) / 100,
    estimatedTotalPayloadBytes: htmlBytes * total,
    confirmRealSend: toBoolean(env.OVERLOAD_CONFIRM_REAL_SEND, false),
    reportPath:
      clean(env.OVERLOAD_REPORT_PATH) ||
      path.join("logs", `overload-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    authMode: clean(env.AUTH_MODE || "jwt").toLowerCase(),
    clientId: clean(env.OVERLOAD_AUTH_CLIENT_ID || env.AUTH_CLIENT_ID),
    clientSecret: clean(env.OVERLOAD_AUTH_CLIENT_SECRET || env.AUTH_CLIENT_SECRET),
    apiKey: clean(env.OVERLOAD_API_KEY || env.API_KEY),
    rateLimitMax,
    rateLimitWindowMs,
    queueBackend: clean(env.QUEUE_BACKEND || "redis"),
    queueMaxSize,
    workerConcurrency,
  };
}

async function resolveAuthHeader(config) {
  if (config.authMode === "none") {
    return {};
  }

  if (config.authMode === "api_key") {
    if (!config.apiKey) {
      throw new Error("API_KEY or OVERLOAD_API_KEY is required when AUTH_MODE=api_key.");
    }
    return { "x-api-key": config.apiKey };
  }

  if (!config.clientId || !config.clientSecret) {
    throw new Error("AUTH_CLIENT_ID/AUTH_CLIENT_SECRET or overload auth overrides are required.");
  }

  const response = await fetch(new URL("/auth/token", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: SEND_SCOPE,
    }),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload || !payload.access_token) {
    throw new Error(`Token request failed with HTTP ${response.status}.`);
  }
  return { authorization: `Bearer ${payload.access_token}` };
}

async function runOverload(config, authHeaders) {
  const results = new Array(config.total);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= config.total) {
        return;
      }
      if (config.batchDelayMs > 0 && index > 0) {
        await sleep(config.batchDelayMs);
      }
      results[index] = await sendOne(config, authHeaders, index);
    }
  }

  const workerCount = Math.min(config.concurrency, config.total);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function sendOne(config, authHeaders, index) {
  const id = `${Date.now()}-${process.pid}-${index}`;
  const body = {
    tenantId: config.tenantId,
    category: config.category,
    to: config.testRecipient,
    subject: `${config.subjectPrefix} #${index + 1}`,
    html: buildHtml(config, index),
  };

  if (config.smtpAccount) {
    body.smtpAccount = config.smtpAccount;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedMs = performance.now();

  try {
    const response = await fetch(new URL("/send", config.baseUrl), {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        "idempotency-key": `overload-${id}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      index,
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round((performance.now() - startedMs) * 100) / 100,
      body: text.slice(0, 500),
    };
  } catch (error) {
    return {
      index,
      ok: false,
      status: "error",
      latencyMs: Math.round((performance.now() - startedMs) * 100) / 100,
      error: error && error.name === "AbortError" ? "request timeout" : getErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildHtml(config, index) {
  const base = `<p>MailFastApi overload test message ${index + 1}.</p>`;
  const padLength = Math.max(0, config.htmlBytes - base.length);
  return `${base}<pre>${"x".repeat(padLength)}</pre>`;
}

function buildReport(config, results, startedAt, durationMs) {
  const statusCounts = {};
  const latencies = [];
  for (const result of results) {
    const key = String(result.status);
    statusCounts[key] = (statusCounts[key] || 0) + 1;
    if (typeof result.latencyMs === "number") {
      latencies.push(result.latencyMs);
    }
  }
  latencies.sort((a, b) => a - b);

  return {
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(durationMs * 100) / 100,
    target: {
      baseUrl: config.baseUrl,
      recipient: maskEmail(config.testRecipient),
      smtpAccount: config.smtpAccount || "default",
      category: config.category,
      tenantId: config.tenantId,
      profile: config.profile,
    },
    plan: {
      total: config.total,
      concurrency: config.concurrency,
      batchDelayMs: config.batchDelayMs,
      requestTimeoutMs: config.timeoutMs,
      htmlBytes: config.htmlBytes,
      htmlMb: config.htmlMb,
      estimatedTotalPayloadBytes: config.estimatedTotalPayloadBytes,
      rateLimitMax: config.rateLimitMax,
      rateLimitWindowMs: config.rateLimitWindowMs,
      queueBackend: config.queueBackend,
      queueMaxSize: config.queueMaxSize,
      workerConcurrency: config.workerConcurrency,
    },
    statusCounts,
    latencyMs: {
      min: percentile(latencies, 0),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: percentile(latencies, 100),
      avg: average(latencies),
    },
    results,
  };
}

function printPlan(config) {
  console.log("MailFastApi overload plan");
  console.log(`- profile: ${config.profile}`);
  console.log(`- endpoint: ${config.baseUrl}/send`);
  console.log(`- recipient: ${maskEmail(config.testRecipient)}`);
  console.log(`- smtp account: ${config.smtpAccount || "default"}`);
  console.log(`- total attempts: ${config.total}`);
  console.log(`- concurrency: ${config.concurrency}`);
  console.log(
    `- message html size: ${formatBytes(config.htmlBytes)} each, estimated total ${formatBytes(
      config.estimatedTotalPayloadBytes,
    )}`,
  );
  console.log(`- api rate limit: ${config.rateLimitMax}/${config.rateLimitWindowMs}ms`);
  console.log(`- queue: ${config.queueBackend}, max=${config.queueMaxSize}`);
  console.log(`- worker concurrency: ${config.workerConcurrency}`);
  if (config.profile === "api-limit") {
    console.log("- expected: API should queue up to the configured rate limit, then return 429.");
  } else if (config.profile === "max-performance") {
    console.log("- expected: API, queue, worker, and SMTP provider are pushed with high concurrency and MB payloads.");
  } else {
    console.log("- expected: SMTP provider/worker/queue path is stressed; raise API rate limit first.");
  }
}

function printSummary(report) {
  console.log("");
  console.log("Overload summary");
  console.log(`- durationMs: ${report.durationMs}`);
  console.log(`- statusCounts: ${JSON.stringify(report.statusCounts)}`);
  console.log(`- latencyMs: ${JSON.stringify(report.latencyMs)}`);
  console.log(`- report: ${report.reportPath || "written"}`);
}

function writeReport(reportPath, report) {
  const absolute = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const output = { ...report, reportPath };
  fs.writeFileSync(absolute, `${JSON.stringify(output, null, 2)}\n`);
  report.reportPath = reportPath;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function percentile(values, p) {
  if (!values.length) {
    return null;
  }
  if (p <= 0) return values[0];
  if (p >= 100) return values[values.length - 1];
  const index = Math.ceil((p / 100) * values.length) - 1;
  return values[Math.max(0, Math.min(values.length - 1, index))];
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function maskEmail(value) {
  const email = clean(value);
  const at = email.indexOf("@");
  if (at <= 1) {
    return email ? "***" : "";
  }
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return Boolean(fallback);
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveHtmlBytes(env) {
  const explicitMb = clean(env.OVERLOAD_HTML_MB);
  if (explicitMb) {
    const parsedMb = Number.parseFloat(explicitMb.replace(",", "."));
    if (!Number.isFinite(parsedMb) || parsedMb <= 0) {
      throw new Error("OVERLOAD_HTML_MB must be a positive number.");
    }
    return Math.max(32, Math.round(parsedMb * 1024 * 1024));
  }
  return Math.max(32, toInt(env.OVERLOAD_HTML_BYTES, 512));
}

function resolveRecommendedTotal(profile, rateLimitMax) {
  if (profile === "max-performance") {
    return 2000;
  }
  if (profile === "smtp-provider") {
    return Math.max(1000, Math.min(rateLimitMax + 1, 5000));
  }
  return Math.max(rateLimitMax + Math.ceil(rateLimitMax * 0.25), rateLimitMax + 1);
}

function resolveRecommendedConcurrency(profile, workerConcurrency) {
  if (profile === "max-performance") {
    return Math.max(100, workerConcurrency * 4);
  }
  if (profile === "smtp-provider") {
    return Math.max(25, workerConcurrency * 10);
  }
  return Math.max(10, workerConcurrency * 10);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024) * 100) / 100} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round((bytes / 1024) * 100) / 100} KB`;
  }
  return `${bytes} B`;
}

function clean(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error && error.message ? error.message : "Unknown error";
}
