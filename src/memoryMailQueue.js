"use strict";

const { InMemoryQueue } = require("./queue");

function createMemoryMailQueue(options = {}) {
  const queue = new InMemoryQueue({ maxSize: options.maxSize || 50000 });

  return {
    backend: "memory",
    start: async () => {},
    stop: async () => {
      queue.close();
    },
    enqueue: async (job) => {
      queue.enqueue(job);
      return queue.length;
    },
    dequeue: async () => queue.dequeue(),
    getDepth: async () => queue.length,
    close: () => queue.close(),
    get length() {
      return queue.length;
    },
  };
}

module.exports = { createMemoryMailQueue };
