// Staged required-photo cleanup against a disposable PostgreSQL database.
//
// Object storage is an in-memory fake with tenant ACLs; no real bucket or
// application storage is touched. Fixture tenants/users are created here and
// removed at the end. Run through:
//   bash tests/run-fresh-schema.sh tests/staged-photo-cleanup.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.env.FRESH_SCHEMA_TEST !== "1" || !process.env.DATABASE_URL) {
  throw new Error("Run through tests/run-fresh-schema.sh: a disposable database is required");
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-staged-photo-cleanup-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "staged-photo-cleanup.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "sharp", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
  });
  const {
    db, pool, sql, photosRouter,
    createWithStagedPhotoReceipts, StagedPhotoReceiptError,
    cleanupStagedPhotoUploads, isTenantFinalizedObjectPath,
    ObjectNotFoundError, ObjectOwnershipError, ObjectStorageService,
  } = await import(outfile);

  // ── In-memory object storage with tenant ACLs ────────────────────────────
  const objects = new Map();
  const storageHooks = { beforeDelete: null, failWith: null, deleteThenFail: false };
  const fakeStorage = {
    async deleteTenantObject(objectPath, tenantId) {
      if (storageHooks.beforeDelete) await storageHooks.beforeDelete(objectPath);
      if (storageHooks.failWith) throw storageHooks.failWith;
      const object = objects.get(objectPath);
      if (!object) throw new ObjectNotFoundError();
      if (object.owner !== String(tenantId) || object.visibility !== "private") throw new ObjectOwnershipError();
      objects.delete(objectPath);
      if (storageHooks.deleteThenFail) throw new Error("connection reset after delete");
    },
  };
  const originalDelete = ObjectStorageService.prototype.deleteTenantObject;
  ObjectStorageService.prototype.deleteTenantObject = function (objectPath, tenantId) {
    return fakeStorage.deleteTenantObject(objectPath, tenantId);
  };

  const rows = async (query) => (await db.execute(query)).rows;
  // The fresh-schema database is built by runtime migrations only; the legacy
  // drizzle-only certificate tables that the shared reference check reads may
  // be absent. Create minimal empty stand-ins in this disposable database only.
  const [{ present }] = await rows(sql`SELECT to_regclass('public.certificates') IS NOT NULL AS present`);
  if (!present) {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS contractors (id serial PRIMARY KEY, client_id integer)`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS certificates (id serial PRIMARY KEY, contractor_id integer, file_url text)`);
  }
  const tag = `staged-cleanup-${Date.now()}`;
  const [clientA] = await rows(sql`INSERT INTO clients (name, slug, active) VALUES (${`${tag} A`}, ${`${tag}-a`}, true) RETURNING id`);
  const [clientB] = await rows(sql`INSERT INTO clients (name, slug, active) VALUES (${`${tag} B`}, ${`${tag}-b`}, true) RETURNING id`);
  const user = async (clientId, suffix) => (await rows(sql`
    INSERT INTO users (email, password_hash, name, role, client_id)
    VALUES (${`${tag}-${suffix}@example.test`}, 'not-a-real-hash', ${`Fixture ${suffix}`}, 'client_staff', ${clientId})
    RETURNING id
  `))[0].id;
  const A = clientA.id;
  const B = clientB.id;
  const actorA = await user(A, "a1");
  const actorA2 = await user(A, "a2");
  const actorB = await user(B, "b1");

  let objectCounter = 0;
  async function stage({ clientId = A, actorId = actorA, expiresIn = "30 minutes", cancelled = false, owner, pathOverride } = {}) {
    const id = randomUUID();
    const objectPath = pathOverride ?? `/objects/finalized/tenant-${clientId}/${tag}-${++objectCounter}.jpg`;
    objects.set(objectPath, { owner: String(owner ?? clientId), visibility: "private" });
    await db.execute(sql`
      INSERT INTO staged_photo_upload_receipts (id, client_id, entity_type, actor_id, object_path, expires_at, cancelled_at)
      VALUES (${id}::uuid, ${clientId}, 'swim_session', ${actorId}, ${objectPath},
        now() + ${expiresIn}::interval, ${cancelled ? sql`now()` : sql`NULL`})
    `);
    return { id, objectPath };
  }
  const receiptRow = async (id) => (await rows(sql`SELECT * FROM staged_photo_upload_receipts WHERE id = ${id}::uuid`))[0];
  const sweep = (options = {}) => cleanupStagedPhotoUploads(fakeStorage, { clientId: A, ...options });

  // Route helpers (handler invoked directly; middleware asserted separately).
  const deleteLayer = photosRouter.stack.find((layer) => layer.route?.path === "/staged/:id" && layer.route.methods.delete);
  assert.ok(deleteLayer, "DELETE /photos/staged/:id is registered");
  assert.ok(deleteLayer.route.stack.some((layer) => layer.handle.name === "denyViewers"), "cancel route mounts denyViewers");
  const cancelHandler = deleteLayer.route.stack.at(-1).handle;
  async function cancel(id, { clientId = A, userId = actorA } = {}) {
    const response = { status: 200, body: undefined };
    const res = {
      status(code) { response.status = code; return this; },
      json(value) { response.body = value; return this; },
    };
    await cancelHandler({
      params: { id }, query: {}, body: {},
      currentUser: { id: userId, clientId, role: "client_staff" },
      log: { warn() {} },
    }, res);
    return response;
  }

  try {
    // 1. Cancellation: only the owning actor in the owning tenant can cancel,
    //    and the object is removed immediately.
    const cancelled = await stage();
    assert.equal((await cancel(cancelled.id, { userId: actorA2 })).status, 404, "another actor cannot cancel");
    assert.equal((await cancel(cancelled.id, { clientId: B, userId: actorB })).status, 404, "another tenant cannot cancel");
    assert.equal((await cancel("not-a-uuid")).status, 400);
    assert.ok(await receiptRow(cancelled.id), "rejected cancels leave the receipt");
    assert.ok(objects.has(cancelled.objectPath));
    assert.equal((await cancel(cancelled.id)).status, 200);
    assert.equal(await receiptRow(cancelled.id), undefined, "cancelled receipt removed");
    assert.equal(objects.has(cancelled.objectPath), false, "cancelled object deleted");
    assert.equal((await cancel(cancelled.id)).status, 404, "repeat cancel is a no-op");

    // A cancelled receipt can never be claimed by a create.
    const cancelledStill = await stage({ cancelled: true });
    await assert.rejects(
      createWithStagedPhotoReceipts(
        { clientId: A, entityType: "swim_session", actorId: actorA, photoUploadIds: [cancelledStill.id] },
        async () => ({ id: 1 }),
      ),
      (err) => err instanceof StagedPhotoReceiptError && err.status === 400,
    );

    // 2. Expiry: expired and cancelled receipts are swept; live ones are not.
    const expired = await stage({ expiresIn: "-1 minute" });
    const live = await stage();
    let result = await sweep();
    assert.ok(result.objectsDeleted >= 2, "expired and cancelled objects deleted");
    assert.equal(objects.has(expired.objectPath), false);
    assert.equal(objects.has(cancelledStill.objectPath), false);
    assert.equal(await receiptRow(expired.id), undefined);
    assert.ok(await receiptRow(live.id), "unexpired receipt untouched");
    assert.ok(objects.has(live.objectPath), "unexpired object untouched");

    // 3. Objects referenced by a committed record are preserved.
    const referenced = await stage({ expiresIn: "-1 minute" });
    await db.execute(sql`
      INSERT INTO check_photos (client_id, entity_type, entity_id, object_path, created_by)
      VALUES (${A}, 'swim_session', 424242, ${referenced.objectPath}, ${actorA})
    `);
    result = await sweep();
    assert.equal(result.keptReferenced, 1);
    assert.equal(await receiptRow(referenced.id), undefined, "stale receipt removed");
    assert.ok(objects.has(referenced.objectPath), "referenced object kept");

    // 4. Tenant ACL and tenant prefix: never delete another tenant's object.
    const foreignAcl = await stage({ expiresIn: "-1 minute", owner: B });
    const foreignPath = await stage({ expiresIn: "-1 minute", pathOverride: `/objects/finalized/tenant-${B}/${tag}-x.jpg` });
    result = await sweep();
    assert.equal(result.keptForeign, 2);
    assert.ok(objects.has(foreignAcl.objectPath), "object with a foreign ACL kept");
    assert.ok(objects.has(foreignPath.objectPath), "object outside tenant prefix kept");
    assert.equal(isTenantFinalizedObjectPath(`/objects/finalized/tenant-${A}/x.jpg`, A), true);
    assert.equal(isTenantFinalizedObjectPath(`/objects/finalized/tenant-${A}/../tenant-${B}/x.jpg`, A), false);
    assert.equal(isTenantFinalizedObjectPath(`/objects/uploads/tenant-${A}/x.jpg`, A), false);

    // 5. Interrupted cleanup is retried, with backoff, until complete.
    const flaky = await stage({ expiresIn: "-1 minute" });
    storageHooks.failWith = new Error("storage timeout");
    result = await sweep();
    storageHooks.failWith = null;
    assert.equal(result.failed, 1);
    let row = await receiptRow(flaky.id);
    assert.ok(row, "receipt survives a failed storage delete (rolled back)");
    assert.equal(row.cleanup_attempts, 1);
    assert.ok(new Date(row.cleanup_after) > new Date(), "failed item backs off");
    assert.ok(objects.has(flaky.objectPath));
    result = await sweep();
    assert.equal(result.examined, 0, "backed-off item is not retried immediately");
    // Crash after storage delete but before commit: the row survives and the
    // retry completes when it finds the object already gone.
    await db.execute(sql`UPDATE staged_photo_upload_receipts SET cleanup_after = now() - interval '1 second' WHERE id = ${flaky.id}::uuid`);
    storageHooks.deleteThenFail = true;
    result = await sweep();
    storageHooks.deleteThenFail = false;
    assert.equal(result.failed, 1);
    assert.ok(await receiptRow(flaky.id), "row kept when commit did not happen");
    assert.equal(objects.has(flaky.objectPath), false);
    await db.execute(sql`UPDATE staged_photo_upload_receipts SET cleanup_after = NULL WHERE id = ${flaky.id}::uuid`);
    result = await sweep();
    assert.equal(result.alreadyMissing, 1);
    assert.equal(await receiptRow(flaky.id), undefined, "retry completes the interrupted cleanup");

    // 6. Bounded batches.
    const batch = [];
    for (let i = 0; i < 5; i++) batch.push(await stage({ expiresIn: "-1 minute" }));
    result = await sweep({ limit: 2 });
    assert.equal(result.examined, 2, "one run processes at most `limit` receipts");
    result = await sweep({ limit: 10 });
    assert.equal(result.examined, 3);
    assert.ok(batch.every((item) => !objects.has(item.objectPath)));

    // 7a. Simultaneous successful create: the create holds the receipt lock
    //     while the receipt crosses its expiry. Cleanup skips the locked row;
    //     the committed record keeps its object.
    const racing = await stage({ expiresIn: "1.5 seconds" });
    const createEntered = deferred();
    const releaseCreate = deferred();
    const creating = createWithStagedPhotoReceipts(
      { clientId: A, entityType: "swim_session", actorId: actorA, photoUploadIds: [racing.id] },
      async () => {
        createEntered.resolve();
        await releaseCreate.promise;
        return { id: 515151 };
      },
    );
    await createEntered.promise;
    await sleep(1700);
    result = await sweep();
    assert.equal(result.examined, 0, "cleanup never touches a receipt being claimed");
    assert.ok(objects.has(racing.objectPath));
    // A concurrent cancel waits for the claim and then finds nothing to cancel.
    const cancelling = cancel(racing.id);
    await sleep(100);
    releaseCreate.resolve();
    await creating;
    assert.equal((await cancelling).status, 404, "cancel after a committed create is a no-op");
    assert.equal(await receiptRow(racing.id), undefined, "claimed receipt consumed by the create");
    const [photo] = await rows(sql`SELECT object_path FROM check_photos WHERE client_id = ${A} AND entity_id = 515151`);
    assert.equal(photo.object_path, racing.objectPath, "record attached the staged object");
    result = await sweep();
    assert.ok(objects.has(racing.objectPath), "committed object survives later sweeps");

    // 7b. Cleanup first: a create using a cancelled receipt waits for the
    //     cleanup transaction and then fails without inserting a record.
    const late = await stage({ cancelled: true });
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    storageHooks.beforeDelete = async () => { deleteEntered.resolve(); await releaseDelete.promise; };
    const sweeping = sweep({ receiptId: late.id });
    await deleteEntered.promise;
    let created = false;
    const lateCreate = createWithStagedPhotoReceipts(
      { clientId: A, entityType: "swim_session", actorId: actorA, photoUploadIds: [late.id] },
      async () => { created = true; return { id: 616161 }; },
    ).then(() => "ok", (err) => err);
    await sleep(150);
    releaseDelete.resolve();
    storageHooks.beforeDelete = null;
    result = await sweeping;
    assert.equal(result.objectsDeleted, 1);
    const lateOutcome = await lateCreate;
    assert.ok(lateOutcome instanceof StagedPhotoReceiptError && lateOutcome.status === 400, "create after cleanup is rejected");
    assert.equal(created, false, "no record inserted for an already-cleaned receipt");

    console.log("Staged photo cleanup tests passed (cancel, expiry, references, ACL, interruption, bounds, create races)");
  } finally {
    ObjectStorageService.prototype.deleteTenantObject = originalDelete;
    await db.execute(sql`DELETE FROM check_photos WHERE client_id IN (${A}, ${B})`);
    await db.execute(sql`DELETE FROM staged_photo_upload_receipts WHERE client_id IN (${A}, ${B})`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${actorA}, ${actorA2}, ${actorB})`);
    await db.execute(sql`DELETE FROM clients WHERE id IN (${A}, ${B})`);
    await pool.end();
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
