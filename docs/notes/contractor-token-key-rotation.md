---
name: Contractor token key rotation
description: Safe procedure and invariants for rotating encryption keys used by approved contractor email drafts.
---

Every dedicated contractor-token encryption key must have a unique, never-reused version. Existing envelopes must be readable with the retained previous key and re-encrypted onto the current version before the previous key is removed.

**Why:** Reusing or omitting a version can make ciphertext created by a different key appear current, delaying failure until an approved email is previewed or dispatched. Rolling deployments can also create old-version drafts after a migration has already run.

**How to apply:** Stop or drain old writers. Configure the new dedicated key and a new version while retaining the old key in the previous-key ring. Start the new version, wait for migrations and readiness, and verify no stale envelope versions remain. Remove the retired key only in a later deployment, retaining rollback access until that deployment is healthy. Never run database-wide rotation tests with temporary keys; target isolated fixture rows.