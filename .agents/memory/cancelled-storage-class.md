---
name: Cancelled business storage class
description: Why cancelled businesses' files move to ARCHIVE after 30 days, and what must keep reading them.
---

`runCancelledStorageClassJob` (lib/cancelledClientStorage.ts, daily 04:00) moves a business's ACL-owned files to `CANCELLED_FILES_STORAGE_CLASS` (default ARCHIVE; NEARLINE/COLDLINE/off) once `cancelled_at` is 30+ days old, stamps `clients.files_archived_at`, and moves them back to STANDARD when `cancelled_at` is cleared (resubscription). It holds the per-client erasure lock (106), so it never races deletion.

**Why ARCHIVE:** records are deleted 12 months after cancellation, so files sit cold ~11 months; Archive's 365-day minimum charge is still below 11 months of Coldline. GCS cold classes are readable immediately (no restore step), with a per-GB read fee, so the export, downloads, legal holds and the eraser need no change.

**How to apply:** never rewrite an object already in the target class (`setTenantObjectsStorageClass` skips it): a rewrite of a cold object is charged as an early deletion. A bucket with Autoclass manages classes itself; set the variable to `off` there. The full export (`GET /export`) is allowed through the billing lock so cancelled businesses can download for the whole 12 months. Test: `test:cancelled-storage-class`.

**Download and reminder (2026-10-19, Steuart):** `GET /export` splits files into parts of `EXPORT_ATTACHMENT_MAX_BYTES` (default 500 MB; `?part=N`, header `X-Export-Parts`; records CSVs in part 1 only; file order is sorted so every part request plans the same split). Settings shows one button per part. `runDeletionReminderJob` (daily 07:15) emails the business once, 30 days before `data_deletion_scheduled_at`, with the download link (`clients.deletion_reminder_sent_at`, cleared on resubscription). Only the business's own owner (client_admin, or a consultant-role self-signup owner whose own business it is) may request early deletion, and only after cancelling; linked consultants and ALPS review instead. Tests: `test:export-parts`, `test:deletion-reminder`, `test:data-deletion-request`.
