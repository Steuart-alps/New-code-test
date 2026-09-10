---
name: Mobile draft hydration
description: Protecting editable mobile records from query refresh and scope-switch data loss
---

Editable mobile screens must not hydrate server responses over dirty local state. Disable edits while a query is fetching, update the query cache from successful mutations, and ignore later hydration while unsaved changes exist.

**Why:** Background invalidation and pull-to-refresh can complete after a user resumes editing, silently replacing newer local work. Scope changes can also carry stale edits into a different record if a confirmed discard does not reset both the dirty flag and local values.

**How to apply:** For draft-capable React Query forms, track dirty state explicitly. Reset abandoned local values before changing date/site/frequency keys, preserve per-item attribution when rebuilding payloads, and use the mutation response as the immediate canonical cache value.