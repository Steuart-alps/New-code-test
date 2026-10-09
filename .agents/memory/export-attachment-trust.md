---
name: Export attachment trust
description: Why cancellation exports omit unmarked objects instead of claiming them on demand
---

An export may include an object only if its existing ACL says it is private and owned by the exporting tenant. A tenant-scoped database row is not sufficient permission to assign an ACL during export. Missing or foreign ACLs belong in the omission manifest, not in the ZIP.

**Why:** A stale or incorrectly pointed reference could otherwise cause a client export to take ownership of another client's file. The export is a read operation and should not change storage ownership.

**How to apply:** If older legitimate uploads have missing ACLs, reconcile them in a separate, ownership-verified migration rather than weakening the export. Keep the original reference and omission reason in the manifest so the gap is visible.