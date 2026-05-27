"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { InMemoryQueue } = require("../../src/queue");
const { createMemoryMailQueue } = require("../../src/memoryMailQueue");

describe("queue module", () => {
  test("keeps FIFO order", async () => {
    const queue = new InMemoryQueue({ maxSize: 10 });

    queue.enqueue({ id: "1" });
    queue.enqueue({ id: "2" });
    queue.enqueue({ id: "3" });

    const first = await queue.dequeue();
    const second = await queue.dequeue();
    const third = await queue.dequeue();

    assert.equal(first.id, "1");
    assert.equal(second.id, "2");
    assert.equal(third.id, "3");
    queue.close();
  });

  test("throws QUEUE_FULL when max size is reached", () => {
    const queue = new InMemoryQueue({ maxSize: 1 });
    queue.enqueue({ id: "1" });

    assert.throws(
      () => queue.enqueue({ id: "2" }),
      (error) => error && error.code === "QUEUE_FULL",
    );
    queue.close();
  });

  test("returns null from dequeue after close", async () => {
    const queue = new InMemoryQueue({ maxSize: 10 });
    queue.close();
    const item = await queue.dequeue();
    assert.equal(item, null);
  });

  test("memory mail queue exposes delayed deferred jobs in depth", async () => {
    const queue = createMemoryMailQueue({ maxSize: 10 });

    await queue.defer({ id: "later" }, 10);
    assert.equal(await queue.getDepth(), 1);
    assert.equal(await queue.getDelayedDepth(), 1);

    const item = await queue.dequeue();
    assert.equal(item.id, "later");
    assert.equal(await queue.getDelayedDepth(), 0);
    queue.close();
  });
});
