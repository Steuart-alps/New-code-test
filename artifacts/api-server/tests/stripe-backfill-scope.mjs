// stripe-replit-sync's syncBackfill() with no arguments matches no object and
// copies nothing, so the synced stripe.* tables (and the service-price
// catalogue check that reads them) stayed empty after start-up. Pins that
// library behaviour and checks every call site names what to copy.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StripeSync } from "stripe-replit-sync";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The pool connects lazily; no database or Stripe call is made here.
const sync = new StripeSync({
  poolConfig: { connectionString: "postgresql://unused@127.0.0.1:1/unused", max: 1 },
  stripeSecretKey: "sk_test_unused",
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});
const calls = [];
sync.getCurrentAccount = async () => ({ id: "acct_unused" });
for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(sync))) {
  if (/^sync[A-Z]/.test(name) && name !== "syncBackfill") {
    sync[name] = async () => { calls.push(name); return { synced: 0 }; };
  }
}

await sync.syncBackfill();
assert.deepEqual(calls, [], "the library default copies nothing (if this changes, revisit the call sites)");
await sync.syncBackfill({ object: "price" });
assert.deepEqual(calls, ["syncPrices"]);
calls.length = 0;
await sync.syncBackfill({ object: "all" });
for (const name of ["syncProducts", "syncPrices", "syncCustomers", "syncSubscriptions"]) {
  assert.ok(calls.includes(name), `object "all" copies ${name}`);
}
await sync.postgresClient?.pool?.end?.().catch(() => {});

const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith(".ts")) sources.push(full);
  }
};
walk(path.join(apiDir, "src"));
let callSites = 0;
for (const file of sources) {
  for (const match of readFileSync(file, "utf8").matchAll(/\.syncBackfill\(([^)]*)\)/g)) {
    callSites++;
    assert.match(match[1], /object:\s*"[a-z_]+"/, `${path.relative(apiDir, file)} calls syncBackfill(${match[1]}) without naming an object`);
  }
}
assert.ok(callSites >= 2, "start-up and price creation both backfill");

console.log("Stripe backfill scope tests passed.");
