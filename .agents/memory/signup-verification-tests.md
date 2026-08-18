---
name: Signup verification tests
description: The integration-test contract for self-registration after email verification was introduced.
---

Self-registration no longer creates an authenticated session until the email verification token has been confirmed. Integration tests that create accounts must follow the same flow: register, verify the token through the verification endpoint, then log in.

**Why:** Requiring a confirmed email prevents unverified addresses from accessing tenant data or receiving compliance alerts, while preserving a realistic end-to-end test of the new onboarding contract.

**How to apply:** Keep any test-only token exposure strictly limited to the non-production test environment; production responses must never return verification tokens.