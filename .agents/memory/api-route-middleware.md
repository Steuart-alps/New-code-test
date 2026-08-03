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
