#!/usr/bin/env node
// Bounded-concurrency, memory-aware validation runner.
//
// Every validation check runs as `node scripts/validate.mjs <check>`. When
// several runners start at once (separate terminals, agents or CI jobs), each
// runner waits here, as one small Node process, for a shared slot instead of
// starting pnpm, tsc, esbuild, Vite, Chromium and an API server immediately.
// The commands themselves are unchanged: they are listed in CHECKS below.
//
//   node scripts/validate.mjs <check> [<check> ...]   run the named checks
//   node scripts/validate.mjs --all                    run every check in stages
//   node scripts/validate.mjs --stage integration      run one stage
//   node scripts/validate.mjs --list                   list checks and stages
// Options: --concurrency N, --fail-fast, --dry-run.
//
// Environment (all optional):
//   VALIDATE_CONCURRENCY        total checks running at once, across every runner (default 2)
//   VALIDATE_HEAVY_CONCURRENCY  typechecks/builds at once (default 1)
//   VALIDATE_API_CONCURRENCY    self-booting API suites at once (default 1; they also
//                               share tests/api-integration-lock.sh)
//   VALIDATE_BROWSER_CONCURRENCY browser suites at once (default 1)
//   VALIDATE_MEM_RESERVE_MB     memory to keep free on top of a check's estimate (default 768)
//   VALIDATE_MEM_WAIT_SECONDS   longest wait for memory before starting anyway (default 900)
//   VALIDATE_GUARD_PORT         port owned by the local API dev server (default 8080)
//   VALIDATE_ON_DUPLICATE       wait (default) | replace: what to do when the same check
//                               is already running in another live runner
//   VALIDATE_STATE_DIR          slot/claim directory (default $TMPDIR/complytrack-validate)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUSY_EXIT = 197; // flock -E: the slot was taken; retry later.

// class: heavy = typecheck/build/bundle, api = boots a private API (and builds it),
// browser = Vite + Chromium, light = node-only unit checks.
// memMb is a rough peak estimate used for memory-aware start decisions.
const CLASSES = {
  heavy: { memMb: 2000, capEnv: "VALIDATE_HEAVY_CONCURRENCY", cap: 1 },
  api: { memMb: 1000, capEnv: "VALIDATE_API_CONCURRENCY", cap: 1 },
  browser: { memMb: 1200, capEnv: "VALIDATE_BROWSER_CONCURRENCY", cap: 1 },
  light: { memMb: 400, capEnv: null, cap: Infinity },
};

// Stages run in order. `codegen` runs alone, after the static stage's typecheck
// has built lib/*/dist (the drift check typechecks the regenerated client against
// it) and before the integration suites, because it temporarily removes
// generated client files that builds and the fresh-schema bundle import.
const STAGES = ["static", "codegen", "integration"];

const api = (script) => `pnpm --filter @workspace/api-server run ${script}`;
const web = (script) => `pnpm --filter @workspace/compliance-tracker run ${script}`;

// Each check's shell command.
const DEFAULT_CHECKS = {
  "api-codegen-drift": { stage: "codegen", class: "heavy", generated: "exclusive", cmd: "pnpm run check:api-codegen" },

  typecheck: { stage: "static", class: "heavy", cmd: "pnpm run typecheck" },
  "api-typecheck": { stage: "static", class: "heavy", cmd: "pnpm --filter @workspace/api-server run typecheck" },
  "web-typecheck": { stage: "static", class: "heavy", cmd: "pnpm --filter @workspace/compliance-tracker run typecheck" },
  "build-api-server": { stage: "static", class: "heavy", cmd: "cd artifacts/api-server && source tests/api-integration-lock.sh && pnpm run build" },
  "build-web": { stage: "static", class: "heavy", cmd: "PORT=5000 BASE_PATH=/ pnpm --filter @workspace/compliance-tracker run build" },
  "mobile-production-bundle": { stage: "static", class: "heavy", memMb: 3000, cmd: "pnpm --filter @workspace/mobile run validate:production" },
  "mobile-kitchen-site-scope": { stage: "static", class: "light", cmd: "pnpm --filter @workspace/mobile run test:kitchen-site-scope" },
  "track-record-lock": { stage: "static", class: "light", cmd: api("test:track-record-lock") },
  "induction-print": { stage: "static", class: "light", cmd: web("test:induction-print") },
  "private-file-acl": { stage: "static", class: "light", cmd: api("test:private-file-acl") },
  "service-price-readiness": { stage: "static", class: "light", cmd: api("check:service-prices") },
  "billing-addon-catalog": { stage: "static", class: "light", cmd: api("test:billing-addon-catalog") },
  "staged-photo-creation": { stage: "static", class: "light", cmd: api("test:staged-photo-creation") },
  "fix-track-priority": { stage: "static", class: "light", cmd: web("test:fix-track-priority") },

  "test-trial-reminders": { stage: "integration", class: "api", cmd: api("test:trial-reminders") },
  "test-tenant-isolation": { stage: "integration", class: "api", cmd: api("test:isolation:ci") },
  "module-routes": { stage: "integration", class: "api", cmd: api("test:modules:ci") },
  "test-config": { stage: "integration", class: "api", cmd: "cd artifacts/api-server && pnpm run test:config:ci" },
  "fresh-schema-regression": { stage: "integration", class: "api", cmd: api("test:schema:fresh") },
  "test-twofa-recovery": { stage: "integration", class: "api", cmd: api("test:twofa-recovery") },
  "pat-evidence-retention": { stage: "integration", class: "api", cmd: api("test:pat-dept-isolation") },
  "content-filter-endpoints": { stage: "integration", class: "api", cmd: api("test:content-filter") },
  "feedback-triage": { stage: "integration", class: "api", cmd: api("test:feedback-triage") },
  "quote-reminder-approval": { stage: "integration", class: "api", cmd: api("test:fix-track-contractor-approval") },
  "contractor-token-security": { stage: "integration", class: "api", cmd: api("test:contractor-token-security") },
  "contractor-key-rotation": { stage: "integration", class: "api", cmd: api("test:contractor-key-rotation") },
  "kitchen-mobile-replay": { stage: "integration", class: "api", cmd: api("test:kitchen-mobile-replay") },
  "kitchen-temperature-actions": { stage: "integration", class: "api", cmd: api("test:kitchen-temperature-actions") },
  "kitchen-inspection-register-export": { stage: "integration", class: "api", cmd: api("test:kitchen-inspection-export") },

  "hot-tub-pdf-export": { stage: "integration", class: "browser", cmd: web("test:hot-tub-pdf") },
  "recovery-code-browser": { stage: "integration", class: "browser", cmd: web("test:recovery-code-browser") },
  "photo-upload-browser": { stage: "integration", class: "browser", cmd: web("test:photo-upload-browser") },
  "billing-addon-settings-browser": { stage: "integration", class: "browser", cmd: web("test:billing-addon-settings-browser") },
  "required-track-photos-browser": { stage: "integration", class: "browser", cmd: web("test:required-track-photos-browser") },
  "feedback-inbox-browser": { stage: "integration", class: "browser", cmd: web("test:feedback-inbox-browser") },
};

// Test hook: the runner's own tests substitute a registry of harmless commands.
export function loadChecks(env = process.env) {
  if (env.VALIDATE_REGISTRY_FILE) {
    return JSON.parse(fs.readFileSync(env.VALIDATE_REGISTRY_FILE, "utf8"));
  }
  return DEFAULT_CHECKS;
}

const intEnv = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- memory

function readNumber(file) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (text === "max") return Infinity;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function statField(file, key) {
  try {
    const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${key} `));
    return line ? Number(line.split(" ")[1]) : 0;
  } catch {
    return 0;
  }
}

/** Memory a new process can use, in MB: the lower of host MemAvailable and the cgroup headroom. */
export function availableMemoryMb() {
  let available = os.freemem() / 1048576;
  try {
    const line = fs.readFileSync("/proc/meminfo", "utf8").split("\n").find((l) => l.startsWith("MemAvailable:"));
    if (line) available = Number(line.split(/\s+/)[1]) / 1024;
  } catch { /* not Linux */ }
  const v2Max = readNumber("/sys/fs/cgroup/memory.max");
  if (v2Max !== null && v2Max !== Infinity) {
    const used = (readNumber("/sys/fs/cgroup/memory.current") ?? 0) - statField("/sys/fs/cgroup/memory.stat", "inactive_file");
    available = Math.min(available, (v2Max - used) / 1048576);
  } else {
    const v1Max = readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    if (v1Max !== null && v1Max < 2 ** 60) {
      const used = (readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes") ?? 0) - statField("/sys/fs/cgroup/memory/memory.stat", "total_inactive_file");
      available = Math.min(available, (v1Max - used) / 1048576);
    }
  }
  return Math.max(0, Math.round(available));
}

// ---------------------------------------------------------------- processes

function procStat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), start: rest[19] };
  } catch {
    return null;
  }
}

const isAlive = (pid, start) => {
  const stat = procStat(pid);
  return Boolean(stat && stat.state !== "Z" && (start === undefined || stat.start === start));
};

function allPids() {
  try {
    return fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
  } catch {
    return [];
  }
}

export function groupMembers(pgid) {
  return allPids().filter((pid) => {
    const stat = procStat(pid);
    return stat && stat.pgrp === pgid && stat.state !== "Z";
  });
}

async function killGroup(pgid, graceMs = 10000) {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (groupMembers(pgid).length === 0) return;
    await sleep(250);
  }
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- port guard

function listeningInodes(port) {
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") continue; // 0A = LISTEN
      if (parseInt(cols[1].split(":").pop(), 16) === port) inodes.add(cols[9]);
    }
  }
  return inodes;
}

function pidsOwningInodes(pids, inodes) {
  const owners = [];
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target = "";
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) { owners.push(pid); break; }
    }
  }
  return owners;
}

/** PIDs (readable by this user) listening on `port`; `listening` is true even when the owner is unreadable. */
export function portOwners(port) {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return { listening: false, pids: [] };
  return { listening: true, pids: pidsOwningInodes(allPids(), inodes) };
}

// ---------------------------------------------------------------- claims

function stateDir(env) {
  const dir = env.VALIDATE_STATE_DIR || path.join(env.TMPDIR || os.tmpdir(), "complytrack-validate");
  fs.mkdirSync(path.join(dir, "claims"), { recursive: true });
  return dir;
}

const claimPath = (dir, name) => path.join(dir, "claims", `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

function readClaim(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * One live run per check. A claim left by a runner that has died (killed by a
 * workflow restart, OOM, SIGKILL) is reaped: any processes still in its group,
 * such as a private test API or a Vite child, are terminated first so a restart
 * never stacks a second copy of the same check on top of the old one.
 */
async function claimCheck(dir, name, log, env) {
  const file = claimPath(dir, name);
  const self = { runnerPid: process.pid, runnerStart: procStat(process.pid)?.start, pgid: null };
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify(self), { flag: "wx" });
      return {
        setGroup(pgid) { self.pgid = pgid; fs.writeFileSync(file, JSON.stringify(self)); },
        release() { const current = readClaim(file); if (current?.runnerPid === process.pid) fs.rmSync(file, { force: true }); },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const other = readClaim(file);
    if (!other) { await sleep(200); continue; } // being written right now
    if (other.runnerPid !== process.pid && isAlive(other.runnerPid, other.runnerStart)) {
      if ((env.VALIDATE_ON_DUPLICATE || "wait") === "replace") {
        log(`another runner (pid ${other.runnerPid}) is running ${name}; replacing it`);
        try { process.kill(other.runnerPid, "SIGTERM"); } catch { /* gone */ }
        await sleep(1000);
        continue;
      }
      if (!announced) log(`waiting for the ${name} run already in progress (runner pid ${other.runnerPid})`);
      announced = true;
      await sleep(2000);
      continue;
    }
    if (other.pgid && groupMembers(other.pgid).length > 0) {
      log(`stopping processes left by an interrupted ${name} run (process group ${other.pgid})`);
      await killGroup(other.pgid);
    }
    fs.rmSync(file, { force: true });
  }
}

/** Reap every orphaned check group recorded by dead runners (used by --all and focused runs). */
async function reapStaleClaims(dir, log) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, "claims")); } catch { return; }
  for (const entry of names) {
    const file = path.join(dir, "claims", entry);
    const claim = readClaim(file);
    if (!claim || isAlive(claim.runnerPid, claim.runnerStart)) continue;
    if (claim.pgid && groupMembers(claim.pgid).length > 0) {
      log(`stopping processes left by an interrupted validation run (${entry}, process group ${claim.pgid})`);
      await killGroup(claim.pgid);
    }
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------- slots

// A slot is { file, shared }. Locks are taken by flock(1), so the kernel releases
// them when the holder dies; there are no stale lock files to clean up.
function slotHeld(slot) {
  const { file, shared } = typeof slot === "string" ? { file: slot, shared: false } : slot;
  const result = spawnSync("flock", ["-n", ...(shared ? ["-s"] : []), "-E", String(BUSY_EXIT), file, "true"]);
  return result.status === BUSY_EXIT;
}

// The API codegen drift check temporarily deletes the generated client. It takes
// the generated-files lock exclusively; every other check holds it shared, so
// separate runners (e.g. one per check) never overlap the gap.
// While the drift check waits, it leaves a marker so new checks queue behind it.
const pendingFile = (dir) => path.join(dir, "generated-pending.json");

function exclusivePending(dir) {
  const marker = readClaim(pendingFile(dir));
  if (!marker) return false;
  if (marker.runnerPid !== process.pid && isAlive(marker.runnerPid, marker.runnerStart)) return true;
  if (marker.runnerPid !== process.pid) fs.rmSync(pendingFile(dir), { force: true });
  return false;
}

// ---------------------------------------------------------------- running

function childEnvironment(env, guardPort) {
  const childEnv = { ...env };
  // Self-booting suites pick private ephemeral ports. Never let an inherited
  // PORT/TEST_PORT/API_BASE send them to (or start them on) the preview API.
  for (const key of ["PORT", "TEST_PORT", "API_BASE"]) delete childEnv[key];
  delete childEnv.VALIDATE_REGISTRY_FILE;
  childEnv.VALIDATE_GUARD_PORT = String(guardPort);
  return childEnv;
}

function prefixStream(stream, out, prefix) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) out.write(`${prefix}${line}\n`);
  });
  stream.on("end", () => { if (buffered) out.write(`${prefix}${buffered}\n`); });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const checks = loadChecks(env);
  const opts = { all: false, stages: [], names: [], failFast: false, dryRun: false, list: false };
  let concurrency = intEnv(env, "VALIDATE_CONCURRENCY", os.totalmem() < 4 * 1024 ** 3 ? 1 : 2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--stage") opts.stages.push(argv[++i]);
    else if (arg === "--concurrency" || arg === "-j") concurrency = intEnv({ v: argv[++i] }, "v", concurrency);
    else if (arg.startsWith("--concurrency=")) concurrency = intEnv({ v: arg.split("=")[1] }, "v", concurrency);
    else if (arg === "--fail-fast") opts.failFast = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--help" || arg === "-h") { process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n"); return 0; }
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else opts.names.push(arg);
  }

  if (opts.list) {
    for (const stage of STAGES) {
      console.log(`${stage}:`);
      for (const [name, check] of Object.entries(checks)) if (check.stage === stage) console.log(`  ${name.padEnd(36)} ${check.class.padEnd(8)} ${check.cmd}`);
    }
    return 0;
  }

  for (const stage of opts.stages) if (!STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}" (stages: ${STAGES.join(", ")})`);
  for (const name of opts.names) if (!checks[name]) throw new Error(`Unknown check "${name}". Run with --list to see them.`);
  let selected;
  if (opts.all) selected = Object.keys(checks);
  else if (opts.stages.length) selected = Object.keys(checks).filter((n) => opts.stages.includes(checks[n].stage));
  else selected = [...new Set(opts.names)];
  if (selected.length === 0) throw new Error("Name at least one check, or pass --all / --stage. Run with --list to see them.");
  selected.sort((a, b) => STAGES.indexOf(checks[a].stage) - STAGES.indexOf(checks[b].stage));

  const guardPort = intEnv(env, "VALIDATE_GUARD_PORT", 8080);
  const reserveMb = Number(env.VALIDATE_MEM_RESERVE_MB ?? 768);
  const memWaitMs = Number(env.VALIDATE_MEM_WAIT_SECONDS ?? 900) * 1000;
  const launchGapMs = Number(env.VALIDATE_LAUNCH_GAP_MS ?? 1500);
  const classCaps = Object.fromEntries(Object.entries(CLASSES).map(([k, c]) => [k, c.capEnv ? Math.min(concurrency, intEnv(env, c.capEnv, c.cap)) : concurrency]));
  const single = selected.length === 1;
  const log = (msg) => process.stderr.write(`[validate] ${msg}\n`);

  if (opts.dryRun) {
    for (const name of selected) console.log(`${checks[name].stage}\t${checks[name].class}\t${name}\t${checks[name].cmd}`);
    return 0;
  }

  const dir = stateDir(env);
  await reapStaleClaims(dir, log);
  const preview = portOwners(guardPort);
  log(`${selected.length} check(s); concurrency ${concurrency} (heavy ${classCaps.heavy}, api ${classCaps.api}, browser ${classCaps.browser}); ${availableMemoryMb()} MB available; port ${guardPort} ${preview.listening ? `owned by ${preview.pids.length ? `pid ${preview.pids.join(",")}` : "another user's process"} (left untouched)` : "free"}`);

  const childEnv = childEnvironment(env, guardPort);
  const running = new Map(); // name -> { child, pgid, cls, started }
  const results = new Map();
  let minMemory = availableMemoryMb();
  let stopping = false;
  let stopSignal = null;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    stopSignal = signal;
    log(`received ${signal}; stopping ${running.size} running check(s)`);
    await Promise.all([...running.values()].map((r) => killGroup(r.pgid, 5000)));
  };
  const onSignal = (signal) => { shutdown(signal).then(() => process.exit(signal === "SIGINT" ? 130 : 143)); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);

  // Port guard: no validation process may listen on the preview API port.
  const guard = setInterval(() => {
    const inodes = listeningInodes(guardPort);
    minMemory = Math.min(minMemory, availableMemoryMb());
    if (inodes.size === 0) return;
    for (const [name, run] of running) {
      if (run.guardTripped) continue;
      if (pidsOwningInodes(groupMembers(run.pgid), inodes).length > 0) {
        run.guardTripped = true;
        log(`${name} started a listener on port ${guardPort}, which belongs to the API preview; stopping it`);
        killGroup(run.pgid, 3000);
      }
    }
  }, 2000);
  guard.unref();

  const startCheck = (name, slotFiles, claim) => new Promise((resolve) => {
    const check = checks[name];
    // flock -o: the lock is held by flock itself, not inherited by stray daemons.
    const flockArgs = slotFiles.flatMap(({ file, shared }) => ["flock", "-n", ...(shared ? ["-s"] : []), "-o", "-E", String(BUSY_EXIT), file]);
    // The watcher kills this check's whole process group if the runner dies
    // without cleaning up (e.g. SIGKILL from a workflow restart).
    const script = `( while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -TERM 0 ) >/dev/null 2>&1 & exec bash -c "$1"`;
    const child = spawn(flockArgs[0], [...flockArgs.slice(1), "bash", "-c", script, "validate-check", check.cmd], {
      cwd: ROOT,
      env: { ...childEnv, VALIDATE_CHECK_NAME: name },
      detached: true,
      stdio: single ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    const started = Date.now();
    const run = { child, pgid: child.pid, cls: check.class, started, guardTripped: false };
    claim.setGroup(child.pid);
    running.set(name, run);
    if (!single) {
      prefixStream(child.stdout, process.stdout, `[${name}] `);
      prefixStream(child.stderr, process.stderr, `[${name}] `);
    }
    child.on("error", (error) => { log(`${name}: ${error.message}`); });
    // "exit", not "close": a stray background server could hold the pipes open.
    child.on("exit", async (code, signal) => {
      running.delete(name);
      // Clean up anything the check left behind (servers started with `&`, the watcher).
      if (groupMembers(child.pid).length > 0) await killGroup(child.pid, 3000);
      resolve({ code: code ?? (signal ? 128 : 1), signal, ms: Date.now() - started, guardTripped: run.guardTripped });
    });
  });

  const slotsFor = (cls, exclusiveGenerated) => {
    const slot = (file) => ({ file: path.join(dir, file), shared: false });
    const general = Array.from({ length: concurrency }, (_, i) => slot(`slot-${i}.lock`));
    const classSlots = Number.isFinite(classCaps[cls]) ? Array.from({ length: classCaps[cls] }, (_, i) => slot(`${cls}-${i}.lock`)) : [null];
    const generated = { file: path.join(dir, "generated.lock"), shared: !exclusiveGenerated };
    const combos = [];
    for (const g of general) for (const c of classSlots) combos.push(c ? [g, c, generated] : [g, generated]);
    return { general, generated, combos };
  };

  /** Try to start one check now; returns a promise for its result, or null if it must wait. */
  const tryStart = async (name, memState) => {
    const check = checks[name];
    const cls = CLASSES[check.class] ? check.class : "light";
    const localOfClass = [...running.values()].filter((r) => r.cls === cls).length;
    if (running.size >= concurrency || localOfClass >= classCaps[cls]) return null;
    const exclusiveGenerated = check.generated === "exclusive";
    if (!exclusiveGenerated && exclusivePending(dir)) {
      if (!memState.codegenAnnounced) log(`${name} is waiting for the API codegen drift check to finish`);
      memState.codegenAnnounced = true;
      return null;
    }
    const { general, generated, combos } = slotsFor(cls, exclusiveGenerated);
    const need = (check.memMb ?? CLASSES[cls].memMb) + reserveMb;
    const available = availableMemoryMb();
    minMemory = Math.min(minMemory, available);
    const othersRunning = running.size > 0 || general.some(slotHeld);
    if (available < need && othersRunning) {
      memState.since ??= Date.now();
      if (Date.now() - memState.since < memWaitMs) {
        if (!memState.announced) log(`${name} needs ~${need} MB; ${available} MB available — waiting for running checks to finish`);
        memState.announced = true;
        return null;
      }
      log(`${name}: still only ${available} MB available after ${Math.round(memWaitMs / 1000)}s; starting anyway`);
    }
    if (exclusiveGenerated && slotHeld(generated)) {
      fs.writeFileSync(pendingFile(dir), JSON.stringify({ runnerPid: process.pid, runnerStart: procStat(process.pid)?.start }));
      if (!memState.slotAnnounced) log(`${name} is waiting for running checks to release the generated API client`);
      memState.slotAnnounced = true;
      return null;
    }
    for (const slotFiles of combos) {
      if (slotFiles.some(slotHeld)) continue;
      const claim = memState.claim ?? (memState.claim = await claimCheck(dir, name, log, env));
      const result = await startCheck(name, slotFiles, claim);
      if (result.code === BUSY_EXIT && result.ms < 2000) continue; // lost the race for this slot
      claim.release();
      if (exclusiveGenerated) fs.rmSync(pendingFile(dir), { force: true });
      return result;
    }
    if (!memState.slotAnnounced) log(`${name} is waiting for a free validation slot`);
    memState.slotAnnounced = true;
    return null;
  };

  const runOne = async (name) => {
    const memState = {};
    for (;;) {
      if (stopping) return { code: 143, ms: 0, skipped: true };
      const result = await tryStart(name, memState);
      if (result) return result;
      await sleep(1000 + Math.floor(Math.random() * 1000));
    }
  };

  let failed = false;
  for (const stage of STAGES) {
    const queue = selected.filter((n) => checks[n].stage === stage);
    if (queue.length === 0) continue;
    if (!single) log(`stage ${stage}: ${queue.join(", ")}`);
    const inFlight = new Set();
    while ((queue.length || inFlight.size) && !stopping) {
      let launched = false;
      for (const name of [...queue]) {
        if (failed && opts.failFast) break;
        const cls = checks[name].class;
        const localOfClass = [...inFlight].filter((n) => checks[n].class === cls).length;
        if (inFlight.size >= concurrency || localOfClass >= (classCaps[cls] ?? concurrency)) continue;
        queue.splice(queue.indexOf(name), 1);
        inFlight.add(name);
        launched = true;
        if (!single) log(`starting ${name}`);
        runOne(name).catch((error) => {
          log(`${name}: ${error.message}`);
          return { code: 1, ms: 0 };
        }).then((result) => {
          inFlight.delete(name);
          results.set(name, result);
          const ok = result.code === 0 && !result.guardTripped;
          if (!ok) failed = true;
          if (!single) log(`${ok ? "passed" : "FAILED"} ${name} (${Math.round(result.ms / 1000)}s${ok ? "" : `, exit ${result.code}`})`);
        });
        // Leave a moment between launches so the memory reading reflects the newcomer.
        await sleep(launchGapMs);
      }
      if (failed && opts.failFast && inFlight.size === 0) break;
      if (!launched) await sleep(500);
    }
    if (failed && opts.failFast) break;
  }
  clearInterval(guard);
  if (stopping) return stopSignal === "SIGINT" ? 130 : 143;

  const after = portOwners(guardPort);
  const previewNote = preview.listening
    ? after.listening ? `port ${guardPort} preview still listening${after.pids.length ? ` (pid ${after.pids.join(",")})` : ""}` : `WARNING: port ${guardPort} preview stopped listening during validation`
    : `port ${guardPort} ${after.listening ? "now in use by another process" : "free"}`;

  if (single) {
    const [name] = selected;
    const result = results.get(name) ?? { code: 1 };
    log(`${name} ${result.code === 0 && !result.guardTripped ? "passed" : "FAILED"}; lowest available memory ${minMemory} MB; ${previewNote}`);
    return result.guardTripped ? 1 : result.code;
  }
  console.log("\nValidation summary");
  for (const name of selected) {
    const r = results.get(name);
    const status = !r ? "not run" : r.code === 0 && !r.guardTripped ? "pass" : r.guardTripped ? "FAIL (port guard)" : `FAIL (exit ${r.code})`;
    console.log(`  ${status.padEnd(18)} ${name.padEnd(36)} ${r ? `${Math.round(r.ms / 1000)}s` : ""}`);
  }
  console.log(`Lowest available memory during the run: ${minMemory} MB; ${previewNote}`);
  const notRun = selected.filter((n) => !results.has(n));
  return failed || notRun.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`[validate] ${error.message}`);
    process.exit(2);
  });
}
