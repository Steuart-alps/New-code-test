---
name: Git metadata cleanup
description: Safely handling stale temporary packed-refs files during Git reconciliation.
---

When Git reports it cannot create `.git/packed-refs.new` because the file already exists, the commit or ref update may still have succeeded. Verify repository status and current refs before retrying. Remove only a clearly stale temporary file after confirming there is no active Git process; never remove `packed-refs` itself.

**Why:** A stale temporary refs file in the workspace caused a pack-refs warning even though the merge commit completed successfully.

**How to apply:** After Git lock or ref errors, inspect process activity and file age, then verify both local and remote refs. Preserve histories and avoid force-pushing.
