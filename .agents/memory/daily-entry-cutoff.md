---
name: Track record lock
description: Shared 24-hour correction window for dated operational track records.
---

Staff can edit a dated track record during its scheduled local day and the following local calendar day. After that 24-hour correction window, the record is read-only for staff. Client administrators and consultants retain the correction override.

**Why:** The user requires past operational evidence to lock after a short correction period while preserving controlled corrections by client administrators and consultants.

**How to apply:** Keep the rule at the API boundary so web, mobile, and future clients share it. Return `TRACK_RECORD_LOCKED` with HTTP 423 and identify the administrator override path.

For ID-addressed operational evidence, use the record's tenant-scoped persisted date rather than a request-body date. Do not treat every old row as locked: SOPs, risk-assessment documents, assets, templates, FixTrack issues, and action follow-up workflows are not historical daily check records. A created_at timestamp alone is not an operational evidence date.

**Why:** Action remediation can legitimately continue after the source check's correction window, and documents or configuration should not become uneditable merely because they were created long ago.

**How to apply:** Classify new ID-addressed routes by whether they mutate day-bound evidence before adding them to the persisted-date lookup; keep unrelated follow-up and metadata authorization separate.