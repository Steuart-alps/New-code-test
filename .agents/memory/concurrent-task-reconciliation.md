---
name: Concurrent task reconciliation
description: Safeguard for main-workspace changes while isolated task work merges concurrently.
---

Concurrent task reconciliation can remove untracked helper files created in the main workspace while leaving edits that import them.

**Why:** A task merge completed during a backlog batch and removed newly created untracked helper files without reverting the page import, producing a delayed typecheck failure.

**How to apply:** After any task merge or rebase during isolated work, inspect `git status`, rebuild referenced TypeScript packages if declarations changed, run the combined typecheck, and rerun feature-level integration tests for both the task and newly merged auth/routing changes. Typecheck alone will not catch wrong API prefixes, wrong-table lookups, migration ordering, or partial-update data loss.