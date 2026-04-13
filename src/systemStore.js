"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createSystemStore(options = {}) {
  const dbPath = path.resolve(options.dbPath || "data/mailfastapi.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");

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

    CREATE INDEX IF NOT EXISTS idx_system_logs_created_at_ms ON system_logs(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
    CREATE INDEX IF NOT EXISTS idx_system_logs_event ON system_logs(event);
  `);

  const insertLogStmt = db.prepare(`
    INSERT INTO system_logs (
      timestamp, level, event, source, trace_id, details_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `);

  function insertLogEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    db.exec("BEGIN");
    try {
      for (const entry of entries) {
        insertLogStmt.run(
          entry.timestamp,
          entry.level,
          entry.event,
          entry.source,
          entry.traceId || null,
          JSON.stringify(entry.details || {}),
          entry.createdAtMs,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function close() {
    db.close();
  }

  function getDbPath() {
    return dbPath;
  }

  return {
    insertLogEntries,
    close,
    getDbPath,
  };
}

module.exports = { createSystemStore };
