---
name: Artifact API request rules
description: Frontend API routing and Drizzle list-filter pitfalls that only show up at runtime.
---

Hand-written frontend fetch helpers in an artifact must append `/api` after the artifact base path; otherwise page-relative requests can hit the SPA server and return HTML instead of JSON.

**Why:** Generated API hooks already include `/api`, so pages that mix them with local fetch helpers can appear partly functional until a local request is made. The resulting HTML/object mismatch may only surface as a client error boundary.

**How to apply:** Prefer the shared API client. If a local helper is unavoidable, build it from the artifact base path plus `/api`, then pass API-relative route paths.

For Drizzle filters over a fixed JavaScript list, use `inArray(column, values)` rather than interpolating the list into `column = ANY(...)`.

**Why:** Interpolation can expand the list into SQL tuple parameters rather than a PostgreSQL array, causing `ANY/ALL requires array on right side` at runtime.

**How to apply:** Reserve raw `ANY` for explicitly typed PostgreSQL array parameters; use Drizzle's list helper for ordinary application arrays.