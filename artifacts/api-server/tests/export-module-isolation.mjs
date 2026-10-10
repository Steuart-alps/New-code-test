// Regression test: one failing dataset query must not cut short the rest of a
// client's full data export (GET /api/export). Drives the route's own writer
// and summary helpers with a staff-roster query that fails part-way through.
// Needs no database or API server: node tests/export-module-isolation.mjs
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { build } from "esbuild";

// Pure test: the route module builds a lazy pool at import time but never
// connects here, so it is never given a real database.
process.env.DATABASE_URL = "postgresql://no-shared-database.invalid/pure-unit-test";
const dir = path.dirname(fileURLToPath(import.meta.url));
// Keep the bundle below api-server so its external dependencies resolve from
// this workspace's node_modules, as the other bundled route tests do.
const outDir = await mkdtemp(path.join(dir, ".build-export-isolation-"));
let appendExportSummary, createExportWriter, describeExportError, ZipArchive;
try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "export-module-isolation.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: [
      "pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*",
      "sharp", "pdfjs-dist/*",
    ],
    banner: {
      js: `import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);`,
    },
  });
  ({ appendExportSummary, createExportWriter, describeExportError, ZipArchive } = await import(outfile));
} finally {
  await rm(outDir, { recursive: true, force: true });
}

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(name);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Shaped like the DrizzleQueryError the route sees: the SQL and parameters
 * are on the wrapper, the Postgres error is its cause. */
function missingColumnError() {
  const cause = Object.assign(new Error('column "job_title" does not exist'), { code: "42703" });
  return new Error('Failed query: SELECT id, job_title FROM staff_roster WHERE client_id = $1\nparams: 4242', { cause });
}

async function buildZip(dir, name, failStaffRoster) {
  const path = join(dir, name);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const file = createWriteStream(path);
  archive.pipe(file);
  const out = createExportWriter(archive);
  await out.csv("fire-safety/evidence.csv", async () => [{ id: 1, title: "Fire evidence" }]);
  await out.csv("legionella/evidence.csv", async () => [{ id: 2, title: "Legionella evidence" }]);
  await out.csv("staff-roster/staff.csv", async () => {
    if (failStaffRoster) throw missingColumnError();
    return [{ id: 3, name: "Roster member" }];
  });
  await out.csv("pat-track/tests.csv", async () => [{ id: 4, result: "pass" }]);
  await out.csv("premises-track/inspections.csv", async () => [{ id: 5, area: "Kitchen" }]);
  const incomplete = appendExportSummary(archive, out, {
    now: new Date("2026-10-10T00:00:00Z"), clientId: 4242, maxBytes: 1000, usedBytes: 0, omittedForCap: 0,
  });
  await archive.finalize();
  await finished(file);
  const entries = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).split("\n").filter(Boolean);
  const read = (entry) => execFileSync("unzip", ["-p", path, entry], { encoding: "utf8" });
  return { incomplete, entries, read };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "export-module-isolation-"));
  try {
    const broken = await buildZip(dir, "broken.zip", true);
    check("export is reported incomplete", broken.incomplete === true);
    for (const entry of ["fire-safety/evidence.csv", "legionella/evidence.csv", "pat-track/tests.csv", "premises-track/inspections.csv"]) {
      check(`${entry} is still written`, broken.entries.includes(entry), broken.entries.join(", "));
    }
    check("later module keeps its rows", broken.read("pat-track/tests.csv").includes("pass"));
    check("failed dataset is not written", !broken.entries.includes("staff-roster/staff.csv"));
    check("export-errors.csv is written", broken.entries.includes("export-errors.csv"));
    const errors = broken.read("export-errors.csv");
    check("export-errors.csv names the dataset and reason",
      errors.startsWith("dataset,reason\n")
        && errors.includes('staff-roster/staff.csv,"database query failed: column ""job_title"" does not exist (42703)"'),
      errors);
    check("export-errors.csv lists only the failed dataset", errors.trim().split("\n").length === 2, errors);
    check("export-errors.csv leaves out SQL and parameters", !errors.includes("Failed query") && !errors.includes("4242"), errors);
    const readme = broken.read("README.txt");
    check("README status is incomplete", readme.includes("Status: INCOMPLETE — 1 dataset(s) missing"), readme);
    check("README warning names the missing dataset", /WARNING: THIS EXPORT IS INCOMPLETE\..*staff-roster\/staff\.csv/.test(readme), readme);

    const healthy = await buildZip(dir, "healthy.zip", false);
    check("healthy export is complete", healthy.incomplete === false);
    check("healthy export writes the roster", healthy.entries.includes("staff-roster/staff.csv"));
    check("healthy export-errors.csv is header only", healthy.read("export-errors.csv") === "dataset,reason\n");
    const healthyReadme = healthy.read("README.txt");
    check("healthy README status is complete", healthyReadme.includes("Status: complete") && !healthyReadme.includes("INCOMPLETE"), healthyReadme);

    check("non-database errors get generic wording", describeExportError(new Error("secret detail")) === "unexpected export error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`export module isolation tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
