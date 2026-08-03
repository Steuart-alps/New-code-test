---
name: Mobile app planned
description: User confirmed a native mobile app is planned for ComplyTrack; key drivers and design decisions to carry forward.
---

# ComplyTrack Mobile App

## Decision
User confirmed (2026-08-03) that a native React Native/Expo mobile app should be built alongside the existing web app.

## Primary drivers
- **Bluetooth device integration** — temperature probes (HACCP/KitchenTrack), PAT testers. Web Bluetooth is blocked on iOS; native CoreBluetooth is required.
- **Field use on iOS** — most UK field workers use iPhones/iPads; the web app has Safari limitations for Bluetooth.

## Why not web/PWA
- Safari on iOS does not support Web Bluetooth API regardless of browser brand (Chrome/Firefox on iOS all use WebKit).
- EU DMA opened alternative browser engines from iOS 17.4 but no iOS browser has shipped Web Bluetooth.

## Architecture implications
- Mobile app should talk to the **same existing API server** (`artifacts/api-server`) — no new backend needed.
- Auth: session-based auth already works; mobile will need cookie/token handling via Expo's fetch.
- Start with field-facing screens first: daily checklists, temperature logs, issue reporting (FixTrack).
- Bluetooth integration (temperature probe auto-fill) is a later phase after core screens are working.

## How to apply
- When building new API endpoints, consider mobile consumption: prefer JSON over redirects, avoid HTML responses.
- When designing UI flows, note which ones are most field-critical (checklist submission, temperature recording, issue logging) — these are the mobile MVP screens.
- Use `react-native-ble-plx` for Bluetooth in the Expo app (requires bare workflow or Expo dev client, not Expo Go).
