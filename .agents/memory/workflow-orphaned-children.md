---
name: Orphaned workflow children
description: A managed frontend restart can leave the old Vite child holding the registered port.
---

If Vite reports that the registered port is occupied after a workflow restart, check for a surviving child from the previous run before changing ports or artifact configuration.

**Why:** a managed restart left the old Vite child listening, while the new workflow silently selected the next port. The preview still reached the old process despite the new workflow reporting running.

**How to apply:** use lsof and process-parent inspection to identify the exact listeners and confirm they belong to the affected artifact. Terminate only the confirmed stale or displaced frontend children, restart the managed workflow, and verify the registered port responds. Do not kill unrelated Vite servers or add duplicate workflows.