---
name: Required photo creation
description: Why mandatory photo evidence is staged before new GreenTrack and SwimTrack records are committed.
---

For new records requiring photo evidence, verify the uploads first and atomically associate the staged receipts when creating the parent record. Do not create apparently completed compliance records simply to obtain an attachment ID.

**Why:** the existing photo association API requires a saved parent ID, but saving first would let incomplete records affect lists, counts and operational state before the evidence requirement is met.

**How to apply:** new mandatory-photo types should follow the staged-evidence creation contract, with tenant, actor, type, expiry and one-use checks. Requirement changes must serialize with creation, including when no previous requirement row exists.

The initial enforcement scope is creation, not retroactive invalidation of historical records or permanent minimum-photo retention.

**Why:** the requested behavior preserves existing optional-photo saves and historical edits. Post-creation removal and record-lock policy need a separate explicit decision.

**How to apply:** keep optional one-step creation working. Do not introduce draft compliance rows or silently impose new historical edit/retention constraints during unrelated photo work.