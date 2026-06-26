---
name: Multi-tenant authz caveat
description: getClientId trusts client-supplied clientId for consultant role — cross-tenant risk.
---

# getClientId cross-tenant caveat

`getClientId(req)` (api-server `middleware/requireAuth.ts`) returns, for a user with role `"consultant"`, `req.query.clientId ?? req.body?.clientId` when supplied, otherwise `req.currentUser.clientId`.

**Why this exists:** real H&S consultants legitimately manage multiple client businesses, so the app lets them pass a `clientId`. BUT self-signup account owners are *also* assigned role `"consultant"` and linked to one auto-provisioned client. There is no consultant↔client membership model, so the two cases are indistinguishable.

**Risk:** a self-signup owner can pass another account's `clientId` and operate on it (billing checkout/portal/config, sites, etc.) — cross-tenant access.

**How to apply:** A proper fix needs a membership/ownership table to constrain which clientIds a consultant may act on; it is app-wide (every consultant endpoint), not billing-specific. Do not "fix" it piecemeal in one route — that gives false assurance while leaving the rest open.
