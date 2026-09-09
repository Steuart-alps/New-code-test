import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const workspaceDir = path.resolve(apiDir, "../..");
const outDir = await mkdtemp(path.join(testsDir, ".build-"));
const outFile = path.join(outDir, "pattrack-billing.mjs");

try {
  await build({
    entryPoints: [path.join(testsDir, "pattrack-billing.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: {
      js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);",
    },
  });

  const { ADDON_KEYS, SERVICES } = await import(new URL(`file://${outFile}`).href);
  assert.deepEqual(SERVICES.pattrack, {
    label: "PATtrack",
    amountPence: 1000,
  });
  assert.ok(ADDON_KEYS.includes("pattrack"), "PATtrack must be accepted by billing activation routes");

  const [billingRoute, routeIndex, settingsPage] = await Promise.all([
    readFile(path.join(apiDir, "src/routes/billing.ts"), "utf8"),
    readFile(path.join(apiDir, "src/routes/index.ts"), "utf8"),
    readFile(
      path.join(workspaceDir, "artifacts/compliance-tracker/src/pages/settings.tsx"),
      "utf8",
    ),
  ]);

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
    settingsPage,
    /apiFetch\("\/billing\/refresh-access",\s*\{\s*method:\s*"POST"\s*\}\)/,
    "Settings must refresh access immediately after changing a service",
  );
  assert.match(
    billingRoute,
    /invalidateEntitlements\(clientId\);\s*const entitled = await getEntitledServices\(clientId\);/,
    "Billing changes must invalidate cached entitlements before returning",
  );
  assert.match(
    routeIndex,
    /router\.use\("\/pat-track",\s*requireAuth,\s*requireService\("pattrack"\),\s*patTrackRouter\)/,
    "PATtrack routes must remain protected by the PATtrack entitlement",
  );

  console.log("PATtrack billing wiring tests passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}