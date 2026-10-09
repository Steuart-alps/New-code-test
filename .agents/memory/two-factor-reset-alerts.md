---
name: Two-factor reset alert outbox
description: Admin 2FA reset security alerts are queued with the reset and retried; the queue stores no secrets or rendered mail.
---

The admin `POST /users/:id/reset-2fa` route queues its security alert in `two_factor_reset_notifications` inside the reset's transaction, makes one immediate attempt, and leaves retries to `runTwoFactorResetAlertRecovery` (boot + every minute, `src/lib/twoFactorResetAlerts.ts`).

**Why:** a provider outage used to log the failure and drop the alert. Email failure must never undo or repeat the reset.

**How to apply:**
- Store only user id, a random delivery key and the reset time. Render at send time; never persist secrets, recovery codes, hashes or the rendered message (unlike the bike outbox, which stores rendered digests).
- The provider key is `delivery_key` plus a digest of the rendered content, so a changed name/address never reuses a key with a different payload.
- Same lease / 23h-window / expire rules as [restart-safe delivery](restart-safe-notification-delivery.md). New rows wait a 2-minute grace so recovery does not race the route's first attempt.
- A reset that clears nothing (retried request) queues no alert; one open alert per user covers a second reset while undelivered.
- Tests: `test:two-factor-reset-alerts` uses `clockOffsetSeconds` + `userIds` scope so the harness API's own cron cannot pick up fixture rows mid-test.
