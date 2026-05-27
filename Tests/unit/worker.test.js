"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { createWorker } = require("../../src/worker");

describe("worker delivery lifecycle", () => {
  test("adds one-click unsubscribe headers and acknowledges successful jobs", async () => {
    const sent = [];
    const acked = [];
    const queue = createSingleJobQueue(
      {
        id: "job-1",
        to: "user@example.com",
        subject: "Hello",
        html: "<p>Hello</p>",
        unsubscribeUrl: "https://mail.example.com/unsubscribe?token=abc",
        queuedAt: Date.now(),
      },
      acked,
    );
    const worker = createWorker({
      queue,
      transporter: {
        sendMail: async (mailOptions) => {
          sent.push(mailOptions);
          return { messageId: "message-1" };
        },
      },
      concurrency: 1,
      retryAttempts: 1,
      logger: () => {},
    });

    worker.start();
    await worker.stop({ drainTimeoutMs: 1000 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers["List-Unsubscribe"], "<https://mail.example.com/unsubscribe?token=abc>");
    assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.deepEqual(acked, ["job-1"]);
  });

  test("dead-letters and acknowledges jobs after final failure", async () => {
    const acked = [];
    const deadLetters = [];
    const queue = createSingleJobQueue(
      {
        id: "job-2",
        to: "user@example.com",
        subject: "Hello",
        html: "<p>Hello</p>",
        queuedAt: Date.now(),
      },
      acked,
    );
    const worker = createWorker({
      queue,
      transporter: {
        sendMail: async () => {
          throw new Error("smtp unavailable");
        },
      },
      deadLetterSink: (job, error) => {
        deadLetters.push({ jobId: job.id, reason: error.message });
      },
      concurrency: 1,
      retryAttempts: 1,
      logger: () => {},
    });

    worker.start();
    await worker.stop({ drainTimeoutMs: 1000 });

    assert.deepEqual(deadLetters, [{ jobId: "job-2", reason: "smtp unavailable" }]);
    assert.deepEqual(acked, ["job-2"]);
  });
});

function createSingleJobQueue(job, acked) {
  let delivered = false;
  let closed = false;
  return {
    get length() {
      return delivered ? 0 : 1;
    },
    async dequeue() {
      if (closed || delivered) {
        return null;
      }
      delivered = true;
      return job;
    },
    async ack(nextJob) {
      acked.push(nextJob.id);
      return true;
    },
    async touch() {
      return true;
    },
    close() {
      closed = true;
    },
  };
}
