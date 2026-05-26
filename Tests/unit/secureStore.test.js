"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const { createSecureStore } = require("../../src/secureStore");

const TEST_SECRET = "tests_secure_store_secret_key_32_chars_minimum";

describe("secure store", () => {
  test("encrypts and decrypts SMTP account records", () => {
    const dbPath = createTempDbPath();
    const store = createSecureStore({ dbPath, secretKey: TEST_SECRET });
    try {
      store.upsertSmtpAccount({
        name: "info",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "info@example.com",
        pass: "super-secret",
        from: "Info <info@example.com>",
      });
      store.setDefaultSmtpAccountName("info");

      const account = store.getSmtpAccount("info");
      assert.equal(account.pass, "super-secret");
      assert.equal(store.getDefaultSmtpAccountName(), "info");

      const fileText = fs.readFileSync(dbPath, "latin1");
      assert.equal(fileText.includes("super-secret"), false);
      assert.equal(fileText.includes("smtp.example.com"), false);
    } finally {
      store.close();
      cleanupDb(dbPath);
    }
  });

  test("stores web admin password as a non-plaintext verifier", () => {
    const dbPath = createTempDbPath();
    const store = createSecureStore({ dbPath, secretKey: TEST_SECRET });
    try {
      store.setAdminPassword("valid-test-password");
      assert.equal(store.hasAdminPassword(), true);
      assert.equal(store.verifyAdminPassword("valid-test-password"), true);
      assert.equal(store.verifyAdminPassword("wrong-password"), false);

      const fileText = fs.readFileSync(dbPath, "latin1");
      assert.equal(fileText.includes("valid-test-password"), false);
    } finally {
      store.close();
      cleanupDb(dbPath);
    }
  });

  test("rejects the example secure store key", () => {
    assert.throws(
      () =>
        createSecureStore({
          dbPath: createTempDbPath(),
          secretKey: "change_me_with_at_least_32_random_characters",
        }),
      /must be changed from the example value/,
    );
  });
});

function createTempDbPath() {
  return path.join(
    os.tmpdir(),
    `mailfastapi-secure-store-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
  );
}

function cleanupDb(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch (error) {
      // noop
    }
  }
}
