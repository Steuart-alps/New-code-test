---
name: Feedback review revisions and history
description: Feedback triage uses optimistic revisions (409 on stale drafts) and an append-only, trigger-guarded review history.
---

`PATCH /feedback/:id` requires `expectedRevision`. The route locks the report (`FOR UPDATE OF f`), returns 409 with the latest report when the revision is stale, and otherwise bumps `revision` and inserts a `feedback_report_reviews` row in the same transaction. Identical re-saves return 200 without a new revision or history row.

**Why:** two managers could silently overwrite each other's notes, and reopening a report erased who resolved it and why.

**How to apply:** history rows are guarded by triggers in `runtimeMigrations.ts`: inserts must match the report's tenant; updates are rejected except the FK's `actor_id → NULL` on user removal; deletes are allowed only when the report or client is already gone (cascade). Actor names are joined live from `users`, not snapshotted, so user anonymisation applies to history too. Feedback reports (and so their history) are not in `deleteAllClientData`; they follow the client row's retention. The inbox keeps dirty drafts across refreshes and 409s, offering "Keep my draft" (rebase onto the latest revision) or "Use saved version".
