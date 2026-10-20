# Contractor calendar invites: Outlook, Google and Apple Calendar checklist

`artifacts/api-server/tests/calendar-invite-compatibility.ts` checks that the
FixTrack contractor invitations are valid RFC 5545 (CRLF line endings, lines
folded at 75 octets, escaping, all-day dates, a stable UID with a rising
SEQUENCE) and that the committed fixtures match what the API generates today.
`tests/fix-track-contractor-approval.mjs` checks that a revised or cancelled job
re-sends the same UID. What neither can check is how real calendar apps show
and update the event. This checklist covers that.

No email is sent. The fixtures are files you import by hand, and every address
in them is on `example.test`, a reserved domain that never delivers. If an app
offers to send a reply to the organiser, choose not to send one.

## The files

All four are in `artifacts/api-server/tests/fixtures/calendar/` (and copied to
the project files folder `testing/calendar-invites/`):

| File | Event | Expected date |
| --- | --- | --- |
| `uk-dst-start.ics` | "Boiler service", its own event | All day, **Sunday 31 March 2030** (the day UK clocks go forward) |
| `uk-dst-end-original.ics` | "Révision chaudière № 12", first version | All day, **Saturday 26 October 2030** |
| `uk-dst-end-long-unicode-update.ics` | Same event (same UID), revised: moved a day and a longer title | All day, **Sunday 27 October 2030** (the day UK clocks go back) |
| `uk-cancelled-calendar-update.ics` | Same event, cancelled | Event removed or shown as cancelled |

The revised title is
`Révision complète — chaudière № 12 🔧 with an intentionally long title for calendar clients`.
The organiser should read `ÅLPS “Facilities” ^ Europe` (one `^`) and the
contractor `Zoë O’Connor`.

## Before you start

- In each app, make a new calendar called **ComplyTrack test** and import into
  that. Deleting it afterwards removes everything.
- Keep the device or account time zone on **London**.
- Note the app version: Outlook › Help or Account › About; Mac Calendar ›
  Calendar › About Calendar; iPhone › Settings › General › About › iOS Version;
  Google Calendar is web only, so note the browser and the date tested.

How to import:

- **Google Calendar (web):** Settings (gear) › Import & export › Import, pick
  the file and the ComplyTrack test calendar.
- **Outlook:** classic Outlook: File › Open & Export › Import/Export › Import
  an iCalendar file, or double-click the file. New Outlook and Outlook on the
  web: Calendar › Add calendar › Upload from file. If it opens as a meeting
  request, choose Accept › **Don't send a response**.
- **Apple Calendar (Mac):** File › Import, pick the file and the ComplyTrack
  test calendar.
- **iPhone:** save the file to Files (or AirDrop it), tap it, then Add All and
  choose the ComplyTrack test calendar.

## Steps (repeat in each app)

1. Import `uk-dst-start.ics`.
   - Expect one all-day "Boiler service" on Sun 31 Mar 2030 only, with no time
     shown and nothing on Sat 30 Mar or Mon 1 Apr.
2. Import `uk-dst-end-original.ics`.
   - Expect one all-day "Révision chaudière № 12" on Sat 26 Oct 2030.
3. Import `uk-dst-end-long-unicode-update.ics`.
   - Expect the Saturday event to **move** to Sun 27 Oct 2030 with the long
     title. There must be **one** event across 26 and 27 Oct, not two.
   - Open it: the accents, dashes, `№`, the 🔧 emoji and the curly quotes show
     correctly; the notes keep their line breaks and read "Bring replacement
     seal; confirm access with José."
4. Optional: import `uk-cancelled-calendar-update.ics`.
   - Expect the 27 Oct event to disappear or show as cancelled, and no new
     event to appear.
5. Optional time-zone check: set the device or account to New York, reopen the
   calendar, and check both events are still on the same dates. Set it back to
   London.
6. Take a screenshot of 26 to 27 Oct (and of the event details after step 3).
   Delete the ComplyTrack test calendar.

## Results

Record one row per app. "Update" is step 3: one event that moved (pass), or two
events (fail).

| App and version | Date tested | 31 Mar all-day | Update, no duplicate | Characters | Cancel (optional) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Google Calendar (web) | | | | | | |
| Outlook (desktop) | | | | | | |
| Outlook (web / new) | | | | | | |
| Apple Calendar (Mac) | | | | | | |
| iPhone Calendar | | | | | | |

A failure on step 3 by **file import** is not automatically a bug: some apps
(Google's import screen in particular) treat an imported file as a copy rather
than as an invitation from the organiser. Note what happened; the real check
for that app is then a revised invitation sent through FixTrack to a test
mailbox you own, which needs a separate go-ahead because it sends real email.
