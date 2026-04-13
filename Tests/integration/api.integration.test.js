"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { before, after, describe, test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
require("dotenv").config();

const { startTestServer } = require("../helpers/server");

const MAILSEND_MODE = String(process.env.MAILSEND_MODE || "").toLowerCase() === "true";
const REAL_MAIL_TO = process.env.TEST_MAIL_TO || "";

describe("API integration", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startTestServer();
    baseUrl = server.baseUrl;
  });

  after(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("GET /health returns healthy status", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.authMode, "jwt");
  });

  test("POST /send without token returns 401", async () => {
    const response = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "user@example.com",
        subject: "No Token",
        html: "<p>Denied</p>",
      }),
    });

    assert.equal(response.status, 401);
  });

  test("POST /auth/token returns access token", async () => {
    const response = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "test-client",
        clientSecret: "test-client-secret",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.token_type, "Bearer");
    assert.equal(typeof body.access_token, "string");
    assert.ok(body.access_token.length > 20);
    assert.equal(typeof body.expires_in, "number");
  });

  test("POST /send with token queues mail", async () => {
    const tokenResponse = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "test-client",
        clientSecret: "test-client-secret",
      }),
    });
    const tokenBody = await tokenResponse.json();

    const response = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({
        to: "user@example.com",
        subject: "Queued Mail",
        html: "<h1>Hello</h1>",
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.deepEqual(body, { status: "queued" });
  });

  test("POST /send with invalid payload returns 400", async () => {
    const tokenBody = await getToken(baseUrl);

    const response = await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({
        to: "not-an-email",
        subject: "",
        html: "",
      }),
    });

    assert.equal(response.status, 400);
  });

  test(
    "POST /send sends real mail and sends metrics/performance report mail",
    { skip: !MAILSEND_MODE || !REAL_MAIL_TO },
    async () => {
      const realServer = await startTestServer({ useRealSmtp: true });

      try {
        const marker = `mailsend-${Date.now()}`;
        const tokenMeasure = await measureToken(realServer.baseUrl);
        const healthBefore = await getHealth(realServer.baseUrl);

        const probeMail = {
          to: REAL_MAIL_TO,
          subject: `[mailFastApi Probe] ${marker}`,
          html: `<h1>mailFastApi Probe</h1><p>Marker: ${escapeHtml(marker)}</p><p>This is a probe mail used to collect SMTP delivery metrics.</p>`,
        };

        const probeSend = await sendQueuedMail({
          baseUrl: realServer.baseUrl,
          token: tokenMeasure.token.access_token,
          mail: probeMail,
          server: realServer,
        });

        assert.equal(probeSend.statusCode, 202);
        assert.deepEqual(probeSend.body, { status: "queued" });

        const probeRequestLog = await waitForRequestReceivedLog({
          server: realServer,
          fromOffset: probeSend.logOffset,
          to: REAL_MAIL_TO,
          timeoutMs: 5000,
        });

        const probeMailSentLog = await waitForMailSentLog({
          server: realServer,
          fromOffset: probeSend.logOffset,
          jobId: probeRequestLog.meta.jobId,
          timeoutMs: 30000,
        });

        const healthAfterProbe = await getHealth(realServer.baseUrl);
        const endToEndMs = calculateEndToEndMs(
          probeSend.requestStartedAtEpochMs,
          probeMailSentLog.timestamp,
        );

        const reportMail = {
          to: REAL_MAIL_TO,
          subject: `[mailFastApi Metrics Report] ${marker}`,
          html: buildMetricsReportHtml({
            marker,
            probeMail,
            healthBefore,
            healthAfterProbe,
            tokenMeasure,
            probeSend,
            probeRequestLog,
            probeMailSentLog,
            endToEndMs,
          }),
        };

        const reportSend = await sendQueuedMail({
          baseUrl: realServer.baseUrl,
          token: tokenMeasure.token.access_token,
          mail: reportMail,
          server: realServer,
        });

        assert.equal(reportSend.statusCode, 202);
        assert.deepEqual(reportSend.body, { status: "queued" });

        const reportRequestLog = await waitForRequestReceivedLog({
          server: realServer,
          fromOffset: reportSend.logOffset,
          to: REAL_MAIL_TO,
          timeoutMs: 5000,
        });

        await waitForMailSentLog({
          server: realServer,
          fromOffset: reportSend.logOffset,
          jobId: reportRequestLog.meta.jobId,
          timeoutMs: 30000,
        });
      } finally {
        await realServer.stop();
      }
    },
  );
});

if (MAILSEND_MODE && !REAL_MAIL_TO) {
  console.warn(
    "[tests] mailsend mode enabled but TEST_MAIL_TO is missing. Real mail send test was skipped.",
  );
}

async function getToken(baseUrl) {
  const tokenResponse = await fetch(`${baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "test-client",
      clientSecret: "test-client-secret",
    }),
  });

  assert.equal(tokenResponse.status, 200);
  return tokenResponse.json();
}

async function measureToken(baseUrl) {
  const start = performance.now();
  const token = await getToken(baseUrl);
  return {
    token,
    latencyMs: roundMs(performance.now() - start),
  };
}

async function getHealth(baseUrl) {
  const start = performance.now();
  const response = await fetch(`${baseUrl}/health`);
  const latencyMs = roundMs(performance.now() - start);

  assert.equal(response.status, 200);
  const body = await response.json();
  return {
    ...body,
    latencyMs,
  };
}

async function sendQueuedMail({ baseUrl, token, mail, server }) {
  const requestStartedAtEpochMs = Date.now();
  const start = performance.now();
  const logOffset = server.getLogs().length;

  const response = await fetch(`${baseUrl}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(mail),
  });

  const latencyMs = roundMs(performance.now() - start);
  const body = await response.json();

  return {
    statusCode: response.status,
    body,
    latencyMs,
    logOffset,
    requestStartedAtEpochMs,
  };
}

async function waitForRequestReceivedLog({ server, fromOffset, to, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const logs = server.getLogs().slice(fromOffset);
    const entries = parseLogEntries(logs);

    const requestEntry = entries.find(
      (entry) =>
        entry.message === "request received" &&
        entry.meta &&
        entry.meta.path === "/send" &&
        entry.meta.to === to &&
        typeof entry.meta.jobId === "string",
    );

    if (requestEntry) {
      return requestEntry;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for request-received log for recipient: ${to}\nLast logs:\n${getLastLogLines(server.getLogs(), 20)}`,
  );
}

async function waitForMailSentLog({ server, fromOffset, jobId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const logs = server.getLogs().slice(fromOffset);
    const entries = parseLogEntries(logs);

    const sentEntry = entries.find(
      (entry) => entry.message === "mail sent" && entry.meta && entry.meta.jobId === jobId,
    );
    if (sentEntry) {
      return sentEntry;
    }

    const failedEntry = entries.find(
      (entry) => entry.message === "mail failed" && entry.meta && entry.meta.jobId === jobId,
    );
    if (failedEntry) {
      throw new Error(
        `Real mail send failed for job: ${jobId}\nLast logs:\n${getLastLogLines(server.getLogs(), 20)}`,
      );
    }

    await delay(150);
  }

  throw new Error(
    `Timed out waiting for "mail sent" log for job: ${jobId}\nLast logs:\n${getLastLogLines(server.getLogs(), 20)}`,
  );
}

function parseLogEntries(logText) {
  return String(logText)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseLogEntry)
    .filter(Boolean);
}

function parseLogEntry(line) {
  const match = line.match(
    /^\[(?<timestamp>[^\]]+)\] \[(?<level>[^\]]+)\] (?<message>.*?)(?: (?<meta>\{.*\}))?$/,
  );
  if (!match || !match.groups) {
    return null;
  }

  let meta = null;
  if (match.groups.meta) {
    try {
      meta = JSON.parse(match.groups.meta);
    } catch (error) {
      meta = null;
    }
  }

  return {
    timestamp: match.groups.timestamp,
    level: match.groups.level,
    message: match.groups.message.trim(),
    meta,
    raw: line,
  };
}

function buildMetricsReportHtml(params) {
  const {
    marker,
    probeMail,
    healthBefore,
    healthAfterProbe,
    tokenMeasure,
    probeSend,
    probeRequestLog,
    probeMailSentLog,
    endToEndMs,
  } = params;

  return `
    <h1>mailFastApi MailSend Metrics Report</h1>
    <p><strong>Marker:</strong> ${escapeHtml(marker)}</p>
    <p><strong>Generated At:</strong> ${escapeHtml(new Date().toISOString())}</p>

    <h2>Mail Content (Probe)</h2>
    <p><strong>To:</strong> ${escapeHtml(probeMail.to)}</p>
    <p><strong>Subject:</strong> ${escapeHtml(probeMail.subject)}</p>
    <p><strong>Body:</strong></p>
    <div style="padding:10px;border:1px solid #ddd;background:#f9f9f9;">${probeMail.html}</div>

    <h2>Mail System Metrics</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><td>Request Job ID</td><td>${escapeHtml(probeRequestLog.meta.jobId)}</td></tr>
      <tr><td>SMTP Message ID</td><td>${escapeHtml(String(probeMailSentLog.meta.messageId || ""))}</td></tr>
      <tr><td>Attempt</td><td>${escapeHtml(String(probeMailSentLog.meta.attempt || ""))}</td></tr>
      <tr><td>Queue Latency (ms)</td><td>${escapeHtml(String(probeMailSentLog.meta.queueLatencyMs || ""))}</td></tr>
      <tr><td>Dispatch Latency (ms)</td><td>${escapeHtml(String(probeMailSentLog.meta.dispatchLatencyMs || ""))}</td></tr>
    </table>

    <h2>Performance Metrics</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><td>Token Endpoint Latency (ms)</td><td>${escapeHtml(String(tokenMeasure.latencyMs))}</td></tr>
      <tr><td>Send Endpoint ACK Latency (ms)</td><td>${escapeHtml(String(probeSend.latencyMs))}</td></tr>
      <tr><td>End-to-End Delivery (ms)</td><td>${escapeHtml(String(endToEndMs))}</td></tr>
      <tr><td>Health Before - queueDepth</td><td>${escapeHtml(String(healthBefore.queueDepth))}</td></tr>
      <tr><td>Health Before - activeJobs</td><td>${escapeHtml(String(healthBefore.activeJobs))}</td></tr>
      <tr><td>Health Before - uptimeSec</td><td>${escapeHtml(String(healthBefore.uptimeSec))}</td></tr>
      <tr><td>Health Before - responseLatencyMs</td><td>${escapeHtml(String(healthBefore.latencyMs))}</td></tr>
      <tr><td>Health After Probe - queueDepth</td><td>${escapeHtml(String(healthAfterProbe.queueDepth))}</td></tr>
      <tr><td>Health After Probe - activeJobs</td><td>${escapeHtml(String(healthAfterProbe.activeJobs))}</td></tr>
      <tr><td>Health After Probe - uptimeSec</td><td>${escapeHtml(String(healthAfterProbe.uptimeSec))}</td></tr>
      <tr><td>Health After Probe - responseLatencyMs</td><td>${escapeHtml(String(healthAfterProbe.latencyMs))}</td></tr>
      <tr><td>JWT Expires In (sec)</td><td>${escapeHtml(String(tokenMeasure.token.expires_in || ""))}</td></tr>
    </table>
  `;
}

function calculateEndToEndMs(requestStartedAtEpochMs, sentTimestampIso) {
  const sentAt = Date.parse(sentTimestampIso);
  if (!Number.isFinite(sentAt)) {
    return "";
  }
  return Math.max(0, Math.round(sentAt - requestStartedAtEpochMs));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function roundMs(value) {
  return Math.round(Number(value));
}

function getLastLogLines(logs, count) {
  return String(logs)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .join("\n");
}
