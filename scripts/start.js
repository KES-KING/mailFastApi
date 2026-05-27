"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const mode = normalizeMode(args[0] || "core");
const forwardedArgs = args.slice(mode.consumedArgs);

if (mode.help) {
  printUsage();
  process.exit(0);
}

if (mode.error) {
  console.error(mode.error);
  printUsage();
  process.exit(1);
}

const child = spawn(process.execPath, [mode.entry, ...forwardedArgs], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    ...(mode.role ? { MAILFASTAPI_ROLE: mode.role } : {}),
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
    return;
  }
  console.error(`mailFastApi ${mode.name} terminated with signal: ${signal}`);
  process.exit(1);
});

child.on("error", (error) => {
  console.error(`Failed to start mailFastApi ${mode.name}: ${error.message}`);
  process.exit(1);
});

function normalizeMode(value) {
  const raw = String(value || "core").trim().toLowerCase();
  if (raw === "--help" || raw === "-h" || raw === "help") {
    return { help: true, consumedArgs: 1 };
  }
  if (raw === "core") {
    return { name: "core", entry: "src/app.js", consumedArgs: 1 };
  }
  if (raw === "web") {
    return { name: "web", entry: "src/web.js", consumedArgs: 1 };
  }
  if (raw === "api") {
    return { name: "api", entry: "src/app.js", role: "api", consumedArgs: 1 };
  }
  if (raw === "worker") {
    return { name: "worker", entry: "src/app.js", role: "worker", consumedArgs: 1 };
  }
  if (raw === "all") {
    return { name: "all", entry: "src/app.js", role: "all", consumedArgs: 1 };
  }
  if (raw.startsWith("-")) {
    return { name: "core", entry: "src/app.js", consumedArgs: 0 };
  }
  return {
    error: `Unknown start target: ${value}`,
    consumedArgs: 1,
  };
}

function printUsage() {
  console.log(`Usage:
  npm start                 Start core service
  npm start core            Start core service
  npm start web             Start legacy web panel on port 8080
  npm start api             Start core in API-only role
  npm start worker          Start core in worker-only role
  npm start all             Start core with API and worker roles`);
}
