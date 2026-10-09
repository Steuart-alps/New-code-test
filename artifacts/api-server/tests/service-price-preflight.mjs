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
    addonPurchaseAvailability,
    ADDON_KEYS,
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
  assert.deepEqual(complete.duplicates, []);
  assert.deepEqual(complete.issues, []);
  const duplicate = evaluateServicePricePreflight([...required, "pattrack"]);
  assert.equal(duplicate.ready, false, "duplicate active prices must fail readiness");
  assert.deepEqual(duplicate.duplicates, ["pattrack"]);
  assert.ok(!duplicate.configured.includes("pattrack"), "an ambiguous price is not selectable");
  assert.deepEqual(duplicate.issues, [{ key: "pattrack", label: "PATtrack", reason: "duplicate" }]);
  const mixed = evaluateServicePricePreflight([...required.filter((key) => key !== "doctrack"), "fixtrack"]);
  assert.deepEqual(mixed.missing, ["doctrack"]);
  assert.deepEqual(mixed.duplicates, ["fixtrack"]);
  assert.deepEqual(mixed.issues.map(({ label, reason }) => [label, reason]), [
    ["FixTrack", "duplicate"], ["DocTrack", "missing"],
  ]);
  assert.equal(evaluateServicePricePreflight([...required, "unrelated", "unrelated"]).ready, true);
  assert.deepEqual(evaluateServicePricePreflight([]).missing, required);
  assert.equal(getServicePriceReadinessBlocker({
    catalogueReadFailed: false, repairFailed: false, finalPreflight: duplicate,
  }), "Required Stripe service prices are duplicated");
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

  // Client-facing add-on availability reuses the activation preflight.
  assert.deepEqual(addonPurchaseAvailability(complete), { checked: true, unavailable: [] });
  assert.deepEqual(addonPurchaseAvailability(mixed), { checked: true, unavailable: ["fixtrack", "doctrack"].sort((a, b) => ADDON_KEYS.indexOf(a) - ADDON_KEYS.indexOf(b)) },
    "missing and duplicate add-on prices are both unpurchasable");
  const legacyPoolLost = evaluateServicePricePreflight(required.filter((key) => key !== "pooltrack" && key !== "core" && key !== "bundle"));
  assert.deepEqual(addonPurchaseAvailability(legacyPoolLost), { checked: true, unavailable: ["pooltrack"] },
    "only add-on keys are reported; legacy PoolTrack is reported rather than dropped");
  assert.deepEqual(addonPurchaseAvailability(null), { checked: false, unavailable: [] },
    "an unread catalogue is reported as unchecked, never as fully available");

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
  assert.match(billingRoute, /duplicateServicePrices: pricePreflight\.duplicates/);
  assert.match(billingRoute, /action === "add" &&[\s\S]*pricePreflight\.duplicates\.includes\(service\)/,
    "ambiguity must block additions, not removals");
  const configRoute = billingRoute.slice(billingRoute.indexOf('router.get("/config"'), billingRoute.indexOf('router.get("/plans"'));
  assert.match(configRoute, /addonPurchaseAvailability\(await getServicePricePreflight\(\)\)/,
    "Settings availability must come from the same preflight activation enforces");
  assert.match(configRoute, /addonAvailability,/);
  const servicesSource = await (await import("node:fs/promises")).readFile(path.join(apiDir, "src/lib/services.ts"), "utf8");
  const liveQuery = servicesSource.slice(servicesSource.indexOf("async function listLiveMonthlyPriceServiceKeys"), servicesSource.indexOf("export type Entitlements"));
  assert.doesNotMatch(liveQuery, /SELECT DISTINCT/, "live prices must retain duplicates");
  assert.match(liveQuery, /p\.active = true[\s\S]*pr\.active = true/);
  assert.match(liveQuery, /interval'\) = 'month'/);
  assert.match(liveQuery, /interval_count', '1'\) = '1'/);
  assert.doesNotMatch(liveQuery, /\b(?:INSERT|UPDATE|DELETE)\b/,
    "catalogue checks must only read the database");
  const cli = await (await import("node:fs/promises")).readFile(path.join(apiDir, "scripts/check-service-prices.mjs"), "utf8");
  assert.match(cli, /default_transaction_read_only=on/);
  assert.match(cli, /process\.exitCode = 1/);
  assert.doesNotMatch(cli, /ensureServicePrices|initStripe|subscriptions\.|invoices\./);

  console.log("Stripe service-price preflight tests passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}