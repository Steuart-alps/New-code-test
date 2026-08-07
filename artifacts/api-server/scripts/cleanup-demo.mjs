import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const here   = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.dirname(here);

const entryTs = `
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
const rows = await db.delete(clientsTable).where(eq(clientsTable.slug, "complytrack-demo")).returning({ id: clientsTable.id });
if (rows.length) console.log("Deleted demo client id=" + rows[0].id + " (cascades to sites/users)");
else console.log("Nothing to delete");
process.exit(0);
`;

async function main() {
  const outDir  = await mkdtemp(path.join(os.tmpdir(), "cleanup-demo-"));
  const entryFile = path.join(outDir, "cleanup.ts");
  const outFile   = path.join(outDir, "cleanup.mjs");
  await writeFile(entryFile, entryTs);
  await build({
    entryPoints: [entryFile],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: `import { createRequire as __cr } from "node:module";\nglobalThis.require = __cr(import.meta.url);` },
    absWorkingDir: apiDir,
  });
  await import(new URL(`file://${outFile}`).href);
  try { await rm(outDir, { recursive: true, force: true }); } catch {}
}
main().catch(err => { console.error(err); process.exit(1); });
