---
name: Training matrix identity
description: How TrainTrack certificates are matched to roster members in the training matrix.
---

TrainTrack records keep `staff_name` as a snapshot and an optional `staff_roster_id` link (added Oct 2026; NULL on legacy rows, no backfill). The matrix rows are active roster members keyed by roster id; linked certificates attach by id only. A legacy name-only certificate attaches only when exactly one active roster member in the selected site scope has the same normalised name (NFKC, trimmed, collapsed whitespace, case-folded); otherwise it is left out and counted in `unmatchedCertificates`, which the download toast reports. Same-name rows are labelled `Name (Site, roster #id)`.

**Why:** grouping by name merged same-name staff and let one person's certificate fill another's cell. A DB backfill was not done because it would freeze a guess; display-time matching stays reversible as the roster changes.

**How to apply:** the API accepts `staffRosterId` only for a roster row of the session tenant whose site is visible in the active department (same 400 for foreign and unknown ids). `train_track_records` now has a Drizzle definition (`lib/db/src/schema/train-track.ts`) mirroring the runtime migrations; keep both in step.
