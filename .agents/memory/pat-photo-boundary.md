---
name: PAT photo boundary
description: PAT test photos follow the test's recorded department/site, in photo routes and direct object downloads.
---

`pat_test` photos are scoped like the PAT test routes: by the department/site snapshot recorded with the test (`patTestHistoryAccess` in `lib/patLegacyHistoryScope.ts`), never the appliance's current location. `photos.ts` applies it to list, request-upload, attach and delete (an out-of-scope parent returns 404). `GET /storage/objects/*` also refuses (403, before touching storage) a department-scoped caller unless every `pat_test` photo row referencing the object is visible to them, and refuses tenant-prefixed keys of another tenant.

**Why:** the tenant ACL alone let another department of the same client list, delete or download a retained test's photos by ID or path.

**How to apply:** when adding another department-scoped photo parent, add its boundary check to `requireOwnedPhotoEntity` and the object-serving route; `check_photos` has a unique (client_id, object_path), so a finalized object cannot be re-attached to another parent.
