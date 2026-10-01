import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "service-action-analytics-"));
const originalWindow = globalThis.window;
try {
  const bundle = path.join(temp, "analytics.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/analytics.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { trackServiceActionOutcome } = await import(pathToFileURL(bundle).href);
  delete globalThis.window;
  assert.equal(trackServiceActionOutcome("fixtrack", "add", { ok: true, entitled: true }), true);
  globalThis.window = {};
  assert.equal(trackServiceActionOutcome("fixtrack", "remove", { ok: true }), true);
  const events = [];
  globalThis.window = { umami: { track: (...args) => events.push(args) } };
  trackServiceActionOutcome("fixtrack", "add", { ok: true, entitled: true, clientId: 999, invoice: "private" });
  trackServiceActionOutcome("doctrack", "remove", { ok: true, entitled: ["core"] });
  for (const result of [
    { ok: false }, { ok: true, entitled: false }, { ok: true },
    { ok: true, entitled: true, paymentPending: true },
  ]) assert.equal(trackServiceActionOutcome("fixtrack", "add", result), false);
  assert.deepEqual(events, [
    ["service_action_succeeded", { service_key: "fixtrack", action: "add" }],
    ["service_action_succeeded", { service_key: "doctrack", action: "remove" }],
  ], "send only service key and action, never fields from the response");

  // Execute the real Settings handler with an isolated API/tracker, without
  // mounting the page or touching Stripe, subscriptions, or real clients.
  const page = await readFile(path.join(root, "src/pages/settings.tsx"), "utf8");
  const handler = page.slice(page.indexOf("const handleServiceAction ="), page.indexOf("const servicesConfig ="));
  const source = `export function makeHandler(deps) {
    const {config,confirm,setActionBusy,apiFetch,toast,trackServiceActionOutcome,
      trackModuleActivation,clearModuleActivation,activeClientId,fetchConfig,refreshAuth}=deps;
    ${handler}
    return handleServiceAction;
  }`;
  const output = path.join(temp, "settings-handler.mjs");
  await writeFile(output, (await transform(source, { loader: "ts", format: "esm" })).code);
  const { makeHandler } = await import(pathToFileURL(output).href);
  async function run({ action = "add", result = { ok: true, entitled: true }, fail = false, approve = true } = {}) {
    const calls = { requests: [], busy: [], notices: [], refresh: 0, activations: 0, removals: 0 };
    const execute = makeHandler({
      config: { services: { catalog: [{ key: "fixtrack", amountPence: 1000 }] }, billableQuantity: 1 },
      activeClientId: 999,
      confirm: () => approve,
      setActionBusy: value => calls.busy.push(value),
      apiFetch: async url => {
        calls.requests.push(url);
        if (url === "/billing/services" && fail) throw new Error("billing failed");
        return result;
      },
      toast: notice => calls.notices.push(notice),
      trackServiceActionOutcome,
      trackModuleActivation: () => calls.activations++,
      clearModuleActivation: () => calls.removals++,
      fetchConfig: () => {},
      refreshAuth: async () => calls.refresh++,
    });
    await execute("fixtrack", action);
    return calls;
  }
  events.length = 0;
  assert.equal((await run()).activations, 1);
  assert.equal((await run({ action: "remove", result: { ok: true, entitled: ["core"] } })).removals, 1);
  assert.deepEqual(events.map(([, data]) => data.action), ["add", "remove"]);
  for (const scenario of [
    { fail: true }, { approve: false }, { result: { ok: false } },
    { result: { ok: true, entitled: false } },
    { result: { ok: true, entitled: true, paymentPending: true } },
  ]) {
    events.length = 0;
    const calls = await run(scenario);
    assert.deepEqual(events, [], "failed, cancelled, pending or unconfirmed actions must not emit success");
    assert.equal(calls.activations, 0);
  }
  for (const track of [
    () => { throw new Error("tracker failed"); },
    () => Promise.reject(new Error("tracker request failed")),
  ]) {
    globalThis.window = { umami: { track } };
    for (const action of ["add", "remove"]) {
      const calls = await run({ action });
      assert.equal(calls.refresh, 1, "analytics failure must not interrupt access refresh");
      assert.equal(calls.busy.at(-1), null);
      assert.ok(!calls.notices.some(({ title }) => title === "Action failed"));
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  console.log("Service-action analytics privacy, success gating and failure checks passed.");
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  await rm(temp, { recursive: true, force: true });
}