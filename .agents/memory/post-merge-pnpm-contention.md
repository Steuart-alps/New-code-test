---
name: Post-merge pnpm contention
description: Why post-merge dependency reconciliation checks pnpm's installed lock marker before installing.
---

When post-merge setup runs while several pnpm-based workflows are active, a redundant workspace install can stall before emitting output. Treat an exact match between the repository lockfile and pnpm's installed lock marker as proof that dependency installation can be skipped.

**Why:** Increasing the timeout from 20 seconds to two minutes did not help and both output streams remained empty. Skipping the redundant install let setup and workflow reconciliation complete in under a second.

**How to apply:** Preserve the lockfile comparison fast path. Run a frozen, offline install only when the installed marker is missing or differs, and keep enough timeout for a real dependency update.