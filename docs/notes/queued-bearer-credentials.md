---
name: Queued bearer credentials
description: Security rules for contractor action, quote, and portal links that pass through approval queues.
---

Persist only token digests in lookup columns. Any approval-queue subject, HTML, text, or preview JSON must contain placeholders rather than working bearer links; keep the raw values in an authenticated encrypted payload and hydrate them only for an authorized preview or provider dispatch.

**Why:** Hashing dedicated token columns did not protect credentials duplicated inside rendered email drafts. Replacement ordering also matters: replace a complete portal URL before its token suffix or hydration creates a broken duplicated prefix.

**How to apply:** Route every queue create/update path through the same sanitize/encrypt boundary, reject unrecognized pasted bearer URLs, scrub all rendered fields during migrations, and verify migration reruns plus exact post-hydration links.