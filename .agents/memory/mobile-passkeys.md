---
name: Mobile native passkeys
description: How the Expo app's native passkey sign-in fits the mandatory TOTP policy, and what a working build needs.
---

## Rule
On mobile a passkey replaces the email and password only. `POST /api/auth/mobile-passkeys/authenticate`
answers a verified passkey exactly like a correct password: a `pendingToken` for the unchanged
`/auth/mobile-login/verify-totp` step, or `requires2faSetup` + the web setup link. It never issues a
bearer. Mobile passkeys are discoverable and user-verified (UV required) because they stand in for the password.

## How it works
- Routes live in `api-server/src/routes/mobilePasskeys.ts` (not auth.ts). Bearer clients have no cookie
  session, so challenges sit in the runtime-only `mobile_passkey_challenges` table as a SHA-256 digest of
  a single-use token (deleted on use; 5-minute expiry).
- Same RP ID as the web (`getPasskeyRpId()`), so passkeys saved to iCloud Keychain / Google Password
  Manager from the web work in the app. Accepted origins: web origin, `https://<rpId>` (iOS) and
  `android:apk-key-hash:<b64url sha256>` per `MOBILE_ANDROID_CERT_SHA256` fingerprint.
- `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` (routes/mobileAppLinks.ts,
  mounted before the web build's index.html fallback) are 404 until `MOBILE_IOS_TEAM_ID` +
  `MOBILE_IOS_BUNDLE_ID` / `MOBILE_ANDROID_PACKAGE` + `MOBILE_ANDROID_CERT_SHA256` are set.
- Mobile `app.config.js` reads `MOBILE_IOS_BUNDLE_ID`, `MOBILE_ANDROID_PACKAGE` and adds
  `webcredentials:<EXPO_PUBLIC_DOMAIN host>`; that host must equal the API's RP ID.
- `react-native-passkeys` is required lazily (`lib/passkeys.ts`): Expo Go has no native module, so the
  passkey button simply doesn't show there.

## Why
The 2026-10 mandatory-TOTP policy forbids passkeys replacing the authenticator code; replacing the
password with a phishing-resistant, user-verified passkey keeps two factors.

## How to apply
Native passkeys need an installed (EAS/dev) build, which reverses the Expo Go-only decision in
mobile-app-plan.md. Tests: api-server `test:mobile-passkeys` (software authenticator), mobile `test:passkey-errors`.
