"use strict";

require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const modeArg = String(process.argv[2] || "").trim().toLowerCase();

if (modeArg !== "mailsender") {
  printUsage();
  process.exit(1);
}

const dbPath = path.resolve(process.env.LOG_DB_PATH || "data/mailfastapi.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    source TEXT NOT NULL,
    trace_id TEXT,
    details_json TEXT,
    created_at_ms INTEGER NOT NULL
  );
`);

try {
  renderDashboard();
} finally {
  db.close();
}

function renderDashboard() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const totals = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN event = 'mail sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN event = 'mail failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN event = 'mail send failed, retrying' THEN 1 ELSE 0 END) AS retries
      FROM system_logs
      WHERE created_at_ms >= ?;
    `,
    )
    .get(oneDayAgo);

  const levelRows = db
    .prepare(
      `
      SELECT level, COUNT(*) AS count
      FROM system_logs
      WHERE created_at_ms >= ?
      GROUP BY level
      ORDER BY count DESC;
    `,
    )
    .all(oneDayAgo);

  const topEvents = db
    .prepare(
      `
      SELECT event, COUNT(*) AS count
      FROM system_logs
      WHERE created_at_ms >= ?
      GROUP BY event
      ORDER BY count DESC
      LIMIT 10;
    `,
    )
    .all(oneDayAgo);

  const recentRows = db
    .prepare(
      `
      SELECT timestamp, level, event, details_json
      FROM system_logs
      ORDER BY id DESC
      LIMIT 30;
    `,
    )
    .all();

  const throughputRows = db
    .prepare(
      `
      SELECT timestamp, event
      FROM system_logs
      WHERE created_at_ms >= ?
        AND event IN ('mail sent', 'mail failed')
      ORDER BY id ASC;
    `,
    )
    .all(oneHourAgo);

  const latencyRows = db
    .prepare(
      `
      SELECT details_json
      FROM system_logs
      WHERE created_at_ms >= ?
        AND event = 'mail sent'
      ORDER BY id DESC
      LIMIT 1000;
    `,
    )
    .all(oneDayAgo);

  const latencyStats = buildLatencyStats(latencyRows);
  const perMinute = buildPerMinuteSeries(throughputRows, oneHourAgo, now);

  printHeader("mailFastApi :: MailSender Log Dashboard");
  console.log(`DB Path: ${dbPath}`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log("");

  printHeader("24h Summary");
  console.log(`Total Logs       : ${totals.total || 0}`);
  console.log(`Mail Sent        : ${totals.sent || 0}`);
  console.log(`Mail Failed      : ${totals.failed || 0}`);
  console.log(`Retry Events     : ${totals.retries || 0}`);
  console.log("");

  printHeader("Level Distribution (24h)");
  if (levelRows.length === 0) {
    console.log("No log data.");
  } else {
    for (const row of levelRows) {
      console.log(`${pad(row.level, 8)} ${bar(row.count, getMax(levelRows, "count"), 28)} ${row.count}`);
    }
  }
  console.log("");

  printHeader("Top Events (24h)");
  if (topEvents.length === 0) {
    console.log("No event data.");
  } else {
    for (const row of topEvents) {
      console.log(`${pad(truncate(row.event, 40), 42)} ${pad(String(row.count), 6)}`);
    }
  }
  console.log("");

  printHeader("SMTP Latency Stats (mail sent, last 1000 rows / 24h)");
  console.log(`queueLatencyMs    avg=${latencyStats.queue.avg}  p95=${latencyStats.queue.p95}  max=${latencyStats.queue.max}`);
  console.log(
    `dispatchLatencyMs avg=${latencyStats.dispatch.avg}  p95=${latencyStats.dispatch.p95}  max=${latencyStats.dispatch.max}`,
  );
  console.log("");

  printHeader("1h Throughput Graph (per minute)");
  renderThroughputGraph(perMinute);
  console.log("");

  printHeader("Recent Logs (last 30)");
  for (const row of recentRows.reverse()) {
    const detailsPreview = summarizeJson(row.details_json, 80);
    console.log(`${row.timestamp} [${pad(row.level, 5)}] ${truncate(row.event, 38)} ${detailsPreview}`);
  }
}

function buildLatencyStats(rows) {
  const queueValues = [];
  const dispatchValues = [];

  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.details_json || "{}");
    } catch (error) {
      parsed = {};
    }

    if (Number.isFinite(parsed.queueLatencyMs)) {
      queueValues.push(parsed.queueLatencyMs);
    }
    if (Number.isFinite(parsed.dispatchLatencyMs)) {
      dispatchValues.push(parsed.dispatchLatencyMs);
    }
  }

  return {
    queue: stat(queueValues),
    dispatch: stat(dispatchValues),
  };
}

function buildPerMinuteSeries(rows, fromMs, toMs) {
  const bucketSizeMs = 60 * 1000;
  const bucketCount = Math.max(1, Math.ceil((toMs - fromMs) / bucketSizeMs));

  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const start = fromMs + i * bucketSizeMs;
    buckets.push({
      label: new Date(start).toISOString().slice(11, 16),
      sent: 0,
      failed: 0,
    });
  }

  for (const row of rows) {
    const atMs = Date.parse(row.timestamp);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs > toMs) {
      continue;
    }

    const index = Math.floor((atMs - fromMs) / bucketSizeMs);
    if (index < 0 || index >= buckets.length) {
      continue;
    }

    if (row.event === "mail sent") {
      buckets[index].sent += 1;
    } else if (row.event === "mail failed") {
      buckets[index].failed += 1;
    }
  }

  return buckets.slice(-30);
}

function renderThroughputGraph(series) {
  if (series.length === 0) {
    console.log("No throughput data.");
    return;
  }

  const maxValue = Math.max(
    1,
    ...series.map((item) => Math.max(item.sent, item.failed)),
  );

  console.log("Legend: S=mail sent, F=mail failed");
  for (const item of series) {
    const sentBars = bar(item.sent, maxValue, 20);
    const failBars = bar(item.failed, maxValue, 20);
    console.log(`${item.label} | S ${sentBars} ${pad(String(item.sent), 4)} | F ${failBars} ${pad(String(item.failed), 4)}`);
  }
}

function stat(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { avg: "n/a", p95: "n/a", max: "n/a" };
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const avg = Math.round(sum / sorted.length);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = Math.round(sorted[p95Index]);
  const max = Math.round(sorted[sorted.length - 1]);

  return { avg, p95, max };
}

function summarizeJson(raw, maxLength) {
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return truncate(String(raw), maxLength);
  }

  const compact = JSON.stringify(parsed);
  return truncate(compact, maxLength);
}

function printHeader(title) {
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function pad(value, length) {
  return String(value).padEnd(length, " ");
}

function truncate(value, maxLength) {
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function bar(value, max, width) {
  const safeValue = Math.max(0, Number(value) || 0);
  const safeMax = Math.max(1, Number(max) || 1);
  const filled = Math.round((safeValue / safeMax) * width);
  return "#".repeat(filled).padEnd(width, ".");
}

function getMax(rows, key) {
  return Math.max(1, ...rows.map((row) => Number(row[key]) || 0));
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm run log -- mailsender");
  console.log("");
  console.log("Examples:");
  console.log("  npm run log -- mailsender");
  console.log("  npm run log:mailsender");
}
