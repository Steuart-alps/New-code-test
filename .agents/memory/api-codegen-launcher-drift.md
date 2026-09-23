---
name: API codegen launcher drift
description: An environment-specific Orval launcher mismatch can make deterministic API codegen appear to rewrite unrelated generated files.
---

Run API codegen through the package script with the installed Orval module path, and keep source consumers from compiling while generated directories are being replaced.

**Why:** The workspace launcher can retain a path to an Orval peer variant that is no longer installed. Synthetic copied workspaces can also resolve the custom mutator differently, while direct codegen can briefly remove generated files and race concurrent typechecks.

**How to apply:** Use `pnpm --dir lib/api-spec run codegen` for the authoritative output, compare the generated trees across two runs, and serialize codegen against API/web typechecks with a shared lock. Do not edit generated clients by hand.