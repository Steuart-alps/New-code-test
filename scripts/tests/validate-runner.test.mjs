// Tests for scripts/validate.mjs using a registry of harmless shell commands.
// Run: node scripts/tests/validate-runner.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../validate.mjs");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "validate-runner-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let caseNo = 0;

function setup(checks) {
  const dir = path.join(work, `case-${++caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const registry = path.join(dir, "registry.json");
  fs.writeFileSync(registry, JSON.stringify(checks));
  return {
    dir,
    log: path.join(dir, "events.log"),
    env: {
      ...process.env,
      VALIDATE_REGISTRY_FILE: registry,
      VALIDATE_STATE_DIR: path.join(dir, "state"),
      VALIDATE_MEM_RESERVE_MB: "0",
      VALIDATE_GUARD_PORT: "1", // nothing listens on port 1 unless told otherwise
      VALIDATE_LAUNCH_GAP_MS: "100",
    },
  };
}

function run(args, env) {
  const child = spawn(process.execPath, [runner, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
  return { child, done };
}

// Each fake check appends "start <name> <ms>" / "end <name> <ms>" to the log.
const timed = (log, name, seconds) => `echo "start ${name} $(date +%s%3N)" >> ${log}; sleep ${seconds}; echo "end ${name} $(date +%s%3N)" >> ${log}`;

function maxOverlap(log) {
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => {
    const [kind, , at] = l.split(" ");
    return { kind, at: Number(at) };
  }).sort((a, b) => a.at - b.at || (a.kind === "end" ? -1 : 1));
  let current = 0;
  let max = 0;
  for (const e of events) { current += e.kind === "start" ? 1 : -1; max = Math.max(max, current); }
  return max;
}

// A killed process can linger briefly as a zombie until its new parent reaps it.
const alive = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
};
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const cases = {
  async "caps total concurrency and runs every check"() {
    const t = setup({});
    const checks = Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [n, { stage: "static", class: "light", cmd: timed(t.log, n, 1.5) }]));
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify(checks));
    const { code, output } = await run(["--all", "--concurrency", "2"], t.env).done;
    assert.equal(code, 0, output);
    assert.equal(fs.readFileSync(t.log, "utf8").trim().split("\n").length, 10);
    assert.ok(maxOverlap(t.log) <= 2, `overlap ${maxOverlap(t.log)}`);
    assert.ok(maxOverlap(t.log) === 2, "light checks should share the two slots");
  },

  async "runs heavy checks one at a time and stages in order"() {
    const t = setup({});
    const checks = {
      gen: { stage: "codegen", class: "light", cmd: timed(t.log, "gen", 1) },
      h1: { stage: "static", class: "heavy", cmd: timed(t.log, "h1", 1) },
      h2: { stage: "static", class: "heavy", cmd: timed(t.log, "h2", 1) },
      it: { stage: "integration", class: "api", cmd: timed(t.log, "it", 0.2) },
    };
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify(checks));
    const { code, output } = await run(["--all", "--concurrency", "3"], t.env).done;
    assert.equal(code, 0, output);
    assert.equal(maxOverlap(t.log), 1);
    const order = fs.readFileSync(t.log, "utf8").trim().split("\n").filter((l) => l.startsWith("start")).map((l) => l.split(" ")[1]);
    assert.deepEqual(order.slice(2), ["gen", "it"], "static, then codegen, then integration");
  },

  async "shares the cap across separate runner processes"() {
    const t = setup({});
    const checks = Object.fromEntries(["p1", "p2", "q1", "q2"].map((n) => [n, { stage: "static", class: "light", cmd: timed(t.log, n, 1) }]));
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify(checks));
    const env = { ...t.env, VALIDATE_CONCURRENCY: "1" };
    const results = await Promise.all([run(["p1", "p2"], env).done, run(["q1", "q2"], env).done]);
    for (const r of results) assert.equal(r.code, 0, r.output);
    assert.equal(maxOverlap(t.log), 1);
  },

  async "keeps the codegen drift check apart from every other check across runners"() {
    const t = setup({});
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify({
      s1: { stage: "static", class: "light", cmd: timed(t.log, "s1", 2) },
      gen: { stage: "codegen", class: "light", generated: "exclusive", cmd: timed(t.log, "gen", 1) },
      s2: { stage: "static", class: "light", cmd: timed(t.log, "s2", 1) },
    }));
    const env = { ...t.env, VALIDATE_CONCURRENCY: "3" };
    const first = run(["s1"], env).done;
    await sleep(700);
    const second = run(["gen"], env).done;
    await sleep(1200);
    const third = run(["s2"], env).done;
    for (const r of await Promise.all([first, second, third])) assert.equal(r.code, 0, r.output);
    const starts = fs.readFileSync(t.log, "utf8").trim().split("\n").filter((l) => l.startsWith("start")).map((l) => l.split(" ")[1]);
    assert.deepEqual(starts, ["s1", "gen", "s2"]);
    assert.equal(maxOverlap(t.log), 1);
  },

  async "never runs two copies of the same check at once"() {
    const t = setup({});
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify({ dup: { stage: "static", class: "light", cmd: timed(t.log, "dup", 1.5) } }));
    const env = { ...t.env, VALIDATE_CONCURRENCY: "2" };
    const results = await Promise.all([run(["dup"], env).done, run(["dup"], env).done]);
    for (const r of results) assert.equal(r.code, 0, r.output);
    assert.equal(maxOverlap(t.log), 1);
  },

  async "propagates a single check's exit code"() {
    const t = setup({ bad: { stage: "static", class: "light", cmd: "exit 3" } });
    const { code } = await run(["bad"], t.env).done;
    assert.equal(code, 3);
  },

  async "does not pass PORT, TEST_PORT or API_BASE to checks"() {
    const t = setup({ env: { stage: "static", class: "light", cmd: 'test -z "$PORT$TEST_PORT$API_BASE"' } });
    const { code, output } = await run(["env"], { ...t.env, PORT: "8080", TEST_PORT: "8080", API_BASE: "http://localhost:8080/api" }).done;
    assert.equal(code, 0, output);
  },

  async "stops a check that listens on the guarded preview port"() {
    const port = await freePort();
    const t = setup({ squat: { stage: "static", class: "light", cmd: `node -e 'require("net").createServer().listen(${port}, "127.0.0.1"); setTimeout(() => {}, 60000)'` } });
    const started = Date.now();
    const { code, output } = await run(["squat"], { ...t.env, VALIDATE_GUARD_PORT: String(port) }).done;
    assert.notEqual(code, 0);
    assert.match(output, new RegExp(`listener on port ${port}`));
    assert.ok(Date.now() - started < 20000, "guard should stop the check promptly");
  },

  async "leaves an existing preview listener alone"() {
    const port = await freePort();
    const preview = net.createServer().listen(port, "127.0.0.1");
    await new Promise((r) => preview.once("listening", r));
    try {
      const t = setup({ ok: { stage: "static", class: "light", cmd: "sleep 3" } });
      const { code, output } = await run(["ok"], { ...t.env, VALIDATE_GUARD_PORT: String(port) }).done;
      assert.equal(code, 0, output);
      assert.match(output, /preview still listening/);
    } finally {
      preview.close();
    }
  },

  async "reaps processes left by an interrupted run before restarting the check"() {
    const t = setup({ again: { stage: "static", class: "light", cmd: "true" } });
    const orphan = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const dead = spawn("true");
    await new Promise((r) => dead.on("exit", r));
    fs.mkdirSync(path.join(t.env.VALIDATE_STATE_DIR, "claims"), { recursive: true });
    fs.writeFileSync(path.join(t.env.VALIDATE_STATE_DIR, "claims", "again.json"), JSON.stringify({ runnerPid: dead.pid, runnerStart: "0", pgid: orphan.pid }));
    const { code, output } = await run(["again"], t.env).done;
    assert.equal(code, 0, output);
    assert.match(output, /interrupted/);
    assert.equal(alive(orphan.pid), false, "the orphaned process group should be stopped");
  },

  async "kills a check's processes when the runner itself is killed"() {
    const t = setup({});
    const pidFile = path.join(t.dir, "server.pid");
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify({ srv: { stage: "static", class: "light", cmd: `sleep 60 & echo $! > ${pidFile}; wait` } }));
    const { child, done } = run(["srv"], t.env);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100);
    const serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    child.kill("SIGKILL");
    await done;
    for (let i = 0; i < 50 && alive(serverPid); i++) await sleep(200);
    assert.equal(alive(serverPid), false, "the watcher should stop the check after the runner dies");
  },

  async "stops running checks on SIGTERM"() {
    const t = setup({});
    const pidFile = path.join(t.dir, "server.pid");
    fs.writeFileSync(t.env.VALIDATE_REGISTRY_FILE, JSON.stringify({ srv: { stage: "static", class: "light", cmd: `sleep 60 & echo $! > ${pidFile}; wait` } }));
    const { child, done } = run(["srv"], t.env);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100);
    const serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    const { code } = await done;
    assert.equal(code, 143);
    assert.equal(alive(serverPid), false);
  },

  async "checks that .replit routes every validation through the runner"() {
    const t = setup({ one: { stage: "static", class: "light", cmd: "true" }, two: { stage: "static", class: "light", cmd: "true" } });
    const replit = path.join(t.dir, ".replit");
    const workflow = (name, args) => `[[workflows.workflow]]\nname = "${name}"\nauthor = "agent"\n\n[[workflows.workflow.tasks]]\ntask = "shell.exec"\nargs = "${args}"\n\n[workflows.workflow.metadata]\nisValidation = true\n\n`;
    fs.writeFileSync(replit, workflow("one", "node scripts/validate.mjs one") + workflow("two", "node scripts/validate.mjs two"));
    assert.equal((await run(["--check-config"], { ...t.env, VALIDATE_REPLIT_PATH: replit }).done).code, 0);
    fs.writeFileSync(replit, workflow("one", "node scripts/validate.mjs one") + workflow("two", "pnpm run two"));
    const bad = await run(["--check-config"], { ...t.env, VALIDATE_REPLIT_PATH: replit }).done;
    assert.equal(bad.code, 1);
    assert.match(bad.output, /"two" should run/);
  },
};

let failures = 0;
for (const [name, fn] of Object.entries(cases)) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok - ${name}\n${error.stack}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
if (failures) process.exit(1);
console.log("validate runner tests passed");
