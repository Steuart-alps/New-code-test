---
name: Shared auth rate limits
description: Production login, registration and reset-password limits share PostgreSQL counters; reset counts only failed responses via reserve-then-release.
---

Login, registration and reset-password limiters use `auth_rate_limit_counters`
in production (`storeOnlyInProduction` + `requireStore`), and stay in-memory in
development. If the store is down, the request gets a 503 and the handler never runs.

Reset-password counts only failed responses (400/401). With the shared store,
each attempt is **reserved before the handler runs** (an atomic upsert capped at
max+1). After the response, a non-failure status releases the reservation for
the exact window it came from (`windowId` = `expires_at::text`). Concurrent
guesses across instances can't pass the cap. A lost or failed release only
leaves the attempt counted, so the limiter fails closed. Don't switch to
"check, then count on finish": two instances could both pass the check.

**How to apply:** for any new response-based shared limiter, the store must
implement `release`. Tests: `test:login-rate-limit` (unit),
`test:password-reset-rate-limit-postgres` (real PostgreSQL, two module instances).
