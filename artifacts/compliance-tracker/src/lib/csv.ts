/**
 * Client-side CSV cell helpers for downloads built in the browser.
 *
 * The API's CSV exports have their own server-side equivalents
 * (`csvCell` in api-server routes/pat-track.ts and routes/bike-track.ts,
 * `inspectionCsv` in lib/kitchenInspectionRegister.ts); the web app cannot
 * import those, so browser-built CSVs use this module.
 */

// Characters a spreadsheet may skip before deciding a cell is a formula:
// whitespace (including NBSP, ideographic space and BOM), C0/C1 controls and
// zero-width characters.
const LEADING_IGNORABLE = /^[\s\u0000-\u001F\u007F-\u009F​-‍⁠﻿]*/;
// ASCII formula triggers plus their full-width forms.
const FORMULA_TRIGGER = /^[=+\-@＝＋－＠]/;

/**
 * Neutralise spreadsheet formula injection (OWASP "CSV Injection"): a value
 * whose first non-whitespace/control character is = + - @, or which starts
 * with a tab or carriage return, is prefixed with a single quote so it is
 * shown as text. Everything else is returned unchanged.
 */
export function neutraliseSpreadsheetFormula(value: string): string {
  if (/^[\t\r]/.test(value)) return `'${value}`;
  return FORMULA_TRIGGER.test(value.replace(LEADING_IGNORABLE, "")) ? `'${value}` : value;
}

/**
 * One quoted CSV field: formula-neutralised, with embedded quotes doubled.
 * Commas and line breaks stay readable inside the quotes.
 */
export function csvCell(value: string): string {
  return `"${neutraliseSpreadsheetFormula(value).replace(/"/g, '""')}"`;
}
