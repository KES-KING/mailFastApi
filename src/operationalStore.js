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
  `);
  migrateSuppressionPrimaryKey(db);

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

  const getLastAuditStmt = db.prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1");
  const insertAuditStmt = db.prepare(`
    INSERT INTO audit_events (
      previous_hash, event_hash, actor, action, target, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
    insertAuditEvent,
    close,
    getDbPath,
  };
}

function normalizeRecipients(value) {
  return (Array.isArray(value) ? value : [value]).map(normalizeEmail).filter(Boolean);
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
