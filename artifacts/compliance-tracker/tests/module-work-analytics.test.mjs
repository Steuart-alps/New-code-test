import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Checks the activation -> first completed work measure: allowlisted
// service/activity classification, privacy of the payload, once-per-cycle
// deduplication, and that both API layers only report successful saves.
// Everything runs against stubbed fetch/tracker/storage; no server or data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "../..");
const temp = await mkdtemp(path.join(os.tmpdir(), "module-work-analytics-"));
const originals = { window: globalThis.window, fetch: globalThis.fetch };

async function bundle(entry, name) {
  const outfile = path.join(temp, `${name}.mjs`);
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile,
    logLevel: "silent", define: { "import.meta.env.BASE_URL": JSON.stringify("/") },
  });
  return import(pathToFileURL(outfile).href);
}

function makeWindow(events, track) {
  const store = new Map();
  return {
    umami: { track: track ?? ((...args) => { events.push(args); }) },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); },
    },
  };
}

try {
  const analytics = await bundle(path.join(root, "src/lib/analytics.ts"), "analytics");
  const {
    classifyCompletedWork, trackModuleWorkCompleted, trackModuleActivation, clearModuleActivation,
    trackModuleFirstUse, createCompletedWorkObserver,
  } = analytics;

  // --- Allowlist classification -------------------------------------------
  const cases = [
    ["POST", "/fire-safety", ["firetrack"], "check_completed"],
    ["POST", "/api/legionella", ["legionellatrack"], "check_completed"],
    ["POST", "https://example.test/app/api/room-track/checks?x=1", ["roomtrack"], "check_completed"],
    ["post", "/pat-track/tests/", ["pattrack"], "check_completed"],
    ["POST", "/pool-track", ["pooltrack", "aquatrack"], "check_completed"],
    ["POST", "/swim-track/first-aid", ["swimtrack", "aquatrack"], "record_saved"],
    ["POST", "/doc-track/documents/12/acknowledge", ["doctrack"], "acknowledgement_recorded"],
    ["POST", "/safe-track/sops/3/self-acknowledge", ["safetrack"], "acknowledgement_recorded"],
    ["POST", "/bike-track/hires/9/return", ["biketrack"], "record_saved"],
    ["POST", "/kitchen-weekly/probe", ["kitchentrack"], "check_completed"],
    ["POST", "/food-safety/append", ["kitchentrack"], "record_saved"],
    ["POST", "/daily-track-pm/signoffs", ["dailytrack_pm"], "check_completed"],
    ["POST", "/incidents", ["incidenttrack"], "record_saved"],
  ];
  for (const [method, url, modules, activity] of cases) {
    assert.deepEqual(classifyCompletedWork(method, url), { modules, activity }, `${method} ${url}`);
  }
  for (const [method, url] of [
    ["GET", "/fire-safety"], ["DELETE", "/fire-safety/1"], ["PUT", "/fire-safety/1"],
    ["PUT", "/fire-safety/config"], ["PATCH", "/train-track/records/4"],
    ["POST", "/hot-tub/tubs"], ["POST", "/bike-track/bikes"], ["POST", "/green-track/machines"],
    ["POST", "/legionella/outlets"], ["POST", "/room-track/rooms"], ["POST", "/pat-track/appliances"],
    ["POST", "/safe-track/request-upload"], ["POST", "/fix-track/issues/5/notes"],
    ["POST", "/billing/services"], ["POST", "/sites"], ["POST", "/fire-safety-extra"],
    ["POST", "/api/fire-safety/1"], ["POST", "not a url"],
  ]) assert.equal(classifyCompletedWork(method, url), null, `${method} ${url} must not count as completed work`);

  // --- Journey, privacy and deduplication ---------------------------------
  const events = [];
  globalThis.window = makeWindow(events);
  const named = name => events.filter(([event]) => event === name);

  trackModuleWorkCompleted(7, "firetrack", "check_completed");
  assert.deepEqual(events, [], "no completed-work event without a tracked activation");

  trackModuleActivation(7, "firetrack");
  trackModuleFirstUse(7, "firetrack");
  assert.deepEqual(named("module_first_work_completed"), [], "a route visit is not completed work");

  trackModuleWorkCompleted(7, "firetrack", "check_completed");
  trackModuleWorkCompleted(7, "firetrack", "record_saved");
  trackModuleWorkCompleted(8, "firetrack", "check_completed");
  assert.deepEqual(named("module_first_work_completed"), [
    ["module_first_work_completed", { module: "firetrack", activity: "check_completed" }],
  ], "once per client/module cycle, carrying only module and activity");
  assert.deepEqual(events.map(([name]) => name), [
    "module_activation_succeeded", "module_first_used", "module_first_work_completed",
  ], "existing activation and first-use events are unchanged");

  // Reactivation and removal start new cycles.
  events.length = 0;
  trackModuleActivation(7, "firetrack");
  trackModuleWorkCompleted(7, "firetrack", "check_completed");
  assert.equal(named("module_first_work_completed").length, 0, "same cycle stays deduplicated");
  clearModuleActivation(7, "firetrack");
  trackModuleWorkCompleted(7, "firetrack", "check_completed");
  assert.equal(named("module_first_work_completed").length, 0, "no event after removal");
  trackModuleActivation(7, "firetrack");
  trackModuleWorkCompleted(7, "firetrack", "check_completed");
  assert.equal(named("module_first_work_completed").length, 1, "reactivation starts a new cycle");

  // --- Observer: shared APIs, client capture, success only ----------------
  events.length = 0;
  let clientId = 21;
  trackModuleActivation(21, "aquatrack");
  const observer = createCompletedWorkObserver(() => clientId);
  assert.equal(observer("PUT", "/pool-track/4"), undefined, "edits are ignored");
  assert.equal(observer("POST", "/sites"), undefined, "unlisted endpoints are ignored");
  const done = observer("POST", "/api/pool-track");
  assert.equal(typeof done, "function");
  clientId = 99; // a client switch mid-request must not move attribution
  assert.deepEqual(named("module_first_work_completed"), [], "nothing is sent before success");
  done();
  assert.deepEqual(named("module_first_work_completed"), [
    ["module_first_work_completed", { module: "aquatrack", activity: "check_completed" }],
  ], "only the activated service sharing the API is recorded");

  for (const [, data] of named("module_first_work_completed")) {
    assert.deepEqual(Object.keys(data).sort(), ["activity", "module"], "no client, site, record or content fields");
  }

  // Tracker or storage failures never escape.
  globalThis.window = makeWindow([], () => { throw new Error("tracker failed"); });
  trackModuleActivation(3, "fixtrack");
  assert.doesNotThrow(() => trackModuleWorkCompleted(3, "fixtrack", "record_saved"));
  globalThis.window = makeWindow([], () => Promise.reject(new Error("tracker request failed")));
  trackModuleActivation(3, "fixtrack");
  assert.doesNotThrow(() => trackModuleWorkCompleted(3, "fixtrack", "record_saved"));
  globalThis.window = { umami: { track: () => {} }, get localStorage() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => { trackModuleActivation(3, "fixtrack"); trackModuleWorkCompleted(3, "fixtrack", "record_saved"); });
  await new Promise(resolve => setImmediate(resolve));

  // --- Shared web apiFetch -------------------------------------------------
  const api = await bundle(path.join(root, "src/lib/api.ts"), "api");
  const seen = [];
  api.setApiFetchMutationObserver((method, url) => { seen.push(["start", method, url]); return () => seen.push(["ok", method, url]); });
  let status = 500;
  globalThis.fetch = async url => (String(url).endsWith("/auth/csrf-token")
    ? new Response(JSON.stringify({ token: "t" }), { status: 200 })
    : new Response("{}", { status }));
  await api.apiFetch("/fire-safety", { method: "POST", body: "{}" });
  await api.apiFetch("/fire-safety");
  assert.deepEqual(seen, [["start", "POST", "/fire-safety"]], "failed saves and reads do not complete");
  status = 201;
  await api.apiFetch("/fire-safety", { method: "POST", body: "{}" });
  assert.deepEqual(seen.at(-1), ["ok", "POST", "/fire-safety"]);
  api.setApiFetchMutationObserver(() => { throw new Error("observer failed"); });
  assert.equal((await api.apiFetch("/fire-safety", { method: "POST", body: "{}" })).status, 201);
  api.setApiFetchMutationObserver(() => () => { throw new Error("observer failed"); });
  assert.equal((await api.apiFetch("/fire-safety", { method: "POST", body: "{}" })).status, 201);
  api.setApiFetchMutationObserver(null);

  // --- Generated client customFetch ---------------------------------------
  const client = await bundle(path.join(workspace, "lib/api-client-react/src/custom-fetch.ts"), "custom-fetch");
  seen.length = 0;
  client.setMutationObserver((method, url) => { seen.push(["start", method, url]); return () => seen.push(["ok", method, url]); });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "nope" }), { status: 400, headers: { "content-type": "application/json" } });
  await assert.rejects(client.customFetch("/api/legionella", { method: "POST", body: "{}" }));
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "content-type": "application/json" } });
  await client.customFetch("/api/legionella");
  assert.deepEqual(await client.customFetch("/api/legionella", { method: "POST", body: "{}" }), { id: 1 });
  assert.deepEqual(seen, [
    ["start", "POST", "/api/legionella"], ["start", "POST", "/api/legionella"], ["ok", "POST", "/api/legionella"],
  ], "only successful generated-client mutations complete");
  client.setMutationObserver(() => { throw new Error("observer failed"); });
  assert.deepEqual(await client.customFetch("/api/legionella", { method: "POST", body: "{}" }), { id: 1 });
  client.setMutationObserver(null);

  // --- Page-local wrappers report through the shared hook ------------------
  for (const file of [
    "src/pages/hot-tub.tsx", "src/pages/tree-track.tsx", "src/pages/bike-track.tsx",
    "src/pages/aqua-track.tsx", "src/pages/pool-track.tsx", "src/pages/pat-track.tsx",
    "src/pages/pest-track.tsx", "src/components/pat-track/legacy-register.tsx",
  ]) {
    const source = await readFile(path.join(root, file), "utf8");
    assert.match(source, /beginApiMutation\(/, `${file} must report successful saves`);
    assert.match(source, /mutationSucceeded\(\)/, `${file} must only report after success`);
  }
  const auth = await readFile(path.join(root, "src/context/auth-context.tsx"), "utf8");
  assert.match(auth, /setMutationObserver\(observer\)/);
  assert.match(auth, /setApiFetchMutationObserver\(observer\)/);

  console.log("Module completed-work analytics classification, privacy, dedup and success gating passed.");
} finally {
  if (originals.window === undefined) delete globalThis.window; else globalThis.window = originals.window;
  globalThis.fetch = originals.fetch;
  await rm(temp, { recursive: true, force: true });
}
