---
name: Completed-work adoption analytics
description: module_first_work_completed is fired from an allowlisted API-mutation observer, not per page handler; add new record/check endpoints to its allowlist.
---
Practical adoption after a paid activation is `module_first_work_completed` ({ module, activity } only), sent once per client/module activation cycle, separate from the route-visit `module_first_used`.

**Why:** Module pages save through three paths (generated hooks via `customFetch`, the shared `apiFetch`, and page-local fetch wrappers). Instrumenting every handler would be dozens of call sites; one observer on each fetch layer plus `COMPLETED_WORK_RULES` in `compliance-tracker/src/lib/analytics.ts` covers all of them and cannot double-fire.

**How to apply:** Only successful POSTs that create a record or complete a check count; config, asset registers, uploads, edits and deletes do not. A new module endpoint needs a rule there; a new page-local fetch wrapper must call `beginApiMutation` (from `@/lib/api`) before sending and its result after a 2xx. Never add client/site/record fields to the event.
