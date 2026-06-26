---
name: Multi-tenant authz caveat
description: Self-signup owners share the "consultant" role, which can pass an arbitrary clientId — cross-tenant risk.
---

# Cross-tenant authz caveat

The "consultant" role is overloaded: real H&S consultants legitimately manage *multiple* client businesses, but self-signup account owners are also given this role for their single account. The access helper therefore lets any consultant-role user act on a `clientId` supplied by the browser.

**Risk:** a self-signup owner can target another account's id and act on it (billing and core data alike).

**Why it isn't fixed inline:** there is no consultant↔client membership model to tell the two cases apart, and the gap spans every consultant endpoint — fixing one route gives false assurance. A real fix needs a membership/ownership model and must be applied app-wide.
