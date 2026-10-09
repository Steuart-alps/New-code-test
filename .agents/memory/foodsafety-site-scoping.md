---
name: Food-safety site scoping
description: Per-site KitchenTrack templates and diaries — key conventions and inheritance model
---
- Config overrides live in app_settings under `site.<siteId>.<food_* key>`; effective = default ← client ← site. GET returns `_siteOverrides`; PUT value `null` clears an override.
- **Why:** first implementation saved every effective value as a site override, freezing inheritance; site saves must diff against client-level and send only changed keys / nulls.
- Diary records: food_safety_records.site_id nullable (NULL = whole-org diary); uniqueness via two partial unique indexes (site NULL / NOT NULL) — no single whole-table unique.
- **How to apply:** any new per-site config feature should copy this pattern; diary route ON CONFLICT must target the matching partial index per scope.
- Template editors must wait for both the selected scope and client baseline before enabling save, then hydrate new-entry rows once per date/site scope.
- **Why:** saving while a site config is loading can freeze stale values as overrides; rehydrating after edits can erase staff input.
- Historical diary records use their stamped limits and keep populated sections visible even if the current template later hides those sections.
- **Why:** templates define new records; they must not rewrite or conceal evidence already filed.
- Probe calibration names stay client-level until probe-check records themselves become site-scoped.
- **How to apply:** do not expose site-specific probe templates unless probe history, by-date lookup, and uniqueness gain the same site scope.
