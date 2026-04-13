"use strict";

const { spawn } = require("node:child_process");

const isMailSendMode = process.argv.slice(2).some((arg) => String(arg).toLowerCase() === "mailsend");

const env = {
  ...process.env,
  MAILSEND_MODE: isMailSendMode ? "true" : "false",
};

const child = spawn(process.execPath, ["--test", "Tests/**/*.test.js"], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
    return;
  }

  if (signal) {
    console.error(`Test process terminated with signal: ${signal}`);
  }
  process.exit(1);
});
