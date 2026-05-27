"use strict";

const { spawn } = require("node:child_process");

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const token = process.env.ACCESS_TOKEN || "";

if (!token) {
  console.error("ACCESS_TOKEN is required. Create one with POST /auth/token before running autocannon.");
  process.exit(1);
}

const body = JSON.stringify({
  tenantId: process.env.TENANT_ID || "load_test",
  category: process.env.MAIL_CATEGORY || "transactional",
  to: process.env.TEST_TO || "autocannon@example.com",
  subject: "Autocannon load test",
  html: "<p>Autocannon load test</p>",
});

const args = [
  "autocannon",
  "-m",
  "POST",
  "-H",
  "content-type=application/json",
  "-H",
  `authorization=Bearer ${token}`,
  "-b",
  body,
  "-c",
  process.env.CONNECTIONS || "50",
  "-d",
  process.env.DURATION || "30",
  `${baseUrl}/send`,
];

const child = spawn("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }
  console.error(`autocannon terminated with signal: ${signal}`);
  process.exit(1);
});
