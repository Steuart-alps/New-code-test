---
name: Contractor compliance fields
description: User confirmed these fields are planned for contractor records but deferred as out of scope for now.
---

# Contractor Compliance Fields (deferred)

## What the user wants (eventually)
Add compliance-relevant fields to the contractor record:
- Gas Safe registration number
- Public liability insurance expiry date
- DBS check date / expiry

## Why deferred
Out of scope for the initial contractor workflow (task #67). The user wants to revisit this as a standalone task later.

**How to apply:** When a future task touches contractor records or a "contractor compliance" feature is requested, suggest these fields as part of that work. They belong on the `contractors` table as new columns via runtime migration.
