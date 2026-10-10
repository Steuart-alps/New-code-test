---
name: Mandatory account 2FA
description: The authentication policy for real user accounts versus staff-roster-only records.
---

Every real user account that logs in must enroll TOTP before app access. Users without TOTP get a setup-only session, and existing sessions are blocked from application routes until enrollment. Staff-roster-only records are compliance data, not authentication accounts, and are unaffected.

**Why:** The launch requirement is account-level TOTP protection, while roster entries represent people who do not have login credentials. Passkeys are an optional sign-in convenience and never replace the mandatory authenticator code. On mobile a native passkey replaces the password only, then the same TOTP step follows (see mobile-passkeys.md).

**How to apply:** Keep setup, authenticator verification, passkey registration, logout, and account recovery paths usable without full app access. A setup-pending passkey registration must preserve the setup-only session, return `requires2faSetup`, and never set `session.userId` or claim `setupComplete`. Do not add a self-service disable path; removing the only passkey is blocked when TOTP is absent. Mobile login must enforce the same TOTP rule.