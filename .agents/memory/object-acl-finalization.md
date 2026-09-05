---
name: Object ACL finalization
description: Ordering constraint for tenant ownership on direct object-storage uploads.
---

Presigning a PUT URL does not create the object, so an ACL cannot be written while generating the upload URL. Restricted uploads must be validated against one pinned storage generation, copied or normalized to a new immutable tenant key, and only that final key may receive an ACL and be persisted. A still-valid staging URL must never be able to replace attached content.

**Why:** The ACL helper requires the object to exist, and validating then ACL-finalizing the same writable staging key creates a time-of-check/time-of-use race. Untrusted document parsing in the API process can also allow compressed files to exhaust CPU or memory.

**How to apply:** Keep URL generation side-effect free. On completion, pin generation and size, validate actual bytes, normalize images, isolate PDF parsing behind hard time/memory limits, create an immutable tenant-owned final object, then persist its path. Deletion must check all attachment references before removing shared storage.