---
name: UK compliance controls
description: Safety constraints for guidance language and corrective-action verification in UK-regulated use.
---

Compliance guidance must distinguish legislation, Approved Codes of Practice, official guidance, industry material, and best practice. It must state that records support site-specific risk controls rather than certify legal compliance. Do not present fixed intervals or generic defaults as universal statutory requirements.

**Why:** Regulatory duties depend on the jurisdiction, premises, risk assessment, written schemes, HACCP arrangements, equipment, and competent-person advice. Misclassification or universal claims can create unsafe reliance.

**How to apply:** Keep public source links and classification metadata, avoid reproducing licensed standards, and require qualified UK subject-matter review before representing mappings as final.

Corrective-action closure is a controlled evidence record: it must move from awaiting verification only, be approved by a distinct authorized person, and remain immutable after closure. Validate the final persistence state atomically so concurrent updates cannot remove evidence or reopen a closure.

**Why:** Application-level checks alone can race concurrent edits, undermining the integrity of records relied on during inspections.

**How to apply:** Treat blank evidence as absent; use conditional, client-scoped updates that check the current status and non-blank evidence at write time. Regression-test concurrent verification versus reopening and evidence removal.