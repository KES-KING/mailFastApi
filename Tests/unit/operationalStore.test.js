"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { describe, test } = require("node:test");

const { createOperationalStore } = require("../../src/operationalStore");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailfastapi-operational-"));
  return path.join(dir, "ops.sqlite");
}

describe("operational store", () => {
  test("supports global and tenant-level suppression independently", () => {
    const store = createOperationalStore({ dbPath: createTempDbPath() });
    try {
      store.addSuppression("User@Example.com", {
        tenantId: "tenant_a",
        reason: "hard_bounce",
        source: "test",
      });
      store.addSuppression("global@example.com", {
        tenantId: "global",
        reason: "complaint",
        source: "test",
      });

      assert.deepEqual(store.findSuppressedRecipients(["user@example.com"], "tenant_a"), [
        "user@example.com",
      ]);
      assert.deepEqual(store.findSuppressedRecipients(["user@example.com"], "tenant_b"), []);
      assert.deepEqual(store.findSuppressedRecipients(["global@example.com"], "tenant_b"), [
        "global@example.com",
      ]);
    } finally {
      store.close();
    }
  });

  test("stores and replays idempotency responses", () => {
    const store = createOperationalStore({ dbPath: createTempDbPath() });
    try {
      store.putIdempotencyRecord(
        "tenant:actor",
        "idem-1",
        "request-hash",
        202,
        { status: "queued" },
        60000,
      );

      const record = store.getIdempotencyRecord("tenant:actor", "idem-1");
      assert.equal(record.requestHash, "request-hash");
      assert.equal(record.statusCode, 202);
      assert.deepEqual(record.response, { status: "queued" });
    } finally {
      store.close();
    }
  });

  test("writes dead-letter jobs and hash-chained audit events", () => {
    const dbPath = createTempDbPath();
    const store = createOperationalStore({ dbPath });
    try {
      store.insertDeadLetterJob(
        { id: "job-1", tenantId: "tenant_a", to: ["user@example.com"], smtpAccount: "default" },
        "smtp failed",
      );
      store.insertAuditEvent("operator", "config.change", "smtp", { account: "default" });
    } finally {
      store.close();
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const deadLetter = db.prepare("SELECT * FROM dead_letter_jobs WHERE job_id = ?").get("job-1");
      assert.equal(deadLetter.tenant_id, "tenant_a");
      assert.equal(deadLetter.reason, "smtp failed");

      const audits = db.prepare("SELECT * FROM audit_events ORDER BY id").all();
      assert.ok(audits.length >= 1);
      assert.ok(String(audits[0].event_hash).length >= 32);
    } finally {
      db.close();
    }
  });

  test("lists and marks dead-letter jobs as requeued", () => {
    const store = createOperationalStore({ dbPath: createTempDbPath() });
    try {
      store.insertDeadLetterJob(
        {
          id: "job-2",
          tenantId: "tenant_a",
          to: ["retry@example.com"],
          smtpAccount: "default",
          subject: "Retry me",
          html: "<p>retry</p>",
        },
        "smtp failed",
      );

      const pending = store.listDeadLetterJobs({ limit: 10 });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].subject, "Retry me");

      const full = store.getDeadLetterJob(pending[0].id);
      assert.equal(full.job.subject, "Retry me");

      assert.equal(
        store.markDeadLetterRequeued(pending[0].id, {
          requeuedJobId: "job-2-retry",
          actor: "operator",
        }),
        true,
      );
      assert.deepEqual(store.listDeadLetterJobs({ limit: 10 }), []);

      const all = store.listDeadLetterJobs({ limit: 10, includeRequeued: true });
      assert.equal(all[0].requeuedJobId, "job-2-retry");
      assert.equal(all[0].requeuedBy, "operator");
    } finally {
      store.close();
    }
  });

  test("marks pending dead-letter jobs as final error", () => {
    const store = createOperationalStore({ dbPath: createTempDbPath() });
    try {
      store.insertDeadLetterJob(
        {
          id: "job-3",
          tenantId: "tenant_a",
          to: ["final@example.com"],
          smtpAccount: "default",
          subject: "Final",
          html: "<p>final</p>",
          autoRetryCount: 3,
        },
        "smtp failed",
      );

      const pending = store.listDeadLetterJobs({ limit: 10 });
      assert.equal(pending[0].autoRetryCount, 3);
      assert.equal(store.markDeadLetterFinalError(pending[0].id, { reason: "auto_retry_exhausted" }), true);
      assert.deepEqual(store.listDeadLetterJobs({ limit: 10 }), []);

      const all = store.listDeadLetterJobs({ limit: 10, includeRequeued: true });
      assert.equal(all[0].finalErrorReason, "auto_retry_exhausted");
      assert.ok(all[0].finalErrorAtMs);
    } finally {
      store.close();
    }
  });

  test("records lifecycle states and delivery counters", () => {
    const store = createOperationalStore({ dbPath: createTempDbPath() });
    try {
      store.recordJobLifecycle("job-1", "queued", { tenantId: "tenant_a" });
      store.recordJobLifecycle("job-1", "processing", { tenantId: "tenant_a" });
      store.recordJobLifecycle("job-1", "delivered", {
        tenantId: "tenant_a",
        details: { messageId: "message-1" },
      });

      store.recordDeliveryEvent("queued", {
        tenantId: "tenant_a",
        smtpAccount: "default",
        recipients: ["user@example.com"],
        jobId: "job-1",
      });
      store.recordDeliveryEvent("sent", {
        tenantId: "tenant_a",
        smtpAccount: "default",
        recipients: ["user@example.com"],
        jobId: "job-1",
      });

      const lifecycle = store.getJobLifecycle("job-1");
      assert.deepEqual(lifecycle.map((entry) => entry.state), ["queued", "processing", "delivered"]);
      assert.equal(
        store.countDeliveryEvents({
          tenantId: "tenant_a",
          smtpAccount: "default",
          domain: "example.com",
          events: ["queued", "sent"],
          sinceMs: Date.now() - 1000,
        }),
        2,
      );
      assert.equal(store.getDeliveryEventTotals(Date.now() - 1000).sent, 1);
    } finally {
      store.close();
    }
  });

  test("ingests hard bounces and complaints into suppression", () => {
    const store = createOperationalStore({ dbPath: createTempDbPath() });
    try {
      store.insertBounceEvent("hard@example.com", {
        tenantId: "tenant_a",
        bounceType: "hard",
        reason: "hard_bounce",
      });
      store.insertComplaintEvent("complaint@example.com", {
        tenantId: "tenant_a",
      });

      assert.ok(store.getSuppression("hard@example.com", "tenant_a"));
      assert.ok(store.getSuppression("complaint@example.com", "tenant_a"));
    } finally {
      store.close();
    }
  });
});
