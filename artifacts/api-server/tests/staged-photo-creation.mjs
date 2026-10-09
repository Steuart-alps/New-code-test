import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-staged-photo-creation-"));
try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "staged-photo-creation.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "sharp", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
  });
  const {
    db, photosRouter, greenTrackRouter, swimTrackRouter,
    ObjectContentError, ObjectGenerationError, ObjectNotFoundError, ObjectOwnershipError,
    ObjectStorageService, hasTenantAttachmentReference, isTenantReservedObjectPath,
    parsePhotoUploadIds, STAGED_PHOTO_ENTITY_TYPES, TENANT_ATTACHMENT_REFERENCE_SOURCES,
  } = await import(outfile);

  function queryParts(query) {
    let text = "";
    const params = [];
    function visit(chunk) {
      if (Array.isArray(chunk)) {
        for (const item of chunk) visit(item);
      } else if (chunk && Array.isArray(chunk.queryChunks)) {
        visit(chunk.queryChunks);
      } else if (chunk && Array.isArray(chunk.value)) {
        text += chunk.value.join("");
      } else if (typeof chunk === "string" || typeof chunk === "number" || typeof chunk === "boolean") {
        params.push(chunk);
        text += "?";
      }
    }
    visit(query);
    return { text: text.replace(/\s+/g, " ").trim().toLowerCase(), params };
  }

  const cloneState = (source) => ({
    requirements: new Map([...source.requirements].map(([key, value]) => [key, { ...value }])),
    receipts: new Map([...source.receipts].map(([key, value]) => [key, { ...value }])),
    photos: source.photos.map((photo) => ({ ...photo })),
    records: source.records.map((record) => ({ ...record })),
    stagedInsert: [],
  });
  let state = {
    requirements: new Map(),
    receipts: new Map(),
    photos: [],
    records: [],
    stagedInsert: [],
  };
  let nextRecordId = 1;
  let failTable = null;
  let settingsPause = null;
  const lockTails = new Map();

  async function acquireLock(key) {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    lockTails.set(key, previous.then(() => current));
    await previous;
    return release;
  }

  async function executeAgainst(local, query, refreshAfterLock = () => {}) {
    const { text, params } = queryParts(query);
    if (text.includes("pg_advisory_xact_lock")) {
      const unlock = await acquireLock(String(params[0]));
      refreshAfterLock();
      return { rows: [], unlock };
    }
    if (text.includes("from photo_requirements")) {
      const row = local.requirements.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (text.startsWith("select ") && text.includes("from staged_photo_upload_receipts")) {
      return {
        rows: params
          .map((id) => local.receipts.get(String(id).toLowerCase()))
          .filter(Boolean)
          .map((receipt) => ({
            ...receipt,
            unexpired: new Date(receipt.expires_at).getTime() > Date.now(),
          })),
      };
    }
    if (text.startsWith("update staged_photo_upload_receipts")) {
      const rows = [];
      for (const id of params) {
        const receipt = local.receipts.get(String(id).toLowerCase());
        if (receipt && !receipt.claimed) {
          receipt.claimed = true;
          rows.push({ id: receipt.id });
        }
      }
      return { rows };
    }
    if (text.startsWith("delete from staged_photo_upload_receipts")) {
      for (const id of params) local.receipts.delete(String(id).toLowerCase());
      return { rows: [] };
    }
    if (text.startsWith("insert into check_photos")) {
      local.photos.push({
        client_id: Number(params[0]), entity_type: params[1],
        entity_id: Number(params[2]), object_path: params[3], created_by: Number(params[4]),
      });
      return { rows: [] };
    }
    if (text.startsWith("insert into photo_requirements")) {
      if (settingsPause) {
        settingsPause.enter();
        await settingsPause.wait;
      }
      const key = `${params[0]}:${params[1]}`;
      local.requirements.set(key, {
        client_id: Number(params[0]), entity_type: params[1],
        required: Boolean(params[2]), min_photos: Number(params[3]),
      });
      return { rows: [] };
    }
    if (text.startsWith("insert into staged_photo_upload_receipts")) {
      const [id, clientId, entityType, actorId, objectPath] = params;
      const key = String(id).toLowerCase();
      if (local.receipts.has(key)) {
        const error = new Error("duplicate receipt");
        error.code = "23505";
        throw error;
      }
      const receipt = {
        id: key, client_id: Number(clientId), entity_type: entityType,
        actor_id: Number(actorId), object_path: objectPath,
        expires_at: new Date(Date.now() + 60_000), claimed: false,
      };
      local.receipts.set(key, receipt);
      return { rows: [] };
    }
    const insertTable = text.match(/^insert into ([a-z_]+)/)?.[1];
    if (insertTable && [
      "green_pre_use_checks", "green_service_records", "green_defects",
      "swim_sessions", "swim_surveillance_checks", "swim_first_aid_checks", "swim_incidents",
    ].includes(insertTable)) {
      if (failTable === insertTable) throw new Error("intentional create failure");
      const record = { id: nextRecordId++, table: insertTable };
      local.records.push(record);
      return { rows: [record] };
    }
    if (text.startsWith("select id from green_machines")) return { rows: [{ id: 42 }] };
    return { rows: [] };
  }

  const original = {
    execute: db.execute,
    transaction: db.transaction,
    finalize: ObjectStorageService.prototype.finalizeVerifiedTenantUpload,
    discard: ObjectStorageService.prototype.discardTenantUpload,
    delete: ObjectStorageService.prototype.deleteTenantObject,
  };
  db.execute = async (query) => executeAgainst(state, query);
  db.transaction = async (callback) => {
    let local = cloneState(state);
    const locks = [];
    const tx = {
      execute: async (query) => {
        const result = await executeAgainst(local, query, () => { local = cloneState(state); });
        if (result.unlock) locks.push(result.unlock);
        return result;
      },
    };
    try {
      const result = await callback(tx);
      state = local;
      return result;
    } finally {
      for (const unlock of locks.reverse()) unlock();
    }
  };

  function routeHandler(router, method, routePath) {
    const route = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]);
    assert.ok(route, `${method.toUpperCase()} ${routePath} is registered`);
    return route.route.stack.at(-1).handle;
  }
  async function invoke(handler, { body = {}, query = {}, params = {}, userId = 1, role = "client_admin" } = {}) {
    const req = {
      body, query, params,
      currentUser: { id: userId, clientId: 7, role, departmentId: null },
      user: { id: userId },
    };
    const response = { status: 200, body: undefined };
    const res = {
      status(code) { response.status = code; return this; },
      json(value) { response.body = value; return this; },
    };
    await handler(req, res);
    return response;
  }

  const routeCases = [
    { type: "green_pre_use_check", router: greenTrackRouter, path: "/pre-use-checks", body: { machineId: 42, checkDate: "2026-01-01" }, table: "green_pre_use_checks" },
    { type: "green_service", router: greenTrackRouter, path: "/service-records", body: { machineId: 42, serviceDate: "2026-01-01" }, table: "green_service_records" },
    { type: "green_defect", router: greenTrackRouter, path: "/defects", body: { machineId: 42, description: "Fixture defect" }, table: "green_defects" },
    { type: "swim_session", router: swimTrackRouter, path: "/sessions", body: { sessionDate: "2026-01-01" }, table: "swim_sessions" },
    { type: "swim_surveillance_check", router: swimTrackRouter, path: "/surveillance", body: { checkDate: "2026-01-01" }, table: "swim_surveillance_checks" },
    { type: "swim_first_aid_check", router: swimTrackRouter, path: "/first-aid", body: { checkDate: "2026-01-01" }, table: "swim_first_aid_checks" },
    { type: "swim_incident", router: swimTrackRouter, path: "/incidents", body: { incidentDate: "2026-01-01", description: "Fixture incident" }, table: "swim_incidents" },
  ].map((item) => ({ ...item, handler: routeHandler(item.router, "post", item.path) }));

  assert.deepEqual(STAGED_PHOTO_ENTITY_TYPES, routeCases.map(({ type }) => type));
  assert.equal(parsePhotoUploadIds(undefined).length, 0);
  assert.throws(() => parsePhotoUploadIds(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"]), /unique/);
  assert.throws(() => parsePhotoUploadIds(Array(11).fill("00000000-0000-4000-8000-000000000001")), /at most 10/);

  try {
    // Legacy creation stays optional when the manager has not enabled a rule.
    for (const item of routeCases) {
      const response = await invoke(item.handler, { body: { ...item.body } });
      assert.equal(response.status, 201, `${item.type} remains optional without a requirement`);
      assert.equal(response.body.table, item.table);
    }
    assert.equal(state.photos.length, 0, "no photo attachment is synthesized from a direct body path");
    for (const item of routeCases) {
      const directPath = await invoke(item.handler, {
        body: { ...item.body, objectPath: "/objects/finalized/tenant-7/forged" },
      });
      assert.equal(directPath.status, 400, "create rejects direct object paths");
      state.requirements.set(`7:${item.type}`, { required: true, min_photos: 1 });
      const blocked = await invoke(item.handler, {
        body: { ...item.body, objectPath: "/objects/finalized/tenant-7/forged" },
      });
      assert.equal(blocked.status, 400, `${item.type} rejects direct paths under strict photo rules`);
    }
    assert.equal(state.records.length, 7, "direct-path and missing-photo errors insert no parent records");

    const makeReceipt = (type, id, values = {}) => {
      state.receipts.set(id.toLowerCase(), {
        id: id.toLowerCase(), client_id: 7, entity_type: type, actor_id: 1,
        object_path: `/objects/finalized/tenant-7/${id}`, expires_at: new Date(Date.now() + 60_000),
        claimed: false, ...values,
      });
    };
    for (const [index, item] of routeCases.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      makeReceipt(item.type, id);
      const response = await invoke(item.handler, { body: { ...item.body, photoUploadIds: [id] } });
      assert.equal(response.status, 201, `${item.type} accepts a matching verified receipt`);
      const photo = state.photos.at(-1);
      assert.equal(photo.entity_type, item.type);
      assert.equal(photo.entity_id, response.body.id);
      assert.equal(photo.created_by, 1);
      assert.equal(state.receipts.has(id), false, `${item.type} atomically removes the claimed receipt`);
    }

    // minPhotos is enforced rather than treating required as exactly one.
    state.requirements.set("7:swim_incident", { required: true, min_photos: 2 });
    const incident = routeCases.find((item) => item.type === "swim_incident");
    const oneId = "00000000-0000-4000-8000-000000000020";
    makeReceipt("swim_incident", oneId);
    let response = await invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [oneId] } });
    assert.equal(response.status, 422, "minimum of two rejects one verified receipt");
    const twoA = "00000000-0000-4000-8000-000000000021";
    const twoB = "00000000-0000-4000-8000-000000000022";
    makeReceipt("swim_incident", twoA);
    makeReceipt("swim_incident", twoB);
    response = await invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [twoA, twoB] } });
    assert.equal(response.status, 201, "minimum of two accepts exactly two verified receipts");
    assert.equal(state.photos.filter((photo) => photo.entity_type === "swim_incident").length, 3);

    state.requirements.set("7:swim_incident", { required: true, min_photos: 1 });
    const invalidCases = [
      { name: "wrong tenant", id: "00000000-0000-4000-8000-000000000030", row: { client_id: 8 }, status: 403 },
      { name: "wrong type", id: "00000000-0000-4000-8000-000000000031", row: { entity_type: "swim_session" }, status: 400 },
      { name: "wrong actor", id: "00000000-0000-4000-8000-000000000032", row: { actor_id: 2 }, status: 403 },
      { name: "expired receipt", id: "00000000-0000-4000-8000-000000000033", row: { expires_at: new Date("2000-01-01T00:00:00Z") }, status: 400 },
    ];
    for (const item of invalidCases) {
      makeReceipt("swim_incident", item.id, item.row);
      response = await invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [item.id] } });
      assert.equal(response.status, item.status, `${item.name} receipt rejected with ${item.status}`);
    }
    const replayId = twoA;
    response = await invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [replayId, twoB] } });
    assert.equal(response.status, 400, "a previously claimed receipt cannot be replayed");

    // A failed original insert rolls back both the claim and check_photos row.
    const rollbackId = "00000000-0000-4000-8000-000000000040";
    const rollbackId2 = "00000000-0000-4000-8000-000000000041";
    makeReceipt("swim_incident", rollbackId);
    makeReceipt("swim_incident", rollbackId2);
    const beforeRollbackPhotos = state.photos.length;
    const beforeRollbackRecords = state.records.length;
    failTable = "swim_incidents";
    response = await invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [rollbackId, rollbackId2] } });
    assert.equal(response.status, 500, "original create failure remains an API error");
    assert.equal(state.receipts.has(rollbackId), true, "receipt claim rolled back with the record");
    assert.equal(state.photos.length, beforeRollbackPhotos, "photo row rolled back with the record");
    assert.equal(state.records.length, beforeRollbackRecords, "failed create inserted no record");
    failTable = null;

    // Concurrent claims serialize on receipt row locks: exactly one create can win.
    state.requirements.set("7:swim_incident", { required: true, min_photos: 1 });
    const concurrentId = "00000000-0000-4000-8000-000000000050";
    makeReceipt("swim_incident", concurrentId);
    const pair = await Promise.all([
      invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [concurrentId] } }),
      invoke(incident.handler, { body: { ...incident.body, photoUploadIds: [concurrentId] } }),
    ]);
    assert.deepEqual(pair.map((result) => result.status).sort(), [201, 400]);

    // PUT requirements is manager-only, and it shares the absent-row advisory
    // lock with create so a simultaneous enable cannot be missed.
    const putRequirements = photosRouter.stack
      .find((layer) => layer.route?.path === "/requirements" && layer.route.methods.put)
      .route.stack;
    const settingsFinal = putRequirements.at(-1).handle;
    response = await invoke(putRequirements.at(-2).handle, { body: [], role: "client_staff" });
    assert.equal(response.status, 403, "ordinary staff cannot disable or weaken photo rules");
    state.requirements.delete("7:swim_session");
    let enterSettings;
    let finishSettings;
    const settingsEntered = new Promise((resolve) => { enterSettings = resolve; });
    const settingsWait = new Promise((resolve) => { finishSettings = resolve; });
    settingsPause = { enter: enterSettings, wait: settingsWait };
    const settingUpdate = invoke(settingsFinal, {
      body: [{ entityType: "swim_session", required: true, minPhotos: 1 }],
    });
    await settingsEntered;
    let createFinished = false;
    const racingCreate = invoke(routeCases.find((item) => item.type === "swim_session").handler, {
      body: { sessionDate: "2026-01-01" },
    }).then((result) => { createFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(createFinished, false, "create waits for an in-flight requirement update");
    finishSettings();
    await settingUpdate;
    settingsPause = null;
    response = await racingCreate;
    assert.equal(response.status, 422, "create sees the serialized newly enabled requirement");

    // The staged-finalization endpoint refuses foreign tenant paths before
    // storage verification and maps invalid image bytes like existing photos.
    const stagedHandler = routeHandler(photosRouter, "post", "/staged");
    let finalizedCount = 0;
    ObjectStorageService.prototype.discardTenantUpload = async () => {};
    ObjectStorageService.prototype.deleteTenantObject = async () => {};
    ObjectStorageService.prototype.finalizeVerifiedTenantUpload = async function(path, tenantId, allowed) {
      finalizedCount++;
      assert.equal(tenantId, 7);
      assert.deepEqual([...allowed].sort(), ["image/jpeg", "image/png"]);
      if (path.endsWith("invalid")) throw new ObjectContentError();
      if (path.endsWith("missing")) throw new ObjectNotFoundError();
      if (path.endsWith("changed")) throw new ObjectGenerationError();
      return { objectPath: "/objects/finalized/tenant-7/staged-copy", contentType: "image/png" };
    };
    response = await invoke(stagedHandler, {
      body: { entityType: "swim_incident", objectPath: "/objects/uploads/tenant-8/foreign" },
    });
    assert.equal(response.status, 403, "staged finalization rejects a wrong tenant path");
    assert.equal(finalizedCount, 0, "wrong tenant path never reaches storage verification");
    for (const [suffix, expectedStatus] of [["invalid", 400], ["missing", 404], ["changed", 409]]) {
      response = await invoke(stagedHandler, {
        body: { entityType: "swim_incident", objectPath: `/objects/uploads/tenant-7/${suffix}` },
      });
      assert.equal(response.status, expectedStatus, `storage ${suffix} error retains current photo API semantics`);
    }
    response = await invoke(stagedHandler, {
      body: { entityType: "swim_incident", objectPath: "/objects/uploads/tenant-7/valid" },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.objectPath, "/objects/finalized/tenant-7/staged-copy");
    assert.equal(state.receipts.get(response.body.id)?.actor_id, 1, "receipt binds the authenticated actor");

    assert.equal(isTenantReservedObjectPath("/objects/uploads/tenant-7/path", 7), true);
    assert.equal(isTenantReservedObjectPath("/objects/uploads/tenant-8/path", 7), false);
    assert.ok(TENANT_ATTACHMENT_REFERENCE_SOURCES.includes("staged_photo_upload_receipts.object_path"));
    assert.equal(
      await hasTenantAttachmentReference(
        { execute: async () => ({ rows: [{ referenced: true }] }) },
        7,
        "/objects/finalized/tenant-7/pending",
      ),
      true,
      "pending staged objects are retained by shared attachment reference checks",
    );
    console.log("Atomic staged photo create and receipt regression tests passed");
  } finally {
    db.execute = original.execute;
    db.transaction = original.transaction;
    ObjectStorageService.prototype.finalizeVerifiedTenantUpload = original.finalize;
    ObjectStorageService.prototype.discardTenantUpload = original.discard;
    ObjectStorageService.prototype.deleteTenantObject = original.delete;
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}