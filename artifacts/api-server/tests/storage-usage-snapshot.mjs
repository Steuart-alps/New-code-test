// PostgreSQL regression test for the retained-storage usage ledger and its
// per-tenant snapshots (src/lib/storageUsageSnapshot.ts).
//
// Run through the disposable-database harness only:
//   bash tests/run-fresh-schema.sh tests/storage-usage-snapshot.mjs
//
// It proves, against real PostgreSQL built from runtime migrations:
//   - concurrent, retried finalisations and deletions for two tenants end at
//     exact totals, never read negative, and never count another tenant's files
//   - a reconciliation racing with uploads and deletions keeps the newer
//     writes instead of its stale listing
//   - drift between the ledger and provider metadata is corrected and recorded
//   - only one reconciliation per tenant runs at a time (lease)
//   - an interrupted lifecycle change leaves a marker that forces reconciliation
//   - ObjectStorageService reports finalisation and deletion to the ledger and
//     clears its marker only when nothing changed at the provider

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const { default: test, after } = await import("node:test");
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("Run via tests/run-fresh-schema.sh: this test needs the disposable database.");
}

const temp = await mkdtemp(fileURLToPath(new URL(".build-storage-usage-snapshot-", import.meta.url)));
const bundlePath = `${temp}/runtime.mjs`;
await build({
  entryPoints: [fileURLToPath(new URL("./storage-usage-snapshot.entry.ts", import.meta.url))],
  outfile: bundlePath,
  bundle: true, platform: "node", format: "esm", logLevel: "silent",
  external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "pdfjs-dist/*"],
  banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
});
const runtime = await import(pathToFileURL(bundlePath).href);
const {
  pool, beginStorageUsageChange, readStorageUsageSnapshot, reconcileStorageUsage,
  recordStorageUsageChange, storageUsageLedger, storageUsageSnapshotIsStale,
  ObjectOwnershipError, ObjectStorageService, setStorageUsageRecorder,
} = runtime;

const runId = randomUUID().slice(0, 8);
const tenants = [];

async function createTenant(label) {
  const { rows } = await pool.query(
    "INSERT INTO clients (name, slug) VALUES ($1, $2) RETURNING id",
    [`Storage usage ${label} ${runId}`, `storage-usage-${label}-${runId}`],
  );
  tenants.push(rows[0].id);
  return rows[0].id;
}

const present = (objectPath, sizeBytes) => ({ kind: "present", objectPath, sizeBytes });
const removed = (objectPath) => ({ kind: "removed", objectPath });
const objectPath = (tenantId, name) => `/objects/finalized/tenant-${tenantId}/${name}`;

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, opened };
}

async function ledgerRow(path) {
  const { rows } = await pool.query(
    "SELECT client_id, size_bytes::int AS size_bytes, present FROM storage_usage_objects WHERE object_path = $1",
    [path],
  );
  return rows[0] ?? null;
}

async function pendingCount(tenantId) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM storage_usage_pending WHERE client_id = $1", [tenantId]);
  return rows[0].n;
}

after(async () => {
  setStorageUsageRecorder(null);
  if (tenants.length) {
    await pool.query("DELETE FROM clients WHERE id = ANY($1::int[])", [tenants]);
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM storage_usage_objects WHERE client_id = ANY($1::int[]))
            + (SELECT count(*) FROM storage_usage_pending WHERE client_id = ANY($1::int[]))
            + (SELECT count(*) FROM storage_usage_snapshots WHERE client_id = ANY($1::int[])) AS n`,
      [tenants],
    );
    assert.equal(Number(rows[0].n), 0, "fixture rows are removed with their tenants");
  }
  await pool.end();
  await rm(temp, { recursive: true, force: true });
});

test("concurrent retried finalisations and deletions end exact, non-negative and tenant-scoped", async () => {
  const a = await createTenant("race-a");
  const b = await createTenant("race-b");
  const objects = [];
  for (let i = 0; i < 40; i += 1) {
    objects.push({ tenant: a, path: objectPath(a, `obj-${i}`), size: (i + 1) * 100, keep: i % 2 === 1 });
    objects.push({ tenant: b, path: objectPath(b, `obj-${i}`), size: (i + 1) * 7, keep: i % 3 !== 0 });
  }
  const maxBytes = new Map([[a, 0], [b, 0]]);
  for (const o of objects) maxBytes.set(o.tenant, maxBytes.get(o.tenant) + o.size);

  // Each object's lifecycle is ordered (upload, then maybe delete) but every
  // step is retried, and all objects of both tenants run at once.
  const lifecycles = shuffle(objects).map(async (o) => {
    await Promise.all([
      recordStorageUsageChange(o.tenant, present(o.path, o.size)),
      recordStorageUsageChange(o.tenant, present(o.path, o.size)),
    ]);
    if (!o.keep) {
      await Promise.all([
        recordStorageUsageChange(o.tenant, removed(o.path)),
        recordStorageUsageChange(o.tenant, removed(o.path)),
      ]);
    }
  });
  // Another tenant trying to claim or delete reserved paths has no effect.
  const intrusions = objects.filter((o) => o.tenant === a).map(async (o) => {
    await assert.rejects(recordStorageUsageChange(b, present(o.path, 1)), /reserved for another tenant/);
    await assert.rejects(recordStorageUsageChange(b, removed(o.path)), /reserved for another tenant/);
    await storageUsageLedger.record(b, removed(o.path), null); // logged, never thrown
  });

  let sampling = true;
  const samples = (async () => {
    let reads = 0;
    while (sampling || reads === 0) {
      for (const tenant of [a, b]) {
        const s = await readStorageUsageSnapshot(tenant);
        assert.ok(s.usedBytes >= 0 && s.objectCount >= 0, `tenant ${tenant} never reads negative`);
        assert.ok(s.usedBytes <= maxBytes.get(tenant), `tenant ${tenant} never exceeds its own files`);
      }
      reads += 1;
    }
    return reads;
  })();
  await Promise.all([...lifecycles, ...intrusions]);
  sampling = false;
  assert.ok(await samples > 0);

  for (const tenant of [a, b]) {
    const kept = objects.filter((o) => o.tenant === tenant && o.keep);
    const s = await readStorageUsageSnapshot(tenant);
    assert.equal(s.usedBytes, kept.reduce((sum, o) => sum + o.size, 0), `tenant ${tenant} bytes are exact`);
    assert.equal(s.objectCount, kept.length, `tenant ${tenant} file count is exact`);
  }
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM storage_usage_objects WHERE client_id = $1 AND object_path LIKE $2",
    [b, `/objects/finalized/tenant-${a}/%`],
  );
  assert.equal(rows[0].n, 0, "no ledger row attributes tenant A's files to tenant B");

  // Replaying everything after a restart changes nothing.
  await Promise.all(objects.map((o) => recordStorageUsageChange(o.tenant, o.keep ? present(o.path, o.size) : removed(o.path))));
  const replayed = await readStorageUsageSnapshot(a);
  assert.equal(replayed.objectCount, objects.filter((o) => o.tenant === a && o.keep).length);
});

test("legacy paths stay with the tenant that recorded them, and sizes cannot go negative", async () => {
  const a = await createTenant("legacy-a");
  const b = await createTenant("legacy-b");
  const legacy = `/objects/legacy/${runId}-shared.pdf`;
  await recordStorageUsageChange(a, present(legacy, 500));
  await Promise.all([
    recordStorageUsageChange(b, present(legacy, 9999)),
    recordStorageUsageChange(b, removed(legacy)),
  ]);
  assert.deepEqual(await ledgerRow(legacy), { client_id: a, size_bytes: 500, present: true });
  assert.equal((await readStorageUsageSnapshot(b)).usedBytes, 0);

  await assert.rejects(recordStorageUsageChange(a, present(objectPath(a, "negative"), -1)), /non-negative/);
  await assert.rejects(
    pool.query("INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present) VALUES ($1, $2, -5, true)", [objectPath(a, "raw-negative"), a]),
    /storage_usage_objects_size_nonnegative/,
  );
  // Deleting something never recorded leaves a zero-size tombstone, not a debit.
  await recordStorageUsageChange(a, removed(objectPath(a, "never-recorded")));
  assert.equal((await readStorageUsageSnapshot(a)).usedBytes, 500);
});

test("a reconciliation racing with uploads and deletions keeps the newer writes", async () => {
  const a = await createTenant("reconcile-race");
  const [p1, p2, p3] = ["one", "two", "three"].map((name) => objectPath(a, name));
  await recordStorageUsageChange(a, present(p1, 100));
  await recordStorageUsageChange(a, present(p2, 200));

  const listed = gate();
  const release = gate();
  const reconciling = reconcileStorageUsage(a, async () => {
    // The provider listing is taken here, before the changes below.
    const snapshot = [{ objectPath: p1, sizeBytes: 100 }, { objectPath: p2, sizeBytes: 200 }];
    listed.open();
    await release.opened;
    return snapshot;
  });
  await listed.opened;
  await recordStorageUsageChange(a, present(p3, 300)); // uploaded after the listing
  await recordStorageUsageChange(a, removed(p2)); // deleted after the listing
  release.open();
  const result = await reconciling;

  assert.ok(result, "the reconciliation ran");
  assert.equal(result.driftBytes, 0, "concurrent lifecycle writes are not drift");
  assert.deepEqual(await ledgerRow(p2), { client_id: a, size_bytes: 200, present: false }, "the stale listing does not resurrect a deletion");
  assert.equal((await ledgerRow(p3)).present, true, "the stale listing does not drop a new upload");
  const s = await readStorageUsageSnapshot(a);
  assert.equal(s.usedBytes, 400);
  assert.equal(s.objectCount, 2);
  assert.ok(s.reconciledAt instanceof Date && s.ageSeconds >= 0 && s.ageSeconds < 60);
  assert.equal(storageUsageSnapshotIsStale(s, 3600), false);
});

test("drift from provider metadata is corrected and recorded", async () => {
  const a = await createTenant("drift-a");
  const b = await createTenant("drift-b");
  const [kept, phantom, missed, resized] = ["kept", "phantom", "missed", "resized"].map((name) => objectPath(a, name));
  const misattributed = `/objects/legacy/${runId}-misattributed.pdf`;
  await recordStorageUsageChange(a, present(kept, 10));
  await recordStorageUsageChange(a, present(phantom, 1000)); // gone from the provider
  await recordStorageUsageChange(a, present(resized, 50));
  await recordStorageUsageChange(b, present(misattributed, 70)); // ACL says tenant A
  const firstRun = await reconcileStorageUsage(a, async () => [
    { objectPath: kept, sizeBytes: 10 },
    { objectPath: missed, sizeBytes: 300 }, // never reached the ledger
    { objectPath: resized, sizeBytes: 55 },
    { objectPath: misattributed, sizeBytes: 70 },
  ]);
  assert.equal(firstRun.usedBytes, 10 + 300 + 55 + 70);
  assert.equal(firstRun.driftBytes, (10 + 300 + 55 + 70) - (10 + 1000 + 50));
  assert.equal(firstRun.driftObjects, 1);
  assert.equal((await ledgerRow(phantom)).present, false);
  assert.equal((await ledgerRow(misattributed)).client_id, a, "ACL ownership corrects the ledger's tenant");
  assert.equal((await readStorageUsageSnapshot(b)).usedBytes, 0);

  const { rows } = await pool.query(
    "SELECT drift_bytes::int AS drift_bytes, last_drift_at IS NOT NULL AS drifted FROM storage_usage_snapshots WHERE client_id = $1",
    [a],
  );
  assert.deepEqual(rows[0], { drift_bytes: firstRun.driftBytes, drifted: true });
  const secondRun = await reconcileStorageUsage(a, async () => [
    { objectPath: kept, sizeBytes: 10 },
    { objectPath: missed, sizeBytes: 300 },
    { objectPath: resized, sizeBytes: 55 },
    { objectPath: misattributed, sizeBytes: 70 },
  ]);
  assert.equal(secondRun.driftBytes, 0, "a consistent ledger reports no drift");
});

test("only one reconciliation per tenant holds the lease", async () => {
  const a = await createTenant("lease");
  const release = gate();
  const first = reconcileStorageUsage(a, async () => { await release.opened; return []; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await reconcileStorageUsage(a, async () => []), null, "a second reconciliation is refused");
  assert.equal((await readStorageUsageSnapshot(a)).refreshing, true);
  release.open();
  assert.ok(await first);
  assert.equal((await readStorageUsageSnapshot(a)).refreshing, false);

  // A crashed holder's lease expires; a failed listing releases it at once.
  await pool.query("UPDATE storage_usage_snapshots SET refresh_lease_token = 'crashed', refresh_lease_until = now() - interval '1 second' WHERE client_id = $1", [a]);
  await assert.rejects(reconcileStorageUsage(a, async () => { throw new Error("provider unavailable"); }), /provider unavailable/);
  assert.ok(await reconcileStorageUsage(a, async () => []), "the lease is free after a failed listing");
});

test("an interrupted lifecycle change forces reconciliation", async () => {
  const a = await createTenant("interrupted");
  await reconcileStorageUsage(a, async () => []);
  const crashed = objectPath(a, "crashed-before-ledger");
  await beginStorageUsageChange(a); // the process dies before the ledger write
  let s = await readStorageUsageSnapshot(a);
  assert.equal(s.interruptedChanges, false, "a change in flight is not yet suspicious");
  await pool.query("UPDATE storage_usage_pending SET started_at = now() - interval '11 minutes' WHERE client_id = $1", [a]);
  s = await readStorageUsageSnapshot(a);
  assert.equal(s.interruptedChanges, true);
  assert.equal(storageUsageSnapshotIsStale(s, 3600), true, "the marker makes a fresh snapshot stale");

  const result = await reconcileStorageUsage(a, async () => [{ objectPath: crashed, sizeBytes: 42 }]);
  assert.equal(result.usedBytes, 42, "the object finalised before the crash is counted");
  s = await readStorageUsageSnapshot(a);
  assert.equal(s.interruptedChanges, false);
  assert.equal(await pendingCount(a), 0);
});

test("ObjectStorageService reports lifecycle changes to the ledger", async () => {
  const a = await createTenant("service-a");
  const b = await createTenant("service-b");
  setStorageUsageRecorder(storageUsageLedger);
  const storage = new ObjectStorageService();
  const files = new Map();
  const fakeFile = (path, size, { failDelete = false } = {}) => {
    const file = {
      name: path,
      customMetadata: {},
      exists: async () => [files.has(path)],
      getMetadata: async () => [{ size: String(size), metadata: { ...file.customMetadata } }],
      setMetadata: async ({ metadata }) => { Object.assign(file.customMetadata, metadata); return [{}]; },
      delete: async () => {
        if (failDelete) throw new Error("provider timeout");
        files.delete(path);
        return [{}];
      },
    };
    files.set(path, file);
    return file;
  };
  storage.getObjectEntityFile = async (path) => {
    const file = files.get(path);
    if (!file) throw new Error(`missing ${path}`);
    return file;
  };

  const upload = `/objects/uploads/tenant-${a}/${randomUUID()}`;
  fakeFile(upload, 1234);
  await Promise.all([storage.finalizeTenantUpload(upload, a), storage.finalizeTenantUpload(upload, a)]);
  assert.deepEqual(await ledgerRow(upload), { client_id: a, size_bytes: 1234, present: true });
  assert.equal(await pendingCount(a), 0, "completed changes clear their markers");

  await assert.rejects(storage.deleteTenantObject(upload, b), ObjectOwnershipError);
  assert.equal(await pendingCount(b), 0, "a refused change leaves no marker");
  assert.equal((await ledgerRow(upload)).present, true);

  await storage.deleteTenantObject(upload, a);
  assert.equal((await ledgerRow(upload)).present, false);
  assert.equal(await pendingCount(a), 0);

  const stuck = `/objects/uploads/tenant-${a}/${randomUUID()}`;
  fakeFile(stuck, 10, { failDelete: true });
  await storage.finalizeTenantUpload(stuck, a);
  await assert.rejects(storage.deleteTenantObject(stuck, a), /provider timeout/);
  assert.equal(await pendingCount(a), 1, "an uncertain provider outcome keeps its marker for reconciliation");
  assert.equal((await ledgerRow(stuck)).present, true);
});
