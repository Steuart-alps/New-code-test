---
name: Storage happy-path fixture
description: Environment requirement for running destructive object-storage integration checks safely.
---

Required storage integration checks must use a dedicated non-production bucket and a unique per-run private prefix. The development application bucket is not a safe substitute, and the runner must fail closed when the dedicated bucket or Google signing credentials are unavailable.

**Why:** The checks upload and delete real objects and assert tenant ACL metadata; using the application bucket could damage or remove customer data, while an environment without provider credentials cannot prove the happy path.

**How to apply:** Provision the dedicated bucket and credential path outside application code, then run the serial fixture runner with cleanup in its exit trap. Keep local environments on the explicit storage-unavailable skip path unless required-storage mode is enabled.