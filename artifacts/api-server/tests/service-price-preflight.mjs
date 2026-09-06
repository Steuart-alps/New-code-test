// Focused coverage for the read-only Stripe service-price launch safeguard.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const outDir = await mkdtemp(path.join(testsDir, ".build-"));
const outFile = path.join(outDir, "service-price-preflight.mjs");

try {
  await build({
    entryPoints: [path.join(testsDir, "service-price-preflight.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
  });

  const {
    SERVICE_PRICE_CATALOGUE,
    evaluateServicePricePreflight,
    getServicePriceReadinessBlocker,
  } =
    await import(new URL(`file://${outFile}`).href);
  const required = SERVICE_PRICE_CATALOGUE.map((service) => service.key);

  const incomplete = evaluateServicePricePreflight(["core", "safetrack"]);
  assert.deepEqual(incomplete.required, required);
  assert.deepEqual(incomplete.configured, ["core", "safetrack"]);
  assert.equal(incomplete.ready, false);
  assert.deepEqual(
    incomplete.missing,
    required.filter((key) => key !== "core" && key !== "safetrack"),
    "preflight must report every missing catalogue price, not just the first one",
  );

  const complete = evaluateServicePricePreflight(required);
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.configured, required);
  assert.equal(
    getServicePriceReadinessBlocker({
      catalogueReadFailed: false,
      repairFailed: false,
      finalPreflight: incomplete,
    }),
    "Required Stripe service prices are missing",
    "remaining missing prices must keep readiness degraded",
  );
  assert.equal(
    getServicePriceReadinessBlocker({
      catalogueReadFailed: true,
      repairFailed: false,
      finalPreflight: complete,
    }),
    "Stripe service-price catalogue could not be read",
    "a catalogue read failure must never be silently marked ready",
  );
  assert.equal(
    getServicePriceReadinessBlocker({
      catalogueReadFailed: false,
      repairFailed: true,
      finalPreflight: complete,
    }),
    "Stripe service-price catalogue repair failed",
    "a failed repair must keep readiness degraded",
  );
  assert.equal(
    getServicePriceReadinessBlocker({
      catalogueReadFailed: false,
      repairFailed: false,
      finalPreflight: complete,
    }),
    null,
    "a successful repair's final complete preflight must clear the blocker",
  );

  const [adminRoute, startup, billingRoute, app] = await Promise.all([
    (await import("node:fs/promises")).readFile(path.join(apiDir, "src/routes/admin.ts"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(apiDir, "src/index.ts"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(apiDir, "src/routes/billing.ts"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(apiDir, "src/app.ts"), "utf8"),
  ]);
  assert.match(
    adminRoute,
    /router\.get\("\/api\/admin\/service-price-preflight", requireAuth, requireConsultant/,
    "the all-gap preflight must be consultant-only",
  );
  assert.match(
    adminRoute,
    /const result = await getServicePricePreflight\(\);[\s\S]*res\.status\(result\.ready \? 200 : 503\)\.json\(result\);/,
    "the admin preflight must expose readiness and all missing keys",
  );
  assert.doesNotMatch(
    adminRoute.slice(adminRoute.indexOf('router.get("/api/admin/service-price-preflight"'), adminRoute.indexOf("// One-shot demo")),
    /ensureServicePrices/,
    "the preflight must remain read-only",
  );
  assert.match(startup, /const preflight = await getServicePricePreflight\(\);/);
  assert.match(startup, /const readinessBlocker = await initStripe\(\);\s+markApplicationReady\(readinessBlocker\);/);
  assert.match(app, /status: readinessBlocker \? "degraded" : "starting"/);
  const activation = billingRoute.indexOf('if (action === "add")');
  const activationPreflight = billingRoute.indexOf("const pricePreflight = await getServicePricePreflight();");
  assert.ok(
    activationPreflight >= 0 && activationPreflight < activation,
    "a missing selected price must be rejected before subscription activation",
  );
  assert.match(
    billingRoute,
    /missingServicePrices: pricePreflight\.missing/,
    "activation failure must identify every catalogue gap for remediation",
  );

  console.log("Stripe service-price preflight tests passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}