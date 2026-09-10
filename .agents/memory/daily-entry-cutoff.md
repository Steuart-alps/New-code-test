---
name: Daily entry cutoff
description: Shared end-of-day locking behavior for operational track entries.
---

Non-administrator track users can enter the current day's records until 23:58:59 in the operating timezone. At 23:59, writes for that day close; after midnight, backdated writes remain closed while the new current day opens. Client administrators and consultants bypass the cutoff for corrections.

**Why:** Compliance evidence should not be silently backfilled after the daily record window closes, but managers still need a controlled way to correct late or historical entries.

**How to apply:** Keep the rule at the API boundary so web, mobile, and future clients cannot bypass it. Preserve the `DAILY_ENTRY_CUTOFF` response code so clients can explain the administrator override path.