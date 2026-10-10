import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-storage-usage-"));

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "storage-usage.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    external: ["@google-cloud/*", "sharp", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);" },
  });
  const { listOwnedObjectMetadata, sumOwnedObjectMetadata } = await import(outfile);

  const fakeFile = (name, size, policy) => ({
    name,
    getMetadata: async () => [{
      size: String(size),
      metadata: policy === undefined
        ? {}
        : { "custom:aclPolicy": typeof policy === "string" ? policy : JSON.stringify(policy) },
    }],
  });
  const tenant = { owner: "7", visibility: "private" };
  const files = [
    fakeFile("private/uploads/tenant-7/current", 100, tenant),
    fakeFile("private/finalized/tenant-7/verified", 200, tenant),
    fakeFile("private/legacy/unscoped", 300, tenant),
    fakeFile("private/uploads/tenant-8/foreign", 400, { owner: "8", visibility: "private" }),
    fakeFile("private/uploads/tenant-7/public", 500, { owner: "7", visibility: "public" }),
    fakeFile("private/uploads/tenant-7/unowned", 600, undefined),
    fakeFile("private/uploads/tenant-7/malformed", 700, "not-json"),
    fakeFile("private/uploads/tenant-7/invalid-size", "unknown", tenant),
    fakeFile("private/legacy/unscoped", 300, tenant),
  ];

  assert.deepEqual(
    await sumOwnedObjectMetadata(files, 7),
    { usedBytes: 600, objectCount: 3 },
    "current, verified, and legacy tenant objects are counted once; foreign, public, unowned, malformed, and invalid objects are excluded",
  );

  // Provider listings already carry metadata: reconciliation must reuse it
  // rather than issue one metadata request per object.
  let metadataRequests = 0;
  const listedFile = (name, size, policy) => ({
    name,
    metadata: { size: String(size), metadata: { "custom:aclPolicy": JSON.stringify(policy) } },
    getMetadata: async () => { metadataRequests += 1; throw new Error("listing metadata should be reused"); },
  });
  const missingLegacy = {
    name: "private/legacy/deleted",
    getMetadata: async () => { throw Object.assign(new Error("No such object"), { code: 404 }); },
  };
  assert.deepEqual(
    await listOwnedObjectMetadata([
      { objectPath: "/objects/finalized/tenant-7/a", file: listedFile("private/finalized/tenant-7/a", 10, tenant) },
      { objectPath: "/objects/finalized/tenant-7/a", file: listedFile("private/finalized/tenant-7/a", 10, tenant) },
      { objectPath: "/objects/uploads/tenant-7/b", file: listedFile("private/uploads/tenant-7/b", 20, { owner: "8", visibility: "private" }) },
      { objectPath: "/objects/legacy/deleted", file: missingLegacy },
      { objectPath: "/objects/legacy/unscoped", file: fakeFile("private/legacy/unscoped", 30, tenant) },
    ], 7),
    [
      { objectPath: "/objects/finalized/tenant-7/a", sizeBytes: 10 },
      { objectPath: "/objects/legacy/unscoped", sizeBytes: 30 },
    ],
    "listed metadata is reused, paths are counted once, and foreign or deleted legacy objects are excluded",
  );
  assert.equal(metadataRequests, 0, "no per-object metadata request for listed objects");
  await assert.rejects(
    listOwnedObjectMetadata([{ objectPath: "/objects/legacy/x", file: { name: "x", getMetadata: async () => { throw Object.assign(new Error("denied"), { code: 403 }); } } }], 7),
    /denied/,
    "provider errors other than not-found fail the reconciliation instead of under-counting",
  );
  console.log("storage usage metadata accounting passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}