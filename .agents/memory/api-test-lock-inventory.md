---
name: API test lock inventory
description: Every api-server test:* script must be classified in test-api-integration-lock.sh; fresh-schema runs are locked, not pure.
---

`pnpm --filter @workspace/api-server run test:api-runner-lock` fails closed: any `test:*`
package script missing from its explicit inventory fails with a message naming the script.
When you add a test, add it to exactly one set in `artifacts/api-server/tests/test-api-integration-lock.sh`:

- `directLocked`: `bash tests/run-db-workflow.sh tests/<file>.mjs` (anything using the shared `DATABASE_URL`).
- `runnerLocked`: `bash tests/run-<name>.sh` whose runner sources `tests/api-integration-lock.sh`.
- `freshSchema`: `bash tests/run-fresh-schema.sh [tests/<file>.mjs ...]`, or a wrapper that only delegates to it.
- `pure`: static assertions, in-memory fakes and unique mkdtemp outputs only (plus `pureEntrypoints`).
  Bundled `.ts` unit tests use `bash tests/run-bundled-unit.sh tests/<file>.ts <cjs|esm>`.

**Why:** fresh-schema suites use a private initdb cluster, so they cannot touch shared data, but
`run-fresh-schema.sh` still takes the shared lock because bundling and booting the API compete for
memory. Treating them as pure would let them run unserialized. Scripts that wrote to fixed
`/tmp/<name>` bundles collided between concurrent runs and users, so they could not be pure either.

**How to apply:** when in doubt, lock it. Some pure tests import `@workspace/db` through source
modules (lazy pool, never queried); prove purity by running them with an unresolvable `DATABASE_URL`.
