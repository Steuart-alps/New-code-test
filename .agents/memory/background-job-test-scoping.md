---
name: Background-job test scoping
description: Keep integration assertions reliable for jobs that scan across tenants in a shared database.
---

**Rule:** For tenant-sweeping background jobs, assert delivery for the test tenant and its recipients rather than assuming the global candidate count contains only fixture rows.

**Why:** The shared development/test database can contain unrelated active overdue records. A job's global `hiresFound` total may include those records even when no corresponding users are eligible to receive notifications.

**How to apply:** Create and clean up test tenants and records; scope assertions to the expected client, recipients, and notification contents. Treat global scan counts as diagnostic unless the test uses an isolated database.