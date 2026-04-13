"use strict";

class InMemoryQueue {
  constructor(options = {}) {
    const { maxSize = 50000 } = options;
    this.maxSize = maxSize;
    this.items = [];
    this.head = 0;
    this.waiters = [];
    this.closed = false;
  }

  get length() {
    return this.items.length - this.head;
  }

  enqueue(job) {
    if (this.closed) {
      const error = new Error("Queue is closed.");
      error.code = "QUEUE_CLOSED";
      throw error;
    }

    if (this.length >= this.maxSize) {
      const error = new Error("Queue is full.");
      error.code = "QUEUE_FULL";
      throw error;
    }

    this.items.push(job);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
    return this.length;
  }

  async dequeue() {
    while (true) {
      if (this.length > 0) {
        const item = this.items[this.head];
        this.items[this.head] = undefined;
        this.head += 1;

        // Periodically compact to keep memory usage stable.
        if (this.head >= 1024 && this.head * 2 >= this.items.length) {
          this.items = this.items.slice(this.head);
          this.head = 0;
        }

        return item;
      }

      if (this.closed) {
        return null;
      }

      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter();
    }
  }
}

module.exports = { InMemoryQueue };
