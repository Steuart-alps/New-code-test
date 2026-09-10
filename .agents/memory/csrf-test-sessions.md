---
name: Browser CSRF and test sessions
description: The production browser CSRF boundary and how the existing API integration harness authenticates.
---

Cookie-authenticated browser mutations require a session-bound CSRF header. Bearer-authenticated mobile requests do not need that header because the bearer credential is not sent automatically by a cross-site browser.

**Why:** The existing API integration suites authenticate through session fixtures but do not bootstrap browser CSRF headers. Enforcing the browser rule unconditionally in test mode causes unrelated tenant/config suites to fail before they reach their assertions.

**How to apply:** Keep the production check enabled. If expanding CSRF coverage, run tests with the explicit enforcement flag and have the fixture fetch the CSRF endpoint; do not weaken production checks to accommodate the legacy default harness.