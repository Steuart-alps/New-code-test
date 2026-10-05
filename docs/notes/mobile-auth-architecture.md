---
name: Mobile auth architecture
description: How bearer token auth works for the Expo mobile app — token lifecycle, endpoints, middleware, storage
---

## Rule
The mobile app uses a long-lived bearer token (90-day expiry) stored in `expo-secure-store`. Every authenticated API request sends `Authorization: Bearer <token>`.

## How it works

### Backend
- **Table**: `mobile_sessions(id, user_id, token, expires_at, created_at)` — created by `migrateMobileSessions()` in `runtimeMigrations.ts`
- **Login**: `POST /api/auth/mobile-login` — verifies password (no 2FA), inserts a row, returns `{ token, user }`
- **Logout**: `POST /api/auth/mobile-logout` — deletes the token row
- **`loadUser`** in `requireAuth.ts` now checks `Authorization: Bearer <token>` against `mobile_sessions` if session auth fails; wraps in try/catch so pre-migration environments don't crash

### Frontend (mobile)
- `lib/auth.tsx` — `AuthProvider` context: loads token from SecureStore on mount, validates with `/api/auth/me`, calls `setAuthTokenGetter` and `setToken` so both generated hooks AND `apiFetch` send the bearer token
- `lib/api.ts` — `apiFetch` wrapper for non-spec endpoints (fix-track, traintrack, doctrack, auth); reads token from module-level `_token`
- Root `_layout.tsx` — calls `setBaseUrl(https://${EXPO_PUBLIC_DOMAIN})` at module level; wraps with `AuthProvider` inside `QueryClientProvider`; redirects unauthenticated users to `/(auth)/login`

## Why
Session cookies don't work in native mobile apps. Bearer tokens in SecureStore are the standard mobile auth pattern.

## How to apply
- Any new API endpoint just needs `requireAuth` middleware — it already handles both cookie and bearer token
- To add 2FA for mobile login, add a `pendingMobileToken` table + TOTP verification step before issuing the real token
- `expo-secure-store` must be pinned to `~15.0.8` (Expo SDK 54 compatible)
