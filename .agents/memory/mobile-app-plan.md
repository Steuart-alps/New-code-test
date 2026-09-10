---
name: Mobile app plan
description: Durable architecture constraints for the ComplyTrack Expo mobile app
---

ComplyTrack Mobile currently uses stock Expo Go with the Replit-managed Expo CLI session; do not reintroduce a development client without revisiting the product decision.

**Why:** The current launch path is deliberately Expo Go-only, with SDK 57 dependency alignment and no EAS or custom development build. Native hardware work is future scope, not a reason to change the current preview flow.

**How to apply:** Keep the mobile workflow on `expo start --go`; use the Replit Preview on your phone flow for physical testing. Revisit the client choice only when native-only features are actually scheduled.

Expo Go 57 physical-device testing requires the Replit-managed sign-in handoff.

**Why:** A personal Expo Go account and the `replit-private-*` CLI session are rejected as mismatched accounts; manually signing into the private account is not supported.

**How to apply:** Log out of Expo Go first, then start from Replit's Preview on your phone panel and follow its managed sign-in steps. A QR copied outside that panel may not complete the handoff.

Mobile issue creation must treat the fault record and its photo uploads as separate recoverable stages.

**Why:** Uploads can fail after the issue has already been persisted. Presenting that as a failed issue submission encourages retries that create duplicate faults.

**How to apply:** Persist the created issue identifier and pending photo state, retry attachments against the same issue, and clearly tell users the issue is saved even when its photos still need attention.
