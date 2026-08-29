---
name: Check results and remediation
description: Durable distinction between recorded check evidence and the workflow used to correct a failed check.
---

Completed operational checks record only `pass` or `fail`. A failed observation is historical evidence and must not be rewritten when its remediation is assigned, edited, verified, or closed. Legacy outcome aliases remain readable rather than being destructively migrated.

Remediation is a separate, source-linked action created atomically and insert-once. Later edits to the failed source must not overwrite or reopen the action. Specialist urgency belongs on remediation severity, not in the observation result.

**Why:** Mixing `action_required` into check outcomes made it possible for closing an action to obscure the original failed observation and caused result/status semantics to diverge across tracks.

**How to apply:** New operational check APIs and forms must use Pass/Fail. If a failure needs follow-up, create or retain one independently managed action keyed by tenant, module, source kind, and source record.