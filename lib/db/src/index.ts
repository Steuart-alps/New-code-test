import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { auditPool } from "./audit-context";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// An idle client can lose its connection (database restart, network blip).
// Without a listener that 'error' event would crash the process; the pool has
// already discarded the client, so logging is enough.
pool.on("error", (err) => {
  console.error(JSON.stringify({
    level: "error",
    msg: "PostgreSQL idle client error (connection discarded)",
    err: { message: err.message, code: (err as { code?: string }).code },
  }));
});

// Session lock_timeout applied to every client as it is checked out, so a
// caller (API start-up migrations) can bound lock waits without owning a
// dedicated connection. The SET is queued on the client before the caller's
// own query, so it always runs first.
type TrackedClient = pg.PoolClient & { complytrackLockTimeout?: string | null };
let sessionLockTimeout: string | null = null;

/** Set (e.g. "5s") or clear (null) the lock_timeout for subsequent checkouts. */
export function setSessionLockTimeout(value: string | null): void {
  if (value !== null && !/^\d{1,6}(ms|s)$/.test(value)) {
    throw new Error("lock timeout must look like 5s or 500ms");
  }
  sessionLockTimeout = value;
}

pool.on("acquire", (client) => {
  const tracked = client as TrackedClient;
  const current = tracked.complytrackLockTimeout ?? null;
  if (current === sessionLockTimeout) return;
  tracked.complytrackLockTimeout = sessionLockTimeout;
  void tracked
    .query(sessionLockTimeout ? `SET lock_timeout = '${sessionLockTimeout}'` : "RESET lock_timeout")
    .catch(() => {});
});

export const db = drizzle(auditPool(pool), { schema });
export { auditContext } from "./audit-context";

export * from "./schema";
