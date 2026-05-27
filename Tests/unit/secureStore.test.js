"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const { createSecureStore } = require("../../src/secureStore");
const { generateTotp } = require("../../src/totp");

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

  test("accepts email-like and readable SMTP account names", () => {
    const dbPath = createTempDbPath();
    const store = createSecureStore({ dbPath, secretKey: TEST_SECRET });
    try {
      store.upsertSmtpAccount({
        name: "Info.Mail+2FA@example.com",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "info@example.com",
        pass: "super-secret",
        from: "Info <info@example.com>",
      });
      store.upsertSmtpAccount({
        name: "Bilgi Maili",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "bilgi@example.com",
        pass: "super-secret",
        from: "Bilgi <bilgi@example.com>",
      });

      assert.equal(
        store.getSmtpAccount("info.mail+2fa@example.com").name,
        "info.mail+2fa@example.com",
      );
      assert.equal(store.getSmtpAccount("bilgi maili").name, "bilgi maili");
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

  test("stores managed application settings encrypted", () => {
    const dbPath = createTempDbPath();
    const store = createSecureStore({ dbPath, secretKey: TEST_SECRET });
    try {
      store.setAppSettings({
        JWT_SECRET: "managed-jwt-secret",
        PORT: "3100",
      });

      assert.deepEqual(store.getAppSettings(), {
        JWT_SECRET: "managed-jwt-secret",
        PORT: "3100",
      });

      const fileText = fs.readFileSync(dbPath, "latin1");
      assert.equal(fileText.includes("managed-jwt-secret"), false);
      assert.equal(fileText.includes("3100"), false);
    } finally {
      store.close();
      cleanupDb(dbPath);
    }
  });

  test("enrolls TOTP MFA and consumes recovery codes once", () => {
    const dbPath = createTempDbPath();
    const store = createSecureStore({ dbPath, secretKey: TEST_SECRET });
    try {
      store.setAdminPassword("valid-test-password");
      const enrollment = store.beginAdminTotpEnrollment({
        issuer: "MailFastApi",
        accountName: "admin@example.com",
      });
      const code = generateTotp(enrollment.secret);
      const result = store.confirmAdminTotpEnrollment(code);

      assert.equal(store.hasAdminTotp(), true);
      assert.equal(store.getAdminMfaStatus().totpEnabled, true);
      assert.equal(store.verifyAdminMfaCode(generateTotp(enrollment.secret)), true);
      assert.equal(result.recoveryCodes.length, 8);

      const recoveryCode = result.recoveryCodes[0];
      assert.equal(store.verifyAdminMfaCode(recoveryCode), true);
      assert.equal(store.verifyAdminMfaCode(recoveryCode), false);

      const fileText = fs.readFileSync(dbPath, "latin1");
      assert.equal(fileText.includes(enrollment.secret), false);
      assert.equal(fileText.includes(recoveryCode), false);
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

  test("can read secure store key from file source", () => {
    const dbPath = createTempDbPath();
    const keyPath = path.join(os.tmpdir(), `mailfastapi-secure-key-${process.pid}-${Date.now()}.txt`);
    const previous = process.env.SECURE_STORE_KEY_FILE;
    fs.writeFileSync(keyPath, `${TEST_SECRET}\n`);
    process.env.SECURE_STORE_KEY_FILE = keyPath;

    const store = createSecureStore({ dbPath });
    try {
      store.setAdminPassword("valid-test-password");
      assert.equal(store.verifyAdminPassword("valid-test-password"), true);
    } finally {
      store.close();
      cleanupDb(dbPath);
      fs.unlinkSync(keyPath);
      if (previous === undefined) {
        delete process.env.SECURE_STORE_KEY_FILE;
      } else {
        process.env.SECURE_STORE_KEY_FILE = previous;
      }
    }
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
