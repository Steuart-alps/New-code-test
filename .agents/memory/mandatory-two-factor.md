---
name: Mandatory account 2FA
description: The authentication policy for real user accounts versus staff-roster-only records.
---

Every real user account that logs in must have at least one enrolled second factor: TOTP or a passkey. Users without either get a setup-only session, and existing sessions are blocked from application routes until enrollment. Staff-roster-only records are compliance data, not authentication accounts, and are unaffected.

**Why:** The launch requirement is account-level protection, while roster entries represent people who do not have login credentials. Passkeys are an alternative factor, while existing TOTP accounts remain supported.

**How to apply:** Keep setup, authenticator verification, passkey registration, logout, and account recovery paths usable without full app access. Do not add a self-service disable path; removing the only passkey is blocked when TOTP is absent. Mobile login must enforce the same rule or direct accounts needing a web-only passkey flow to web setup.