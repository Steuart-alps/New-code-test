---
name: Post-merge pnpm contention
description: Why post-merge dependency reconciliation checks pnpm's installed lock marker before installing.
---

When post-merge setup runs while several pnpm-based workflows are active, a redundant workspace install can stall before emitting output. Treat an exact match between the repository lockfile and pnpm's installed lock marker as proof that dependency installation can be skipped.

**Why:** Increasing the timeout from 20 seconds to two minutes did not help and both output streams remained empty. Skipping the redundant install let setup and workflow reconciliation complete in under a second.

**How to apply:** Preserve the lockfile comparison fast path. When the marker differs, try a frozen offline install first, but retry the same frozen install with downloads enabled if pnpm reports a missing offline tarball. Keep enough timeout for a real dependency update.