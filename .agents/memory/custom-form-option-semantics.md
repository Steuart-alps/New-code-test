---
name: Custom form-option semantics
description: Rules for tenant-customizable dropdowns, legacy records, and values with compliance meaning.
---

Only business-preference vocabularies should be tenant-customizable. Keep values fixed when raw codes drive compliance calculations or workflow behavior, unless the model gains stable identities and separate editable labels.

**Why:** Renaming raw incident severity values would make new serious/fatal incidents disappear from summary metrics. Mobile and web consumers also need to agree on which lists are customizable.

**How to apply:** New-record forms must select only active tenant options. Edit forms may retain an unchanged disabled or legacy value so unrelated fields remain editable. TrainTrack's `Other` option enables a bespoke description only while `Other` is active.