// Per-run fixture ownership and cleanup for API integration suites.
//
// A suite registers its accounts with emails that contain its run id and
// tracks every client it creates (self-registered and consultant-created).
// cleanup() then removes exactly those tenants and everything that references
// them, in one transaction:
//
//   * Owned users are users whose email contains this run's UUID and ends in
//     @test.local. Owned clients are the tracked ids that still exist and are
//     linked to an owned user (users.client_id / consultant_clients) or carry
//     the run id in their slug. Any other tracked id aborts the cleanup, so a
//     wrong id can never delete another tenant.
//   * Dependent rows are found by walking foreign keys from those clients and
//     users. If a dependent row belongs to a different client_id, the cleanup
//     aborts instead of deleting it.
//   * The audit ledgers (audit_log, audit_events, ...) are append-only through
//     user triggers. Only for the duration of the cleanup transaction, the
//     user triggers on tables that hold this run's rows are disabled and then
//     restored to their previous state before commit. DDL is transactional and
//     takes a write-blocking lock, so no other session ever sees the guards
//     off; an error rolls everything back. Production erasure deliberately
//     keeps this evidence (see src/lib/offboarding.ts); this is only for
//     synthetic test tenants owned by the current run.
//
// Plain .mjs suites run the SQL through psql; bundled suites can pass the SQL
// from buildOwnedFixturePurgeSql() to their own pg pool.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETRYABLE = /deadlock detected|lock timeout|could not obtain lock|40P01|55P03/i;

/** Run id for this process. TEST_RUN_ID lets a probe know a child's run id. */
export function resolveRunId() {
  const fromEnv = process.env.TEST_RUN_ID;
  if (fromEnv === undefined || fromEnv === "") return randomUUID();
  if (!UUID.test(fromEnv)) throw new Error("TEST_RUN_ID must be a lowercase UUID");
  return fromEnv;
}

export function buildOwnedFixturePurgeSql({ runId, clientIds = [], minUsers = 0 }) {
  if (!UUID.test(runId)) throw new Error("fixture purge needs a UUID run id");
  const ids = [...new Set(clientIds)];
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("fixture purge client ids must be positive integers");
  }
  if (!Number.isSafeInteger(minUsers) || minUsers < 0) throw new Error("minUsers must be a non-negative integer");
  const tracked = `ARRAY[${ids.join(",")}]::integer[]`;
  return `
BEGIN;
SET LOCAL lock_timeout = '20s';
-- Serialize fixture purges with each other (not with application traffic).
SELECT pg_advisory_xact_lock(hashtext('complytrack-test-fixture-purge'));
CREATE TEMP TABLE _fx_queue (
  seq serial PRIMARY KEY, tbl regclass NOT NULL, col text NOT NULL, vals text[] NOT NULL,
  recurse boolean NOT NULL, done boolean NOT NULL DEFAULT false
) ON COMMIT DROP;
CREATE TEMP TABLE _fx_seen (tbl regclass NOT NULL, val text NOT NULL, PRIMARY KEY (tbl, val)) ON COMMIT DROP;
CREATE TEMP TABLE _fx_triggers (tbl regclass NOT NULL, tgname name NOT NULL, tgenabled "char" NOT NULL) ON COMMIT DROP;
DO $fx$
DECLARE
  marker constant text := '${runId}';
  tracked constant integer[] := ${tracked};
  owned_users integer[];
  owned_clients integer[];
  refused integer[];
  item record; fk record; trg record; pending record;
  col_type text; child_pk text; child_pk_type text; new_vals text[];
  foreign_rows bigint; deleted bigint; total bigint := 0; cur integer := 0;
  remaining integer; progress boolean;
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO owned_users FROM users
    WHERE position(marker IN email) > 0;
  IF EXISTS (SELECT 1 FROM users WHERE id = ANY(owned_users) AND email !~* '@test\\.local$') THEN
    RAISE EXCEPTION 'fixture purge refused: run % matched a non-synthetic email', marker;
  END IF;
  IF cardinality(owned_users) < ${minUsers} THEN
    RAISE EXCEPTION 'fixture purge refused: expected % user(s) for run % but found % (does DATABASE_URL match the API database?)',
      ${minUsers}, marker, cardinality(owned_users);
  END IF;

  SELECT coalesce(array_agg(c.id), '{}') INTO owned_clients FROM clients c
    WHERE c.id = ANY(tracked) AND (
      position(marker IN coalesce(c.slug, '')) > 0
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ANY(owned_users) AND u.client_id = c.id)
      OR EXISTS (SELECT 1 FROM consultant_clients cc WHERE cc.client_id = c.id AND cc.user_id = ANY(owned_users)));
  SELECT coalesce(array_agg(c.id), '{}') INTO refused FROM clients c
    WHERE c.id = ANY(tracked) AND NOT c.id = ANY(owned_clients);
  IF cardinality(refused) > 0 THEN
    RAISE EXCEPTION 'fixture purge refused: client(s) % are not owned by run %', refused, marker;
  END IF;

  INSERT INTO _fx_queue (tbl, col, vals, recurse) VALUES
    ('clients'::regclass, 'id', owned_clients::text[], true),
    ('users'::regclass, 'id', owned_users::text[], true);
  INSERT INTO _fx_seen SELECT 'clients'::regclass, unnest(owned_clients::text[]) ON CONFLICT DO NOTHING;
  INSERT INTO _fx_seen SELECT 'users'::regclass, unnest(owned_users::text[]) ON CONFLICT DO NOTHING;

  -- Walk restrict/no-action/cascade foreign keys outward from the owned roots.
  LOOP
    SELECT * INTO item FROM _fx_queue WHERE seq > cur ORDER BY seq LIMIT 1;
    EXIT WHEN NOT FOUND;
    cur := item.seq;
    CONTINUE WHEN NOT item.recurse OR cardinality(item.vals) = 0;
    FOR fk IN
      SELECT con.conrelid::regclass AS child, ca.attname AS child_col,
             format_type(ca.atttypid, ca.atttypmod) AS child_type
      FROM pg_constraint con
      JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND con.confrelid = item.tbl AND cardinality(con.conkey) = 1
        AND pa.attname = item.col AND con.confdeltype IN ('a', 'r', 'c')
    LOOP
      IF fk.child = 'clients'::regclass THEN
        EXECUTE format('SELECT count(*) FROM clients WHERE %I = ANY($1::%s[]) AND NOT id = ANY($2)', fk.child_col, fk.child_type)
          INTO foreign_rows USING item.vals, owned_clients;
      ELSIF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = fk.child AND attname = 'client_id' AND NOT attisdropped) THEN
        EXECUTE format('SELECT count(*) FROM %s WHERE %I = ANY($1::%s[]) AND client_id IS NOT NULL AND NOT client_id = ANY($2)',
          fk.child, fk.child_col, fk.child_type)
          INTO foreign_rows USING item.vals, owned_clients;
      ELSE
        foreign_rows := 0;
      END IF;
      IF foreign_rows > 0 THEN
        RAISE EXCEPTION 'fixture purge refused: % row(s) in % reference run % fixtures but belong to another tenant',
          foreign_rows, fk.child, marker;
      END IF;

      SELECT a.attname, format_type(a.atttypid, a.atttypmod) INTO child_pk, child_pk_type
        FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = fk.child AND i.indisprimary AND i.indnatts = 1;
      IF child_pk IS NULL THEN
        INSERT INTO _fx_queue (tbl, col, vals, recurse) VALUES (fk.child, fk.child_col, item.vals, false);
      ELSE
        EXECUTE format(
          'WITH found AS (SELECT %I::text AS v FROM %s WHERE %I = ANY($1::%s[])),
                fresh AS (INSERT INTO _fx_seen SELECT $2, v FROM found ON CONFLICT DO NOTHING RETURNING val)
           SELECT array_agg(val) FROM fresh',
          child_pk, fk.child, fk.child_col, fk.child_type)
          INTO new_vals USING item.vals, fk.child;
        IF new_vals IS NOT NULL THEN
          INSERT INTO _fx_queue (tbl, col, vals, recurse) VALUES (fk.child, child_pk, new_vals, true);
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- Suspend user triggers (audit capture and append-only guards) only on the
  -- tables that hold this run's rows, remembering their previous state.
  INSERT INTO _fx_triggers
    SELECT t.tgrelid::regclass, t.tgname, t.tgenabled FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgrelid IN (SELECT DISTINCT tbl FROM _fx_queue WHERE cardinality(vals) > 0);
  FOR trg IN SELECT * FROM _fx_triggers ORDER BY tbl::text, tgname LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', trg.tbl, trg.tgname);
  END LOOP;

  -- Delete deepest rows first; retry rows still referenced until stable.
  LOOP
    progress := false;
    remaining := 0;
    FOR pending IN SELECT * FROM _fx_queue WHERE NOT done ORDER BY seq DESC LOOP
      IF cardinality(pending.vals) = 0 THEN
        UPDATE _fx_queue SET done = true WHERE seq = pending.seq;
        CONTINUE;
      END IF;
      SELECT format_type(atttypid, atttypmod) INTO col_type FROM pg_attribute
        WHERE attrelid = pending.tbl AND attname = pending.col;
      BEGIN
        EXECUTE format('DELETE FROM %s WHERE %I = ANY($1::%s[])', pending.tbl, pending.col, col_type)
          USING pending.vals;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        total := total + deleted;
        UPDATE _fx_queue SET done = true WHERE seq = pending.seq;
        progress := true;
      EXCEPTION WHEN foreign_key_violation THEN
        remaining := remaining + 1;
      END;
    END LOOP;
    EXIT WHEN remaining = 0;
    IF NOT progress THEN
      RAISE EXCEPTION 'fixture purge for run % is blocked by rows outside its ownership graph', marker;
    END IF;
  END LOOP;

  FOR trg IN SELECT * FROM _fx_triggers ORDER BY tbl::text, tgname LOOP
    EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I', trg.tbl,
      CASE trg.tgenabled WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END, trg.tgname);
  END LOOP;

  IF EXISTS (SELECT 1 FROM users WHERE position(marker IN email) > 0)
     OR EXISTS (SELECT 1 FROM clients WHERE id = ANY(owned_clients)) THEN
    RAISE EXCEPTION 'fixture purge left run % fixtures behind', marker;
  END IF;
  RAISE NOTICE 'fixture-purge run=% users=% clients=% rows=%',
    marker, cardinality(owned_users), cardinality(owned_clients), total;
END
$fx$;
COMMIT;
`;
}

function runPsql(databaseUrl, sqlText) {
  return new Promise((resolve) => {
    // Pass the URL as an argument (never echoed) and the SQL on stdin.
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl, "-f", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stderr: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(sqlText);
  });
}

/** Removes only the fixtures owned by `runId`; resolves to the summary line. */
export async function purgeOwnedFixtures({ runId, clientIds, minUsers = 0, databaseUrl = process.env.DATABASE_URL }) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required to clean up this run's fixtures");
  const sqlText = buildOwnedFixturePurgeSql({ runId, clientIds, minUsers });
  for (let attempt = 1; ; attempt++) {
    const { code, stderr } = await runPsql(databaseUrl, sqlText);
    const safe = stderr.split(databaseUrl).join("<DATABASE_URL>");
    if (code === 0) return safe.match(/fixture-purge run=[^\n]*/)?.[0] ?? "fixture-purge completed";
    if (attempt < 5 && RETRYABLE.test(safe)) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
      continue;
    }
    throw new Error(`fixture cleanup failed (psql exit ${code}): ${safe.trim().split("\n").slice(-3).join(" | ")}`);
  }
}

/**
 * Tracks what the current run owns. `probe(stage)` throws when
 * FIXTURE_PROBE_FAIL_AT names that stage, so tests can prove cleanup on
 * deliberate failure paths.
 */
export function createFixtureOwnership({ runId, suite }) {
  const clientIds = new Set();
  let registeredUsers = 0;
  return {
    runId,
    trackRegisteredUser() {
      registeredUsers += 1;
    },
    trackClient(id) {
      if (Number.isSafeInteger(id) && id > 0) clientIds.add(id);
    },
    probe(stage) {
      if (process.env.FIXTURE_PROBE_FAIL_AT === stage) {
        throw new Error(`deliberate ${suite} failure at ${stage} (FIXTURE_PROBE_FAIL_AT)`);
      }
    },
    async cleanup() {
      const summary = await purgeOwnedFixtures({ runId, clientIds: [...clientIds], minUsers: registeredUsers > 0 ? 1 : 0 });
      console.log(`${suite}: ${summary}`);
      return summary;
    },
  };
}
