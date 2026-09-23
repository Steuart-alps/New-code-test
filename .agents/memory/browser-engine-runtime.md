---
name: Browser engine runtime
description: Playwright browser-engine coverage depends on system libraries beyond the npm package.
---

Firefox and Chromium can run the compliance tracker browser harness in the current Nix environment after installing the available GTK/X11/media packages. Playwright WebKit may still fail because its bundled MiniBrowser requires exact Ubuntu sonames such as libgles2 and a matching GStreamer codec library that the available Nix package index does not provide.

**Why:** Installing the WebKit browser archive alone is not enough; host validation and the MiniBrowser loader both require version-specific native libraries.

**How to apply:** Keep cross-engine tests parameterized and make missing browser binaries or host libraries explicit skips. Do not report a WebKit pass unless the MiniBrowser actually launches and completes the UI assertions.