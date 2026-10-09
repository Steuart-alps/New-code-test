---
name: Shell runtime loader hangs
description: Historical (Replit-only) — A process-local workaround when even Node version checks stall in the shell.
---

> **Historical (Replit-only, 2026-10-09):** ComplyTrack no longer runs on Replit (see `replit-removed-render-only.md`). The `LD_AUDIT`/`REPLIT_LD_LIBRARY_PATH` loader injection was specific to the Replit workspace. Kept for context only.

When Node or pnpm produces no output and even `node --version` hangs, check the wrapped Node launcher before blaming dependency installation or lock contention. In this environment, clearing `LD_AUDIT` and `REPLIT_LD_LIBRARY_PATH` for the child command restored normal execution.

**Why:** Both a package add and an isolated version check stalled until timeout; the wrapper was injecting a runtime loader. The same Node binary returned its version immediately without that injection, and scoped package installation then completed normally.

**How to apply:** Use `export LD_AUDIT= REPLIT_LD_LIBRARY_PATH=;` only inside the affected shell command before Node/pnpm. Do not persist these overrides in application configuration or change secrets. Managed app workflows may work normally and do not need this workaround. Distinguish this from genuine workspace install contention.

If both wrapped and unwrapped Node still time out after clearing loader settings, check available memory before trying dependencies or another install.

**Why:** running the entire Project validation group concurrently saturated the workspace's memory; even Node version checks stalled. Pausing unrelated validation workflows restored Node immediately.

**How to apply:** inspect memory and process states, stop unneeded running validation jobs without deleting their configuration, then run focused checks sequentially. Restore failed app services afterward; do not restart the whole Project group.