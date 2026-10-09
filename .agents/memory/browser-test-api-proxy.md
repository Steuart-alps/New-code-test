---
name: Browser test API proxy
description: Running real frontend browser tests against an isolated test-mode API.
---

When browser tests serve Vite on a separate port but forward its API requests to a private test-mode server, remove the browser's Vite Origin header from upstream proxy requests. Complete mandatory authenticator enrolment for the seeded admin before visiting protected pages.

**Why:** A browser route interception that forwards the original Origin looks cross-origin to the API, so mutating requests fail its CORS check despite appearing same-origin to the browser. Newly registered test admins can authenticate but are held on the two-factor setup screen until they enrol.

**How to apply:** Keep browser-facing requests same-origin, use an isolated test API for registration and verification fixtures, complete TOTP setup through its normal endpoints, and strip the forwarded Origin at the proxy boundary; do not disable the app's CORS or two-factor checks.
## Enforced CSRF/2FA variant

`FRESH_SCHEMA_BROWSER_POLICY=1 bash tests/run-fresh-schema.sh <suite>` boots the disposable API with `ENFORCE_CSRF=1`, `ENFORCE_MANDATORY_2FA=1` and `PUBLIC_APP_URL` set to the API's own origin. Under real CSRF, rewrite (do not strip) the browser's app Origin to the API origin at the proxy: the CORS allowlist only accepts configured public origins, and the CSRF check needs an exact same-origin Origin plus the session token. Fixture sessions come from `createTenant/createUser(..., { browserPolicy: true })` (CSRF header + TOTP enrolment) and are carried into Playwright contexts as cookies. Run one suite per API process; combining suites exhausts the per-IP login throttle (429).
