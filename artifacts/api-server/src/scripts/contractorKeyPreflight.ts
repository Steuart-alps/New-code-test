/**
 * Read-only check before removing a retained contractor-token encryption key.
 *
 *   node artifacts/api-server/dist/contractor-key-preflight.mjs [--json]
 *     [--writers-drained] [--version <retained-version>]
 *
 * Run it with the same environment as the API (DATABASE_URL and the
 * CONTRACTOR_TOKEN_ENCRYPTION_* variables), e.g. from the Render shell. It
 * prints aggregate counts only and never changes keys or queue rows.
 *
 * Exit codes: 0 report printed (and, with --version, that key is safe to
 * retire); 2 the named key is not yet safe to retire; 1 the check failed.
 */
import { pool } from "@workspace/db";
import { formatKeyPreflightReport, runKeyPreflight } from "../lib/contractorKeyPreflight";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const writersDrainedConfirmed = args.includes("--writers-drained");
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  if (versionIndex >= 0 && !version) {
    console.error("--version needs a retained key version");
    return 1;
  }

  const report = await runKeyPreflight({ writersDrainedConfirmed });
  console.log(json ? JSON.stringify(report, null, 2) : formatKeyPreflightReport(report));
  if (!version) return 0;
  const assessment = report.retirement.find((candidate) => candidate.keyVersion === version);
  if (!assessment) {
    console.error(`${version} is not a retained key version in this environment`);
    return 2;
  }
  return assessment.safeToRetire ? 0 : 2;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`Key preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
