---
name: Task queue lags codebase
description: Most queued project tasks were already implemented; always audit before building.
---
The project task list is far behind the actual codebase state. In the bulk "complete queued tasks" effort (Aug 2026), roughly 3/4 of assigned tasks turned out to be already fully implemented.

**Why:** Tasks were created from user requests over time, but prior sessions/agents built many of them without the task pane being updated.

**How to apply:** Before implementing any queued task, verify the feature in code first (routes, pages, jobs). Brief subagents with "verify before building" or they waste effort/duplicate code. Exports use a consistent client-side printable-HTML window.print pattern; reminder crons follow the contractorComplianceReminders claim-first/release-on-failure pattern.
