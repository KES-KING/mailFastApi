"use strict";

const { InMemoryQueue } = require("./queue");

function createMemoryMailQueue(options = {}) {
  const maxSize = options.maxSize || 50000;
  const queue = new InMemoryQueue({ maxSize });
  const delayedTimers = new Set();
  let delayedCount = 0;

  return {
    backend: "memory",
    start: async () => {},
    stop: async () => {
      clearDelayedTimers();
      queue.close();
    },
    enqueue: async (job) => {
      if (queue.length + delayedCount >= maxSize) {
        const error = new Error("Queue is full.");
        error.code = "QUEUE_FULL";
        throw error;
      }
      queue.enqueue(job);
      return queue.length + delayedCount;
    },
    dequeue: async () => queue.dequeue(),
    ack: async () => true,
    touch: async () => true,
    defer: async (job, delayMs) => {
      const waitMs = Math.max(0, Number(delayMs) || 0);
      delayedCount += 1;
      scheduleDelayed(job, waitMs);
      return true;
    },
    getDepth: async () => queue.length + delayedCount,
    getProcessingDepth: async () => 0,
    getDelayedDepth: async () => delayedCount,
    close: () => {
      clearDelayedTimers();
      queue.close();
    },
    get length() {
      return queue.length + delayedCount;
    },
  };

  function clearDelayedTimers() {
    for (const timer of delayedTimers) {
      clearTimeout(timer);
    }
    delayedTimers.clear();
    delayedCount = 0;
  }

  function scheduleDelayed(job, waitMs) {
    const timer = setTimeout(() => {
      delayedTimers.delete(timer);
      if (queue.closed) {
        delayedCount = Math.max(0, delayedCount - 1);
        return;
      }
      try {
        queue.enqueue(job);
        delayedCount = Math.max(0, delayedCount - 1);
      } catch (error) {
        scheduleDelayed(job, 1000);
      }
    }, waitMs);
    delayedTimers.add(timer);
  }
}

module.exports = { createMemoryMailQueue };
