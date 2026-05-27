"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

const targetUrl = new URL("/send", baseUrl).toString();
const harPath = path.join(os.tmpdir(), `mailfastapi-autocannon-${process.pid}.har`);
writeHarRequest(harPath, targetUrl, body, token);

const args = [
  "autocannon",
  "--har",
  harPath,
  "-c",
  process.env.CONNECTIONS || "50",
  "-d",
  process.env.DURATION || "30",
  targetUrl,
];

if (process.env.OVERALL_RATE) {
  args.splice(args.length - 1, 0, "-R", process.env.OVERALL_RATE);
}

if (process.env.RENDER_STATUS_CODES === "true") {
  args.splice(args.length - 1, 0, "--renderStatusCodes");
}

const child = spawn("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  try {
    fs.unlinkSync(harPath);
  } catch (error) {
    // Best-effort cleanup only.
  }

  if (typeof code === "number") {
    process.exit(code);
  }
  console.error(`autocannon terminated with signal: ${signal}`);
  process.exit(1);
});

function writeHarRequest(filePath, url, requestBody, accessToken) {
  const har = {
    log: {
      version: "1.2",
      creator: {
        name: "mailfastapi-load-helper",
        version: "1.0.0",
      },
      entries: [
        {
          startedDateTime: new Date().toISOString(),
          time: 0,
          request: {
            method: "POST",
            url,
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [
              { name: "content-type", value: "application/json" },
              { name: "authorization", value: `Bearer ${accessToken}` },
            ],
            queryString: [],
            postData: {
              mimeType: "application/json",
              text: requestBody,
            },
            headersSize: -1,
            bodySize: Buffer.byteLength(requestBody),
          },
          response: {
            status: 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            content: {
              size: 0,
              mimeType: "x-unknown",
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: {
            send: 0,
            wait: 0,
            receive: 0,
          },
        },
      ],
    },
  };

  fs.writeFileSync(filePath, JSON.stringify(har));
}
