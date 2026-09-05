import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const workspaceDir = path.resolve(apiDir, "../..");
const outDir = await mkdtemp(path.join(testsDir, ".build-"));
const outFile = path.join(outDir, "biketrack-billing.mjs");

try {
  await build({
    entryPoints: [path.join(testsDir, "biketrack-billing.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "@google-cloud/*"],
    banner: {
      js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);",
    },
  });

  const { ADDON_KEYS, SERVICES } = await import(new URL(`file://${outFile}`).href);
  assert.deepEqual(SERVICES.biketrack, {
    label: "BikeTrack",
    amountPence: 1000,
  });
  assert.ok(ADDON_KEYS.includes("biketrack"), "BikeTrack must be accepted by billing activation routes");

  const [billingRoute, routeIndex, settingsPage] = await Promise.all([
    readFile(path.join(apiDir, "src/routes/billing.ts"), "utf8"),
    readFile(path.join(apiDir, "src/routes/index.ts"), "utf8"),
    readFile(
      path.join(workspaceDir, "artifacts/compliance-tracker/src/pages/settings.tsx"),
      "utf8",
    ),
  ]);

  assert.match(
    billingRoute,
    /Object\.entries\(SERVICES\).*key,\s*label:\s*s\.label,\s*amountPence:\s*s\.amountPence/s,
    "Billing config must expose the service catalog used by Settings",
  );
  assert.match(
    settingsPage,
    /servicesConfig\.catalog[\s\S]*handleServiceAction\(service\.key,\s*"add"\)/,
    "Settings must render catalog services with an activation action",
  );
  assert.match(
    settingsPage,
    /servicesConfig\.catalog[\s\S]*handleServiceAction\(service\.key,\s*"remove"\)/,
    "Settings must render catalog services with a deactivation action",
  );
  assert.match(
    routeIndex,
    /router\.use\("\/bike-track",\s*requireAuth,\s*requireService\("biketrack"\),\s*bikeTrackRouter\)/,
    "BikeTrack routes must remain protected by the matching service entitlement",
  );

  console.log("BikeTrack billing wiring tests passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}