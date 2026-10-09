---
name: Object ACL finalization
description: Ordering constraint for tenant ownership on direct object-storage uploads.
---

Presigning a PUT URL does not create the object, so an ACL cannot be written while generating the upload URL. Restricted uploads must be validated against one pinned storage generation, copied or normalized to a new immutable tenant key, and only that final key may receive an ACL and be persisted. A still-valid staging URL must never be able to replace attached content.

**Why:** The ACL helper requires the object to exist, and validating then ACL-finalizing the same writable staging key creates a time-of-check/time-of-use race. Untrusted document parsing in the API process can also allow compressed files to exhaust CPU or memory.

**How to apply:** Keep URL generation side-effect free. On completion, pin generation and size, validate actual bytes, normalize images, isolate PDF parsing behind hard time/memory limits, create an immutable tenant-owned final object, then persist its path. Deletion must check all attachment references before removing shared storage.

**Failure ordering (Oct 2026):** DocTrack `POST /doc-track/documents` and generic `POST /documents` write the tenant ACL before inserting the row. A provider `setMetadata` failure therefore returns 500 (DocTrack) or 400 (generic), leaves no row and no ACL, and the object stays unreadable. `test:private-file-acl` locks this in with a one-shot fault in the fake GCS `File.setMetadata`. Its fake `db.execute` recognises only the DocTrack INSERT and the PAT-photo department SELECT, so a reader's query never counts as a document write.