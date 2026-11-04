---
name: Email design
description: Every email uses one ComplyTrack layout, applied in sendEmail and sendSystemEmail
---

Every email gets the same design (Steuart, 2026-10-19): dark ComplyTrack header, white card, footer with the ALPS logo (`compliance-tracker/public/email-assets/alps-logo.png`, loaded from `getPublicAppUrl()`) and "ALPS Consulting Ltd t/as ALPS Consultancy". Buttons use `EMAIL_BRAND.button` (#2563eb).

- `sendEmail` and `sendSystemEmail` call `applyEmailLayout`, so a new email needs no layout code; a full HTML document keeps only its `<body>` contents.
- Use `renderEmailLayout({ subtitle, footerNote, bodyHtml })` for a header subtitle or footer note; its marker stops a second wrap. Escape business text in both.
- FixTrack's queued contractor emails are previewed and stored without the layout; it is added when sent, so approved == stored body still holds.
- Test: `test:email-layout`.
