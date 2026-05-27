"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  assertSafeGitRef,
  assertSafeRemoteName,
  compareTagsDescending,
  parseArgs,
  parseTagVersion,
} = require("../../scripts/updater");

describe("updater helpers", () => {
  test("parses release-mode and target options", () => {
    const options = parseArgs(["--check", "--json", "--release-mode", "tag", "--target", "v1.2.3"]);

    assert.equal(options.mode, "check");
    assert.equal(options.json, true);
    assert.equal(options.releaseMode, "tag");
    assert.equal(options.target, "v1.2.3");
  });

  test("sorts semantic release tags descending", () => {
    const tags = ["v1.9.0", "v1.10.0", "v2.0.0", "v1.10.1"];

    assert.deepEqual(tags.sort(compareTagsDescending), [
      "v2.0.0",
      "v1.10.1",
      "v1.10.0",
      "v1.9.0",
    ]);
  });

  test("extracts numeric tag parts", () => {
    assert.deepEqual(parseTagVersion("v10.20.3"), [10, 20, 3]);
  });

  test("rejects unsafe git refs and remote names", () => {
    assert.doesNotThrow(() => assertSafeGitRef("origin/main"));
    assert.doesNotThrow(() => assertSafeRemoteName("origin"));

    assert.throws(() => assertSafeGitRef("--upload-pack=sh"), { code: "REF_NOT_ALLOWED" });
    assert.throws(() => assertSafeGitRef("origin/main..evil"), { code: "REF_NOT_ALLOWED" });
    assert.throws(() => assertSafeRemoteName("--upload-pack=sh"), { code: "REMOTE_NOT_ALLOWED" });
    assert.throws(() => assertSafeRemoteName("origin/main"), { code: "REMOTE_NOT_ALLOWED" });
  });
});
