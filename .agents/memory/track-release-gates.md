---
name: Track release gates
description: GreenTrack was launched on 2026-10-19; how the "Coming soon" gate works if a future module needs it.
---

GreenTrack is live (Steuart asked "switch on greentrack", 2026-10-19). It had sat behind a "Coming soon" page since before 2026-10-01, when the user chose to keep the gate.

**Why:** remembering that the gate was a deliberate business choice, not a bug, avoids switching a future module on as a side effect of unrelated work.

**How to apply:** to hide a future module, add its key to `COMING_SOON_SERVICE_KEYS` (api-server `src/lib/services.ts`; checkout and add-on activation refuse it, trial reminders skip it) and set `comingSoon: true` in compliance-tracker `src/lib/addon-catalog.ts`; swap its page's default export for a placeholder. Only launch one on an explicit request.
