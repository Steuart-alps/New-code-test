---
name: Mobile app plan
description: Architecture, screens, and status of the ComplyTrack Expo mobile app
---

## Status: First build complete

The mobile app (`artifacts/mobile`) is built and running on Expo SDK 54 / React Native 0.81.

## Screen structure

```
app/
  _layout.tsx           — root: AuthProvider + 5-screen Stack
  (auth)/
    login.tsx           — email/password login → /api/auth/mobile-login
  (tabs)/
    _layout.tsx         — 5 tabs: Today | Checks | Issues | Docs | Profile
    index.tsx           — Today: fire/water/kitchen status cards + recent issues + quick actions
    checks.tsx          — Module grid: FireTrack | LegionellaTrack | KitchenTrack
    issues.tsx          — FixTrack issues list with filter chips + FAB
    docs.tsx            — DocTrack files + TrainTrack records (tab switcher)
    profile.tsx         — User info + sign-out
  checks/[type].tsx     — Log a fire or water check (full form with result, temp, site, etc.)
  issues/new.tsx        — Report a new maintenance issue (type grid + priority + site)
  issues/[id].tsx       — Issue detail view with status update buttons
```

## API calls

| Screen | Endpoint | Via |
|--------|----------|-----|
| Today | `/api/fire-safety/status` | apiFetch |
| Today | `/api/legionella/status` | apiFetch |
| Today | `/api/fix-track/issues` | apiFetch |
| Today | `/api/sites` | apiFetch |
| Issues | `/api/fix-track/issues` | apiFetch |
| Checks (fire) | `/api/fire-safety` POST | apiFetch |
| Checks (water) | `/api/legionella` POST | apiFetch |
| Docs | `/api/doctrack/files` | apiFetch (graceful 404) |
| Docs | `/api/traintrack/staff` | apiFetch (graceful 404) |
| Issue detail | `/api/fix-track/issues/:id` PUT | apiFetch |
| Profile | `/api/sites` | apiFetch |

## Design tokens
- Deep Navy `#162d42` — nav header background
- Steel Blue `#7ea7c9` — primary interactive
- Cream `#f7f2e4` — secondary background
- Font: Inter (400/500/600/700) from @expo-google-fonts/inter
- Radius: 4px (slightly more rounded than web's 2px for mobile comfort)

## Key dependencies
- `expo-secure-store ~15.0.8` — token storage (pin this version for Expo SDK 54)
- `@workspace/api-client-react` — generated hooks + setBaseUrl/setAuthTokenGetter
- `expo-haptics` — feedback on form actions

## Deferred / known gaps
- KitchenTrack: mobile shows info card directing to web app (diary is too complex for v1)
- 2FA: mobile login skips TOTP; users with 2FA enabled can still log in (intentional for v1 — add dedicated mobile 2FA step if needed)
- DocTrack/TrainTrack: API endpoints (`/api/doctrack/files`, `/api/traintrack/staff`) may not exist yet — both calls use `.catch(() => [])` graceful fallback
- Push notifications: not implemented (planned for future)
- Photo attachments on checks: not implemented

## Why Expo Go (not development build)
Using Expo Go for easy testing. A native development build would be needed for push notifications, Bluetooth sensors, and biometric auth.
