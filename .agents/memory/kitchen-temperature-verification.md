---
name: KitchenTrack temperature verification
description: Why temperature remediation uses one manager sign-off, and why maintenance escalation cannot replace it.
---
KitchenTrack failed-temperature follow-ups use one manager sign-off that both verifies the evidence and resolves the action; they do not require a second independent reviewer simply because a temperature failed.

**Why:** The requested workflow is manager-verified corrective action, not an additional two-person approval. Temperature observations remain historical failures; sign-off confirms remediation rather than turning the observation into a pass.

**How to apply:** Require recorded verification evidence, manager identity and a final signature. Preserve the original value and numeric control snapshot separately from later corrected readings.

Do not send the original temperature corrective action to FixTrack unless the linked maintenance-completion path preserves the same evidence and manager-verification requirements.

**Why:** Automatic completion from a linked maintenance issue would otherwise bypass KitchenTrack sign-off.

**How to apply:** Until both workflows share the same completion contract, raise a separate maintenance issue and keep temperature verification in KitchenTrack.

Unconfigured numeric reheating defaults follow the effective client/site jurisdiction. Explicit numeric rules are authoritative and are not parsed from legacy descriptive text.

**Why:** England/Wales and Scotland have different existing defaults. Automatically persisting a default during a staff write would make it appear to be an administrator's deliberate numeric override.

**How to apply:** Materialize fallback rules for reads and assessment without saving an implicit override; save explicit rules only through configuration.