"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { InMemoryQueue } = require("../../src/queue");

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
});
