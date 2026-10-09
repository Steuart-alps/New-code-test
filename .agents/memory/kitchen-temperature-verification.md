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

Inspection-register access is a read-only handover, not approval of corrective work. Department managers can export accessible sites without acquiring the stricter action sign-off permissions.

**Why:** Manager handover needs department-scoped access; reusing the approval restriction would unnecessarily prevent department managers from handing over their existing records.

**How to apply:** Keep download authorization separate from remediation approval. Always apply tenant and site/department checks to the download; do not broaden action approval roles to match it.
Hold times and item rules: `food_temperature_rules` also carries `cookingHoldSeconds`,
`sousVideHoldMinutes` (null = no hold control; rules saved before these existed parse as
null) and `items.cooking` / `items.sousVide` per-item rules. An item rule replaces the
section's minimum °C *and* hold for that item, including "no control" when null; items
match on the trimmed, case-folded name. With a hold control, a changed core temperature
without a hold time is rejected, and a short hold is a failure needing a corrective action
like any other (same track action and manager sign-off). `kitchenHoldRequirement` is the
one source for both the assessment and the web/mobile hints.
