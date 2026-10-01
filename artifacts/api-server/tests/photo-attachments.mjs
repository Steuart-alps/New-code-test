// Focused self-contained storage/route-guard coverage for GreenTrack and
// SwimTrack photo attachments. The compiled entry is placed beneath this API
// package so Node resolves @google-cloud/storage from the workspace instead of
// a temporary directory outside its node_modules tree. This suite stubs every
// storage operation and does not require live object storage.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { deflateSync } from "node:zlib";
import { getStorageUnavailableSkipReason } from "./storage-test-availability.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-photo-attachments-"));
try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "photo-attachments.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "sharp", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
  });
  const {
    ObjectContentError, ObjectGenerationError, ObjectNotFoundError, ObjectOwnershipError,
    ObjectStorageService, PHOTO_ENTITY_TABLES, db, detectUploadType,
    hasTenantAttachmentReference, isSupportedPhotoEntityType, isTenantReservedObjectPath,
    photosRouter, TENANT_ATTACHMENT_REFERENCE_SOURCES, validateUploadContent,
  } = await import(outfile);

  assert.match(
    getStorageUnavailableSkipReason(
      {
        status: 503,
        data: {
          error: "File uploads are temporarily unavailable. Please try again later.",
          code: "OBJECT_STORAGE_UNAVAILABLE",
        },
      },
      "fixture",
    ) ?? "",
    /requires object storage/,
    "recognized upload-signing outages can be skipped explicitly",
  );
  assert.equal(
    getStorageUnavailableSkipReason(
      { status: 500, data: { error: "Unexpected database failure" } },
      "fixture",
    ),
    null,
    "unrelated server failures remain test failures",
  );
  assert.equal(
    getStorageUnavailableSkipReason(
      {
        status: 503,
        data: { error: "File uploads are temporarily unavailable. Please try again later." },
      },
      "fixture",
    ),
    null,
    "responses without the stable storage error code remain test failures",
  );

  // Both modules' record types are explicitly bound to their real tenant tables.
  assert.equal(PHOTO_ENTITY_TABLES.green_pre_use_check, "green_pre_use_checks");
  assert.equal(PHOTO_ENTITY_TABLES.green_service, "green_service_records");
  assert.equal(PHOTO_ENTITY_TABLES.green_defect, "green_defects");
  assert.equal(PHOTO_ENTITY_TABLES.swim_session, "swim_sessions");
  assert.equal(PHOTO_ENTITY_TABLES.swim_surveillance_check, "swim_surveillance_checks");
  assert.equal(PHOTO_ENTITY_TABLES.swim_first_aid_check, "swim_first_aid_checks");
  assert.equal(PHOTO_ENTITY_TABLES.swim_incident, "swim_incidents");
  assert.equal(PHOTO_ENTITY_TABLES.food_safety_check, "food_safety_records");
  assert.equal(PHOTO_ENTITY_TABLES.bike_hire, "bike_hire_records");
  assert.equal(PHOTO_ENTITY_TABLES.bike_check, "bike_checks");
  assert.equal(PHOTO_ENTITY_TABLES.safe_risk_assessment, "safe_risk_assessments");
  assert.equal(PHOTO_ENTITY_TABLES.safe_sop, "safe_sops");
  assert.equal(PHOTO_ENTITY_TABLES.safe_handbook, "safe_handbook");
  assert.equal(PHOTO_ENTITY_TABLES.safe_training_record, "safe_training_records");
  assert.equal(PHOTO_ENTITY_TABLES.safe_induction, "safe_inductions");
  assert.equal(isSupportedPhotoEntityType("other_tenants_table"), false);
  assert.deepEqual(
    [...TENANT_ATTACHMENT_REFERENCE_SOURCES],
    [
      "doc_track_documents.object_path",
      "safe_risk_assessments.object_path",
      "safe_sops.object_path",
      "safe_handbook.object_path",
      "site_documents.object_path",
      "client_documents.object_path",
      "contractor_certificates.object_path",
      "certificates.file_url",
      "check_photos.object_path",
      "staged_photo_upload_receipts.object_path",
      "fix_track_issues.media_urls",
      "fix_track_issues.completion_document_path",
      "fix_track_action_tokens.completion_object_path",
    ],
    "global registry covers every persisted attachment source",
  );
  assert.equal(
    await hasTenantAttachmentReference(
      { execute: async () => ({ rows: [{ referenced: true }] }) },
      7,
      "/objects/finalized/tenant-7/cross-table",
    ),
    true,
    "cross-table references retain the backing object",
  );

  // A tenant cannot finalise another tenant's object path.
  assert.equal(isTenantReservedObjectPath("/objects/uploads/tenant-7/photo", 7), true);
  assert.equal(isTenantReservedObjectPath("/objects/uploads/tenant-8/photo", 7), false);
  assert.equal(isTenantReservedObjectPath("/objects/uploads/photo", 7), false);
  assert.equal(new ObjectNotFoundError().name, "ObjectNotFoundError", "missing uploads have a distinct error");
  assert.equal(new ObjectOwnershipError().name, "ObjectOwnershipError", "cross-tenant paths have a distinct error");

  const jpeg = Buffer.from([
    0xff,0xd8,
    0xff,0xc0, 0,11, 8, 0,1, 0,1, 1, 1,0x11,0,
    0xff,0xd9,
  ]);
  const png = Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0,1, 0,0,0,1, 8,2,0,0,0, 0,0,0,0,
    0,0,0,0, 0x49,0x45,0x4e,0x44, 0,0,0,0,
  ]);
  assert.equal(detectUploadType(jpeg), "image/jpeg", "a real JPEG can be finalised");
  assert.equal(detectUploadType(png), "image/png", "a real PNG can be finalised");
  assert.equal(detectUploadType(Buffer.from("<html>spoofed image</html>")), null, "HTML is rejected despite image metadata");
  assert.equal(detectUploadType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2])), null, "a JPEG prefix alone is rejected");
  assert.equal(new ObjectContentError().name, "ObjectContentError", "spoofed object errors are distinct for cleanup");
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, body) {
    const typeBytes = Buffer.from(type);
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    typeBytes.copy(out, 4);
    body.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), body.length + 8);
    return out;
  }
  function realPng(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
  assert.equal((await validateUploadContent(realPng(1, 1), new Set(["image/png"]))).contentType, "image/png", "decoded PNG accepted");
  await assert.rejects(
    validateUploadContent(realPng(12_001, 1), new Set(["image/png"])),
    ObjectContentError,
    "oversized image dimensions rejected",
  );

  function handler(method, routePath) {
    const layer = photosRouter.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
    return layer.route.stack.at(-1).handle;
  }
  async function invoke(fn, { body = {}, query = {}, params = {} } = {}) {
    const req = {
      body, query, params,
      currentUser: { id: 1, clientId: 7, role: "client_admin" },
      user: { id: 1 },
    };
    const state = { status: 200, body: undefined };
    const res = {
      status(code) { state.status = code; return this; },
      json(value) { state.body = value; return this; },
    };
    await fn(req, res);
    return state;
  }
  const originalExecute = db.execute;
  const originalTransaction = db.transaction;
  const proto = ObjectStorageService.prototype;
  const originals = {
    finalizeVerifiedTenantUpload: proto.finalizeVerifiedTenantUpload,
    discardTenantUpload: proto.discardTenantUpload,
    deleteTenantObject: proto.deleteTenantObject,
  };
  try {
    const list = handler("get", "/");
    db.execute = async () => ({ rows: [{ id: 44 }] });
    let response = await invoke(list, { query: { entityType: "green_pre_use_check", entityId: "44" } });
    assert.equal(response.status, 200, "owned GreenTrack record photos list");
    db.execute = async () => ({ rows: [] });
    response = await invoke(list, { query: { entityType: "swim_session", entityId: "99" } });
    assert.equal(response.status, 404, "missing or foreign SwimTrack parent does not disclose photos");

    const save = handler("post", "/");
    let calls = [];
    proto.finalizeVerifiedTenantUpload = async function(objectPath, tenantId, allowed) {
      calls.push(["finalize", objectPath, tenantId, [...allowed]]);
      return { objectPath: "/objects/finalized/tenant-7/immutable", contentType: "image/png" };
    };
    proto.discardTenantUpload = async () => {};
    db.execute = async () => ({ rows: [{ id: 1 }] });
    response = await invoke(save, { body: {
      entityType: "swim_incident", entityId: 1,
      objectPath: "/objects/uploads/tenant-7/staging",
    } });
    assert.equal(response.status, 201);
    assert.deepEqual(calls, [["finalize", "/objects/uploads/tenant-7/staging", 7, ["image/jpeg", "image/png"]]], "generation-bound immutable finalisation is used");

    response = await invoke(save, { body: {
      entityType: "green_defect", entityId: 1,
      objectPath: "/objects/uploads/tenant-8/foreign",
    } });
    assert.equal(response.status, 403, "foreign tenant staging path rejected before verification");

    proto.finalizeVerifiedTenantUpload = async () => { throw new ObjectGenerationError(); };
    response = await invoke(save, { body: {
      entityType: "swim_session", entityId: 1,
      objectPath: "/objects/uploads/tenant-7/swapped",
    } });
    assert.equal(response.status, 409, "generation swap is rejected");
    proto.finalizeVerifiedTenantUpload = async () => { throw new ObjectNotFoundError(); };
    response = await invoke(save, { body: {
      entityType: "green_service", entityId: 1,
      objectPath: "/objects/uploads/tenant-7/missing",
    } });
    assert.equal(response.status, 404, "missing staged object is rejected");

    const remove = handler("delete", "/:id");
    let deletedObjects = 0;
    proto.deleteTenantObject = async () => { deletedObjects++; };
    let sequence = [[{ object_path: "/objects/final/tenant-7/orphan" }], [], [], [{ referenced: false }]];
    db.transaction = async (callback) => callback({
      execute: async () => ({ rows: sequence.shift() ?? [] }),
    });
    response = await invoke(remove, { params: { id: "5" } });
    assert.equal(response.status, 200, "photo remains deletable after parent deletion");
    assert.equal(deletedObjects, 1, "unreferenced backing object deleted");
    sequence = [[{ object_path: "/objects/final/tenant-7/shared" }], [], [], [{ referenced: true }]];
    await invoke(remove, { params: { id: "6" } });
    assert.equal(deletedObjects, 1, "cross-table shared backing object retained");
  } finally {
    db.execute = originalExecute;
    db.transaction = originalTransaction;
    Object.assign(proto, originals);
  }
  console.log("GreenTrack and SwimTrack photo attachment guards passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}