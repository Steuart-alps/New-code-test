---
name: Water outlet read boundaries
description: Department-safe reads of Legionella outlets and their joined readings.
---

Scope the outlet and every joined reading independently to the recipient's accessible sites. Do not infer a reading's department solely from its outlet.

**Why:** Outlet links have historically been accepted without checking that the reading and outlet belong to the same site, so an otherwise accessible outlet may reference an inaccessible site's reading.

**How to apply:** When adding outlet reports, status views, or exports, filter by the outlet site's department and by each reading's own site department. Treat unassigned sites according to the established shared-site access rules; validate new outlet links at write time separately.