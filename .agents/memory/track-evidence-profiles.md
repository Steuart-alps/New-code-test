---
name: Track evidence profiles
description: Shared evidence requirements and sign-off enforcement for source-linked operational actions
---

Structured evidence profiles are enforced at sign-off for product-generated FireTrack and LegionellaTrack corrective actions. Each requirement is recorded against the action with a requirement key and expected evidence type; items marked for review must be independently verified by another authenticated user before resolution. Rejected evidence never satisfies a requirement, even when independent review is not otherwise required.

**Why:** Inspection-ready evidence needs more than a free-text reference, but enforcing the full profile on unrelated manual actions would break legitimate generic corrective-action workflows.

**How to apply:** Add new discipline profiles through the shared requirement/evidence contract. Keep manual actions on the existing remedial-action, evidence-reference, notes and signature requirements unless a track-specific source profile is explicitly defined.