---
name: Multi-tenant authz
description: How tenant isolation is enforced — consultant_clients membership, canAccessClient, enforceClientAccess. Rules for adding new endpoints.
---

# Multi-tenant authorization model

The "consultant" role is overloaded: real H&S consultants manage *multiple* client businesses, and self-signup account owners also get this role for their single account. Access is resolved through an explicit membership model, not the role alone.

**The rule:** never trust a browser-supplied `clientId`. Every consultant's permitted clients live in the `consultant_clients` table (plus their own `users.client_id`).

**How to apply when adding endpoints:**
- Per-request, `loadUser` populates `req.allowedClientIds` for consultant users; a global `enforceClientAccess` middleware rejects any query/body `clientId` outside that set (mounted right after `loadUser`).
- Resolve tenant scope with `getClientId(req)` (already vetted) and gate direct resource-ID access with `canAccessClient(req, resource.clientId)` — never with `role !== "consultant"` bypasses.
- Any flow that provisions a new client for a consultant (registration, client creation, self-provisioning) must insert a `consultant_clients` row or the creator locks themselves out.

**Why:** self-signup owners previously could pass another account's id and read/write its data (cross-tenant IDOR); fixed app-wide via this membership model.

**Web client gotcha:** the shared `@/lib/api` apiFetch only prefixes `/api` — it does NOT append activeClientId. Pages must append `clientId=<activeClientId>` themselves (see usePremisesApi/useIncidentsApi hook pattern); page-local raw fetch helpers have repeatedly caused consultant cross-tenant bugs.
