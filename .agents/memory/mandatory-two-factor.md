---
name: Mandatory account 2FA
description: The authentication policy for real user accounts versus staff-roster-only records.
---

Every real user account that logs in must enroll TOTP before app access. Users without TOTP get a setup-only session, and existing sessions are blocked from application routes until enrollment. Staff-roster-only records are compliance data, not authentication accounts, and are unaffected.

**Why:** The launch requirement is account-level TOTP protection, while roster entries represent people who do not have login credentials. Passkeys are an optional web sign-in convenience and do not replace the mandatory authenticator code; mobile sign-in supports TOTP only.

**How to apply:** Keep setup, authenticator verification, passkey registration, logout, and account recovery paths usable without full app access. A setup-pending passkey registration must preserve the setup-only session, return `requires2faSetup`, and never set `session.userId` or claim `setupComplete`. Do not add a self-service disable path; removing the only passkey is blocked when TOTP is absent. Mobile login must enforce the same TOTP rule.

**Tests:** a NODE_ENV=test API enforces the policy unless its runner opts in with `ALLOW_PASSWORD_ONLY_TEST_LOGIN=1` (legacy password-only suites; `ENFORCE_MANDATORY_2FA=1` always wins). New suites sign users in with `signIn`/`completeTwoFactor` from `artifacts/api-server/tests/two-factor-fixture.mjs`, which enrols a TOTP authenticator through the normal endpoints, checks probe routes are refused before enrolment and reachable after, and returns the secret for later sign-ins. Tenant isolation, module routes, config endpoints and mandatory-2fa run enforced. Removing the opt-in from the remaining runners is the path to deleting the bypass.