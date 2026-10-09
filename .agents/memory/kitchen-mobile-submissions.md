---
name: Kitchen mobile submissions
description: Date and retry invariants for mobile KitchenTrack temperature entries.
---

Keep the device-local calendar date, original submission payload, and entry ID fixed across retries. The single-row append path also carries an offset-bearing recorded-at timestamp and checks that its local date agrees with the selected diary.

**Why:** UTC-derived dates can target the previous or next diary around local midnight, while a lost HTTP response can cause staff to submit the same temperature twice.

**How to apply:** Preserve the original date, timestamp, and entry ID when retrying a submission. Changing the form, section, or site starts a new entry identity. Weekly and probe records must remain unique within their nullable site/date scope and validate site access before reads or writes.

Pending diary saves are isolated by both client and user on a shared device, and retained on sign-out rather than erased. Credentials must stay out of device queue storage; replay uses a bearer captured from the verified account session.

**Why:** Erasing the queue on sign-out would lose unsent compliance evidence. Picking up a later account's bearer during an asynchronous replay could submit another person's readings under the wrong identity.

**How to apply:** Suspend replay immediately when auth changes. Hide other accounts' entries and restore only the same verified client/user's queue. A save is queued only after device persistence completes, and sent only after server acknowledgment.

Whole-diary retries must recognize an identical authenticated submission before testing optimistic edit conflicts, without applying its data again. Reusing the identifier with changed readings must fail.

**Why:** After a lost response, the server already contains that submission's changes. Its own original baseline therefore appears stale; treating that as an ordinary conflict would prevent successful recovery, while applying it again would duplicate appended rows.

**How to apply:** Keep acknowledgment and diary mutations atomic. A replay of an acknowledged submission must not change rows or audit timestamps, even after subsequent staff edits. Late unsent entries must retain their original date and respect record-lock rules, never move to today to bypass them.

Release the receipt-capable API before distributing a mobile build that replays whole-diary saves.

**Why:** Older API validation strips unknown submission identifiers. Its ordinary PUT path can append again after an ambiguous response, so the new queue requires the matching server release.

**How to apply:** Include the API receipt migration and mobile bundle in the same publishing milestone, with the API available before native clients update.

A rejected (failed) device entry may be turned back into an editable draft only after `GET /food-safety/mobile-entries/:entryId` (scoped to the caller, client, site and date) confirms the server never applied it. The entry then becomes `restored`: terminal, never sent, original payload kept unchanged. The draft is reviewed on the latest diary and controls and saved under a new entry ID. Unfinished forms are kept per client/user/site/date and offered for restore; earlier days' drafts are only viewable/discardable, never moved to today.

**Why:** A rejection can come from controls tightened while the device was offline; staff need to correct and resend, but an entry the server did accept must never be re-entered or rewritten, and an old diary may be locked.

**How to apply:** Never restore without the receipt check, never mutate a restored entry's payload, and keep form drafts owner-scoped and cleared on save or confirmed discard.
