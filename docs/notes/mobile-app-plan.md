---
name: Mobile app plan
description: Durable architecture constraints for the ComplyTrack Expo mobile app
---

Use an Expo development client rather than Expo Go for ComplyTrack Mobile.

**Why:** Phase-two Bluetooth probes and PAT testers require native modules that Expo Go cannot load. Keeping the development-client setup in the MVP avoids a runtime/tooling migration when BLE drivers are introduced.

**How to apply:** Preserve the static Expo configuration and development-client dependency. Add BLE drivers behind native-safe abstractions, keep manual entry available when hardware is unavailable, and verify both iOS and Android production bundles.

Mobile issue creation must treat the fault record and its photo uploads as separate recoverable stages.

**Why:** Uploads can fail after the issue has already been persisted. Presenting that as a failed issue submission encourages retries that create duplicate faults.

**How to apply:** Persist the created issue identifier and pending photo state, retry attachments against the same issue, and clearly tell users the issue is saved even when its photos still need attention.
