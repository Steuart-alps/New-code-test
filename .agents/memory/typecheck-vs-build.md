---
name: Typecheck vs build
description: Why `tsc` typecheck fails repo-wide here but the app still builds and runs.
---

# Typecheck is not the build signal here

Running `pnpm --filter ... run typecheck` (`tsc --noEmit`) fails across many files with errors like `Module '@workspace/db/schema' has no exported member 'sitesTable'` and missing `@workspace/api-client-react` hooks.

**Why:** these depend on generated codegen (orval client, api-zod) and the built `dist` of workspace packages, which are not present in the dev environment. `tsc` can't resolve them, but the dev workflows compile with **esbuild** (api-server `build.mjs`) and **vite** (frontend), which resolve sources directly.

**How to apply:** Treat a clean esbuild/vite build + server start + route responses as the real verification, not `tsc`. Don't chase these repo-wide typecheck errors as if a single task introduced them — confirm a file you changed isn't the source, then move on.
