---
name: Track record lock
description: Shared 24-hour correction window for dated operational track records.
---

Staff can edit a dated track record during its scheduled local day and the following local calendar day. After that 24-hour correction window, the record is read-only for staff. Client administrators and consultants retain the correction override.

**Why:** The user requires past operational evidence to lock after a short correction period while preserving controlled corrections by client administrators and consultants.

**How to apply:** Keep the rule at the API boundary so web, mobile, and future clients share it. Return `TRACK_RECORD_LOCKED` with HTTP 423 and identify the administrator override path.