---
name: Track record lock
description: Shared 24-hour correction window for dated operational track records; owners override only with an audited reason.
---

Staff can edit a dated track record during its scheduled local day and the following local calendar day. After that 24-hour correction window, the record is read-only for staff (423 `TRACK_RECORD_LOCKED`). Client administrators and consultants (self-signup owners are `consultant`) may still edit, delete or backfill such a record, but only with a reason: without the `X-Override-Reason` header (URI-encoded, trimmed, 5–500 characters) they get 423 `OVERRIDE_REASON_REQUIRED`; with it, the middleware writes an `audit_events` row (`entity_type` `track_record`, `action` `late_edit_override`, metadata method/path/entryDate/reason/role) before the route runs, and refuses the write with 500 if that insert fails.

**Why:** The user requires past operational evidence to lock after a short correction period, and owner corrections to be explained and traceable ("owners can only edit with reason added").

**How to apply:** Keep the rule at the API boundary (`middleware/dailyEntryCutoff.ts`) so web, mobile, and future clients share it. The web app's generated client (`setOverrideReasonHandler`) and `apiFetch`/`fetchWithOverrideReason` prompt for the reason via `OverrideReasonDialog` and retry once; hand-written track fetches must use `fetchWithOverrideReason`. Integration suites whose owner deliberately writes old records send the header (`createTenant(label, { overrideReason })` in approval-workflow-fixtures); never weaken the server rule to make a suite pass.

For ID-addressed operational evidence, use the record's tenant-scoped persisted date rather than a request-body date. Do not treat every old row as locked: SOPs, risk-assessment documents, assets, templates, FixTrack issues, and action follow-up workflows are not historical daily check records. A created_at timestamp alone is not an operational evidence date. Owners need no reason under `/fix-track` and `/track-actions` (`OWNER_REASON_EXEMPT_PREFIXES`): their forms resend past reported/target dates.

**Why:** Action remediation can legitimately continue after the source check's correction window, and documents or configuration should not become uneditable merely because they were created long ago.

**How to apply:** Classify new ID-addressed routes by whether they mutate day-bound evidence before adding them to the persisted-date lookup; for site-scoped rows, enforce the caller's department/site boundary before returning a date-lock decision; keep unrelated follow-up and metadata authorization separate.
