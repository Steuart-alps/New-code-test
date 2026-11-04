// Stripe Tax settings check: which dashboard settings are reported as
// stopping UK VAT being charged on top of prices. Never contacts Stripe.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-stripe-tax-check-"));
const outFile = path.join(outDir, "stripe-tax-check.mjs");
delete process.env.STRIPE_SECRET_KEY;

try {
  await build({
    stdin: {
      contents: `export * from "./src/lib/stripeTaxCheck"; export { getReadinessDetails } from "./src/lib/readinessDetails";`,
      resolveDir: path.join(testsDir, ".."),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    packages: "external",
    plugins: [{
      // Silent stand-ins: the logger's transports and the job monitor's
      // database client cannot load from a test bundle.
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^\.\/(logger|jobMonitor)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export const logger = { info() {}, warn() {}, error() {}, debug() {} }; export const getStaleDailyJobs = () => [];",
        }));
      },
    }],
  });
  const m = await import(pathToFileURL(outFile).href);
  const gb = [{ country: "GB", status: "active" }];

  assert.deepEqual(
    m.describeStripeTaxIssues({ status: "active", defaults: { tax_behavior: "exclusive" } }, gb),
    [],
    "fully set up: nothing to report",
  );

  const all = m.describeStripeTaxIssues({ status: "pending", defaults: { tax_behavior: null } }, []);
  assert.equal(all.length, 3);
  assert.match(all[0], /head office/);
  assert.match(all[1], /Exclusive/);
  assert.match(all[2], /UK VAT registration/);

  assert.deepEqual(
    m.describeStripeTaxIssues({ status: "active", defaults: { tax_behavior: "inferred_by_currency" } }, gb),
    ["Stripe default tax behaviour is not Exclusive, so prices may be treated as including VAT"],
    "GBP prices inferred by currency would include VAT",
  );
  assert.equal(
    m.describeStripeTaxIssues(
      { status: "active", defaults: { tax_behavior: "exclusive" } },
      [{ country: "IE", status: "active" }, { country: "GB", status: "expired" }],
    ).length,
    1,
    "only an active GB registration counts",
  );

  assert.equal(await m.runStripeTaxCheck(), null, "skipped without Stripe credentials");
  assert.equal(m.getReadinessDetails().stripeTax, undefined, "no readiness note without Stripe");
  console.log("ok - stripe tax check");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
