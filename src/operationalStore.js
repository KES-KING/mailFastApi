"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_PATH = "data/mailfastapi-operational.sqlite";

function createOperationalStore(options = {}) {
  const dbPath = path.resolve(options.dbPath || process.env.OPERATIONAL_DB_PATH || DEFAULT_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppression_entries (
      email TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (email, tenant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_suppression_tenant ON suppression_entries(tenant_id);

    CREATE TABLE IF NOT EXISTS idempotency_records (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );

    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_records(expires_at_ms);

    CREATE TABLE IF NOT EXISTS dead_letter_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      tenant_id TEXT NOT NULL,
      smtp_account TEXT,
      recipients_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      job_json TEXT NOT NULL,
      requeued_at_ms INTEGER,
      requeued_job_id TEXT,
      requeued_by TEXT,
      final_error_at_ms INTEGER,
      final_error_reason TEXT,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      previous_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      details_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_lifecycle_job ON job_lifecycle_events(job_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_job_lifecycle_state ON job_lifecycle_events(state, created_at_ms);

    CREATE TABLE IF NOT EXISTS delivery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      smtp_account TEXT NOT NULL,
      domain TEXT NOT NULL,
      recipient TEXT,
      job_id TEXT,
      details_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_events_lookup
      ON delivery_events(tenant_id, smtp_account, domain, event, created_at_ms);

    CREATE TABLE IF NOT EXISTS bounce_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      bounce_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bounce_events_email ON bounce_events(email, tenant_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS complaint_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_complaint_events_email
      ON complaint_events(email, tenant_id, created_at_ms);
  `);
  migrateSuppressionPrimaryKey(db);
  migrateDeadLetterReplayColumns(db);

  const addSuppressionStmt = db.prepare(`
    INSERT OR REPLACE INTO suppression_entries (
      email, tenant_id, reason, source, expires_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getSuppressionStmt = db.prepare(`
    SELECT * FROM suppression_entries
    WHERE email = ?
      AND tenant_id IN ('global', ?)
      AND (expires_at_ms IS NULL OR expires_at_ms > ?)
    ORDER BY CASE tenant_id WHEN ? THEN 0 ELSE 1 END
    LIMIT 1
  `);
  const listSuppressionStmt = db.prepare(`
    SELECT * FROM suppression_entries
    WHERE tenant_id IN ('global', ?)
      AND (expires_at_ms IS NULL OR expires_at_ms > ?)
    ORDER BY created_at_ms DESC
    LIMIT ?
  `);
  const deleteSuppressionStmt = db.prepare(
    "DELETE FROM suppression_entries WHERE email = ? AND tenant_id = ?",
  );

  const getIdempotencyStmt = db.prepare(`
    SELECT * FROM idempotency_records
    WHERE scope = ? AND key = ? AND expires_at_ms > ?
  `);
  const putIdempotencyStmt = db.prepare(`
    INSERT OR REPLACE INTO idempotency_records (
      scope, key, request_hash, status_code, response_json, expires_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const cleanupIdempotencyStmt = db.prepare("DELETE FROM idempotency_records WHERE expires_at_ms <= ?");

  const insertDeadLetterStmt = db.prepare(`
    INSERT INTO dead_letter_jobs (
      job_id, tenant_id, smtp_account, recipients_json, reason, job_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listPendingDeadLettersStmt = db.prepare(`
    SELECT * FROM dead_letter_jobs
    WHERE requeued_at_ms IS NULL
      AND final_error_at_ms IS NULL
    ORDER BY created_at_ms ASC, id ASC
    LIMIT ?
  `);
  const listAllDeadLettersStmt = db.prepare(`
    SELECT * FROM dead_letter_jobs
    ORDER BY created_at_ms DESC, id DESC
    LIMIT ?
  `);
  const getDeadLetterStmt = db.prepare("SELECT * FROM dead_letter_jobs WHERE id = ?");
  const markDeadLetterRequeuedStmt = db.prepare(`
    UPDATE dead_letter_jobs
    SET requeued_at_ms = ?, requeued_job_id = ?, requeued_by = ?
    WHERE id = ? AND requeued_at_ms IS NULL AND final_error_at_ms IS NULL
  `);
  const markDeadLetterFinalErrorStmt = db.prepare(`
    UPDATE dead_letter_jobs
    SET final_error_at_ms = ?, final_error_reason = ?
    WHERE id = ? AND requeued_at_ms IS NULL AND final_error_at_ms IS NULL
  `);

  const getLastAuditStmt = db.prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1");
  const insertAuditStmt = db.prepare(`
    INSERT INTO audit_events (
      previous_hash, event_hash, actor, action, target, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLifecycleStmt = db.prepare(`
    INSERT INTO job_lifecycle_events (
      job_id, tenant_id, state, reason, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getLifecycleStmt = db.prepare(`
    SELECT * FROM job_lifecycle_events WHERE job_id = ? ORDER BY created_at_ms ASC, id ASC
  `);
  const insertDeliveryEventStmt = db.prepare(`
    INSERT INTO delivery_events (
      event, tenant_id, smtp_account, domain, recipient, job_id, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deliveryTotalsStmt = db.prepare(`
    SELECT event, COUNT(*) AS count FROM delivery_events
    WHERE created_at_ms >= ?
    GROUP BY event
  `);
  const insertBounceStmt = db.prepare(`
    INSERT INTO bounce_events (
      email, tenant_id, bounce_type, reason, source, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertComplaintStmt = db.prepare(`
    INSERT INTO complaint_events (
      email, tenant_id, source, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `);

  function addSuppression(email, options = {}) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      const error = new Error("A valid email is required.");
      error.code = "INVALID_SUPPRESSION_EMAIL";
      throw error;
    }
    const tenantId = normalizeTenant(options.tenantId);
    const reason = clean(options.reason) || "manual";
    const source = clean(options.source) || "api";
    const expiresAtMs = Number.isFinite(Number(options.expiresAtMs))
      ? Number(options.expiresAtMs)
      : null;
    addSuppressionStmt.run(normalized, tenantId, reason, source, expiresAtMs, Date.now());
    insertAuditEvent(options.actor || "system", "suppression.upsert", normalized, {
      tenantId,
      reason,
      source,
      expiresAtMs,
    });
    return getSuppression(normalized, tenantId);
  }

  function removeSuppression(email, tenantId = "global", actor = "system") {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;
    const result = deleteSuppressionStmt.run(normalized, normalizeTenant(tenantId));
    if (result.changes > 0) {
      insertAuditEvent(actor, "suppression.delete", normalized, { tenantId: normalizeTenant(tenantId) });
    }
    return result.changes > 0;
  }

  function getSuppression(email, tenantId = "global") {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return getSuppressionStmt.get(normalized, normalizeTenant(tenantId), Date.now(), normalizeTenant(tenantId)) || null;
  }

  function listSuppressions(tenantId = "global", limit = 100) {
    return listSuppressionStmt.all(normalizeTenant(tenantId), Date.now(), clampLimit(limit));
  }

  function findSuppressedRecipients(recipients, tenantId = "global") {
    return normalizeRecipients(recipients).filter((email) => Boolean(getSuppression(email, tenantId)));
  }

  function getIdempotencyRecord(scope, key) {
    const row = getIdempotencyStmt.get(clean(scope), clean(key), Date.now());
    if (!row) return null;
    return {
      scope: row.scope,
      key: row.key,
      requestHash: row.request_hash,
      statusCode: row.status_code,
      response: JSON.parse(row.response_json),
      expiresAtMs: row.expires_at_ms,
      createdAtMs: row.created_at_ms,
    };
  }

  function putIdempotencyRecord(scope, key, requestHash, statusCode, response, ttlMs) {
    const now = Date.now();
    putIdempotencyStmt.run(
      clean(scope),
      clean(key),
      clean(requestHash),
      Number(statusCode) || 200,
      JSON.stringify(response || {}),
      now + Math.max(1000, Number(ttlMs) || 86400000),
      now,
    );
  }

  function cleanupExpiredIdempotency() {
    cleanupIdempotencyStmt.run(Date.now());
  }

  function insertDeadLetterJob(job, reason) {
    insertDeadLetterStmt.run(
      job && job.id ? String(job.id) : null,
      normalizeTenant(job && job.tenantId),
      job && job.smtpAccount ? String(job.smtpAccount) : null,
      JSON.stringify(normalizeRecipients(job && job.to)),
      clean(reason) || "unknown",
      JSON.stringify(job || {}),
      Date.now(),
    );
  }

  function listDeadLetterJobs(options = {}) {
    const limit = clampLimit(options.limit);
    const rows = options.includeRequeued
      ? listAllDeadLettersStmt.all(limit)
      : listPendingDeadLettersStmt.all(limit);
    return rows.map(toDeadLetterSummary);
  }

  function getDeadLetterJob(id) {
    const row = getDeadLetterStmt.get(Number(id) || 0);
    return row ? toDeadLetterRecord(row) : null;
  }

  function markDeadLetterRequeued(id, options = {}) {
    const result = markDeadLetterRequeuedStmt.run(
      Number.isFinite(Number(options.requeuedAtMs)) ? Number(options.requeuedAtMs) : Date.now(),
      clean(options.requeuedJobId),
      clean(options.actor) || "system",
      Number(id) || 0,
    );
    return result.changes > 0;
  }

  function markDeadLetterFinalError(id, options = {}) {
    const result = markDeadLetterFinalErrorStmt.run(
      Number.isFinite(Number(options.finalErrorAtMs)) ? Number(options.finalErrorAtMs) : Date.now(),
      clean(options.reason) || "auto_retry_exhausted",
      Number(id) || 0,
    );
    return result.changes > 0;
  }

  function recordJobLifecycle(jobId, state, options = {}) {
    const normalizedJobId = clean(jobId);
    if (!normalizedJobId) {
      return false;
    }
    const normalizedState = normalizeLifecycleState(state);
    insertLifecycleStmt.run(
      normalizedJobId,
      normalizeTenant(options.tenantId),
      normalizedState,
      clean(options.reason) || null,
      JSON.stringify(options.details && typeof options.details === "object" ? options.details : {}),
      Number.isFinite(Number(options.createdAtMs)) ? Number(options.createdAtMs) : Date.now(),
    );
    return true;
  }

  function getJobLifecycle(jobId) {
    return getLifecycleStmt.all(clean(jobId)).map((row) => ({
      jobId: row.job_id,
      tenantId: row.tenant_id,
      state: row.state,
      reason: row.reason,
      details: safeJson(row.details_json),
      createdAtMs: row.created_at_ms,
    }));
  }

  function recordDeliveryEvent(event, details = {}) {
    const normalizedEvent = normalizeDeliveryEvent(event);
    const recipients = normalizeRecipients(details.recipients || details.to || details.recipient);
    const atMs = Number.isFinite(Number(details.createdAtMs)) ? Number(details.createdAtMs) : Date.now();
    const tenantId = normalizeTenant(details.tenantId);
    const smtpAccount = clean(details.smtpAccount) || "default";
    const jobId = clean(details.jobId) || null;
    const payload = JSON.stringify(details && typeof details === "object" ? details : {});

    const targetRecipients = recipients.length > 0 ? recipients : [""];
    for (const recipient of targetRecipients) {
      insertDeliveryEventStmt.run(
        normalizedEvent,
        tenantId,
        smtpAccount,
        extractDomain(recipient) || clean(details.domain).toLowerCase() || "unknown",
        recipient || null,
        jobId,
        payload,
        atMs,
      );
    }
  }

  function countDeliveryEvents(filter = {}) {
    const events = normalizeDeliveryEvents(filter.events || filter.event || "sent");
    const placeholders = events.map(() => "?").join(", ");
    const stmt = db.prepare(`
      SELECT COUNT(*) AS count FROM delivery_events
      WHERE tenant_id = ?
        AND smtp_account = ?
        AND domain = ?
        AND event IN (${placeholders})
        AND created_at_ms >= ?
    `);
    const row = stmt.get(
      normalizeTenant(filter.tenantId),
      clean(filter.smtpAccount) || "default",
      clean(filter.domain).toLowerCase() || "unknown",
      ...events,
      Number(filter.sinceMs) || 0,
    );
    return Number(row && row.count ? row.count : 0);
  }

  function getDeliveryEventTotals(sinceMs = Date.now() - 60 * 60 * 1000) {
    const rows = deliveryTotalsStmt.all(Number(sinceMs) || 0);
    const totals = {};
    for (const row of rows) {
      totals[row.event] = Number(row.count || 0);
    }
    return totals;
  }

  function insertBounceEvent(email, options = {}) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      const error = new Error("A valid email is required.");
      error.code = "INVALID_BOUNCE_EMAIL";
      throw error;
    }
    const tenantId = normalizeTenant(options.tenantId);
    const bounceType = clean(options.bounceType || options.type) || "unknown";
    const reason = clean(options.reason) || "unknown";
    const source = clean(options.source) || "webhook";
    insertBounceStmt.run(
      normalized,
      tenantId,
      bounceType,
      reason,
      source,
      JSON.stringify(options.details && typeof options.details === "object" ? options.details : {}),
      Date.now(),
    );
    if (bounceType === "hard") {
      addSuppression(normalized, {
        tenantId,
        reason: "hard_bounce",
        source,
        actor: options.actor || "bounce",
      });
    }
  }

  function insertComplaintEvent(email, options = {}) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      const error = new Error("A valid email is required.");
      error.code = "INVALID_COMPLAINT_EMAIL";
      throw error;
    }
    const tenantId = normalizeTenant(options.tenantId);
    const source = clean(options.source) || "feedback_loop";
    insertComplaintStmt.run(
      normalized,
      tenantId,
      source,
      JSON.stringify(options.details && typeof options.details === "object" ? options.details : {}),
      Date.now(),
    );
    addSuppression(normalized, {
      tenantId,
      reason: "complaint",
      source,
      actor: options.actor || "complaint",
    });
  }

  function insertAuditEvent(actor, action, target, details = {}) {
    const previousHash = (getLastAuditStmt.get() || {}).event_hash || "GENESIS";
    const createdAtMs = Date.now();
    const detailsJson = JSON.stringify(details && typeof details === "object" ? details : {});
    const payload = `${previousHash}|${actor}|${action}|${target}|${detailsJson}|${createdAtMs}`;
    const eventHash = require("node:crypto").createHash("sha256").update(payload).digest("hex");
    insertAuditStmt.run(
      previousHash,
      eventHash,
      clean(actor) || "system",
      clean(action) || "event",
      clean(target) || "system",
      detailsJson,
      createdAtMs,
    );
    return eventHash;
  }

  function close() {
    db.close();
  }

  function getDbPath() {
    return dbPath;
  }

  return {
    addSuppression,
    removeSuppression,
    getSuppression,
    listSuppressions,
    findSuppressedRecipients,
    getIdempotencyRecord,
    putIdempotencyRecord,
    cleanupExpiredIdempotency,
    insertDeadLetterJob,
    listDeadLetterJobs,
    getDeadLetterJob,
    markDeadLetterRequeued,
    markDeadLetterFinalError,
    recordJobLifecycle,
    getJobLifecycle,
    recordDeliveryEvent,
    countDeliveryEvents,
    getDeliveryEventTotals,
    insertBounceEvent,
    insertComplaintEvent,
    insertAuditEvent,
    close,
    getDbPath,
  };
}

function normalizeRecipients(value) {
  return (Array.isArray(value) ? value : [value]).map(normalizeEmail).filter(Boolean);
}

function normalizeLifecycleState(value) {
  const state = clean(value).toLowerCase();
  return [
    "queued",
    "processing",
    "retrying",
    "deferred",
    "delivered",
    "bounced",
    "failed",
    "dead-lettered",
  ].includes(state)
    ? state
    : "processing";
}

function normalizeDeliveryEvent(value) {
  const event = clean(value).toLowerCase();
  return ["queued", "sent", "failed", "bounced", "complaint", "deferred", "retrying"].includes(event)
    ? event
    : "sent";
}

function normalizeDeliveryEvents(value) {
  const values = Array.isArray(value) ? value : [value];
  const events = values.map(normalizeDeliveryEvent).filter(Boolean);
  return events.length > 0 ? [...new Set(events)] : ["sent"];
}

function extractDomain(email) {
  const normalized = normalizeEmail(email);
  return normalized ? normalized.split("@").pop() : "";
}

function safeJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    return {};
  }
}

function migrateSuppressionPrimaryKey(db) {
  const columns = db.prepare("PRAGMA table_info(suppression_entries)").all();
  const primaryKeyColumns = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);

  if (primaryKeyColumns.join(",") === "email,tenant_id") {
    return;
  }

  const legacyTable = `suppression_entries_legacy_${Date.now()}`;
  db.exec(`
    ALTER TABLE suppression_entries RENAME TO ${legacyTable};
    DROP INDEX IF EXISTS idx_suppression_tenant;
    CREATE TABLE suppression_entries (
      email TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (email, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_suppression_tenant ON suppression_entries(tenant_id);
    INSERT OR IGNORE INTO suppression_entries (
      email, tenant_id, reason, source, expires_at_ms, created_at_ms
    )
    SELECT email, tenant_id, reason, source, expires_at_ms, created_at_ms FROM ${legacyTable};
    DROP TABLE ${legacyTable};
  `);
}

function migrateDeadLetterReplayColumns(db) {
  const columns = db.prepare("PRAGMA table_info(dead_letter_jobs)").all();
  const names = new Set(columns.map((column) => column.name));
  const statements = [];

  if (!names.has("requeued_at_ms")) {
    statements.push("ALTER TABLE dead_letter_jobs ADD COLUMN requeued_at_ms INTEGER");
  }
  if (!names.has("requeued_job_id")) {
    statements.push("ALTER TABLE dead_letter_jobs ADD COLUMN requeued_job_id TEXT");
  }
  if (!names.has("requeued_by")) {
    statements.push("ALTER TABLE dead_letter_jobs ADD COLUMN requeued_by TEXT");
  }
  if (!names.has("final_error_at_ms")) {
    statements.push("ALTER TABLE dead_letter_jobs ADD COLUMN final_error_at_ms INTEGER");
  }
  if (!names.has("final_error_reason")) {
    statements.push("ALTER TABLE dead_letter_jobs ADD COLUMN final_error_reason TEXT");
  }

  for (const statement of statements) {
    db.exec(statement);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_dead_letter_requeued ON dead_letter_jobs(requeued_at_ms, created_at_ms)");
}

function toDeadLetterSummary(row) {
  const job = safeJson(row.job_json);
  return {
    id: row.id,
    jobId: row.job_id,
    tenantId: row.tenant_id,
    smtpAccount: row.smtp_account,
    recipients: safeJson(row.recipients_json),
    subject: clean(job.subject),
    reason: row.reason,
    createdAtMs: row.created_at_ms,
    requeuedAtMs: row.requeued_at_ms || null,
    requeuedJobId: row.requeued_job_id || null,
    requeuedBy: row.requeued_by || null,
    finalErrorAtMs: row.final_error_at_ms || null,
    finalErrorReason: row.final_error_reason || null,
    autoRetryCount: getAutoRetryCount(job),
  };
}

function toDeadLetterRecord(row) {
  return {
    ...toDeadLetterSummary(row),
    job: safeJson(row.job_json),
  };
}

function getAutoRetryCount(job) {
  if (!job || typeof job !== "object") {
    return 0;
  }
  const count = Number(job.autoRetryCount);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeTenant(value) {
  const tenant = clean(value || "global").toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenant) ? tenant : "global";
}

function clampLimit(value) {
  return Math.max(1, Math.min(500, Number(value) || 100));
}

function clean(value) {
  return String(value || "").trim();
}

module.exports = { createOperationalStore };
