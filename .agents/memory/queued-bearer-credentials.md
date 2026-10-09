---
name: Queued bearer credentials
description: Security rules for contractor action, quote, and portal links that pass through approval queues.
---

Persist only token digests in lookup columns. Any approval-queue subject, HTML, text, or preview JSON must contain placeholders rather than working bearer links; keep the raw values in an authenticated encrypted payload and hydrate them only for an authorized preview or provider dispatch.

**Why:** Hashing dedicated token columns did not protect credentials duplicated inside rendered email drafts. Replacement ordering also matters: replace a complete portal URL before its token suffix or hydration creates a broken duplicated prefix.

**How to apply:** Route every queue create/update path through the same sanitize/encrypt boundary, reject unrecognized pasted bearer URLs, scrub all rendered fields during migrations, and verify migration reruns plus exact post-hydration links.

Automated contractor portal reminders retain manager approval rather than dispatching directly.

**Why:** The existing approval requirement applies to contractor communications even when a feature request describes scheduled emails as being “sent”. Replacing a portal token while an approved message is awaiting dispatch can also invalidate the link the contractor receives.

**How to apply:** Preserve the approval queue for scheduled portal messages and coordinate link rotation with pending and in-flight drafts. Do not silently bypass approval to satisfy reminder timing.

Reminder scheduling must preserve already issued links for their promised lifetime and must never undo an explicit manager revocation.

**Why:** Replacing the sole bearer while its replacement is only awaiting approval locks contractors out, and rotating at the 30-day milestone prematurely ends a 60-day reminder's 90-day link. Clearing revocation automatically also overrides the manager's access decision.

**How to apply:** Keep reminder issuance separate from explicit manager reissue. Test previously delivered and manually issued links across both reminder windows, plus revocation, before changing the token lifecycle.