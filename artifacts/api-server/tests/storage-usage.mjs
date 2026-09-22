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
  const { sumOwnedObjectMetadata } = await import(outfile);

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
  console.log("storage usage metadata accounting passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}