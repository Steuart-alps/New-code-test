#!/usr/bin/env node
// Deploy-time database setup (Render's pre-deploy step).
//
// On an empty database it creates the base schema from lib/db/src/schema with
// `drizzle-kit push --force`, which has nothing to ask about when no tables
// exist yet. On any database that already has the schema it does nothing:
// drizzle-kit push must never run against a live database (it can drop or
// rename columns). Everything after the base schema, on new and existing
// databases alike, is applied by the API's runtime migrations at startup.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dbDir = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("[db-bootstrap] DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let hasSchema;
try {
  const { rows } = await client.query(
    "SELECT to_regclass('public.users') IS NOT NULL AS present",
  );
  hasSchema = rows[0].present;
} finally {
  await client.end();
}

if (hasSchema) {
  console.log("[db-bootstrap] Schema already present; leaving it to the runtime migrations.");
  process.exit(0);
}

console.log("[db-bootstrap] Empty database: creating the base schema.");
const result = spawnSync(
  path.join(dbDir, "node_modules", ".bin", "drizzle-kit"),
  ["push", "--force", "--config", "./drizzle.config.ts"],
  { cwd: dbDir, stdio: "inherit" },
);
if (result.status !== 0) {
  console.error("[db-bootstrap] drizzle-kit push failed");
  process.exit(result.status ?? 1);
}
console.log("[db-bootstrap] Base schema created.");
