"use strict";

require("dotenv").config();

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

main().catch((error) => {
  console.error(`[retry-failed] ${error && error.message ? error.message : "Unknown error"}`);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, options);
  const headers = await resolveAuthHeaders(config);

  const response = await fetch(new URL("/dead-letters/retry", config.baseUrl), {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      ids: config.ids,
      limit: config.limit,
      force: config.force,
      dryRun: config.dryRun,
    }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error((payload && (payload.error || payload.message)) || `Retry failed with HTTP ${response.status}.`);
  }

  console.log("MailFastApi failed-mail retry");
  console.log(`- endpoint: ${config.baseUrl}/dead-letters/retry`);
  console.log(`- limit: ${config.limit}`);
  console.log(`- ids: ${config.ids.length > 0 ? config.ids.join(",") : "pending latest"}`);
  console.log(`- dryRun: ${config.dryRun}`);
  console.log(`- force: ${config.force}`);
  console.log(`- retried: ${payload.retried || 0}`);
  console.log(`- wouldRetry: ${payload.wouldRetry || 0}`);
  console.log(`- skipped: ${payload.skipped || 0}`);
  console.log(`- failed: ${payload.failed || 0}`);

  if (Number(payload.failed || 0) > 0) {
    process.exitCode = 2;
  }
}

function loadConfig(env, options) {
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl || env.BASE_URL || env.MAILFASTAPI_BASE_URL || DEFAULT_BASE_URL),
    authMode: clean(env.AUTH_MODE || "jwt").toLowerCase(),
    clientId: clean(options.clientId || env.RETRY_FAILED_AUTH_CLIENT_ID || env.AUTH_CLIENT_ID),
    clientSecret: clean(options.clientSecret || env.RETRY_FAILED_AUTH_CLIENT_SECRET || env.AUTH_CLIENT_SECRET),
    apiKey: clean(options.apiKey || env.RETRY_FAILED_API_KEY || env.API_KEY),
    ids: options.ids,
    limit: options.limit,
    force: options.force,
    dryRun: options.dryRun,
  };
}

async function resolveAuthHeaders(config) {
  if (config.authMode === "none") {
    return {};
  }
  if (config.authMode === "api_key") {
    if (!config.apiKey) {
      throw new Error("API_KEY or RETRY_FAILED_API_KEY is required when AUTH_MODE=api_key.");
    }
    return { "x-api-key": config.apiKey };
  }
  if (!config.clientId || !config.clientSecret) {
    throw new Error("AUTH_CLIENT_ID/AUTH_CLIENT_SECRET or retry auth overrides are required.");
  }

  const response = await fetch(new URL("/auth/token", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload || !payload.access_token) {
    throw new Error(`Token request failed with HTTP ${response.status}.`);
  }
  return { authorization: `Bearer ${payload.access_token}` };
}

function parseArgs(args) {
  const options = {
    ids: [],
    limit: 100,
    dryRun: false,
    force: false,
    baseUrl: "",
    clientId: "",
    clientSecret: "",
    apiKey: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index] || "";
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--limit") {
      options.limit = clampInt(next(), 100, 1, 500);
    } else if (arg.startsWith("--limit=")) {
      options.limit = clampInt(arg.slice("--limit=".length), 100, 1, 500);
    } else if (arg === "--ids") {
      options.ids = normalizeIds(next());
    } else if (arg.startsWith("--ids=")) {
      options.ids = normalizeIds(arg.slice("--ids=".length));
    } else if (arg === "--base-url") {
      options.baseUrl = next();
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--client-id") {
      options.clientId = next();
    } else if (arg === "--client-secret") {
      options.clientSecret = next();
    } else if (arg === "--api-key") {
      options.apiKey = next();
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run retry:failed -- [options]

Options:
  --limit <n>       Retry up to n pending dead-letter jobs. Default: 100.
  --ids <a,b,c>     Retry specific dead-letter ids.
  --dry-run         Validate and report without queueing.
  --force           Retry hard-bounce/suppressed jobs too.
  --base-url <url>  MailFastApi base URL. Default: http://127.0.0.1:3000.
`);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeIds(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  ];
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, next));
}

function clean(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}
