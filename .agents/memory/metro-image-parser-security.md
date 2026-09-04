---
name: Metro image parser security
description: Security decision for Metro's transitive image-size dependency.
---

Expo/Metro currently depends on the archived `image-size` package, whose ICNS, JXL, and HEIF parsers have unpatched infinite-loop denial-of-service advisories. Keep the workspace override to the maintained `image-size-safe` fork and its pnpm compatibility patch until Metro removes or replaces the dependency.

**Why:** The upstream package has no patched release. The maintained fork hardens the malformed-container loops but only accepts byte arrays, while Metro also passes image file path strings during production bundling; the patch restores that legacy input behavior.

**How to apply:** When upgrading Expo, React Native, or Metro, check whether `image-size` remains in the graph. Remove the override and patch only after the parent dependency ships a safe replacement, and verify a clean all-platform Expo export rather than only parsing a PNG buffer directly.