---
name: Email HTML escaping
description: Business text in contractor/compliance email HTML must go through escapeHtml; plain text and subjects stay verbatim.
---

Every HTML email template escapes names, titles, notes, locations, site and company names with `escapeHtml` from `lib/email.ts` (quotes included). Plain-text bodies and subjects use the raw values. Keep templates as pure renderers (`buildReminderEmail`, `buildVisitConfirmationEmail`, `buildContractorEmailHtml`, `buildManagerEmailHtml`, FixTrack `previewOnly`) so they can be tested without a database or provider.

**Why:** The content filter deliberately allows `&`, `'`, `"`, Unicode and `<`/`>` comparisons, so escaping is the only thing keeping that text from forming markup. The public visit-confirmation email once interpolated contractor/item/company names raw.

**How to apply:** Add new templates to `tests/email-business-text-escaping.ts` (`pnpm --filter @workspace/api-server run test:email-escaping`), which compares tag/attribute structure against a plain-text render and checks decoded readability.
