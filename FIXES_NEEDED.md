# ComplyTrack — Required Fixes

Found during a full functional pass across all app areas (2026-08-08), run
locally against a fresh DB seeded from `runtimeMigrations.ts` + `scripts/seed-demo.mjs`.
Each item below is confirmed with a reproduction, not a guess. Ordered by how
cheap the fix is, not by severity.

---

## 1. Quick code fixes (no migration needed)

### 1a. `[...result]` spread on `db.execute()` result — breaks 4 endpoints

`db.execute()` (node-postgres/drizzle) returns a `QueryResult` object with a
`.rows` array — it is **not** itself iterable. Spreading it directly throws
`TypeError: ... is not iterable`, caught by a generic `catch` and returned as
a silent 500.

Broken in:

- `artifacts/api-server/src/routes/pool-track.ts:73`
  ```ts
  res.json([...(rows as any)]);        // ❌
  res.json((rows as any).rows);        // ✅
  ```
- `artifacts/api-server/src/routes/green-track.ts:26-28` (shared `rows()` helper — fixing this one function fixes every machine/check/service-record endpoint in the file)
  ```ts
  function rows<T = any>(result: any): T[] {
    return [...result] as T[];         // ❌
    return result.rows as T[];         // ✅
  }
  ```
- `artifacts/api-server/src/routes/swim-track.ts:12-13` (same `rows()` helper pattern)
  ```ts
  function rows(result: any): any[] {
    return [...result];                // ❌
    return result.rows;                // ✅
  }
  ```
- `artifacts/api-server/src/routes/photos.ts:120` (`GET /photos/requirements`)
  ```ts
  res.json([...(result as any)]);      // ❌
  res.json((result as any).rows);      // ✅
  ```
  Also check `photos.ts:105` (`DELETE /photos/:id`) — same pattern,
  `(result as any)[0]` should be `(result as any).rows[0]`. Not confirmed by
  a live repro (wasn't exercised in the sweep) but it's the identical bug
  shape in the same file — worth fixing alongside.

**Repro:** log in, open PoolTrack, GreenTrack, SwimTrack, or the Settings →
photo requirements panel. Every one 500s on load.

### 1b. PestTrack — every endpoint 400s "No client context"

`artifacts/api-server/src/routes/pest-track.ts:13-16` defines its own local
`getClientId`:

```ts
function getClientId(req: any): number | null {
  const id = req.session?.clientId ?? req.user?.clientId ?? null;
  return typeof id === "number" ? id : null;
}
```

Neither `req.session.clientId` nor `req.user.clientId` are ever set anywhere
in the app — the real user/client context lives on `req.currentUser`. This
local helper always returns `null`, so **every** PestTrack route (status,
visits, activity, config, create, update, delete) 400s for every user,
always.

**Fix:** delete the local function and import the real one, same as every
other route file:

```ts
import { requireAuth, denyViewers, getClientId } from "../middleware/requireAuth";
```

**Repro:** log in as any role, open PestTrack. Every panel shows an error /
empty state; network tab shows 400 on `/api/pest-track/*`.

### 1c. Checklist templates (KitchenTrack + PremisesTrack opening/closing lists) — every GET 500s

`artifacts/api-server/src/routes/checklist-templates.ts:20,36,47` (and the
PUT/DELETE handlers at similar lines) read the client id as:

```ts
const clientId = (req as any).clientId as number;   // ❌ always undefined
```

No middleware in this app ever sets `req.clientId` — every other route uses
the `getClientId(req)` helper from `middleware/requireAuth.ts`. Because
`clientId` is `undefined`, the interpolated SQL comes out as
`WHERE client_id = \n  AND site_id IS NULL ...` — a syntax error, not just a
bad filter.

**Fix:**

```ts
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";
// ...
const clientId = getClientId(req);
if (!clientId) return res.status(400).json({ error: "No client context" });
```

Apply to all three handlers (`GET`, `PUT`, `DELETE /checklist-templates`).

**Repro:** open DailyTrack AM or DailyTrack PM (they call this endpoint for
each checklist type on load) — 500 in the network tab for every
`?type=kitchen_opening|kitchen_closing|premises_opening|premises_closing`
request. KitchenTrack itself degrades gracefully (falls back to default
template) so it's easy to miss there.

---

## 2. Schema drift — route code and `runtimeMigrations.ts` disagree

Per the project's own `.agents/memory/schema-drift.md`: prod schema comes
**only** from `runtimeMigrations.ts` (no `drizzle push` in prod), so a route
column that isn't in that file will never exist anywhere. These three are
genuinely out of sync — confirmed by booting a fresh DB from
`runtimeMigrations.ts` and hitting the route.

### 2a. StaffRoster — `column sr.name does not exist`

`routes/staff-roster.ts` reads/writes a single `name` field everywhere
(`SELECT sr.name ...`, `INSERT ... VALUES (..., ${s.name}, ...)`). The
migration only has `first_name` / `last_name`:

```sql
-- runtimeMigrations.ts:551-566, current:
"first_name" text NOT NULL,
"last_name" text NOT NULL,
```

**Fix (pick one, whichever matches product intent):**
- Add `"name" text NOT NULL DEFAULT ''` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, backfill from `first_name || ' ' || last_name`, and drop `first_name`/`last_name` once confirmed unused — **or**
- Change the route to read/write `first_name`/`last_name` and compose `name` in the response.

Given the route code is 100% on the "single name field" side already, the
cheaper fix is almost certainly the migration.

**Repro:** open Staff Roster page as `client_admin` — list fails to load.

### 2b. DocTrack — `column d.object_path does not exist`

`routes/doc-track.ts` exclusively uses `object_path` (for GCS object storage:
`storage.getObjectEntityFile(objectPath)`, ACL policy, signed download URL —
`doc-track.ts:87,92,103,437-462`). The migration only has a `file_path`
column (`runtimeMigrations.ts:208-226`), which nothing in the route reads or
writes — it looks like a pre-object-storage leftover.

**Fix:**
```sql
ALTER TABLE "doc_track_documents" ADD COLUMN IF NOT EXISTS "object_path" text;
```
(`file_path` can stay as unused dead weight or be dropped later — not urgent.)

**Repro:** open DocTrack — list 500s. Uploading a document would also fail
at the INSERT.

### 2c. TrainTrack — `column r.record_type does not exist`

`routes/train-track.ts:98` selects `r.record_type`, and the create schema
(`train-track.ts:38-64`) is a `z.discriminatedUnion("recordType", [...])`
over `certificate` / `signoff` / `internal` — a real, distinct field from
the existing `training_type` column (which is `internal`/`external` and
already in the migration). `record_type` was never added:

**Fix:**
```sql
ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "record_type" text NOT NULL DEFAULT 'internal';
```

**Repro:** open TrainTrack — list 500s; every create would also fail.

### 2d. KitchenTrack Weekly Review + Probe Checks — tables don't exist at all

Two tables referenced throughout `routes/kitchen-weekly.ts` and
`routes/food-safety.ts:599` have no `CREATE TABLE` anywhere in
`runtimeMigrations.ts`:

**`kitchen_weekly_records`** — needed columns, from the actual
`INSERT`/`SELECT` in `kitchen-weekly.ts:96-107`:
```sql
CREATE TABLE IF NOT EXISTS "kitchen_weekly_records" (
  "id" serial PRIMARY KEY,
  "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
  "week_commencing" date NOT NULL,
  "checks" jsonb NOT NULL DEFAULT '[]',
  "deviations" jsonb NOT NULL DEFAULT '[]',
  "additional" jsonb NOT NULL DEFAULT '[]',
  "manager_signature" text,
  "submitted_at" timestamp,
  "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "IDX_kitchen_weekly_client" ON "kitchen_weekly_records" ("client_id");
```

**`kitchen_probe_checks`** — needed columns, from `kitchen-weekly.ts:209-219`:
```sql
CREATE TABLE IF NOT EXISTS "kitchen_probe_checks" (
  "id" serial PRIMARY KEY,
  "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
  "check_date" date NOT NULL,
  "probes" jsonb NOT NULL DEFAULT '[]',
  "overall_result" text,
  "checked_by" text,
  "signature" text,
  "notes" text,
  "submitted_at" timestamp,
  "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "IDX_kitchen_probe_client" ON "kitchen_probe_checks" ("client_id");
```

Double-check exact column types/defaults against how the frontend
(`kitchen.tsx`) actually builds `checksJson`/`deviationsJson`/`probesJson`
before applying — the shapes above are inferred from the route's SQL, not
the full request schema.

**Repro:** open KitchenTrack → Weekly Review or Probe Check tab — 500s.
Also silently breaks `GET /api/food-safety/status`, which the KitchenTrack
Daily Diary landing view calls (`food-safety.ts:597-599`), so the daily diary
"last submitted" indicators for the weekly review are always wrong.

---

## 3. Documentation cleanup (not a bug — feature was removed, docs weren't)

`replit.md` documents `GET/POST /api/compliance-items?type=external|internal`
and separate "EXTERNAL COMPLIANCE" / "INTERNAL COMPLIANCE" nav sections.
Neither exists anymore:

- `complianceItemsTable` (`lib/db/src/schema/compliance-items.ts`) has **no
  `type` column at all** — it was fully removed.
- The frontend's single "Compliance Checks" nav item
  (`components/layout.tsx:57`) calls `useListComplianceItems({})` with no
  type filter, and renders one unified list.
- Posting `{"type": "external", ...}` to `POST /api/compliance-items` is
  silently accepted and silently dropped (not stored, not an error) — Zod's
  `insertComplianceItemSchema` just ignores the unknown field.

This isn't causing a live bug (nothing depends on the filter), but the
`replit.md` API reference and nav description are stale and should be
updated to match the current unified-list design — otherwise the next person
(human or agent) will "fix" a phantom bug or build against a param that does
nothing.

---

## Suggested order of work

1. **1a–1c** — five isolated, low-risk one-liners. Safe to batch into a
   single fix.
2. **2a–2c** — three `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in
   `runtimeMigrations.ts`, following the file's existing idempotent pattern.
   `2a` needs a first_name/last_name → name decision before writing the DDL.
3. **2d** — two new `CREATE TABLE IF NOT EXISTS` blocks; verify the exact
   column list against the frontend before committing.
4. **3** — doc-only, whenever convenient.

After any of the above, re-verify against the pattern in
`.agents/memory/schema-changes.md`: schema changes need three touches
(drizzle schema file if applicable, applied to the dev DB, and the
idempotent statement added to `runtimeMigrations.ts` for prod).
