#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const APP_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(APP_DIR, "data");
const STATE_PATH = path.join(DATA_DIR, "update-state.json");
const LOCK_PATH = path.join(DATA_DIR, "updater.lock");

const CORE_SYSTEMD_SERVICE = "mailfastapi-core.service";
const WEB_SYSTEMD_SERVICE = "mailfastapi-web.service";
const CORE_LAUNCHD_LABEL = "com.mailfastapi.core";
const WEB_LAUNCHD_LABEL = "com.mailfastapi.web";
const CORE_WINDOWS_TASK = "mailfastapi-core";
const WEB_WINDOWS_TASK = "mailfastapi-web";
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

const DEFAULT_TAG_PATTERN = "^v[0-9]+\\.[0-9]+\\.[0-9]+$";

class UpdaterError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const context = {
  ok: false,
  code: "",
  message: "",
  updateAvailable: false,
  applied: false,
  rolledBack: false,
  restartDeferred: false,
  branch: "",
  localSha: "",
  remoteSha: "",
  upstream: "",
  remote: "",
  releaseMode: "",
  latest: {
    sha: "",
    shortSha: "",
    subject: "",
    author: "",
    date: "",
    tag: "",
  },
  security: {
    fastForwardOnly: true,
    targetIsFastForward: null,
    allowedTagPattern: "",
    signedTagRequired: false,
    signedTagVerified: null,
    rollbackEnabled: true,
    dirtyAllowed: false,
  },
  steps: [],
  rollback: null,
};

function parseArgs(argv) {
  const options = {
    mode: "interactive",
    json: false,
    assumeYes: false,
    allowDirty: false,
    skipRestart: false,
    skipHealth: false,
    deferRestart: false,
    noRollback: false,
    releaseMode: clean(process.env.UPDATER_RELEASE_MODE || "branch").toLowerCase(),
    target: clean(process.env.UPDATER_TARGET || ""),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--check":
        options.mode = "check";
        break;
      case "--apply":
        options.mode = "apply";
        break;
      case "--yes":
        options.assumeYes = true;
        break;
      case "--allow-dirty":
        options.allowDirty = true;
        break;
      case "--skip-restart":
        options.skipRestart = true;
        break;
      case "--skip-health":
        options.skipHealth = true;
        break;
      case "--defer-restart":
        options.deferRestart = true;
        break;
      case "--no-rollback":
        options.noRollback = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--release-mode":
        options.releaseMode = readValue(argv, index, arg).toLowerCase();
        index += 1;
        break;
      case "--target":
        options.target = readValue(argv, index, arg);
        index += 1;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        throw new UpdaterError("UNKNOWN_OPTION", `Unknown option: ${arg}`, 1);
    }
  }

  if (!["branch", "tag"].includes(options.releaseMode)) {
    throw new UpdaterError(
      "INVALID_RELEASE_MODE",
      "UPDATER_RELEASE_MODE must be branch or tag.",
      1,
    );
  }

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UpdaterError("MISSING_OPTION_VALUE", `${flag} requires a value.`, 1);
  }
  return clean(value);
}

function usage() {
  console.log(`Usage: node scripts/updater.js [options]

Modes:
  --check                 Only check update status and exit.
  --apply                 Apply update without interactive prompt.
  (default)               Interactive mode: check + ask + apply.

Options:
  --yes                   Skip confirmation prompt.
  --release-mode <mode>   branch or tag. Default: UPDATER_RELEASE_MODE or branch.
  --target <ref|tag>      Explicit branch ref or tag target.
  --allow-dirty           Allow local changes. Not recommended; rollback is disabled.
  --skip-restart          Do not restart services/tasks after update.
  --skip-health           Do not run post-restart health checks.
  --defer-restart         Schedule restart after JSON response, for web panel calls.
  --no-rollback           Disable automatic rollback on post-merge failure.
  --json                  Output machine-readable JSON.
  -h, --help              Show help.

Environment:
  UPDATER_RELEASE_MODE=branch|tag
  UPDATER_TARGET=<branch-ref-or-tag>
  UPDATER_ALLOWED_TAG_PATTERN=${DEFAULT_TAG_PATTERN}
  UPDATER_REQUIRE_SIGNED_TAG=false
  UPDATER_RUN_TESTS=false
`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    context.releaseMode = options.releaseMode;
    context.security.allowedTagPattern = getAllowedTagPattern().source;
    context.security.signedTagRequired = boolEnv("UPDATER_REQUIRE_SIGNED_TAG", false);
    context.security.rollbackEnabled = !options.noRollback && !options.allowDirty;
    context.security.dirtyAllowed = options.allowDirty;

    ensureRequirements(options);
    process.chdir(APP_DIR);

    const update = checkForUpdate(options);
    if (!update.updateAvailable) {
      return finish(true, "UP_TO_DATE", "Sistem guncel. Yeni commit/tag bulunmuyor.", 0);
    }

    context.updateAvailable = true;

    if (options.mode === "check") {
      return finish(true, "UPDATE_AVAILABLE", "Yeni surum bulundu.", 0);
    }

    if (options.mode === "interactive" && !(await interactiveConfirm(options))) {
      return finish(true, "CANCELLED", "Guncelleme islemi iptal edildi.", 0);
    }

    await withApplyLock(options, () => applyUpdate(options));
    return finish(true, "UPDATED", "Guncelleme basariyla uygulandi.", 0);
  } catch (error) {
    if (error instanceof UpdaterError) {
      return finish(false, error.code, error.message, error.exitCode || 1);
    }
    return finish(false, "UPDATER_FAILED", error && error.message ? error.message : "Updater failed.", 1);
  }
}

function ensureRequirements(options) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  commandOk("git", ["--version"], "MISSING_GIT", "git command not found.");
  if (options.mode !== "check") {
    commandOk(NPM_BIN, ["--version"], "MISSING_NPM", "npm command not found.");
  }

  if (!fs.existsSync(path.join(APP_DIR, ".git"))) {
    throw new UpdaterError("NOT_A_REPO", `Project directory is not a git repository: ${APP_DIR}`);
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 22 || !process.versions.sqlite) {
    throw new UpdaterError(
      "NODE_UNSUPPORTED",
      "Node.js >=22 with node:sqlite support is required.",
    );
  }

  context.branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  addStep("requirements", "ok", "Requirements verified.");
}

function commandOk(command, args, code, message) {
  const result = spawnSync(command, args, {
    cwd: APP_DIR,
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new UpdaterError(code, message);
  }
}

function checkForUpdate(options) {
  context.remote = resolveRemoteName();
  git(["fetch", "--prune", "--tags", context.remote]);
  addStep("fetch", "ok", `Fetched ${context.remote}.`);

  const target = options.releaseMode === "tag" ? resolveTagTarget(options) : resolveBranchTarget(options);
  context.upstream = target.ref;
  context.remoteSha = target.sha;
  context.latest = {
    sha: target.sha,
    shortSha: git(["rev-parse", "--short", target.sha]),
    subject: git(["log", "-n", "1", "--format=%s", target.sha]),
    author: git(["log", "-n", "1", "--format=%an", target.sha]),
    date: git(["log", "-n", "1", "--format=%aI", target.sha]),
    tag: target.tag || "",
  };

  context.localSha = git(["rev-parse", "HEAD"]);
  const updateAvailable = context.localSha !== context.remoteSha;
  context.updateAvailable = updateAvailable;
  context.security.targetIsFastForward = isAncestor(context.localSha, context.remoteSha);

  return {
    updateAvailable,
    target,
  };
}

function resolveRemoteName() {
  const configured = clean(process.env.UPDATER_REMOTE || "");
  if (configured) {
    assertSafeRemoteName(configured);
    git(["remote", "get-url", configured]);
    return configured;
  }

  const remotes = git(["remote"]).split(/\r?\n/).filter(Boolean);
  if (remotes.includes("origin")) {
    return "origin";
  }
  if (remotes.length > 0) {
    assertSafeRemoteName(remotes[0]);
    return remotes[0];
  }
  throw new UpdaterError("REMOTE_NOT_FOUND", "No git remote configured.");
}

function resolveBranchTarget(options) {
  if (options.target) {
    assertSafeGitRef(options.target);
    const sha = git(["rev-parse", "--verify", `${options.target}^{commit}`]);
    return { ref: options.target, sha };
  }

  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowFailure: true,
  });
  if (upstream.status === 0 && clean(upstream.stdout)) {
    const ref = clean(upstream.stdout);
    assertSafeGitRef(ref);
    return { ref, sha: git(["rev-parse", "--verify", `${ref}^{commit}`]) };
  }

  const candidates = [
    `${context.remote}/${context.branch}`,
    `${context.remote}/main`,
    `${context.remote}/master`,
  ];

  for (const ref of candidates) {
    const exists = runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`], {
      allowFailure: true,
    });
    if (exists.status === 0) {
      assertSafeGitRef(ref);
      return { ref, sha: git(["rev-parse", "--verify", `${ref}^{commit}`]) };
    }
  }

  throw new UpdaterError("UPSTREAM_NOT_FOUND", "Could not resolve upstream reference.");
}

function assertSafeRemoteName(name) {
  const value = clean(name);
  if (!value || value.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new UpdaterError("REMOTE_NOT_ALLOWED", `Unsafe git remote name: ${name}`, 1);
  }
}

function assertSafeGitRef(ref) {
  const value = clean(ref);
  const hasUnsafeToken =
    !value ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    /[\u0000-\u001F\u007F\s~^:?*[\\]/.test(value);

  if (hasUnsafeToken) {
    throw new UpdaterError("REF_NOT_ALLOWED", `Unsafe git ref target: ${ref}`, 1);
  }
}

function resolveTagTarget(options) {
  const tag = options.target || resolveLatestAllowedTag();
  assertAllowedTag(tag);
  const sha = git(["rev-list", "-n", "1", tag]);
  const signed = verifyTagSignature(tag);
  context.security.signedTagVerified = signed;

  if (context.security.signedTagRequired && !signed) {
    throw new UpdaterError(
      "TAG_SIGNATURE_REQUIRED",
      `Tag signature verification failed or unsigned tag was selected: ${tag}`,
      1,
    );
  }

  return {
    ref: tag,
    sha,
    tag,
  };
}

function resolveLatestAllowedTag() {
  const allowed = getAllowedTagPattern();
  const output = git(["for-each-ref", "refs/tags", "--format=%(refname:short)"]);
  const tags = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((tag) => allowed.test(tag))
    .sort(compareTagsDescending);

  if (tags.length === 0) {
    throw new UpdaterError(
      "NO_ALLOWED_TAG",
      `No release tag matches UPDATER_ALLOWED_TAG_PATTERN: ${allowed.source}`,
      1,
    );
  }

  return tags[0];
}

function assertAllowedTag(tag) {
  const allowed = getAllowedTagPattern();
  if (!allowed.test(tag)) {
    throw new UpdaterError(
      "TAG_NOT_ALLOWED",
      `Tag is not allowed by UPDATER_ALLOWED_TAG_PATTERN: ${tag}`,
      1,
    );
  }
}

function getAllowedTagPattern() {
  const pattern = clean(process.env.UPDATER_ALLOWED_TAG_PATTERN || DEFAULT_TAG_PATTERN);
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new UpdaterError("INVALID_TAG_PATTERN", `Invalid UPDATER_ALLOWED_TAG_PATTERN: ${pattern}`);
  }
}

function verifyTagSignature(tag) {
  const result = runGit(["tag", "-v", tag], { allowFailure: true });
  return result.status === 0;
}

async function withApplyLock(options, fn) {
  const release = acquireLock();
  try {
    return await fn();
  } finally {
    release();
  }
}

function acquireLock() {
  const staleMs = intEnv("UPDATER_LOCK_STALE_MS", 30 * 60 * 1000);
  const now = Date.now();

  try {
    const stat = fs.statSync(LOCK_PATH);
    if (now - stat.mtimeMs > staleMs) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  let fd;
  try {
    fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    );
    addStep("lock", "ok", "Updater lock acquired.");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new UpdaterError("UPDATER_LOCKED", "Another update appears to be running.", 2);
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  return () => {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch (error) {
      // noop
    }
  };
}

async function applyUpdate(options) {
  ensureCleanIfNeeded(options);
  ensureFastForwardTarget();
  runPreflight();

  const previousSha = context.localSha || git(["rev-parse", "HEAD"]);
  let gitUpdated = false;

  writeState({
    status: "started",
    previousSha,
    targetSha: context.remoteSha,
    targetRef: context.upstream,
    releaseMode: context.releaseMode,
    startedAt: new Date().toISOString(),
  });

  try {
    git(["merge", "--ff-only", context.upstream]);
    gitUpdated = true;
    context.applied = true;
    addStep("git", "ok", `Fast-forwarded to ${context.latest.shortSha}.`);

    runDependencySync();
    runSyntaxChecks();
    runOptionalTests();
    await restartServices(options);
    await runHealthChecks(options);

    writeState({
      status: "success",
      previousSha,
      targetSha: context.remoteSha,
      targetRef: context.upstream,
      releaseMode: context.releaseMode,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (gitUpdated && context.security.rollbackEnabled) {
      await rollback(previousSha, options, error);
      throw new UpdaterError(
        "UPDATED_ROLLED_BACK",
        `Update failed and rollback completed: ${error.message}`,
        1,
      );
    }

    writeState({
      status: "failed",
      previousSha,
      targetSha: context.remoteSha,
      targetRef: context.upstream,
      releaseMode: context.releaseMode,
      failedAt: new Date().toISOString(),
      error: error.message,
      rollbackSkipped: gitUpdated && !context.security.rollbackEnabled,
    });

    if (error instanceof UpdaterError) {
      throw error;
    }
    throw new UpdaterError("UPDATE_FAILED", error.message || "Update failed.", 1);
  }
}

function ensureCleanIfNeeded(options) {
  const status = git(["status", "--porcelain"]);
  if (!status) {
    addStep("worktree", "ok", "Working tree is clean.");
    return;
  }

  if (options.allowDirty) {
    addStep("worktree", "warn", "Working tree has local changes; rollback is disabled.");
    return;
  }

  throw new UpdaterError(
    "WORKTREE_DIRTY",
    "Working tree has local changes. Commit/stash first.",
    2,
  );
}

function ensureFastForwardTarget() {
  if (context.security.targetIsFastForward !== true) {
    throw new UpdaterError(
      "NON_FAST_FORWARD_UPDATE",
      "Target is not a fast-forward from the current commit. Manual review required.",
      2,
    );
  }
  addStep("fast-forward", "ok", "Target is fast-forward only.");
}

function runPreflight() {
  const requiredFiles = ["package.json", "src/app.js", "src/web.js"];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(APP_DIR, file))) {
      throw new UpdaterError("PREFLIGHT_FAILED", `Required file is missing: ${file}`);
    }
  }

  const minFreeBytes = intEnv("UPDATER_MIN_FREE_BYTES", 50 * 1024 * 1024);
  const freeBytes = getFreeBytes(APP_DIR);
  if (freeBytes !== null && freeBytes < minFreeBytes) {
    throw new UpdaterError("LOW_DISK_SPACE", "Not enough free disk space for update.");
  }

  addStep("preflight", "ok", "Preflight checks passed.");
}

function runDependencySync() {
  if (fs.existsSync(path.join(APP_DIR, "package-lock.json"))) {
    run(NPM_BIN, ["ci", "--omit=dev"]);
    addStep("dependencies", "ok", "npm ci completed.");
    return;
  }

  run(NPM_BIN, ["install", "--omit=dev"]);
  addStep("dependencies", "ok", "npm install completed.");
}

function runSyntaxChecks() {
  const files = ["src/app.js", "src/web.js", "scripts/updater.js"].filter((file) =>
    fs.existsSync(path.join(APP_DIR, file)),
  );

  for (const file of files) {
    run(process.execPath, ["--check", file]);
  }

  addStep("syntax", "ok", "Node syntax checks passed.");
}

function runOptionalTests() {
  if (!boolEnv("UPDATER_RUN_TESTS", false)) {
    addStep("tests", "skipped", "UPDATER_RUN_TESTS is false.");
    return;
  }

  run(NPM_BIN, ["test"]);
  addStep("tests", "ok", "npm test completed.");
}

async function restartServices(options) {
  if (options.skipRestart) {
    addStep("restart", "skipped", "Service restart skipped.");
    return;
  }

  if (options.deferRestart || process.env.MAILFASTAPI_UPDATER_CALLER === "web") {
    scheduleDeferredRestart();
    context.restartDeferred = true;
    addStep("restart", "deferred", "Service restart was scheduled after updater response.");
    return;
  }

  restartNow();
  addStep("restart", "ok", "Services/tasks restarted.");
}

function restartNow() {
  const platform = os.platform();
  if (platform === "win32") {
    run("schtasks.exe", ["/End", "/TN", CORE_WINDOWS_TASK], { allowFailure: true });
    run("schtasks.exe", ["/End", "/TN", WEB_WINDOWS_TASK], { allowFailure: true });
    run("schtasks.exe", ["/Run", "/TN", CORE_WINDOWS_TASK]);
    run("schtasks.exe", ["/Run", "/TN", WEB_WINDOWS_TASK]);
    return;
  }

  if (platform === "darwin") {
    const uid = clean(spawnSync("id", ["-u"], { encoding: "utf8" }).stdout);
    run("launchctl", ["kickstart", "-k", `gui/${uid}/${CORE_LAUNCHD_LABEL}`], {
      allowFailure: true,
    });
    run("launchctl", ["kickstart", "-k", `gui/${uid}/${WEB_LAUNCHD_LABEL}`], {
      allowFailure: true,
    });
    return;
  }

  if (process.getuid && process.getuid() === 0) {
    run("systemctl", ["restart", CORE_SYSTEMD_SERVICE, WEB_SYSTEMD_SERVICE]);
    return;
  }

  run("sudo", ["systemctl", "restart", CORE_SYSTEMD_SERVICE, WEB_SYSTEMD_SERVICE]);
}

function scheduleDeferredRestart() {
  const platform = os.platform();
  let command;
  let args;

  if (platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-Command",
      `Start-Sleep -Seconds 2; schtasks /End /TN ${CORE_WINDOWS_TASK} 2>$null; schtasks /End /TN ${WEB_WINDOWS_TASK} 2>$null; schtasks /Run /TN ${CORE_WINDOWS_TASK}; schtasks /Run /TN ${WEB_WINDOWS_TASK}`,
    ];
  } else if (platform === "darwin") {
    const uid = clean(spawnSync("id", ["-u"], { encoding: "utf8" }).stdout);
    command = "sh";
    args = [
      "-c",
      `sleep 2; launchctl kickstart -k gui/${uid}/${CORE_LAUNCHD_LABEL}; launchctl kickstart -k gui/${uid}/${WEB_LAUNCHD_LABEL}`,
    ];
  } else {
    const systemctl = process.getuid && process.getuid() === 0 ? "systemctl" : "sudo systemctl";
    command = "sh";
    args = ["-c", `sleep 2; ${systemctl} restart ${CORE_SYSTEMD_SERVICE} ${WEB_SYSTEMD_SERVICE}`];
  }

  const child = spawn(command, args, {
    cwd: APP_DIR,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function runHealthChecks(options) {
  if (options.skipHealth) {
    addStep("health", "skipped", "Health checks skipped.");
    return;
  }

  if (context.restartDeferred) {
    addStep("health", "skipped", "Health checks skipped because restart is deferred.");
    return;
  }

  const timeoutMs = intEnv("UPDATER_HEALTH_TIMEOUT_MS", 60 * 1000);
  const port = clean(process.env.PORT || "3000");
  await waitForHealthy(`http://127.0.0.1:${port}/health`, timeoutMs);
  await waitForHealthy("http://127.0.0.1:8080/health", timeoutMs);
  addStep("health", "ok", "Core and web health checks passed.");
}

async function waitForHealthy(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error && error.message ? error.message : "request failed";
    }
    await delay(1000);
  }

  throw new UpdaterError("HEALTH_CHECK_FAILED", `Health check failed for ${url}: ${lastError}`);
}

async function rollback(previousSha, options, cause) {
  context.rolledBack = true;
  context.rollback = {
    toSha: previousSha,
    reason: cause && cause.message ? cause.message : "unknown",
    startedAt: new Date().toISOString(),
  };

  git(["reset", "--hard", previousSha]);
  addStep("rollback-git", "ok", `Rolled back to ${previousSha.slice(0, 12)}.`);

  try {
    runDependencySync();
    runSyntaxChecks();
    await restartServices({ ...options, deferRestart: false });
    await runHealthChecks({ ...options, skipHealth: options.skipHealth || context.restartDeferred });
    context.rollback.completedAt = new Date().toISOString();
    writeState({
      status: "rolled_back",
      rollbackToSha: previousSha,
      failedTargetSha: context.remoteSha,
      reason: context.rollback.reason,
      completedAt: context.rollback.completedAt,
    });
  } catch (rollbackError) {
    context.rollback.failedAt = new Date().toISOString();
    context.rollback.error = rollbackError.message;
    writeState({
      status: "rollback_failed",
      rollbackToSha: previousSha,
      failedTargetSha: context.remoteSha,
      reason: context.rollback.reason,
      rollbackError: rollbackError.message,
      failedAt: context.rollback.failedAt,
    });
    throw new UpdaterError(
      "ROLLBACK_FAILED",
      `Update failed and rollback also failed: ${rollbackError.message}`,
      1,
    );
  }
}

function git(args) {
  const result = runGit(args);
  return clean(result.stdout);
}

function runGit(args, options = {}) {
  return run("git", args, options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: APP_DIR,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });

  if (result.error) {
    if (options.allowFailure) {
      return normalizeResult(result);
    }
    throw new Error(`${command} failed: ${result.error.message}`);
  }

  if (result.status !== 0 && !options.allowFailure) {
    const output = clean(result.stderr || result.stdout || "");
    throw new Error(`${command} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }

  return normalizeResult(result);
}

function normalizeResult(result) {
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function isAncestor(leftSha, rightSha) {
  const result = runGit(["merge-base", "--is-ancestor", leftSha, rightSha], {
    allowFailure: true,
  });
  return result.status === 0;
}

function compareTagsDescending(left, right) {
  const a = parseTagVersion(left);
  const b = parseTagVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] || 0) - (a[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return right.localeCompare(left);
}

function parseTagVersion(tag) {
  const match = String(tag).match(/\d+/g);
  return match ? match.map((part) => Number(part)) : [0];
}

function getFreeBytes(targetPath) {
  if (typeof fs.statfsSync !== "function") {
    return null;
  }

  try {
    const stat = fs.statfsSync(targetPath);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (error) {
    return null;
  }
}

function writeState(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(value, null, 2)}\n`);
}

function addStep(name, status, message) {
  context.steps.push({
    name,
    status,
    message,
    at: new Date().toISOString(),
  });
}

async function interactiveConfirm(options) {
  if (options.assumeYes) {
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UpdaterError(
      "TTY_REQUIRED",
      "Interactive mode requires a TTY. Use --apply --yes for non-interactive.",
      1,
    );
  }

  process.stdout.write(
    `Yeni surum bulundu: ${context.latest.shortSha} - ${context.latest.subject}\nGuncelleme yuklensin mi? (y/n): `,
  );

  const answer = await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).trim());
    });
  });

  return /^(y|yes|e|evet)$/i.test(answer);
}

function finish(ok, code, message, exitCode) {
  context.ok = ok;
  context.code = code;
  context.message = message;

  const options = parseArgsSafe(process.argv.slice(2));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(context)}\n`);
  } else {
    const line = ok ? `[INFO] ${message}` : `[ERROR] ${message}`;
    const stream = ok ? process.stdout : process.stderr;
    stream.write(`${line}\n`);
    if (context.updateAvailable && context.latest.shortSha) {
      process.stdout.write(`- Mode   : ${context.releaseMode}\n`);
      process.stdout.write(`- Target : ${context.upstream}\n`);
      process.stdout.write(`- Commit : ${context.latest.shortSha}\n`);
      process.stdout.write(`- Subject: ${context.latest.subject}\n`);
      process.stdout.write(`- Author : ${context.latest.author}\n`);
      process.stdout.write(`- Date   : ${context.latest.date}\n`);
    }
  }

  process.exit(exitCode);
}

function parseArgsSafe(argv) {
  try {
    return parseArgs(argv);
  } catch (error) {
    return { json: argv.includes("--json") };
  }
}

function clean(value) {
  return String(value || "").trim();
}

function boolEnv(name, fallback) {
  const value = clean(process.env[name]).toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function intEnv(name, fallback) {
  const parsed = Number.parseInt(clean(process.env[name]), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  compareTagsDescending,
  parseTagVersion,
  assertSafeGitRef,
  assertSafeRemoteName,
};
