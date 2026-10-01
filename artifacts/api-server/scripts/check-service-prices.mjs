// Read-only check of the synced catalogue: no Stripe API or app startup.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(dir, ".price-check-"));
let pool;
try {
  const bundle = path.join(temp, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "service-price-check.entry.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
  });
  const lib = await import(pathToFileURL(bundle).href);
  pool = lib.pool;
  // Every connection in this isolated process is read-only, including those
  // opened by the Drizzle query. Never run the application's seeding/repair.
  pool.options.options = "-c default_transaction_read_only=on";
  const mode = await pool.query("SHOW default_transaction_read_only");
  if (mode.rows[0]?.default_transaction_read_only !== "on") throw new Error("Read-only mode unavailable");
  const result = await lib.getServicePricePreflight();
  if (result.ready) {
    console.log(`Service-price readiness passed for ${result.required.length} services.`);
  } else {
    for (const issue of result.issues) {
      console.error(`${issue.label} (${issue.key}): ${issue.reason === "missing" ? "missing active monthly price" : "duplicate active monthly prices"}`);
    }
    process.exitCode = 1;
  }
} catch {
  console.error("Service-price readiness could not read the synced catalogue; check failed.");
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  await rm(temp, { recursive: true, force: true });
}