---
name: Staged photo cleanup
description: How abandoned required-photo uploads are removed without risking committed evidence.
---

Unclaimed staged receipts are cancelled (`DELETE /api/photos/staged/:id`, own actor + tenant only) when a create dialog closes or a staged photo is removed, and expire after 30 minutes. `src/lib/stagedPhotoCleanup.ts` deletes their objects at API boot and every 10 minutes (bounded batch), and immediately after a cancel.

**Why:** the old boot prune deleted expired receipt rows but left the finalized private objects, which accumulated storage charges with nothing pointing at them.

**How to apply:**
- Never prune `staged_photo_upload_receipts` rows directly. The row is the only server-trusted pointer to the object. Remove rows only through the cleanup, which deletes the object first and commits after.
- Each receipt is processed in its own transaction: `FOR UPDATE SKIP LOCKED` on the row (creates claim with `FOR UPDATE`, so the two serialize), then the `${clientId}:${path}` advisory lock, row delete, `hasTenantAttachmentReference`, `/objects/finalized/tenant-<id>/` prefix check, and `deleteTenantObject` (private ACL owned by the tenant). If storage fails, the transaction rolls back and the receipt backs off through `cleanup_after`/`cleanup_attempts`. ObjectNotFound counts as done.
- Creates reject cancelled receipts. Clients call `consume()` after a successful create so they do not cancel claimed receipts.
- The scheduled run skips entirely when private storage is not configured.
- The fresh-schema DB (runtime migrations only) lacks the drizzle-only `certificates` table that the reference check reads. DB tests stub it.
