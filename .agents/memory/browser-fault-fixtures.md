---
name: Browser fault fixtures
description: Stable mocked read outages and coverage boundaries for legacy page browser tests.
---

Keep a mocked read outage active until the test explicitly retries, rather than failing only the first request.

**Why:** Actual page components can issue multiple initial photo reads while auth and other fixtures settle. A single failed response was followed by a successful read before the assertion, hiding the expected error UI.

**How to apply:** Hold the failed-read fixture state through the visible error assertion, restore the service, click the real retry control, and verify the warning clears without losing the record.

Mount redirected legacy page components in a test-only harness instead of changing production routing to make them reachable.

**Why:** SafeTrack currently redirects to DocTrack. Re-enabling a legacy route merely for regression coverage changes user-facing behavior outside that coverage's purpose.

**How to apply:** Render the real page and shared providers, not copied row/uploader markup. Mocked browser uploads prove UI wiring, session-header use and error handling; they do not prove real cloud-storage or tenant-ACL behavior.