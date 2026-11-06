---
name: Track evidence profiles
description: REMOVED Nov 2026 - the Inspection evidence panel and its sign-off gates are gone; actions sign off with the resolve form + drawn signature
---

Historical: structured evidence profiles (FireTrack 5 items, LegionellaTrack 8, KitchenTrack failed-temperature verification) and an "independently reviewed evidence" rule for urgent actions used to block action sign-off, recorded through the "Inspection evidence" panel under every track's actions.

5 Nov 2026 Steuart: "remove inspection evidence, this seems to be covered elsewhere and is unnecessary". The panel (track-evidence-panel.tsx) and all three sign-off gates were removed. Every action now signs off with remedial action, evidence reference, resolution notes, photos/videos if wanted, and a drawn signature; failed temperatures still need an Owner/Consultant to sign off.

The `track_evidence` / `track_evidence_requirements` tables and `/api/track-evidence` routes are kept so records already made stay readable (FireTrack and LegionellaTrack evidence is still in the business data export).

**How to apply:** don't reintroduce a separate evidence register or extra sign-off gates on track actions; put evidence on the action itself (its photos/videos and Evidence reference).
