---
name: Mandatory account 2FA
description: The authentication policy for real user accounts versus staff-roster-only records.
---

Every real user account that logs in must have an enrolled TOTP authenticator before receiving an application session. Users without TOTP get a setup-only session, and existing sessions are blocked from application routes until enrollment. Staff-roster-only records are compliance data, not authentication accounts, and are unaffected.

**Why:** The launch requirement is account-level protection, while roster entries represent people who do not have login credentials. Existing TOTP infrastructure was chosen instead of introducing passkeys.

**How to apply:** Keep setup, authenticator verification, recovery-to-reenrollment, logout, and account recovery paths usable without full app access. Do not add a self-service disable path; administrative reset should force enrollment again. Mobile login must enforce the same rule or direct unconfigured accounts to web setup.