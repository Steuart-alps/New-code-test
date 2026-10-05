// Creates the base schema in a brand-new, empty database so the api-server's
// runtime migrations (which assume the core tables exist) can run.
//
// Safe to run on every deploy: it does nothing once the core tables exist, and
// it refuses to run drizzle-kit against a database that already has other
// tables, because `drizzle-kit push` can try to drop or rename live tables.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("[db:bootstrap] DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const {
  rows: [state],
} = await client.query(`
  SELECT
    to_regclass('public.clients') IS NOT NULL AS has_core,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS table_count
`);
await client.end();

if (state.has_core) {
  console.log("[db:bootstrap] Core schema present; nothing to do.");
  process.exit(0);
}
if (state.table_count > 0) {
  console.error(
    `[db:bootstrap] Database has ${state.table_count} table(s) but no core schema. ` +
      "Refusing to run drizzle-kit push against a non-empty database; inspect it manually.",
  );
  process.exit(1);
}

console.log("[db:bootstrap] Empty database; creating base schema with drizzle-kit push...");
const drizzleKit = path.join(dir, "node_modules", ".bin", "drizzle-kit");
const child = spawn(drizzleKit, ["push", "--config", "./drizzle.config.ts"], {
  cwd: dir,
  // No stdin: on an empty database push has nothing to ask. If it ever does
  // prompt, the timeout below fails the deploy instead of hanging it.
  stdio: ["ignore", "inherit", "inherit"],
});
const timer = setTimeout(() => {
  console.error("[db:bootstrap] drizzle-kit push timed out (it may be waiting for input)");
  child.kill("SIGTERM");
}, 5 * 60 * 1000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
