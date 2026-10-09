# KitchenTrack offline queue: device force-close checklist

Automated tests cover the logic and the server:
- `artifacts/mobile/tests/kitchen-outbox.mjs` (queue, restore-to-draft)
- `artifacts/mobile/tests/kitchen-form-drafts.mjs` (unfinished forms)
- `artifacts/api-server/tests/kitchen-mobile-replay.mjs` (replay, receipts, receipt lookup)

They use an in-memory stand-in for AsyncStorage and simulate restarts. This
checklist covers what they cannot: real AsyncStorage, real OS force
termination and real radios. Run it on **one iPhone and one Android phone**
with a production build, against a staging API you can query. Record
evidence for every step (screenshot or recording, plus the API response or
row) and fill in the results table.

## Setup

1. Install a production build on each phone, pointed at staging.
2. Sign in as a **staff** user with KitchenTrack enabled. Note the user and
   client IDs.
3. In the web app (as an admin), choose a test site and note its KitchenTrack
   temperature controls (e.g. the hot-holding minimum).
4. From a laptop, have these API reads ready (signed in as the same user):
   - `GET /api/food-safety?date=<today>&siteId=<site>` — the diary, including
     `mobileSubmissionReceipts` (`entryId`, `userId` per applied device entry).
   - `GET /api/food-safety/mobile-entries/<entryId>?recordDate=<today>&siteId=<site>`
     — whether the server applied that entry for this user.

To force-close: on iOS, swipe the app away in the app switcher. On Android,
Settings → Apps → ComplyTrack → Force stop, or swipe it from Recents.
Airplane mode is the simplest way to go offline.

## A. Queued, force-close, reopen offline, reconnect

1. Open KitchenTrack, choose the test site, wait for the diary to load.
2. Turn on airplane mode. Enter a fridge reading and tap **Save**.
   - Expect "Saved on this device", and the KitchenTrack delivery panel
     showing **Queued — saved on this device** for today and the site.
3. Force-close. Reopen, still offline.
   - Expect the entry still **Queued**, with **View saved readings** showing
     the same values.
4. Turn airplane mode off and bring the app to the foreground (it also
   retries every 15 seconds while open).
   - Expect **Sent — confirmed by the server**.
5. On the server: exactly **one** receipt with this entry's ID and the
   user's ID; the reading appears once.
6. Force-close and reopen online. Expect nothing new on the server.

## B. Delayed response, then a retry (duplicate check)

1. Slow the API (e.g. a proxy with a 30 s delay on `POST/PUT /api/food-safety`).
2. Save a reading online. While the request is pending, force-close.
3. Remove the delay and reopen. The app resends the same entry ID.
4. On the server: still exactly **one** receipt and one appended reading.
   The app shows **Sent**.

## C. Rejected after the rules tighten, then restore to a draft

1. Go offline. Save a hot-holding reading that passes today's control
   (e.g. 64 °C against a 63 °C minimum), with no corrective action.
2. In the web app, raise the hot-holding minimum (e.g. to 65 °C).
3. Reconnect on the phone.
   - Expect **Failed — needs attention** with the server's message.
4. Force-close and reopen. Expect it still **Failed**, with **Retry saved
   entry**, **Edit as new entry** and **Remove device copy**.
5. Tap **Edit as new entry** and confirm.
   - The app first asks the server whether this entry was applied. Expect
     the entry to change to **Restored for editing — original kept on this
     device, not sent**, and the form to offer **Edit restored readings?**.
   - Tap **Restore**: the original reading is shown on the latest diary and
     controls, with the review notice, and the app now asks for a
     corrective action.
6. Force-close before saving. Reopen: expect the restore offer again with
   the same values.
7. Add the corrective action and **Save**. Expect a new entry that becomes
   **Sent**.
8. On the server: one receipt for the **new** entry ID; **no** receipt for
   the original ID (the lookup returns `receipted: false`); the corrective
   action is recorded.
9. Variant — already applied: make an entry that is applied on the server
   but shown as failed on the device (e.g. remove a proxy-injected 500
   after the server committed). **Edit as new entry** must say the server
   already recorded the readings and mark the entry **Sent**, restoring
   nothing.

## D. Unfinished form after an accidental close

1. Start entering readings, but don't tap Save.
2. Force-close and reopen.
   - Expect **Restore unsaved readings?**. Tap **Restore**: values are back.
     Nothing was sent (check the server).
3. Force-close again, reopen, and tap **Discard**, then confirm.
   - Expect the values to clear, and no offer on the next reopen.
4. Leave a draft unsaved, then open the app the next day.
   - Expect a notice that unsaved readings from the earlier date are on the
     device, with **View** and **Discard** (the form edits today's diary only).

## E. Account change

1. With an entry **Queued** and a draft unsaved, sign out.
2. Sign in as a different user (another organisation if possible).
   - Expect none of the first user's entries or drafts, and nothing sent
     for them.
3. Sign back in as the first user, online.
   - Expect the queued entry to send as **that** user (receipt `userId`), and
     the draft to be offered again.

## Results

| Step | iPhone (model / iOS) | Android (model / version) | Evidence |
|------|---------------------|---------------------------|----------|
| A3 Survives force-close offline | | | |
| A4–A5 Sent once after reconnect | | | |
| B4 One receipt after delayed response | | | |
| C3 Failed shown | | | |
| C5 Restored after receipt check | | | |
| C6 Restored draft survives force-close | | | |
| C8 Only the corrected entry applied | | | |
| C9 Applied entry never restored | | | |
| D2 Unfinished form restored | | | |
| D3 Discard asks first and persists | | | |
| D4 Earlier-day draft surfaced read-only | | | |
| E2 Other account isolated | | | |
| E3 Sent as the original user | | | |
