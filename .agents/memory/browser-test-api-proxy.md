---
name: Browser test API proxy
description: Running real frontend browser tests against an isolated test-mode API.
---

When browser tests serve Vite on a separate port but forward its API requests to a private test-mode server, remove the browser's Vite Origin header from upstream proxy requests. Complete mandatory authenticator enrolment for the seeded admin before visiting protected pages.

**Why:** A browser route interception that forwards the original Origin looks cross-origin to the API, so mutating requests fail its CORS check despite appearing same-origin to the browser. Newly registered test admins can authenticate but are held on the two-factor setup screen until they enrol.

**How to apply:** Keep browser-facing requests same-origin, use an isolated test API for registration and verification fixtures, complete TOTP setup through its normal endpoints, and strip the forwarded Origin at the proxy boundary; do not disable the app's CORS or two-factor checks.