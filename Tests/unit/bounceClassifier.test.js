"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { classifyBounce } = require("../../src/bounceClassifier");

describe("bounce classifier", () => {
  test("classifies hard bounce status and suppressible patterns", () => {
    const result = classifyBounce({
      responseCode: 550,
      response: "5.1.1 user unknown",
    });

    assert.equal(result.type, "hard");
    assert.equal(result.reason, "hard_bounce");
    assert.equal(result.suppress, true);
    assert.equal(result.retryable, false);
  });

  test("classifies greylisting as retryable soft bounce", () => {
    const result = classifyBounce({
      responseCode: 451,
      response: "temporarily deferred due to greylisting",
    });

    assert.equal(result.type, "soft");
    assert.equal(result.reason, "greylisted");
    assert.equal(result.suppress, false);
    assert.equal(result.retryable, true);
  });

  test("classifies complaints as suppressible complaint events", () => {
    const result = classifyBounce({ type: "complaint", message: "spam report" });

    assert.equal(result.type, "complaint");
    assert.equal(result.reason, "complaint");
    assert.equal(result.suppress, true);
  });
});
