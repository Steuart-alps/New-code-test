---
name: Local calendar-day math
description: Counting elapsed calendar dates in user-facing compliance labels across daylight-saving changes.
---

For date-only issue ages and due-date labels, compare normalized calendar dates instead of flooring elapsed milliseconds divided by 24 hours.

**Why:** A local calendar day can be 23 or 25 hours during daylight-saving changes; elapsed-time division can undercount or overcount the dates shown to users.

**How to apply:** Normalize each date to its local year, month and day, then compare civil-day ordinals or use a calendar-aware date-fns helper. Add a regression assertion across spring and autumn clock changes in the user's relevant timezone.