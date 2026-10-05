---
name: Staff kiosk security
description: Security model for shared-device roster PIN flows.
---

Public staff kiosks must use a rotatable tenant-bound bearer token for roster discovery, then exchange successful PIN verification for a short-lived, one-use capability scoped to one staff member and one allowed action.

Shared tenant sign-off links must derive document eligibility from the selected active roster row on the server. Enforce that same effective department scope for listing, downloading, and acknowledging; never trust an independently submitted department.

Initial PIN setup and reset must use a separate manager-issued, per-member, one-time enrollment token. Issuance is serialized by locking the staff row and revokes every older enrollment token before creating the replacement.

**Why:** Numeric tenant identifiers expose cross-tenant roster enumeration, while PIN verification alone does not safely authorize a later public action. A tenant-wide link plus client-supplied department otherwise permits cross-department document access and false acknowledgements. Atomic row locking is also required so concurrent failures cannot bypass the five-attempt lockout.

**How to apply:** Never trust a public client ID for kiosk access, never use a shared kiosk token for PIN enrollment, and never put reusable credentials in query strings. Bootstrap kiosk tokens through a URL fragment, move them to session storage, strip the fragment before requests, store server tokens only as hashes, never return PIN hashes, and consume capabilities atomically.