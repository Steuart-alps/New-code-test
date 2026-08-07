---
name: Subagent delegation pitfalls
description: Recurring mistakes implementation subagents make in this codebase and what to specify in tasks.
---
- Subagents invent their own tenant helpers instead of using `getClientId` from `middleware/requireAuth` (one wrote a broken `req.session.clientId` version). Always instruct: "derive clientId via getClientId from requireAuth; never write a local helper" and review new route files for it.
- New web pages must use the shared `@/lib/api` apiFetch and append the consultant's `activeClientId`; local raw fetch helpers silently break consultant client-switching.
- New mutation endpoints must copy the active-department/site predicate used by that module's existing GET/PUT routes, or dept-restricted staff can act cross-department.
- Any endpoint accepting a client-supplied identity (staffRosterId etc.) or siteId must verify ownership against clientId server-side.

**How to apply:** paste these constraints into every implementation-subagent task; architect-review the batch afterwards — it reliably catches these classes.
