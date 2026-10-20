// Reducing paid extra storage from the next renewal, through the real API.
//
// Runs only through tests/run-fresh-schema.sh (disposable database). The suite
// bundles the app in-process with Stripe replaced by an in-memory fake
// (storage-capacity-stripe.stub.ts). Sessions, tenant checks, the usage
// ledger, the advisory lock and the reductions table are real.
//
// Rules protected here:
//   - a manager can reduce only down to what the retained files need;
//   - Stripe's quantity drops with no proration, and the GiB already paid for
//     stay counted until the period ends;
//   - replays and lost Stripe responses never apply a reduction twice;
//   - concurrent requests are serialised;
//   - files are never touched;
//   - the per-site quantity sync never resizes the storage item.
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/storage-capacity-reduction.mjs (disposable database only)");
}

const GIB = 1024 ** 3;
process.env.SESSION_SECRET ||= "storage-capacity-test-only-not-a-real-secret";
process.env.LOG_LEVEL ||= "error";
for (const name of ["STORAGE_ADDON_PRICE_ID", "STORAGE_INCLUDED_GIB_BY_SERVICE"]) delete process.env[name];

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}${detail ? `: ${detail}` : ""}`); console.error(`FAIL: ${name}${detail ? `: ${detail}` : ""}`); }
}
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function session(base) {
  let cookie = "";
  return async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function registerTenant(base, label, stamp) {
  const user = session(base);
  const email = `storage-capacity-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Capacity ${label}`, email, password: "password-123" });
  if (![200, 201].includes(registered.status)) throw new Error(`register ${label}: ${registered.status} ${JSON.stringify(registered.data)}`);
  await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const login = await user("POST", "/auth/login", { email, password: "password-123" });
  if (login.status !== 200) throw new Error(`login ${label}: ${login.status} ${JSON.stringify(login.data)}`);
  const me = await user("GET", "/auth/me");
  const account = me.data?.user ?? me.data;
  if (!Number.isSafeInteger(account?.clientId)) throw new Error(`no client for ${label}`);
  return { user, clientId: account.clientId, userId: account.id };
}

const query = async (text, params = []) => (await t.pool.query(text, params)).rows;

/** Retained files for a tenant, as the ledger holds them after a checked reconciliation. */
async function setRetained(clientId, bytes) {
  await query("DELETE FROM storage_usage_objects WHERE client_id = $1", [clientId]);
  if (bytes > 0) {
    await query(
      "INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present) VALUES ($1, $2, $3, true)",
      [`/objects/finalized/tenant-${clientId}/retained-${randomUUID()}`, clientId, Math.round(bytes)],
    );
  }
  await query(`
    INSERT INTO storage_usage_snapshots (client_id, reconciled_at) VALUES ($1, now())
    ON CONFLICT (client_id) DO UPDATE SET reconciled_at = now()
  `, [clientId]);
}

const reductionRows = (clientId) =>
  query("SELECT from_gib, to_gib, minimum_gib, requested_by, effective_at FROM storage_capacity_reductions WHERE client_id = $1 ORDER BY id", [clientId]);
const stripeCalls = (method) => t.calls.filter((call) => call.method === method);
const storageQuantity = (customer) =>
  t.getSubscription(customer)?.items.data.find((item) => item.price.metadata.service_key === "storage")?.quantity ?? 0;

async function main(base) {
  const stamp = Date.now();
  const tenant = await registerTenant(base, "a", stamp);
  const other = await registerTenant(base, "b", stamp);
  const { user, clientId } = tenant;
  const customer = `cus_capacity_${clientId}`;
  const periodEnd = Math.floor(Date.now() / 1000) + 12 * 86400;
  const periodEndIso = new Date(periodEnd * 1000).toISOString();

  console.log("\n── no subscription ──");
  same("no Stripe customer: not subscribed", (await user("GET", "/billing/storage")).data, { subscribed: false });

  await query("UPDATE clients SET stripe_customer_id = $1 WHERE id = $2", [customer, clientId]);
  t.setSubscription(customer, [{ serviceKey: "core", quantity: 1 }, { serviceKey: "storage", quantity: 50 }], periodEnd);
  // Needs 22.5 GiB beyond the plan: 30 GiB in whole 10 GiB steps.
  await setRetained(clientId, 23.5 * GIB);

  console.log("\n── what is paid and what the files need ──");
  const before = (await user("GET", "/billing/storage")).data;
  same("renewing, paid, plan and minimum GiB",
    [before?.renewingGib, before?.paidGibThisPeriod, before?.planIncludedGib, before?.minimumGib],
    [50, 50, 1, 30]);
  same("period end comes from the storage item", before?.periodEndsAt, periodEndIso);
  same("unit price shown", [before?.unitAmount, before?.currency], [25, "gbp"]);
  same("can reduce", [before?.canReduce, before?.reduceUnavailableReason], [true, null]);

  console.log("\n── the site-count sync leaves storage alone ──");
  t.getSubscription(customer).items.data[0].quantity = 9;
  await t.syncClientSubscriptionQuantity(clientId);
  const syncUpdates = stripeCalls("subscriptions.update");
  check("site sync ran", syncUpdates.length === 1, JSON.stringify(syncUpdates));
  same("site sync resized only the per-site item", syncUpdates[0]?.params.items.map((item) => item.id), [`si_${customer}_0`]);
  same("storage quantity untouched by site sync", storageQuantity(customer), 50);
  t.calls.length = 0;

  console.log("\n── refused reductions ──");
  const belowFiles = await user("POST", "/billing/storage/reduce", { targetGib: 20, requestId: randomUUID() });
  same("below what the files need → 409", belowFiles.status, 409);
  check("explains the minimum", /at least 30 GB/.test(belowFiles.data?.error ?? ""), belowFiles.data?.error);
  same("not lower than now → 409", (await user("POST", "/billing/storage/reduce", { targetGib: 50, requestId: randomUUID() })).status, 409);
  same("bad body → 400", (await user("POST", "/billing/storage/reduce", { targetGib: 1.5, requestId: randomUUID() })).status, 400);
  same("not a whole 10 GiB step → 400", (await user("POST", "/billing/storage/reduce", { targetGib: 35, requestId: randomUUID() })).status, 400);
  const crossTenant = await other.user("POST", `/billing/storage/reduce?clientId=${clientId}`, { targetGib: 30, requestId: randomUUID() });
  check("another business cannot reduce it", [400, 403, 404].includes(crossTenant.status), String(crossTenant.status));
  same("refusals never reached Stripe", t.calls.length, 0);

  console.log("\n── reduce 50 → 30 GiB ──");
  const requestId = randomUUID();
  const reduced = await user("POST", "/billing/storage/reduce", { targetGib: 30, requestId });
  same("reduction accepted", reduced.status, 201);
  same("confirmation details", [reduced.data?.fromGib, reduced.data?.toGib, reduced.data?.effectiveAt, reduced.data?.paidGibThisPeriod], [50, 30, periodEndIso, 50]);
  const update = stripeCalls("subscriptions.update");
  same("one Stripe quantity change", update.length, 1);
  same("no proration, storage item only", update[0]?.params, { items: [{ id: `si_${customer}_1`, quantity: 30 }], proration_behavior: "none" });
  same("idempotency key is per request", update[0]?.idempotencyKey, `storage-reduce-sub_${customer}-${requestId}`);
  same("Stripe renews with 30 GiB", storageQuantity(customer), 30);
  const rows = await reductionRows(clientId);
  same("one recorded reduction", rows.map((row) => [row.from_gib, row.to_gib, row.minimum_gib, row.requested_by]), [[50, 30, 30, tenant.userId]]);
  same("effective at period end", new Date(rows[0]?.effective_at).toISOString(), periodEndIso);

  const replay = await user("POST", "/billing/storage/reduce", { targetGib: 30, requestId });
  same("replay answers the same reduction", [replay.status, replay.data?.fromGib, replay.data?.toGib, replay.data?.replayed], [200, 50, 30, true]);
  same("replay never reaches Stripe again", stripeCalls("subscriptions.update").length, 1);
  const stolen = await other.user("POST", "/billing/storage/reduce", { targetGib: 30, requestId });
  check("another business cannot replay the request id", stolen.status >= 400, String(stolen.status));

  const after = (await user("GET", "/billing/storage")).data;
  same("paid GiB kept until period end", [after?.renewingGib, after?.paidGibThisPeriod], [30, 50]);
  same("scheduled reduction listed", after?.scheduled?.map((row) => [row.fromGib, row.toGib, row.effectiveAt]), [[50, 30, periodEndIso]]);
  same("files need all that renews: no further reduction", [after?.canReduce, after?.reduceUnavailableReason], [false, "needed_by_files"]);
  const usage = (await user("GET", "/storage/usage")).data;
  same("estimate still includes the paid 50 GiB this period", usage?.estimatedCost?.includedStorageBytes, (1 + 50) * GIB);
  same("files untouched", [usage?.usedBytes, (await query("SELECT count(*)::int AS n FROM storage_usage_objects WHERE client_id = $1 AND present", [clientId]))[0].n], [23.5 * GIB, 1]);

  console.log("\n── Stripe failures ──");
  await setRetained(clientId, 10.5 * GIB); // needs 9.5 GiB extra: one 10 GiB step
  t.setFault("fail");
  const failed = await user("POST", "/billing/storage/reduce", { targetGib: 20, requestId: randomUUID() });
  same("Stripe failure → 502", failed.status, 502);
  same("failure changed nothing", [storageQuantity(customer), (await reductionRows(clientId)).length], [30, 1]);
  t.setFault("lose-response");
  const lost = await user("POST", "/billing/storage/reduce", { targetGib: 20, requestId: randomUUID() });
  same("lost response that Stripe applied is recorded", [lost.status, lost.data?.fromGib, lost.data?.toGib], [201, 30, 20]);
  same("additive paid capacity: 20 renewing + 20 + 10 still paid", (await user("GET", "/billing/storage")).data?.paidGibThisPeriod, 50);

  console.log("\n── concurrent requests are serialised ──");
  t.setUpdateDelay(150);
  const racing = await Promise.all([1, 1].map(() => user("POST", "/billing/storage/reduce", { targetGib: 10, requestId: randomUUID() })));
  t.setUpdateDelay(0);
  same("exactly one of two racing reductions applies", racing.map((r) => r.status).sort(), [201, 409]);
  same("Stripe renews with 10 GiB", storageQuantity(customer), 10);
  same("paid capacity still 50 GiB", (await user("GET", "/billing/storage")).data?.paidGibThisPeriod, 50);

  console.log("\n── remove all extra storage ──");
  await setRetained(clientId, GIB / 2);
  const removed = await user("POST", "/billing/storage/reduce", { targetGib: 0, requestId: randomUUID() });
  same("reduce to 0 accepted", [removed.status, removed.data?.toGib], [201, 0]);
  same("storage item deleted with no proration", stripeCalls("subscriptionItems.del").map((call) => call.params), [{ proration_behavior: "none" }]);
  same("core plan item kept", t.getSubscription(customer).items.data.map((item) => item.price.metadata.service_key), ["core"]);
  const empty = (await user("GET", "/billing/storage")).data;
  same("nothing renews, 50 GiB still paid", [empty?.renewingGib, empty?.paidGibThisPeriod, empty?.reduceUnavailableReason], [0, 50, "no_extra_storage"]);

  console.log("\n── after the period ends ──");
  await query("UPDATE storage_capacity_reductions SET effective_at = now() - interval '1 second' WHERE client_id = $1", [clientId]);
  const renewed = (await user("GET", "/billing/storage")).data;
  same("paid capacity follows the renewal", [renewed?.paidGibThisPeriod, renewed?.scheduled?.length], [0, 0]);
  same("history kept", (await reductionRows(clientId)).map((row) => [row.from_gib, row.to_gib]), [[50, 30], [30, 20], [20, 10], [10, 0]]);
}

// ─── run ────────────────────────────────────────────────────────────────────

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-storage-capacity-"));
let t;
let server;
try {
  const outfile = path.join(outDir, "entry.mjs");
  const stripeStub = path.join(dir, "storage-capacity-stripe.stub.ts");
  await build({
    entryPoints: [path.join(dir, "storage-capacity-reduction.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer", "stripe-replit-sync"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
    plugins: [{
      name: "stripe-client-stub",
      setup(builder) {
        builder.onResolve({ filter: /\/stripeClient$/ }, (args) =>
          args.importer.includes(`${path.sep}src${path.sep}`) ? { path: stripeStub } : undefined);
      },
    }],
  });
  t = await import(outfile);
  server = await t.startServer();
  await main(server.base);
} finally {
  if (server) await server.close();
  await rm(outDir, { recursive: true, force: true });
}

console.log(`\nstorage capacity reduction: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
