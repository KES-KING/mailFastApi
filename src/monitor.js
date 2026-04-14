"use strict";

function createMonitor(options = {}) {
  const maxRecentEntries = Math.max(50, toInt(options.maxRecentEntries, 400));
  const maxTimelineMinutes = Math.max(10, toInt(options.maxTimelineMinutes, 180));
  const startedAtMs = Date.now();

  const totals = {
    logsTotal: 0,
    requestReceivedTotal: 0,
    sendRequestsTotal: 0,
    mailQueuedTotal: 0,
    mailSentTotal: 0,
    mailFailedTotal: 0,
    mailRetryTotal: 0,
    authTokenIssuedTotal: 0,
    internalErrorTotal: 0,
  };

  const levels = {
    INFO: 0,
    WARN: 0,
    ERROR: 0,
    DEBUG: 0,
  };

  const recentEntries = [];
  const timelineByMinute = new Map();

  function ingestLogEntry(entry) {
    const normalized = normalizeEntry(entry);
    if (!normalized) {
      return;
    }

    totals.logsTotal += 1;
    levels[normalized.level] = (levels[normalized.level] || 0) + 1;

    updateTotalsByEvent(normalized);
    updateTimeline(normalized);

    recentEntries.push(normalized);
    if (recentEntries.length > maxRecentEntries) {
      recentEntries.splice(0, recentEntries.length - maxRecentEntries);
    }
  }

  function getSnapshot(runtime = {}) {
    return {
      generatedAt: new Date().toISOString(),
      uptimeSec: round2((Date.now() - startedAtMs) / 1000),
      runtime: {
        queueDepth: numberOrNull(runtime.queueDepth),
        activeJobs: numberOrNull(runtime.activeJobs),
        authMode: runtime.authMode || null,
        queueBackend: runtime.queueBackend || null,
        port: numberOrNull(runtime.port),
      },
      totals: { ...totals },
      levels: { ...levels },
      timeline: getTimelineRows(),
      recent: recentEntries.slice(-120),
    };
  }

  function toPrometheus(runtime = {}) {
    const uptimeSec = round3((Date.now() - startedAtMs) / 1000);
    const queueDepth = numberOrZero(runtime.queueDepth);
    const activeJobs = numberOrZero(runtime.activeJobs);

    const lines = [
      "# HELP mailfastapi_uptime_seconds Process uptime in seconds.",
      "# TYPE mailfastapi_uptime_seconds gauge",
      `mailfastapi_uptime_seconds ${uptimeSec}`,
      "",
      "# HELP mailfastapi_queue_depth Current queue depth.",
      "# TYPE mailfastapi_queue_depth gauge",
      `mailfastapi_queue_depth ${queueDepth}`,
      "",
      "# HELP mailfastapi_active_jobs Current active worker jobs.",
      "# TYPE mailfastapi_active_jobs gauge",
      `mailfastapi_active_jobs ${activeJobs}`,
      "",
      "# HELP mailfastapi_logs_total Total logs ingested by monitor.",
      "# TYPE mailfastapi_logs_total counter",
      `mailfastapi_logs_total ${totals.logsTotal}`,
      "",
      "# HELP mailfastapi_send_requests_total Total /send API requests received.",
      "# TYPE mailfastapi_send_requests_total counter",
      `mailfastapi_send_requests_total ${totals.sendRequestsTotal}`,
      "",
      "# HELP mailfastapi_mail_queued_total Total queued mail jobs.",
      "# TYPE mailfastapi_mail_queued_total counter",
      `mailfastapi_mail_queued_total ${totals.mailQueuedTotal}`,
      "",
      "# HELP mailfastapi_mail_sent_total Total sent mails.",
      "# TYPE mailfastapi_mail_sent_total counter",
      `mailfastapi_mail_sent_total ${totals.mailSentTotal}`,
      "",
      "# HELP mailfastapi_mail_failed_total Total failed mails.",
      "# TYPE mailfastapi_mail_failed_total counter",
      `mailfastapi_mail_failed_total ${totals.mailFailedTotal}`,
      "",
      "# HELP mailfastapi_mail_retry_total Total mail retries.",
      "# TYPE mailfastapi_mail_retry_total counter",
      `mailfastapi_mail_retry_total ${totals.mailRetryTotal}`,
      "",
      "# HELP mailfastapi_auth_token_issued_total Total issued auth tokens.",
      "# TYPE mailfastapi_auth_token_issued_total counter",
      `mailfastapi_auth_token_issued_total ${totals.authTokenIssuedTotal}`,
      "",
      "# HELP mailfastapi_internal_error_total Total internal errors logged.",
      "# TYPE mailfastapi_internal_error_total counter",
      `mailfastapi_internal_error_total ${totals.internalErrorTotal}`,
      "",
      "# HELP mailfastapi_log_level_total Logs grouped by level.",
      "# TYPE mailfastapi_log_level_total counter",
      `mailfastapi_log_level_total{level="INFO"} ${levels.INFO || 0}`,
      `mailfastapi_log_level_total{level="WARN"} ${levels.WARN || 0}`,
      `mailfastapi_log_level_total{level="ERROR"} ${levels.ERROR || 0}`,
      `mailfastapi_log_level_total{level="DEBUG"} ${levels.DEBUG || 0}`,
      "",
    ];

    return lines.join("\n");
  }

  return {
    ingestLogEntry,
    getSnapshot,
    toPrometheus,
  };

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const timestamp = entry.timestamp || new Date().toISOString();
    const createdAtMs = Number.isFinite(entry.createdAtMs)
      ? Number(entry.createdAtMs)
      : Date.parse(timestamp);
    const event = typeof entry.event === "string" ? entry.event : "event";
    const level = String(entry.level || "INFO").toUpperCase();
    const details =
      entry.details && typeof entry.details === "object" ? { ...entry.details } : {};

    return {
      timestamp,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      level,
      event,
      source: entry.source || "app",
      traceId: entry.traceId || null,
      details,
    };
  }

  function updateTotalsByEvent(entry) {
    if (entry.event === "request received") {
      totals.requestReceivedTotal += 1;
      if (entry.details && entry.details.path === "/send") {
        totals.sendRequestsTotal += 1;
      }
      return;
    }

    if (entry.event === "mail queued") {
      totals.mailQueuedTotal += 1;
      return;
    }
    if (entry.event === "mail sent") {
      totals.mailSentTotal += 1;
      return;
    }
    if (entry.event === "mail failed") {
      totals.mailFailedTotal += 1;
      return;
    }
    if (entry.event === "mail send failed, retrying") {
      totals.mailRetryTotal += 1;
      return;
    }
    if (entry.event === "auth token issued") {
      totals.authTokenIssuedTotal += 1;
      return;
    }
    if (entry.event === "internal error") {
      totals.internalErrorTotal += 1;
    }
  }

  function updateTimeline(entry) {
    const minuteMs = Math.floor(entry.createdAtMs / 60000) * 60000;
    const bucket = timelineByMinute.get(minuteMs) || createTimelineBucket(minuteMs);

    if (entry.event === "request received" && entry.details && entry.details.path === "/send") {
      bucket.sendRequests += 1;
    } else if (entry.event === "mail queued") {
      bucket.mailQueued += 1;
    } else if (entry.event === "mail sent") {
      bucket.mailSent += 1;
    } else if (entry.event === "mail failed") {
      bucket.mailFailed += 1;
    } else if (entry.event === "mail send failed, retrying") {
      bucket.mailRetry += 1;
    } else if (entry.event === "auth token issued") {
      bucket.tokenIssued += 1;
    }

    timelineByMinute.set(minuteMs, bucket);
    pruneTimeline(minuteMs);
  }

  function createTimelineBucket(minuteMs) {
    return {
      minuteMs,
      minuteIso: new Date(minuteMs).toISOString(),
      sendRequests: 0,
      mailQueued: 0,
      mailSent: 0,
      mailFailed: 0,
      mailRetry: 0,
      tokenIssued: 0,
    };
  }

  function pruneTimeline(latestMinuteMs) {
    const oldestKept = latestMinuteMs - (maxTimelineMinutes - 1) * 60000;
    for (const key of timelineByMinute.keys()) {
      if (key < oldestKept) {
        timelineByMinute.delete(key);
      }
    }
  }

  function getTimelineRows() {
    return [...timelineByMinute.values()].sort((a, b) => a.minuteMs - b.minuteMs);
  }
}

function renderMonitorPageHtml(options = {}) {
  const title = escapeHtml(options.title || "mailFastApi Monitor");
  const statsPath = escapeHtml(options.statsPath || "/monitor/stats");
  const streamPath = escapeHtml(options.streamPath || "/monitor/stream");
  const metricsPath = escapeHtml(options.metricsPath || "/metrics");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111827;
      --panel-2: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --accent: #22d3ee;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --line: #374151;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Roboto, Arial, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1e293b 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap {
      width: min(1200px, 96vw);
      margin: 18px auto 24px auto;
    }
    .topbar {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .meta {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      display: inline-block;
      background: var(--warn);
      box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.8);
      animation: pulse 1.8s infinite;
    }
    .dot.ok { background: var(--ok); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.8); }
    .dot.err { background: var(--err); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.8); }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
      100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .card {
      background: linear-gradient(180deg, var(--panel-2), var(--panel));
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 9px 10px;
      min-height: 68px;
    }
    .card .k {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .card .v {
      font-weight: 700;
      font-size: 21px;
      color: #f8fafc;
    }
    .panels {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 10px;
    }
    .panel {
      background: linear-gradient(180deg, var(--panel-2), var(--panel));
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
    }
    .panel h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
      font-weight: 700;
      color: #cbd5e1;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    canvas {
      width: 100%;
      height: 230px;
      border-radius: 8px;
      background: #0b1220;
      border: 1px solid #243244;
      display: block;
    }
    .table-wrap {
      max-height: 380px;
      overflow: auto;
      border-radius: 8px;
      border: 1px solid #243244;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      text-align: left;
      background: #0b1220;
      color: #94a3b8;
      border-bottom: 1px solid #334155;
      padding: 8px;
      font-weight: 700;
    }
    tbody td {
      padding: 7px 8px;
      border-bottom: 1px solid #1f2937;
      color: #e2e8f0;
      vertical-align: top;
      word-break: break-word;
    }
    tbody tr:hover td { background: #111827; }
    .lvl-ERROR { color: #fca5a5; }
    .lvl-WARN { color: #fcd34d; }
    .lvl-INFO { color: #86efac; }
    .muted { color: var(--muted); }
    .links {
      margin-top: 8px;
      font-size: 12px;
      color: var(--muted);
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .links a { color: var(--accent); text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    @media (max-width: 980px) {
      .grid { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
      .panels { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="title">${title}</div>
      <div class="meta">
        <span id="conn-dot" class="dot"></span>
        <span id="conn-text">Connecting stream...</span>
        <span id="updated">Updated: -</span>
      </div>
    </div>

    <section class="grid">
      <article class="card"><div class="k">Send Requests</div><div id="sendRequests" class="v">0</div></article>
      <article class="card"><div class="k">Mail Queued</div><div id="mailQueued" class="v">0</div></article>
      <article class="card"><div class="k">Mail Sent</div><div id="mailSent" class="v">0</div></article>
      <article class="card"><div class="k">Mail Failed</div><div id="mailFailed" class="v">0</div></article>
      <article class="card"><div class="k">Queue Depth</div><div id="queueDepth" class="v">0</div></article>
      <article class="card"><div class="k">Active Jobs</div><div id="activeJobs" class="v">0</div></article>
    </section>

    <section class="panels">
      <article class="panel">
        <h3>Timeline (per minute)</h3>
        <canvas id="timelineChart" width="820" height="260"></canvas>
      </article>
      <article class="panel">
        <h3>Runtime</h3>
        <div style="font-size:13px;line-height:1.8;">
          <div><span class="muted">Uptime:</span> <strong id="uptime">-</strong></div>
          <div><span class="muted">Auth Mode:</span> <strong id="authMode">-</strong></div>
          <div><span class="muted">Queue Backend:</span> <strong id="queueBackend">-</strong></div>
          <div><span class="muted">Port:</span> <strong id="port">-</strong></div>
          <div><span class="muted">Token Issued:</span> <strong id="tokenIssued">0</strong></div>
          <div><span class="muted">Retries:</span> <strong id="mailRetry">0</strong></div>
          <div><span class="muted">Total Logs:</span> <strong id="logsTotal">0</strong></div>
          <div><span class="muted">Errors:</span> <strong id="errorsTotal">0</strong></div>
        </div>
        <div class="links">
          <a href="${metricsPath}" target="_blank" rel="noreferrer">Prometheus Metrics</a>
          <a href="${statsPath}" target="_blank" rel="noreferrer">Raw JSON</a>
        </div>
      </article>
    </section>

    <section class="panel" style="margin-top:10px;">
      <h3>Recent Events</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:165px;">Time</th>
              <th style="width:70px;">Level</th>
              <th style="width:180px;">Event</th>
              <th style="width:70px;">Source</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody id="eventsBody"></tbody>
        </table>
      </div>
    </section>
  </div>

  <script>
    const statsPath = "${statsPath}";
    const streamPath = "${streamPath}";
    const state = { snapshot: null };

    const ids = {
      sendRequests: document.getElementById("sendRequests"),
      mailQueued: document.getElementById("mailQueued"),
      mailSent: document.getElementById("mailSent"),
      mailFailed: document.getElementById("mailFailed"),
      queueDepth: document.getElementById("queueDepth"),
      activeJobs: document.getElementById("activeJobs"),
      uptime: document.getElementById("uptime"),
      authMode: document.getElementById("authMode"),
      queueBackend: document.getElementById("queueBackend"),
      port: document.getElementById("port"),
      tokenIssued: document.getElementById("tokenIssued"),
      mailRetry: document.getElementById("mailRetry"),
      logsTotal: document.getElementById("logsTotal"),
      errorsTotal: document.getElementById("errorsTotal"),
      eventsBody: document.getElementById("eventsBody"),
      updated: document.getElementById("updated"),
      connDot: document.getElementById("conn-dot"),
      connText: document.getElementById("conn-text"),
      chart: document.getElementById("timelineChart"),
    };

    let es = null;
    let pollingTimer = null;

    connectSse();
    refreshNow();

    async function refreshNow() {
      try {
        const response = await fetch(statsPath, { cache: "no-store" });
        if (!response.ok) throw new Error("stats request failed");
        const snapshot = await response.json();
        applySnapshot(snapshot);
      } catch (error) {
        setConnection("err", "Snapshot fetch failed");
      }
    }

    function connectSse() {
      if (es) {
        try { es.close(); } catch (_) {}
      }

      try {
        es = new EventSource(streamPath);
      } catch (error) {
        fallbackPolling();
        return;
      }

      es.addEventListener("snapshot", (event) => {
        try {
          const payload = JSON.parse(event.data);
          applySnapshot(payload);
          setConnection("ok", "Live stream connected");
        } catch (error) {}
      });

      es.onerror = () => {
        setConnection("warn", "Stream disconnected, polling...");
        fallbackPolling();
      };
    }

    function fallbackPolling() {
      if (pollingTimer) return;
      pollingTimer = setInterval(() => {
        refreshNow();
      }, 3000);
    }

    function stopPolling() {
      if (!pollingTimer) return;
      clearInterval(pollingTimer);
      pollingTimer = null;
    }

    function setConnection(kind, text) {
      ids.connText.textContent = text;
      ids.connDot.className = "dot " + (kind === "ok" ? "ok" : kind === "err" ? "err" : "");
      if (kind === "ok") {
        stopPolling();
      }
    }

    function applySnapshot(snapshot) {
      state.snapshot = snapshot;
      const t = snapshot.totals || {};
      const r = snapshot.runtime || {};

      ids.sendRequests.textContent = n(t.sendRequestsTotal);
      ids.mailQueued.textContent = n(t.mailQueuedTotal);
      ids.mailSent.textContent = n(t.mailSentTotal);
      ids.mailFailed.textContent = n(t.mailFailedTotal);
      ids.queueDepth.textContent = n(r.queueDepth);
      ids.activeJobs.textContent = n(r.activeJobs);
      ids.uptime.textContent = sec(snapshot.uptimeSec);
      ids.authMode.textContent = r.authMode || "-";
      ids.queueBackend.textContent = r.queueBackend || "-";
      ids.port.textContent = n(r.port);
      ids.tokenIssued.textContent = n(t.authTokenIssuedTotal);
      ids.mailRetry.textContent = n(t.mailRetryTotal);
      ids.logsTotal.textContent = n(t.logsTotal);
      ids.errorsTotal.textContent = n(t.internalErrorTotal);
      ids.updated.textContent = "Updated: " + (snapshot.generatedAt || "-");

      renderEvents(snapshot.recent || []);
      renderTimeline(snapshot.timeline || []);
    }

    function renderEvents(entries) {
      const rows = entries.slice().reverse().slice(0, 120).map((entry) => {
        const lvl = esc(entry.level || "INFO");
        return "<tr>" +
          "<td>" + esc(entry.timestamp || "") + "</td>" +
          "<td class='lvl-" + lvl + "'>" + lvl + "</td>" +
          "<td>" + esc(entry.event || "") + "</td>" +
          "<td>" + esc(entry.source || "") + "</td>" +
          "<td><code>" + esc(JSON.stringify(entry.details || {})) + "</code></td>" +
          "</tr>";
      }).join("");
      ids.eventsBody.innerHTML = rows || "<tr><td colspan='5' class='muted'>No events yet</td></tr>";
    }

    function renderTimeline(points) {
      const canvas = ids.chart;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      const p = 30;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0b1220";
      ctx.fillRect(0, 0, w, h);

      if (!points || points.length === 0) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = "12px Segoe UI";
        ctx.fillText("No timeline data yet", 12, 20);
        return;
      }

      const values = points.map((x) =>
        Math.max(
          Number(x.sendRequests || 0),
          Number(x.mailSent || 0),
          Number(x.mailFailed || 0),
        ),
      );
      const maxY = Math.max(1, ...values);

      drawAxis(ctx, w, h, p, maxY);
      drawLine(ctx, points, w, h, p, maxY, "sendRequests", "#22d3ee");
      drawLine(ctx, points, w, h, p, maxY, "mailSent", "#22c55e");
      drawLine(ctx, points, w, h, p, maxY, "mailFailed", "#ef4444");

      drawLegend(ctx, w, h, [
        ["Send Requests", "#22d3ee"],
        ["Mail Sent", "#22c55e"],
        ["Mail Failed", "#ef4444"],
      ]);
    }

    function drawAxis(ctx, w, h, p, maxY) {
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p, h - p);
      ctx.lineTo(w - p, h - p);
      ctx.moveTo(p, p);
      ctx.lineTo(p, h - p);
      ctx.stroke();

      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px Segoe UI";
      ctx.fillText(String(maxY), 6, p + 4);
      ctx.fillText("0", 14, h - p + 4);
    }

    function drawLine(ctx, points, w, h, p, maxY, key, color) {
      const nPoints = points.length;
      if (nPoints <= 0) return;
      const xStep = nPoints === 1 ? 0 : (w - p * 2) / (nPoints - 1);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();

      for (let i = 0; i < nPoints; i += 1) {
        const v = Number(points[i][key] || 0);
        const x = p + i * xStep;
        const y = h - p - (v / maxY) * (h - p * 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    function drawLegend(ctx, w, h, items) {
      let x = 10;
      const y = h - 8;
      ctx.font = "11px Segoe UI";
      for (const [label, color] of items) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 8, 10, 3);
        x += 14;
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(label, x, y);
        x += ctx.measureText(label).width + 14;
      }
    }

    function n(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return Number(value).toLocaleString("en-US");
    }

    function sec(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const s = Math.floor(Number(value));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      return h + "h " + m + "m " + ss + "s";
    }

    function esc(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Number(Number(value).toFixed(2));
}

function round3(value) {
  return Number(Number(value).toFixed(3));
}

module.exports = {
  createMonitor,
  renderMonitorPageHtml,
};

