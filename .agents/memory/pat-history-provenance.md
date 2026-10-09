---
name: PAT history provenance
description: Why migrated PAT names and locations must remain qualified and separate from current registers.
---

Existing legacy PAT tests and certificate-room links did not contain location or rename timelines. A migration can preserve the best-known appliance location or room name, but cannot prove that it was the identity on the historical inspection date. Keep backfill qualifications visible in screens and exports.

**Why:** Presenting inferred migration data as verified historic evidence would mislead an inspection. Relocating an appliance or renaming a room must not change what an earlier record says.

**How to apply:** Preserve provenance when extending PAT reports, dashboards, certificate views and exports. Do not replace retained names or locations with live register values. If original documents later establish a different identity, use a reviewable supplemental correction rather than silently rewriting the retained snapshot.
**PAT failures:** `pat_failures` location/room/certificate are fixed at insert by the `preserve_pat_failure_identity` trigger; PUT only edits appliance/action/resolution and returns 409 (`PAT_FAILURE_REASSIGNMENT` / `PAT_FAILURE_LOCATION_LOCKED`) on attempted changes. Wrong locations are fixed by an admin/consultant appending to `pat_failure_location_corrections` (reason required, append-only) — shown beside the original, never over it. Pre-existing rows are labelled `legacy_backfill`, `legacy_edit_recapture` (edited before the trigger, so the old route may have recaptured the room name) or `legacy_unavailable`.

**PAT replacements:** `pat_replacements` carries `room_name_snapshot`, `site_id_snapshot`, `site_name_snapshot` and `snapshot_source` set by the `preserve_pat_replacement_identity` trigger. Ordinary corrections keep the snapshot; correcting to another room is allowed only within the recorded site (`snapshot_source='corrected'`, re-captured at correction time); cross-site moves return 409 `PAT_REPLACEMENT_SITE_LOCKED`. Department scoping and the site filter use the recorded site.
