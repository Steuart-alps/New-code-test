---
name: Object ACL finalization
description: Ordering constraint for tenant ownership on direct object-storage uploads.
---

Presigning a PUT URL does not create the object, so an ACL cannot be written while generating the upload URL. Assign tenant ownership in an authenticated finalization request after the direct upload has completed, and fail finalization if ownership cannot be secured.

**Why:** The ACL helper requires the object to exist. Calling it during URL generation throws and prevents clients from receiving a usable upload URL.

**How to apply:** For every direct-upload flow, keep URL generation side-effect free, then make the module's record-creation or explicit completion endpoint verify any existing owner and set the tenant ACL before persisting a reference to the object.