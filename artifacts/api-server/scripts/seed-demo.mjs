/**
 * Bundles and runs src/scripts/seed-demo.ts against the live database.
 * Usage:  node scripts/seed-demo.mjs
 *
 * DATABASE_URL must be set in the environment (it is in Replit dev).
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const here   = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.dirname(here);

async function main() {
  const outDir  = await mkdtemp(path.join(os.tmpdir(), "seed-demo-"));
  const outFile = path.join(outDir, "seed-demo.mjs");

  await build({
    entryPoints: [path.join(apiDir, "src/scripts/seed-demo.ts")],
    bundle:      true,
    platform:    "node",
    format:      "esm",
    outfile:     outFile,
    logLevel:    "silent",
    external:    ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: {
      js: `import { createRequire as __cr } from "node:module";\nglobalThis.require = __cr(import.meta.url);`,
    },
  });

  const { default: seedDemo } = await import(new URL(`file://${outFile}`).href);
  await seedDemo();

  try { await rm(outDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
