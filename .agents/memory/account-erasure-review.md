---
name: Account erasure review
description: Safety policy for customer-initiated permanent account deletion.
---

An account erasure request must remain separate from an individual data-subject rights request. Approval is a distinct human decision by an authorized reviewer other than the submitter; it never shortens the 30-day minimum wait or overrides an active legal hold.

**Why:** A request that can approve itself is not meaningful review. An older scheduled offboarding job could otherwise delete records while a request is being accepted, breaking the stated retention guarantee.

**How to apply:** Serialize request acceptance, review, and all deletion entry points per client. Recheck the waiting date and retention holds after acquiring the lock; fail closed on ambiguous state. Treat database deletion and tenant-owned object storage cleanup as separate concerns until the latter has an auditable completion path.