---
name: Account erasure review
description: Safety policy for customer-initiated permanent account deletion.
---

An account erasure request must remain separate from an individual data-subject rights request. Approval is a distinct human decision by an authorized reviewer other than the submitter; it never shortens the 30-day minimum wait or overrides an active legal hold.

**Why:** A request that can approve itself is not meaningful review. An older scheduled offboarding job could otherwise delete records while a request is being accepted, breaking the stated retention guarantee.

**How to apply:** Serialize request acceptance, review, and all deletion entry points per client. Recheck the waiting date and retention holds after acquiring the lock; fail closed on ambiguous state. Execution re-reads the request through `APPROVED_ERASURE_REQUEST_READY` / `ERASURE_REQUEST_BLOCKING` (offboarding.ts): recorded reviewer other than the requester, earliest date passed, and 30 days since `requested_at` even if the earliest date was edited. Stored files are deleted only when their ACL marks them as the tenant's private object; unmarked or foreign references are left and counted. Every attempt that passes the guard appends one row to `client_data_deletion_outcomes` (insert-only trigger, retained with the request): `completed` inside the deletion transaction, or `failed` after rollback with the files already removed. Test: `test:approved-account-deletion` (in CI).