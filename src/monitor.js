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
        monitorPort: numberOrNull(runtime.monitorPort),
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
  const metricsViewPath = escapeHtml(options.metricsViewPath || "/monitor/metrics-view");
  const rawViewPath = escapeHtml(options.rawViewPath || "/monitor/raw-view");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #111217;
      --sidebar: #0c0e13;
      --header: #181b22;
      --panel: #1f2229;
      --panel-soft: #191c23;
      --line: #343a46;
      --text: #d8d9da;
      --muted: #9fa4ad;
      --good: #22c55e;
      --warn: #f59e0b;
      --bad: #ef4444;
      --json-key: #6ed0e0;
      --json-string: #7eb26d;
      --json-number: #eab839;
      --json-bool: #ba43a9;
      --json-null: #999;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 220px 1fr;
      background: var(--bg);
    }
    .sidebar {
      background: var(--sidebar);
      border-right: 1px solid #2c3039;
      padding: 10px 10px 16px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .brand {
      height: 40px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 6px;
      border-bottom: 1px solid #232830;
      margin-bottom: 8px;
    }
    .logo {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      background: #f2cc0c;
      color: #111;
    }
    .brand span {
      font-size: 13px;
      color: #d8d9da;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    .side-nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .side-nav a {
      text-decoration: none;
      color: #c7cbd1;
      font-size: 13px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 9px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .side-nav a:hover {
      background: #1f232b;
      border-color: #2f3541;
      color: #fff;
    }
    .side-nav a.active {
      background: #20242d;
      border-color: #3b424f;
      color: #fff;
    }
    .main {
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .topbar {
      height: 50px;
      border-bottom: 1px solid var(--line);
      background: var(--header);
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 14px;
      gap: 10px;
      flex-wrap: wrap;
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 36px;
    }
    .nav-arrow {
      border: 1px solid #3a404d;
      background: #1f232b;
      color: #d1d5db;
      border-radius: 3px;
      width: 28px;
      height: 28px;
      font-size: 15px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .dashboard-pill {
      border: 1px solid #3a404d;
      background: #232830;
      color: #f3f4f6;
      border-radius: 3px;
      padding: 6px 10px;
      font-size: 13px;
      font-weight: 600;
    }
    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--muted);
      font-size: 12px;
      min-height: 36px;
    }
    .wrap {
      padding: 12px;
      width: 100%;
    }
    .title-wrap {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
    }
    .title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0;
      color: #f3f4f6;
    }
    .subtitle {
      margin: 4px 0 0 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.4;
      max-width: 980px;
    }
    .meta {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
      background: var(--warn);
      border: 1px solid #d97706;
    }
    .dot.ok { background: var(--good); border-color: #16a34a; }
    .dot.err { background: var(--bad); border-color: #dc2626; }
    .links {
      margin-bottom: 10px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 12px;
    }
    .links a {
      color: #d8d9da;
      text-decoration: none;
      border: 1px solid #3b424f;
      background: #232830;
      border-radius: 4px;
      padding: 6px 10px;
      font-weight: 600;
    }
    .links a:hover {
      border-color: #515a6a;
      background: #2b313b;
      color: #fff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(8, minmax(120px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 4px;
      padding: 10px;
      min-height: 92px;
    }
    .card .k {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 7px;
      text-transform: uppercase;
      letter-spacing: 0.45px;
    }
    .card .v {
      font-size: 20px;
      font-weight: 700;
      color: #f3f4f6;
      margin-bottom: 4px;
      line-height: 1.1;
    }
    .card .note {
      font-size: 11px;
      line-height: 1.4;
      color: var(--muted);
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 4px;
      padding: 12px;
    }
    .panel h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
      font-weight: 700;
      color: #f3f4f6;
      text-transform: uppercase;
      letter-spacing: 0.45px;
    }
    .panel p {
      margin: 0 0 10px 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }
    .timeline-panel {
      margin-bottom: 10px;
    }
    .timeline-wrap {
      border: 1px solid #3a404d;
      background: #161a21;
      border-radius: 4px;
      padding: 8px;
    }
    canvas {
      width: 100%;
      min-height: 280px;
      display: block;
      border-radius: 4px;
      background: #161a21;
      border: 1px solid #303540;
    }
    .legend {
      margin-top: 8px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--muted);
    }
    .legend .item::before {
      content: "";
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 2px;
      margin-right: 6px;
      vertical-align: -1px;
    }
    .legend .req::before { background: #6ed0e0; }
    .legend .queued::before { background: #ef843c; }
    .legend .sent::before { background: #7eb26d; }
    .legend .failed::before { background: #e24d42; }
    .lower {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 10px;
      align-items: start;
    }
    .runtime-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      font-size: 12px;
      color: var(--text);
    }
    .runtime-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid #333944;
      padding-bottom: 6px;
    }
    .runtime-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .runtime-row .label { color: var(--muted); }
    .runtime-row .value { color: #f3f4f6; font-weight: 700; text-align: right; }
    .runtime-row .value.warn { color: #f2cc0c; }
    .runtime-row .value.bad { color: #f2495c; }
    .event-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .event-toolbar input,
    .event-toolbar select {
      background: #161a21;
      color: var(--text);
      border: 1px solid #3a404d;
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 12px;
      min-height: 34px;
    }
    .event-toolbar input {
      flex: 1 1 260px;
      min-width: 180px;
    }
    .table-wrap {
      max-height: 580px;
      overflow: auto;
      border-radius: 4px;
      border: 1px solid #3a404d;
      background: #161a21;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      text-align: left;
      background: #20252f;
      color: #c5cad3;
      border-bottom: 1px solid #3a404d;
      padding: 9px 8px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.45px;
    }
    tbody td {
      padding: 8px;
      border-bottom: 1px solid #323844;
      color: #d8d9da;
      vertical-align: top;
      word-break: break-word;
    }
    tbody tr:nth-child(even) td { background: #181c23; }
    tbody tr:hover td { background: #232a34; }
    .lvl-ERROR { color: #f2495c; font-weight: 700; }
    .lvl-WARN { color: #eab839; font-weight: 700; }
    .lvl-INFO { color: #7eb26d; font-weight: 700; }
    .lvl-DEBUG { color: #6ed0e0; font-weight: 700; }
    .trace {
      font-family: "Courier New", monospace;
      color: #c5cad3;
      font-size: 11px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 6px;
    }
    .chip {
      border: 1px solid #414957;
      background: #2a303b;
      color: #d8d9da;
      border-radius: 12px;
      padding: 3px 8px;
      font-size: 10px;
      white-space: nowrap;
    }
    pre.json {
      margin: 0;
      padding: 8px;
      border: 1px solid #3a404d;
      border-radius: 4px;
      background: #11161f;
      color: #d8d9da;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow: auto;
    }
    .json-key { color: var(--json-key); }
    .json-string { color: var(--json-string); }
    .json-number { color: var(--json-number); }
    .json-boolean { color: var(--json-bool); }
    .json-null { color: var(--json-null); }
    .empty { color: var(--muted); font-size: 12px; padding: 12px; }
    @media (max-width: 1320px) {
      .grid { grid-template-columns: repeat(4, minmax(140px, 1fr)); }
      .lower { grid-template-columns: 1fr; }
    }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { display: none; }
    }
    @media (max-width: 760px) {
      .grid { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      canvas { min-height: 240px; }
      .topbar { height: auto; padding: 8px 10px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">MF</div>
        <span>mailFastApi</span>
      </div>
      <nav class="side-nav">
        <a class="active" href="#"><span>▦</span><span>Dashboards</span></a>
        <a href="${metricsViewPath}" target="_blank" rel="noreferrer"><span>◫</span><span>Metrics View</span></a>
        <a href="${rawViewPath}" target="_blank" rel="noreferrer"><span>{ }</span><span>Raw JSON View</span></a>
        <a href="${metricsPath}" target="_blank" rel="noreferrer"><span>≡</span><span>Prometheus</span></a>
        <a href="${statsPath}" target="_blank" rel="noreferrer"><span>⎘</span><span>Snapshot JSON</span></a>
      </nav>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="toolbar-right">
          <span id="conn-dot" class="dot"></span>
          <span id="conn-text">Connecting stream...</span>
          <span id="updated">Updated: -</span>
        </div>
      </header>

      <div class="wrap">
        <div class="title-wrap">
          <div class="title">${title}</div>
          <p class="subtitle">Grafana inspired monitoring layout with live queue and delivery telemetry.</p>
        </div>

       

        <section class="grid">
          <article class="card"><div class="k">Send Requests</div><div id="sendRequests" class="v">0</div><div class="note">Inbound /send call count.</div></article>
          <article class="card"><div class="k">Mail Queued</div><div id="mailQueued" class="v">0</div><div class="note">Jobs accepted into queue.</div></article>
          <article class="card"><div class="k">Mail Sent</div><div id="mailSent" class="v">0</div><div class="note">Successfully delivered mails.</div></article>
          <article class="card"><div class="k">Mail Failed</div><div id="mailFailed" class="v">0</div><div class="note">Failed after final retry.</div></article>
          <article class="card"><div class="k">Queue Depth</div><div id="queueDepth" class="v">0</div><div class="note">Current pending queue load.</div></article>
          <article class="card"><div class="k">Active Jobs</div><div id="activeJobs" class="v">0</div><div class="note">Worker jobs in progress.</div></article>
          <article class="card"><div class="k">Success Rate</div><div id="successRate" class="v">-</div><div class="note">mailSent / (mailSent + mailFailed)</div></article>
          <article class="card"><div class="k">Error Ratio</div><div id="errorRatio" class="v">-</div><div class="note">internalError / total logs</div></article>
        </section>

        <section class="panel timeline-panel">
          <h3>Timeline</h3>
          <p>Per-minute request, queued, sent, and failed trend across the full page width.</p>
          <div class="timeline-wrap">
            <canvas id="timelineChart" width="1460" height="320"></canvas>
          </div>
          <div class="legend">
            <span class="item req">Send Requests</span>
            <span class="item queued">Mail Queued</span>
            <span class="item sent">Mail Sent</span>
            <span class="item failed">Mail Failed</span>
          </div>
        </section>

        <section class="lower">
          <article class="panel">
            <h3>Runtime</h3>
            <p>Live service state and counters from current process memory.</p>
            <div class="runtime-grid">
              <div class="runtime-row"><span class="label">Uptime</span><span id="uptime" class="value">-</span></div>
              <div class="runtime-row"><span class="label">Auth Mode</span><span id="authMode" class="value">-</span></div>
              <div class="runtime-row"><span class="label">Queue Backend</span><span id="queueBackend" class="value">-</span></div>
              <div class="runtime-row"><span class="label">API Port</span><span id="apiPort" class="value">-</span></div>
              <div class="runtime-row"><span class="label">Monitor Port</span><span id="monitorPort" class="value">-</span></div>
              <div class="runtime-row"><span class="label">Token Issued</span><span id="tokenIssued" class="value">0</span></div>
              <div class="runtime-row"><span class="label">Retries</span><span id="mailRetry" class="value warn">0</span></div>
              <div class="runtime-row"><span class="label">Total Logs</span><span id="logsTotal" class="value">0</span></div>
              <div class="runtime-row"><span class="label">Errors</span><span id="errorsTotal" class="value bad">0</span></div>
              <div class="runtime-row"><span class="label">INFO Logs</span><span id="levelInfo" class="value">0</span></div>
              <div class="runtime-row"><span class="label">WARN Logs</span><span id="levelWarn" class="value warn">0</span></div>
              <div class="runtime-row"><span class="label">ERROR Logs</span><span id="levelError" class="value bad">0</span></div>
              <div class="runtime-row"><span class="label">DEBUG Logs</span><span id="levelDebug" class="value">0</span></div>
            </div>
          </article>

          <article class="panel">
            <h3>Events</h3>
            <p>Detailed event stream with filters, trace ids, and formatted JSON details.</p>
            <div class="event-toolbar">
              <input id="searchInput" type="text" placeholder="Filter event, source, trace, or JSON detail..." />
              <select id="levelFilter">
                <option value="ALL">All Levels</option>
                <option value="ERROR">ERROR</option>
                <option value="WARN">WARN</option>
                <option value="INFO">INFO</option>
                <option value="DEBUG">DEBUG</option>
              </select>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:180px;">Time</th>
                    <th style="width:80px;">Level</th>
                    <th style="width:190px;">Event</th>
                    <th style="width:90px;">Source</th>
                    <th style="width:170px;">Trace</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody id="eventsBody"></tbody>
              </table>
            </div>
          </article>
        </section>
      </div>
    </main>
  </div>

  <script>
    const statsPath = "${statsPath}";
    const streamPath = "${streamPath}";
    const state = {
      snapshot: null,
      levelFilter: "ALL",
      textFilter: "",
    };

    const ids = {
      sendRequests: document.getElementById("sendRequests"),
      mailQueued: document.getElementById("mailQueued"),
      mailSent: document.getElementById("mailSent"),
      mailFailed: document.getElementById("mailFailed"),
      queueDepth: document.getElementById("queueDepth"),
      activeJobs: document.getElementById("activeJobs"),
      successRate: document.getElementById("successRate"),
      errorRatio: document.getElementById("errorRatio"),
      uptime: document.getElementById("uptime"),
      authMode: document.getElementById("authMode"),
      queueBackend: document.getElementById("queueBackend"),
      apiPort: document.getElementById("apiPort"),
      monitorPort: document.getElementById("monitorPort"),
      tokenIssued: document.getElementById("tokenIssued"),
      mailRetry: document.getElementById("mailRetry"),
      logsTotal: document.getElementById("logsTotal"),
      errorsTotal: document.getElementById("errorsTotal"),
      levelInfo: document.getElementById("levelInfo"),
      levelWarn: document.getElementById("levelWarn"),
      levelError: document.getElementById("levelError"),
      levelDebug: document.getElementById("levelDebug"),
      eventsBody: document.getElementById("eventsBody"),
      updated: document.getElementById("updated"),
      connDot: document.getElementById("conn-dot"),
      connText: document.getElementById("conn-text"),
      chart: document.getElementById("timelineChart"),
      searchInput: document.getElementById("searchInput"),
      levelFilter: document.getElementById("levelFilter"),
    };

    let es = null;
    let pollingTimer = null;

    ids.searchInput.addEventListener("input", () => {
      state.textFilter = String(ids.searchInput.value || "").trim().toLowerCase();
      renderEvents((state.snapshot && state.snapshot.recent) || []);
    });

    ids.levelFilter.addEventListener("change", () => {
      state.levelFilter = ids.levelFilter.value || "ALL";
      renderEvents((state.snapshot && state.snapshot.recent) || []);
    });

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
      const lvl = snapshot.levels || {};

      ids.sendRequests.textContent = n(t.sendRequestsTotal);
      ids.mailQueued.textContent = n(t.mailQueuedTotal);
      ids.mailSent.textContent = n(t.mailSentTotal);
      ids.mailFailed.textContent = n(t.mailFailedTotal);
      ids.queueDepth.textContent = n(r.queueDepth);
      ids.activeJobs.textContent = n(r.activeJobs);
      ids.successRate.textContent = percent(
        t.mailSentTotal,
        Number(t.mailSentTotal || 0) + Number(t.mailFailedTotal || 0),
      );
      ids.errorRatio.textContent = percent(t.internalErrorTotal, t.logsTotal);
      ids.uptime.textContent = sec(snapshot.uptimeSec);
      ids.authMode.textContent = r.authMode || "-";
      ids.queueBackend.textContent = r.queueBackend || "-";
      ids.apiPort.textContent = n(r.port);
      ids.monitorPort.textContent = n(
        r.monitorPort === null || r.monitorPort === undefined ? r.port : r.monitorPort,
      );
      ids.tokenIssued.textContent = n(t.authTokenIssuedTotal);
      ids.mailRetry.textContent = n(t.mailRetryTotal);
      ids.logsTotal.textContent = n(t.logsTotal);
      ids.errorsTotal.textContent = n(t.internalErrorTotal);
      ids.levelInfo.textContent = n(lvl.INFO);
      ids.levelWarn.textContent = n(lvl.WARN);
      ids.levelError.textContent = n(lvl.ERROR);
      ids.levelDebug.textContent = n(lvl.DEBUG);
      ids.updated.textContent = "Updated: " + (snapshot.generatedAt || "-");

      renderEvents(snapshot.recent || []);
      renderTimeline(snapshot.timeline || []);
    }

    function renderEvents(entries) {
      const source = entries.slice().reverse();
      const filtered = source
        .filter((entry) => matchEntry(entry, state.levelFilter, state.textFilter))
        .slice(0, 200);

      if (filtered.length === 0) {
        ids.eventsBody.innerHTML =
          "<tr><td colspan='6' class='empty'>No events for current filters.</td></tr>";
        return;
      }

      ids.eventsBody.innerHTML = filtered
        .map((entry) => {
          const level = String(entry.level || "INFO").toUpperCase();
          const details = entry.details && typeof entry.details === "object" ? entry.details : {};
          const trace = entry.traceId || details.traceId || "-";
          const chips = summarizeDetails(details)
            .map(
              (item) =>
                "<span class='chip'>" + esc(item.label) + ": " + esc(item.value) + "</span>",
            )
            .join("");
          const detailsJson = "<pre class='json'>" + highlightJson(details) + "</pre>";
          return (
            "<tr>" +
            "<td>" +
            esc(entry.timestamp || "") +
            "</td>" +
            "<td class='lvl-" +
            esc(level) +
            "'>" +
            esc(level) +
            "</td>" +
            "<td>" +
            esc(entry.event || "") +
            "</td>" +
            "<td>" +
            esc(entry.source || "") +
            "</td>" +
            "<td class='trace'>" +
            esc(shortTrace(trace)) +
            "</td>" +
            "<td><div class='chips'>" +
            chips +
            "</div>" +
            detailsJson +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }

    function matchEntry(entry, levelFilter, textFilter) {
      const level = String(entry && entry.level ? entry.level : "INFO").toUpperCase();
      if (levelFilter && levelFilter !== "ALL" && level !== levelFilter) {
        return false;
      }
      if (!textFilter) {
        return true;
      }
      const haystack = [
        entry && entry.timestamp ? String(entry.timestamp) : "",
        entry && entry.event ? String(entry.event) : "",
        entry && entry.source ? String(entry.source) : "",
        entry && entry.traceId ? String(entry.traceId) : "",
        safeJson(entry && entry.details ? entry.details : {}, false),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(textFilter);
    }

    function summarizeDetails(details) {
      const items = [];
      pushDetail(items, "path", details.path);
      pushDetail(items, "method", details.method);
      pushDetail(items, "jobId", details.jobId);
      pushDetail(items, "queueDepth", details.queueDepth);
      pushDetail(items, "status", details.status);
      pushDetail(items, "clientId", details.clientId);
      pushDetail(items, "authSub", details.authSub);
      if (items.length === 0) {
        items.push({ label: "info", value: "no key detail fields" });
      }
      return items.slice(0, 6);
    }

    function pushDetail(items, label, value) {
      if (value === null || value === undefined || value === "") return;
      items.push({ label, value: String(value) });
    }

    function renderTimeline(points) {
      const canvas = ids.chart;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      const p = 34;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#161a21";
      ctx.fillRect(0, 0, w, h);

      if (!points || points.length === 0) {
        ctx.fillStyle = "#9fa4ad";
        ctx.font = "12px Segoe UI";
        ctx.fillText("No timeline data yet", 12, 22);
        return;
      }

      const values = points.map((x) =>
        Math.max(
          Number(x.sendRequests || 0),
          Number(x.mailQueued || 0),
          Number(x.mailSent || 0),
          Number(x.mailFailed || 0),
        ),
      );
      const maxY = Math.max(1, ...values);
      const midY = Math.max(0, Math.ceil(maxY / 2));

      drawAxis(ctx, w, h, p, maxY, midY);
      drawLine(ctx, points, w, h, p, maxY, "sendRequests", "#6ed0e0");
      drawLine(ctx, points, w, h, p, maxY, "mailQueued", "#ef843c");
      drawLine(ctx, points, w, h, p, maxY, "mailSent", "#7eb26d");
      drawLine(ctx, points, w, h, p, maxY, "mailFailed", "#e24d42");
    }

    function drawAxis(ctx, w, h, p, maxY, midY) {
      ctx.strokeStyle = "#3a404d";
      ctx.lineWidth = 1;

      for (let i = 0; i < 4; i += 1) {
        const y = p + ((h - p * 2) / 3) * i;
        ctx.beginPath();
        ctx.moveTo(p, y);
        ctx.lineTo(w - p, y);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(p, h - p);
      ctx.lineTo(w - p, h - p);
      ctx.moveTo(p, p);
      ctx.lineTo(p, h - p);
      ctx.stroke();

      ctx.fillStyle = "#9fa4ad";
      ctx.font = "11px Segoe UI";
      ctx.fillText(String(maxY), 8, p + 4);
      ctx.fillText(String(midY), 10, p + (h - p * 2) / 2 + 4);
      ctx.fillText("0", 18, h - p + 4);
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

    function highlightJson(value) {
      const json = safeJson(value, true);
      const tokenRx =
        /("(?:\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"\\s*:?)|("(?:\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*")|\\btrue\\b|\\bfalse\\b|\\bnull\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g;
      let output = "";
      let cursor = 0;
      let match = tokenRx.exec(json);

      while (match) {
        const token = match[0];
        const index = match.index;
        output += esc(json.slice(cursor, index));
        if (token.endsWith(":")) {
          output += "<span class='json-key'>" + esc(token) + "</span>";
        } else if (token.startsWith('"')) {
          output += "<span class='json-string'>" + esc(token) + "</span>";
        } else if (token === "true" || token === "false") {
          output += "<span class='json-boolean'>" + esc(token) + "</span>";
        } else if (token === "null") {
          output += "<span class='json-null'>" + esc(token) + "</span>";
        } else {
          output += "<span class='json-number'>" + esc(token) + "</span>";
        }
        cursor = index + token.length;
        match = tokenRx.exec(json);
      }

      output += esc(json.slice(cursor));
      return output;
    }

    function safeJson(value, pretty) {
      try {
        return JSON.stringify(value, null, pretty ? 2 : 0);
      } catch (error) {
        return String(value);
      }
    }

    function shortTrace(value) {
      const text = String(value || "-");
      if (text.length <= 18) return text;
      return text.slice(0, 8) + "..." + text.slice(-6);
    }

    function n(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return Number(value).toLocaleString("en-US");
    }

    function percent(part, total) {
      const p = Number(part);
      const t = Number(total);
      if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return "-";
      return ((p / t) * 100).toFixed(2) + "%";
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

function renderMonitorMetricsPageHtml(options = {}) {
  const title = escapeHtml(options.title || "mailFastApi Prometheus Metrics");
  const metricsPath = escapeHtml(options.metricsPath || "/metrics");
  const monitorPath = escapeHtml(options.monitorPath || "/monitor");
  const rawViewPath = escapeHtml(options.rawViewPath || "/monitor/raw-view");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700;800&display=swap");
    :root {
      --bg: #070b14;
      --panel: #0e1422;
      --line: #1b2640;
      --text: #e5ecff;
      --muted: #93a0be;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Public Sans", "Segoe UI", Tahoma, sans-serif;
      background:
        radial-gradient(1200px 600px at 0% -20%, #14223b 0%, rgba(20, 34, 59, 0) 60%),
        radial-gradient(1000px 500px at 100% -20%, #0f2044 0%, rgba(15, 32, 68, 0) 65%),
        var(--bg);
      color: var(--text);
    }
    .page {
      width: min(1400px, 96vw);
      margin: 18px auto 26px auto;
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .title {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      color: #f1f5ff;
    }
    .subtitle {
      margin: 6px 0 0 0;
      font-size: 13px;
      color: var(--muted);
    }
    .links {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .links a {
      text-decoration: none;
      color: #dbeafe;
      border: 1px solid #233354;
      background: #0f1a31;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .card {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, #121c33, #0f172b);
      border-radius: 12px;
      padding: 10px;
    }
    .k { font-size: 11px; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; letter-spacing: 0.45px; }
    .v { font-size: 22px; font-weight: 800; color: #f8fbff; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: linear-gradient(180deg, #10192a, var(--panel));
      padding: 12px;
      margin-bottom: 10px;
    }
    .panel h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.55px;
      color: #dbeafe;
    }
    .panel p {
      margin: 0 0 10px 0;
      color: var(--muted);
      font-size: 12px;
    }
    .table-wrap {
      border: 1px solid #213252;
      border-radius: 10px;
      overflow: auto;
      max-height: 520px;
      background: #0a1222;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 820px;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: #0f1a31;
      color: #b8c8e8;
      border-bottom: 1px solid #23385c;
      text-align: left;
      padding: 9px 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.45px;
    }
    tbody td {
      border-bottom: 1px solid #182844;
      padding: 8px;
      color: #d9e5ff;
      vertical-align: top;
      word-break: break-word;
    }
    tbody tr:hover td { background: #0f1a31; }
    pre {
      margin: 0;
      padding: 10px;
      border: 1px solid #253a5f;
      border-radius: 10px;
      background: #0a1222;
      color: #dbeafe;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow: auto;
    }
    @media (max-width: 950px) {
      .grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top">
      <div>
        <h1 class="title">${title}</h1>
        <p class="subtitle">Formatted Prometheus explorer with metric types, labels, values, and raw text.</p>
      </div>
      <nav class="links">
        <a href="${monitorPath}" target="_blank" rel="noreferrer">Live Monitor</a>
        <a href="${rawViewPath}" target="_blank" rel="noreferrer">Raw JSON View</a>
        <a href="${metricsPath}" target="_blank" rel="noreferrer">Plain Prometheus</a>
      </nav>
    </header>

    <section class="grid">
      <article class="card"><div class="k">Series</div><div id="seriesCount" class="v">0</div></article>
      <article class="card"><div class="k">Counters</div><div id="counterCount" class="v">0</div></article>
      <article class="card"><div class="k">Gauges</div><div id="gaugeCount" class="v">0</div></article>
      <article class="card"><div class="k">Last Update</div><div id="updated" class="v" style="font-size:14px;">-</div></article>
    </section>

    <section class="panel">
      <h3>Parsed Metrics Table</h3>
      <p>Lines grouped by metric name, type, labels, and value.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:280px;">Metric</th>
              <th style="width:120px;">Type</th>
              <th style="width:300px;">Labels</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody id="metricsBody"></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h3>Raw Prometheus Text</h3>
      <pre id="rawText">Loading...</pre>
    </section>
  </div>

  <script>
    const metricsPath = "${metricsPath}";
    const ids = {
      seriesCount: document.getElementById("seriesCount"),
      counterCount: document.getElementById("counterCount"),
      gaugeCount: document.getElementById("gaugeCount"),
      updated: document.getElementById("updated"),
      metricsBody: document.getElementById("metricsBody"),
      rawText: document.getElementById("rawText"),
    };

    load();
    setInterval(() => { void load(); }, 5000);

    async function load() {
      try {
        const response = await fetch(metricsPath, { cache: "no-store" });
        if (!response.ok) throw new Error("Failed to fetch metrics");
        const text = await response.text();
        ids.rawText.textContent = text || "";
        const rows = parsePrometheus(text || "");
        renderRows(rows);
        ids.updated.textContent = new Date().toISOString();
      } catch (error) {
        ids.rawText.textContent = String(error && error.message ? error.message : "Unknown metrics error");
      }
    }

    function parsePrometheus(text) {
      const lines = String(text || "").split("\\n");
      const typeByMetric = new Map();
      const rows = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("# TYPE ")) {
          const parts = trimmed.split(/\\s+/);
          if (parts.length >= 4) typeByMetric.set(parts[2], parts[3]);
        }
      }

      const pattern = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\\{[^}]*\\})?\\s+([^\\s]+)$/;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = pattern.exec(trimmed);
        if (!match) continue;
        rows.push({
          name: match[1],
          type: typeByMetric.get(match[1]) || "-",
          labels: match[2] || "",
          value: match[3],
        });
      }
      return rows;
    }

    function renderRows(rows) {
      const counterCount = rows.filter((x) => x.type === "counter").length;
      const gaugeCount = rows.filter((x) => x.type === "gauge").length;
      ids.seriesCount.textContent = rows.length.toLocaleString("en-US");
      ids.counterCount.textContent = counterCount.toLocaleString("en-US");
      ids.gaugeCount.textContent = gaugeCount.toLocaleString("en-US");

      if (rows.length === 0) {
        ids.metricsBody.innerHTML = "<tr><td colspan='4' style='padding:10px;color:#93a0be;'>No metric series detected.</td></tr>";
        return;
      }

      ids.metricsBody.innerHTML = rows
        .map(
          (row) =>
            "<tr><td>" +
            esc(row.name) +
            "</td><td>" +
            esc(row.type) +
            "</td><td>" +
            esc(row.labels || "-") +
            "</td><td>" +
            esc(row.value) +
            "</td></tr>",
        )
        .join("");
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

function renderMonitorRawPageHtml(options = {}) {
  const title = escapeHtml(options.title || "mailFastApi Raw Snapshot");
  const statsPath = escapeHtml(options.statsPath || "/monitor/stats");
  const monitorPath = escapeHtml(options.monitorPath || "/monitor");
  const metricsViewPath = escapeHtml(options.metricsViewPath || "/monitor/metrics-view");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700;800&display=swap");
    :root {
      --bg: #070b14;
      --panel: #0e1422;
      --line: #1b2640;
      --text: #e5ecff;
      --muted: #93a0be;
      --json-key: #7dd3fc;
      --json-string: #86efac;
      --json-number: #fcd34d;
      --json-bool: #f9a8d4;
      --json-null: #c4b5fd;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Public Sans", "Segoe UI", Tahoma, sans-serif;
      background:
        radial-gradient(1200px 600px at 0% -20%, #14223b 0%, rgba(20, 34, 59, 0) 60%),
        radial-gradient(1000px 500px at 100% -20%, #0f2044 0%, rgba(15, 32, 68, 0) 65%),
        var(--bg);
      color: var(--text);
    }
    .page {
      width: min(1400px, 96vw);
      margin: 18px auto 26px auto;
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .title {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      color: #f1f5ff;
    }
    .subtitle {
      margin: 6px 0 0 0;
      font-size: 13px;
      color: var(--muted);
    }
    .links {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .links a {
      text-decoration: none;
      color: #dbeafe;
      border: 1px solid #233354;
      background: #0f1a31;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .card {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, #121c33, #0f172b);
      border-radius: 12px;
      padding: 10px;
    }
    .k { font-size: 11px; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; letter-spacing: 0.45px; }
    .v { font-size: 20px; font-weight: 800; color: #f8fbff; line-height: 1.2; word-break: break-word; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: linear-gradient(180deg, #10192a, var(--panel));
      padding: 12px;
      margin-bottom: 10px;
    }
    .panel h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.55px;
      color: #dbeafe;
    }
    .panel p {
      margin: 0 0 10px 0;
      color: var(--muted);
      font-size: 12px;
    }
    .runtime-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(220px, 1fr));
      gap: 8px;
    }
    .runtime-item {
      border: 1px solid #223457;
      background: #0a1222;
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      font-size: 12px;
    }
    .runtime-item .label { color: var(--muted); }
    .runtime-item .value { color: #f8fbff; font-weight: 700; }
    pre {
      margin: 0;
      padding: 10px;
      border: 1px solid #253a5f;
      border-radius: 10px;
      background: #071225;
      color: #dbeafe;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 560px;
      overflow: auto;
    }
    .json-key { color: var(--json-key); }
    .json-string { color: var(--json-string); }
    .json-number { color: var(--json-number); }
    .json-boolean { color: var(--json-bool); }
    .json-null { color: var(--json-null); }
    @media (max-width: 980px) {
      .grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
      .runtime-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top">
      <div>
        <h1 class="title">${title}</h1>
        <p class="subtitle">Formatted monitor snapshot with runtime summary and syntax-highlighted JSON.</p>
      </div>
      <nav class="links">
        <a href="${monitorPath}" target="_blank" rel="noreferrer">Live Monitor</a>
        <a href="${metricsViewPath}" target="_blank" rel="noreferrer">Metrics View</a>
        <a href="${statsPath}" target="_blank" rel="noreferrer">Plain Snapshot JSON</a>
      </nav>
    </header>

    <section class="grid">
      <article class="card"><div class="k">Generated At</div><div id="generatedAt" class="v">-</div></article>
      <article class="card"><div class="k">Uptime</div><div id="uptime" class="v">-</div></article>
      <article class="card"><div class="k">Timeline Points</div><div id="timelineCount" class="v">0</div></article>
      <article class="card"><div class="k">Recent Events</div><div id="recentCount" class="v">0</div></article>
    </section>

    <section class="panel">
      <h3>Runtime Summary</h3>
      <p>Overview from snapshot.runtime, snapshot.totals, and snapshot.levels.</p>
      <div id="runtimeGrid" class="runtime-grid"></div>
    </section>

    <section class="panel">
      <h3>Formatted JSON Payload</h3>
      <pre id="jsonBody">Loading...</pre>
    </section>
  </div>

  <script>
    const statsPath = "${statsPath}";
    const ids = {
      generatedAt: document.getElementById("generatedAt"),
      uptime: document.getElementById("uptime"),
      timelineCount: document.getElementById("timelineCount"),
      recentCount: document.getElementById("recentCount"),
      runtimeGrid: document.getElementById("runtimeGrid"),
      jsonBody: document.getElementById("jsonBody"),
    };

    load();
    setInterval(() => { void load(); }, 3000);

    async function load() {
      try {
        const response = await fetch(statsPath, { cache: "no-store" });
        if (!response.ok) throw new Error("Failed to fetch snapshot JSON");
        const snapshot = await response.json();
        render(snapshot);
      } catch (error) {
        ids.jsonBody.textContent = String(error && error.message ? error.message : "Unknown snapshot error");
      }
    }

    function render(snapshot) {
      ids.generatedAt.textContent = snapshot.generatedAt || "-";
      ids.uptime.textContent = sec(snapshot.uptimeSec);
      ids.timelineCount.textContent = n((snapshot.timeline || []).length);
      ids.recentCount.textContent = n((snapshot.recent || []).length);

      const runtime = snapshot.runtime || {};
      const totals = snapshot.totals || {};
      const levels = snapshot.levels || {};
      const rows = [
        ["authMode", runtime.authMode],
        ["queueBackend", runtime.queueBackend],
        ["queueDepth", runtime.queueDepth],
        ["activeJobs", runtime.activeJobs],
        ["apiPort", runtime.port],
        ["monitorPort", runtime.monitorPort],
        ["sendRequestsTotal", totals.sendRequestsTotal],
        ["mailQueuedTotal", totals.mailQueuedTotal],
        ["mailSentTotal", totals.mailSentTotal],
        ["mailFailedTotal", totals.mailFailedTotal],
        ["internalErrorTotal", totals.internalErrorTotal],
        ["INFO", levels.INFO],
        ["WARN", levels.WARN],
        ["ERROR", levels.ERROR],
        ["DEBUG", levels.DEBUG],
      ];

      ids.runtimeGrid.innerHTML = rows
        .map(
          (row) =>
            "<div class='runtime-item'><span class='label'>" +
            esc(row[0]) +
            "</span><span class='value'>" +
            esc(nv(row[1])) +
            "</span></div>",
        )
        .join("");

      ids.jsonBody.innerHTML = highlightJson(snapshot);
    }

    function highlightJson(value) {
      const json = safeJson(value, true);
      const tokenRx =
        /("(?:\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"\\s*:?)|("(?:\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*")|\\btrue\\b|\\bfalse\\b|\\bnull\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g;
      let output = "";
      let cursor = 0;
      let match = tokenRx.exec(json);

      while (match) {
        const token = match[0];
        const index = match.index;
        output += esc(json.slice(cursor, index));
        if (token.endsWith(":")) output += "<span class='json-key'>" + esc(token) + "</span>";
        else if (token.startsWith('"')) output += "<span class='json-string'>" + esc(token) + "</span>";
        else if (token === "true" || token === "false") output += "<span class='json-boolean'>" + esc(token) + "</span>";
        else if (token === "null") output += "<span class='json-null'>" + esc(token) + "</span>";
        else output += "<span class='json-number'>" + esc(token) + "</span>";
        cursor = index + token.length;
        match = tokenRx.exec(json);
      }

      output += esc(json.slice(cursor));
      return output;
    }

    function safeJson(value, pretty) {
      try {
        return JSON.stringify(value, null, pretty ? 2 : 0);
      } catch (error) {
        return String(value);
      }
    }

    function sec(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const s = Math.floor(Number(value));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      return h + "h " + m + "m " + ss + "s";
    }

    function nv(value) {
      if (value === null || value === undefined || value === "") return "-";
      if (Number.isFinite(Number(value))) return Number(value).toLocaleString("en-US");
      return String(value);
    }

    function n(value) {
      if (!Number.isFinite(Number(value))) return "0";
      return Number(value).toLocaleString("en-US");
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
  renderMonitorMetricsPageHtml,
  renderMonitorRawPageHtml,
};
