---
name: Typecheck vs build
description: The real build signal in this repo is esbuild/vite, not repo-wide tsc.
---

# Trust the build, not repo-wide tsc

Repo-wide `tsc --noEmit` fails here because it depends on generated codegen and built workspace package output that aren't present in the dev environment. The dev workflows compile sources directly via esbuild (api-server) and vite (frontend).

**How to apply:** verify changes with a clean esbuild/vite build + server start + live route responses. Don't treat the standing repo-wide typecheck failures as something a single task introduced — just confirm a file you changed isn't a new source of errors.
