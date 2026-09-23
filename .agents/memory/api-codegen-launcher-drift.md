---
name: API codegen launcher drift
description: An environment-specific Orval launcher mismatch can make deterministic API codegen appear to rewrite unrelated generated files.
---

When API codegen unexpectedly rewrites unrelated generated client files, verify the installed Orval launcher and peer-variant path before changing the OpenAPI contract or generated output.

**Why:** The workspace launcher can retain a path to an Orval peer variant that is no longer installed. The direct generator may then use a different dependency-resolution path from the repository's deterministic codegen validation, producing noisy but unrelated diffs.

**How to apply:** Run the repository's API codegen drift check and compare its isolated output before accepting broad generated changes. Repair the ignored local launcher/install link or regenerate from the matching installed Orval package; do not edit generated clients by hand.