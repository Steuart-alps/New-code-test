---
name: Browser engine runtime
description: Where Playwright Firefox/WebKit tests can actually run, and why missing engines must fail, not skip.
---

Cloud (Claude Code) sessions ship only Chromium under /opt/pw-browsers, and their network policy blocks Playwright's browser CDN (playwright.download.prss.microsoft.com), so `playwright install firefox webkit` fails there. GitHub Actions `ubuntu-latest` installs both with `pnpm exec playwright install --with-deps <browser>`, and the native libraries (GTK for Firefox, GStreamer/GLES for WebKit) come with `--with-deps`. Path-filtered matrix workflows already run cross-engine suites: `.github/workflows/contractor-approvals-browser.yml` and `.github/workflows/hot-tub-pdf-browser.yml` (2026-10-16: the inspection PDF download passed in Chromium, Firefox and WebKit).

**Why:** a skipped engine looks like a pass. Steuart asked (2026-10-16) that unavailable browsers fail explicitly.

**How to apply:** keep cross-engine tests parameterised (e.g. `HOT_TUB_BROWSER`), throw when the engine cannot launch, and run Firefox/WebKit through a workflow (a draft PR, or workflow_dispatch) instead of in a cloud session. Report a WebKit pass only when the engine launched and the assertions completed. Playwright WebKit on Linux is not Safari on macOS/iOS, so it does not prove iPhone download behaviour.
