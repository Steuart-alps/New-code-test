---
name: Kitchen mobile submissions
description: Date and retry invariants for mobile KitchenTrack temperature entries.
---

Mobile KitchenTrack entries use the device-local calendar date, include an offset-bearing recorded-at timestamp, and carry a stable entry ID across retries. The server verifies both dates agree, appends atomically, and treats a repeated entry ID as a successful duplicate rather than appending twice.

**Why:** UTC-derived dates can target the previous or next diary around local midnight, while a lost HTTP response can cause staff to submit the same temperature twice.

**How to apply:** Preserve the original date, timestamp, and entry ID when retrying a submission. Changing the form, section, or site starts a new entry identity. Weekly and probe records must remain unique within their nullable site/date scope and validate site access before reads or writes.