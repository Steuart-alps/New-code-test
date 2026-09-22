---
name: Contractor calendar semantics
description: Date-only calendar invitations and approval-preserving resends.
---

Treat FixTrack target dates as all-day calendar entries, not invented visit times. Keep event identity stable across revised invitations.

**Why:** Target dates do not specify a confirmed time, and replacing the UID creates duplicate calendar entries instead of updates.

**How to apply:** Reuse the event UID and advance its sequence for revisions. Resends must go through the current manager approval queue; the older task wording about force-send must not be interpreted as permission to bypass approval.