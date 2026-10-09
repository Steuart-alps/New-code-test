---
name: First-party analytics
description: Umami replaced by an allowlisted analytics_events table; no tenant hash stored; token-only summary route mounted before sessions.
---
Custom events go `trackEvent` -> shared `apiFetch` (CSRF, keepalive) -> `POST /api/analytics/events` -> `analytics_events` (event_name, enum-only jsonb dimensions, hour-truncated occurred_at). Read back with `GET /api/internal/analytics/summary` (bearer `ANALYTICS_READ_TOKEN`) or `pnpm --filter @workspace/scripts run analytics:report`; both use `@workspace/db/analytics` so the numbers match.

**Decisions and why:**
- **No per-tenant HMAC column.** The adoption events (`module_activation_succeeded` -> `module_first_used` -> `module_first_work_completed`) are already deduplicated once per client/module activation cycle in the browser, so plain counts approximate distinct tenants. A keyed client hash is still pseudonymous personal data for sole traders, and it would allow cross-event linking. If cross-browser dedup is ever needed, add `ANALYTICS_HASH_SECRET` (fallback `SESSION_SECRET`) and store an HMAC, never the raw id.
- **No `denyViewers` on ingest.** Recording an event writes no tenant data, and viewer usage (e.g. training-matrix downloads) is real usage. Documented exception in `tests/viewer-route-policy.mjs`. Bearer (mobile) requests are refused with 401 because CSRF skips bearer requests.
- **Summary route mounted in app.ts before cookieParser/session/loadUser**, so a session cookie can never authorise it and the token never reaches the mobile-session lookup. Tokens under 32 chars keep it disabled (404).
- Rejections use fixed messages (no echo); app.ts also returns a fixed message for malformed JSON bodies app-wide, since body-parser's message quotes the body.

**How to apply:** a new event needs a registry entry in api-server `src/lib/analytics.ts` (every dimension an enum) plus a typed helper in compliance-tracker `src/lib/analytics.ts`. Never add client, site, user, record, date or free-text dimensions.

**HotTubTrack PDF:** `trackInspectionPdfDownload` is called in hot-tub.tsx only after `downloadBlob` returns (failed generation/save/module/font/unsupported-character attempts send nothing); site_scope from the site filter, record_scope from the exported row count. `tests/hot-tub-pdf-browser.test.mjs` captures the POSTs and proves the download survives a 500, abort, hang or throwing fetch.
