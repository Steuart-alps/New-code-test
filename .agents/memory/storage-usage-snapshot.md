# Storage usage snapshot

`GET /storage/usage` no longer lists provider metadata on every Settings load.
`src/lib/storageUsageSnapshot.ts` keeps:

- `storage_usage_objects`: one row per private object path. Finalisation
  upserts `present=true`; deletion leaves a `present=false` tombstone. Totals
  are `SUM(size_bytes)` over present rows, so retries/replays are idempotent and
  totals cannot go negative. Never switch this to a counter adjusted by deltas.
- `storage_usage_pending`: a marker written before the provider is touched and
  cleared with the ledger write. A marker older than 10 minutes means a crash
  and makes the snapshot stale.
- `storage_usage_snapshots`: last provider reconciliation time, drift found,
  and a refresh lease (one reconciliation per tenant at a time).

Rules that keep it correct:

- `ObjectStorageService` reports through `setStorageUsageRecorder` (registered
  by `routes/storage.ts`); only `setTenantObjectAcl`, `trySetObjectEntityAclPolicy`
  (private owner) and `deleteTenantObject` report. A new way to grant a tenant
  ACL or delete a tenant object must go through `trackStorageUsageChange`.
- Lifecycle writes always win. Reconciliation only touches rows whose
  `changed_at` is before its own DB start time, so a stale listing cannot undo
  an upload or resurrect a deletion. Lifecycle writes refuse paths reserved for
  another tenant (`/objects/{uploads,finalized}/tenant-N/`); reconciliation
  may reassign a row because its listing is ACL-filtered.
- Reconciliation runs in-process: synchronously on a tenant's first view, then
  in the background when the snapshot is older than
  `STORAGE_USAGE_SNAPSHOT_MAX_AGE_SECONDS` (default 1 h). No cron/worker, so no
  extra Render cost.
- Test: `pnpm --filter @workspace/api-server run test:storage-usage-snapshot`
  (fresh-schema harness; concurrency, races, drift, lease, crash marker).
