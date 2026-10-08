---
name: Food-safety site scoping
description: Per-site KitchenTrack templates and diaries — key conventions and inheritance model
---
- Config overrides live in app_settings under `site.<siteId>.<food_* key>`; effective = default ← client ← site. GET returns `_siteOverrides`; PUT value `null` clears an override.
- **Why:** first implementation saved every effective value as a site override, freezing inheritance; site saves must diff against client-level and send only changed keys / nulls.
- Diary records: food_safety_records.site_id nullable (NULL = whole-org diary); uniqueness via two partial unique indexes (site NULL / NOT NULL) — no single whole-table unique.
- **How to apply:** any new per-site config feature should copy this pattern; diary route ON CONFLICT must target the matching partial index per scope.
