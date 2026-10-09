---
name: Browser CSV formula safety
description: Where CSV formula-injection protection lives and how strict it is.
---

Browser-built CSV downloads use `artifacts/compliance-tracker/src/lib/csv.ts` (`csvCell`, `neutraliseSpreadsheetFormula`). Following OWASP CSV-injection guidance, it prefixes a single quote when the first character after whitespace, controls, BOM or zero-width characters is `= + - @` (or their full-width forms), or when the value starts with a tab or carriage return. Quotes are doubled; commas and line breaks stay inside the quoted field.

**Why:** quoting alone does not stop Excel/Sheets evaluating user-entered labels. The api-server has its own private copies (`csvCell` in routes/pat-track.ts and routes/bike-track.ts, `inspectionCsv` in lib/kitchenInspectionRegister.ts) that the web app cannot import. Those copies do not neutralise a leading tab/CR followed by text. `pages/reports.tsx` quotes but does not neutralise.

**How to apply:** reuse `csvCell` for any new browser CSV rather than writing another quote helper. If server and web CSV code are ever consolidated, move this helper into a shared workspace lib and point the server copies at it.
