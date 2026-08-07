---
name: Viewer role enforcement
description: Read-only (client_viewer) users must be explicitly blocked from mutation routes; auth alone is not enough.
---

Most module routes historically mount only `requireAuth` on POST/PUT/DELETE, so `client_viewer` users could mutate data.

**Why:** A code-review pass found viewers could create/edit/delete FireTrack and LegionellaTrack records; "read-only" was a UI convention, not server enforcement.

**How to apply:** Use `denyViewers` (in the auth middleware module) after `requireAuth` on every mutation route that isn't already admin-guarded. When adding a new module route file, add it from the start, and add viewer 403 assertions to the dept-isolation test suite. Fire/legionella are covered; other modules still have the gap (tracked as a project task).
