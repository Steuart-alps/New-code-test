---
name: Mandatory account 2FA
description: The authentication policy for real user accounts versus staff-roster-only records, and the manager opt-out.
---

By default every real user account that logs in must enroll TOTP before app access. Users without TOTP get a setup-only session, and existing sessions are blocked from application routes until enrollment. Staff-roster-only records are compliance data, not authentication accounts, and are unaffected.

Managers (client_admin, or a consultant for a linked client) can make 2FA optional for their business with the `requireTwoFactor` client setting (`PUT /settings`, "true"/"false"; absent means required). `lib/twoFactorPolicy.ts` `isTwoFactorRequired()` is the single source: the strictest client wins (a consultant stays required while any linked client requires it), users with no client stay required, and lookup failures fail closed. When optional, password login (web and mobile) and password + passkey issue a full session, recovery signs straight in, and users may enrol or disable TOTP themselves (`POST /auth/2fa/disable`, password-confirmed; refused while required). Turning the requirement back on blocks existing sessions of unenrolled users until they enrol.

**Why:** The launch requirement is account-level TOTP protection, while roster entries represent people who do not have login credentials. Managers asked to choose per business (Oct 2026). Passkeys are an optional web sign-in convenience and do not replace the authenticator code where it is required; mobile sign-in supports TOTP only.

**How to apply:** Gate every 2FA decision on `isTwoFactorRequired`, never on `totpEnabled` alone. Keep setup, authenticator verification, passkey registration, logout, and account recovery paths usable without full app access. A setup-pending passkey registration must preserve the setup-only session, return `requires2faSetup`, and never set `session.userId` or claim `setupComplete`. Tests: `test:mandatory-2fa`, `test:two-factor-policy`, `test:passkey-mandatory-2fa`.
