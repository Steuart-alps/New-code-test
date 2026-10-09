---
name: Session expiry handling
description: How expired sessions are handled in the web client and why
---

Any 401 from the shared API client fires a `setUnauthorizedHandler` callback (exported from the api-client-react lib, registered in the web app's auth context), which clears user/client state so the router redirects to login.

**Why:** Users on the published site with expired sessions saw stale UI and broken buttons ("View checks" → "Site not found") instead of being sent back to login.

**How to apply:** Any new frontend client or artifact consuming the API should register this handler; never leave 401s to render stale data silently.

Password-confirmed account-security actions need an exception for an expected incorrect-password 401: show that error inline without ending a valid signed-in session, while retaining CSRF protection.

**Why:** Recovery-code regeneration deliberately returns 401 for a wrong confirmation password; applying the generic unauthorized callback would log the user out instead of letting them correct it.

**How to apply:** Distinguish expected reauthentication failures from session expiry in personal security forms. Use a CSRF-aware request path that lets the form handle the response explicitly; do not disable the global handler for ordinary account data requests.
