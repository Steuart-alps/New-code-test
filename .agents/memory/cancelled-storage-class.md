---
name: Cancelled business storage class
description: Why cancelled businesses' files move to ARCHIVE after 30 days, and what must keep reading them.
---

`runCancelledStorageClassJob` (lib/cancelledClientStorage.ts, daily 04:00) moves a business's ACL-owned files to `CANCELLED_FILES_STORAGE_CLASS` (default ARCHIVE; NEARLINE/COLDLINE/off) once `cancelled_at` is 30+ days old, stamps `clients.files_archived_at`, and moves them back to STANDARD when `cancelled_at` is cleared (resubscription). It holds the per-client erasure lock (106), so it never races deletion.

**Why ARCHIVE:** records are deleted 12 months after cancellation, so files sit cold ~11 months; Archive's 365-day minimum charge is still below 11 months of Coldline. GCS cold classes are readable immediately (no restore step), with a per-GB read fee, so the export, downloads, legal holds and the eraser need no change.

**How to apply:** never rewrite an object already in the target class (`setTenantObjectsStorageClass` skips it): a rewrite of a cold object is charged as an early deletion. A bucket with Autoclass manages classes itself; set the variable to `off` there. The full export (`GET /export`) is allowed through the billing lock so cancelled businesses can download for the whole 12 months. Test: `test:cancelled-storage-class`.
