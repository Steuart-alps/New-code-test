---
name: Storage happy-path fixture
description: Environment requirement for running destructive object-storage integration checks safely.
---

Required storage integration checks must use a dedicated non-production bucket and a unique per-run private prefix. The development application bucket is not a safe substitute, and the runner must fail closed when the dedicated bucket or Google signing credentials are unavailable.

**Why:** The checks upload and delete real objects and assert tenant ACL metadata; using the application bucket could damage or remove customer data, while an environment without provider credentials cannot prove the happy path.

**How to apply:** Provision the dedicated bucket and credential path outside application code, then run the serial fixture runner with cleanup in its exit trap. Keep local environments on the explicit storage-unavailable skip path unless required-storage mode is enabled.

**Provider-backed ACL suites:** `doc-track-object-acl.mjs` and `generic-document-object-acl.mjs` read stored ACL metadata through `openStorageFixture()` (exported by `tests/storage-happy-path-fixture.mjs`, same credential sources as the API) and confine every direct read/delete to the run prefix. Shared sign-in/cleanup lives in `tests/storage-acl-session.mjs`: it adapts to enforced CSRF/mandatory 2FA, adds a same-client `client_staff` user via `POST /users`, and purges plus re-counts the run's rows. Outside the dedicated fixture the provider checks print `SKIP:` and never touch application storage. The runner unsets `PRIVATE_OBJECT_DIR`/`PUBLIC_OBJECT_SEARCH_PATHS` because they override the test bucket/prefix.
