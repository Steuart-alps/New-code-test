---
name: API route middleware
description: Which middleware to use for role-gated routes in the api-server; common mistake of importing a non-existent file.
---

## Rule
Admin-only route handlers use `requireClientAdmin` imported from `../middleware/requireAuth`.

```typescript
import { getClientId, requireClientAdmin } from "../middleware/requireAuth";

router.post("/things", requireClientAdmin, async (req, res) => { ... });
```

**Why:** There is no `requireCanAdmin` middleware file and no separate admin middleware module. All role guards live in `requireAuth.ts`. The available exports are:
- `requireAuth` — any authenticated user
- `requireRole(...roles)` — specific roles
- `requireConsultant` — consultant only
- `requireClientAdmin` — consultant or client_admin

**How to apply:** Whenever adding a new route file that needs admin-only endpoints, import `requireClientAdmin` from `requireAuth`. Do not create or import `requireCanAdmin`.

## Public route ordering
Place token-protected public routers before any root-mounted router that installs an unscoped authentication middleware. A router mounted at the API root can intercept unrelated paths even when all its handlers look narrowly named.

**Why:** An anonymous contractor portal request returned 401 before its token handler ran. Rebuilding and isolating the test server did not change the result; an earlier root-mounted router's authentication middleware was the cause.

**How to apply:** When adding or debugging a public API route, inspect middleware installed by earlier root-mounted routers, not just the route's own handlers. Prefer a path-scoped auth boundary where practical, and verify public access without a session.
