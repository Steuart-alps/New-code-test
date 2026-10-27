---
name: AI model and effort per feature
description: Each AI feature's Claude model and effort live in aiModels.ts; Haiku has no server-side fallback, so lists retry once on Sonnet; Render *_MODEL / *_EFFORT override.
type: project
---

The owner agreed the split on 2026-10-27: the cheapest model that does each
job well, so the £10 monthly AI allowance goes further.

| Feature | Model | Effort |
|---|---|---|
| List imports (contractors, rooms, call points, GreenTrack, staff) | claude-haiku-5-5 | low |
| PAT registers, certificates | claude-sonnet-5-5 | low |
| Audit / inspection reports | claude-opus-5-5 | medium |
| COSHH drafts (not built) | claude-opus-5-5 | high |
| Help chat (not built) | claude-sonnet-5-5 | low |

How it works (`artifacts/api-server/src/lib/aiModels.ts`):

- `aiModelFor(feature)` / `aiEffortFor(feature)` give the model and effort;
  each feature has its own `*_MODEL` and `*_EFFORT` Render variable
  (`LIST_READING_*`, `REGISTER_READING_*`, `CERTIFICATE_READING_*`,
  `REPORT_READING_*`, `COSHH_DRAFTING_*`, `HELP_CHAT_*`). Before this,
  `REPORT_READING_MODEL` also covered lists and PAT; now it is reports only.
- `serverSideFallbackParams(model)` adds the server-side refusal fallback
  (`fallbacks: "default"`) for every model except Claude Haiku, which has
  none (a list of fallbacks is a 400 there). `listReading.ts` instead tries a
  declined Haiku list once on Claude Sonnet 5.5 and counts both requests
  (`combinedUsage` in aiPricing.ts, priced at Sonnet's rates).
- A new AI feature should add itself to `AI_MODEL_SETTINGS`; the pricing test
  checks every default model has a price in aiPricing.ts.
- Letting businesses choose their own model or effort is on the future
  developments roadmap, not built.
