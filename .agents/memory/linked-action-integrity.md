---
name: Cross-module action authorization
description: General rule for access controls on shared action records linked to another module.
---

Treat cross-module links as authorization boundaries, not merely labels. A generic action list or update route must enforce the linked source record's visibility rules, even if the source module already does so.

**Why:** Restricting the source page alone left the generic actions endpoint able to show or modify linked actions for another department. The fact that two records share a tenant is not sufficient to grant the same person access to both.

**How to apply:** Whenever a shared record points to a source in another module, verify the source module's scope rules in all generic read and mutation paths. Review historical records as well as new writes before relying on the link for workflow enforcement.