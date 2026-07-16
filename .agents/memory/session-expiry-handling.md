---
name: Session expiry handling
description: How expired sessions are handled in the web client and why
---

Any 401 from the shared API client fires a `setUnauthorizedHandler` callback (exported from the api-client-react lib, registered in the web app's auth context), which clears user/client state so the router redirects to login.

**Why:** Users on the published site with expired sessions saw stale UI and broken buttons ("View checks" → "Site not found") instead of being sent back to login.

**How to apply:** Any new frontend client or artifact consuming the API should register this handler; never leave 401s to render stale data silently.
