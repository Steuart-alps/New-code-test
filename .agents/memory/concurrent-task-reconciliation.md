---
name: Concurrent task reconciliation
description: Safeguard for main-workspace changes while isolated task work merges concurrently.
---

Concurrent task reconciliation can remove untracked helper files created in the main workspace while leaving edits that import them.

**Why:** A task merge completed during a backlog batch and removed newly created untracked helper files without reverting the page import, producing a delayed typecheck failure.

**How to apply:** After any task merge or reconciliation during main-workspace work, immediately inspect `git status` and run the combined typecheck before building further on the current diff. Prefer completing and validating coherent file sets before allowing another merge boundary.