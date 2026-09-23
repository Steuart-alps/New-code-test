---
name: Approval refresh storage fallback
description: Privacy-safe persistence and cross-tab synchronization for contractor approval indicators.
---

**Rule:** Scope approval refresh state by authenticated user and selected client; use localStorage when available, a scoped BroadcastChannel when it is blocked, and scoped in-memory state for same-tab continuity.

**Why:** Privacy-restricted browsers can deny localStorage access without preventing the page from working. A shared unscoped channel could expose another tenant's approval context, while no fallback would make same-user tabs stale.

**How to apply:** Keep storage access behind the refresh-state helper, validate incoming state, and treat browsers with neither storage nor BroadcastChannel as same-tab-only until a server-refresh fallback is added.