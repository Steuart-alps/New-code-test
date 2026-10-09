import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = await mkdtemp(path.join(root, "tests/.fix-track-priority-"));
const bundle = path.join(testDir, "fix-track.test.mjs");

try {
  await build({
    entryPoints: [path.join(root, "src/pages/__tests__/fix-track.test.tsx")],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "info",
  });
  await import(pathToFileURL(bundle).href);
} finally {
  await rm(testDir, { recursive: true, force: true });
}