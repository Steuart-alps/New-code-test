---
name: Mobile staged photo evidence
description: How the Expo app satisfies required-photo rules for new GreenTrack/SwimTrack records.
---

Mobile uses the same staged contract as the web (`request-staged-upload` → signed PUT → `/photos/staged` → create with `photoUploadIds`). Logic lives in `artifacts/mobile/components/staged-photo-logic.ts` (import-free, node-tested) and `hooks/useStagedPhotoEvidence.ts`.

**Why:** the API rejects new required-rule records without receipts; creating first and attaching later is not allowed (see required-photo-creation.md).

**How to apply:**
- Storage PUT uses `expo/fetch` with only `Content-Type` and `credentials: 'omit'`; never route it through `apiFetch` (which adds the bearer). Upload URLs must be HTTPS.
- Receipts are scoped to user id + client id + entity type and dropped when that scope (or the selected machine/open form) changes.
- Unlike the web, a failed requirements load does not block saving: the server enforces the rule and a 422 keeps the draft. Network failures keep the draft and receipts; receipt errors (400/403 naming a photo upload receipt) drop only the photos. Receipts older than 28 minutes are discarded locally before submit (server TTL is 30).
