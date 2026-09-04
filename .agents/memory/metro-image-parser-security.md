---
name: Metro image parser security
description: Security decision for Metro's transitive image-size dependency.
---

Expo/Metro currently depends on the archived `image-size` package, whose ICNS, JXL, and HEIF parsers have unpatched infinite-loop denial-of-service advisories. Keep the workspace override to the maintained `image-size-safe` fork until Metro removes or replaces the dependency.

**Why:** The upstream package has no patched release, while the maintained fork preserves both the default and named APIs Metro uses and hardens the malformed-container loops.

**How to apply:** When upgrading Expo, React Native, or Metro, check whether `image-size` remains in the graph. Remove the override only after the parent dependency ships a safe replacement, and verify Metro can still inspect a small PNG buffer.