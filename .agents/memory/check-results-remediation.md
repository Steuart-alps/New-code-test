---
name: Check results and remediation
description: Durable distinction between recorded check evidence and the workflow used to correct a failed check.
---

Completed operational checks record only `pass` or `fail`. A failed observation is historical evidence and must not be rewritten when its remediation is assigned, edited, verified, or closed. Legacy outcome aliases remain readable rather than being destructively migrated.

Remediation is a separate, source-linked action created atomically and insert-once. Later edits to the failed source must not overwrite or reopen the action. Specialist urgency belongs on remediation severity, not in the observation result.

**Why:** Mixing `action_required` into check outcomes made it possible for closing an action to obscure the original failed observation and caused result/status semantics to diverge across tracks.

**How to apply:** New operational check APIs and forms must use Pass/Fail. If a failure needs follow-up, create or retain one independently managed action keyed by tenant, module, source kind, and source record.

GreenTrack corrective work remains inside GreenTrack and is owned by greenkeepers; it must not be routed into FixTrack. Failed pre-use and PUWER records create source-linked GreenTrack actions, with machine site scope treated as immutable provenance.

**Why:** GreenTrack equipment and grounds work is managed by the greenkeeping team rather than the general maintenance/contractor workflow represented by FixTrack.

**How to apply:** Exclude GreenTrack from any cross-track FixTrack escalation. Keep its action list, ownership, evidence, resolution, and source association within the GreenTrack module.

Every resolved shared track action requires an authenticated resolver sign-off. Store both the resolver's user ID and a snapshot of their account name, display the name with the completed action, and never accept the signer name from request input.

**Why:** Inspection evidence must identify the real signed-in person who closed an action, while preserving their name even if the account is later renamed or removed.

**How to apply:** Apply this to every module using the shared action register. Keep resolved actions immutable and require remedial work, evidence, resolution notes, resolver ID, resolver-name snapshot, and resolution time.