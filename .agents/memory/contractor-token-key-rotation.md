---
name: Contractor token key rotation
description: Safe procedure and invariants for rotating encryption keys used by approved contractor email drafts.
---

Every dedicated contractor-token encryption key must have a unique, never-reused version. Existing envelopes must be readable with the retained previous key and re-encrypted onto the current version before the previous key is removed.

**Why:** Reusing or omitting a version can make ciphertext created by a different key appear current, delaying failure until an approved email is previewed or dispatched. Rolling deployments can also create old-version drafts after a migration has already run.

**How to apply:** Stop or drain old writers. Configure the new dedicated key and a new version while retaining the old key in the previous-key ring. Start the new version, wait for migrations and readiness, and verify no stale envelope versions remain. Remove the retired key only in a later deployment, retaining rollback access until that deployment is healthy. Never run database-wide rotation tests with temporary keys; target isolated fixture rows.

Do not rotate the session secret in place while it remains the current contractor encryption key. Move drafts onto a uniquely versioned dedicated key first, retaining the original session key as `session-v1` if the session secret must change during migration.

**Why:** The session fallback has a fixed version, so two different session secrets cannot both be identified as the current `session-v1` key. A retained historical key must identify the original draft key, not the new login-session secret.

**How to apply:** Keep real keys in Replit Secrets. Use dedicated current-key versions and explicitly retained historical keys for rotation; never infer historical key material from the live session secret after it changes.

**Preflight before removing a key:** run `node artifacts/api-server/dist/contractor-key-preflight.mjs --version <old-version>` with the API's environment (e.g. the Render shell). It is read-only and prints aggregate counts by envelope format, key version and queue state, including legacy unversioned payloads; it never prints payloads, links, recipients or key values. It reports SAFE (exit 0) only when no active or historical draft names the version, no legacy payload remains, the key configuration is valid, and `--writers-drained` confirms every instance still writing with the old key has stopped. Keys themselves live in the host's secret environment variables, never in the repository.
