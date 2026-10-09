# PDF export failure recovery

- jsPDF 4 wraps `output()` in a `SAFE` helper that catches errors, calls
  `window.alert("Error in function …")` and returns `undefined`. Never trust
  its return value: `hot-tub-log-pdf.ts` silences the alert for that one
  synchronous call and throws if the result is not a non-empty Blob.
- A failed lazy `import()` is cached by the browser for the document's
  lifetime (verified in Chromium: an in-place retry fails again). Module-load
  failures must tell the user to reload the page, not just to "try again".
- Export errors surface as `HotTubLogPdfError` with a user-facing message;
  the page shows that message, logs the cause, and dismisses the previous
  failure toast when a new attempt starts.
- `test:hot-tub-pdf` covers generation, save and chunk-fetch failures once
  each, then retries under changed filters. Playwright routing disables the
  HTTP cache, so the chunk abort works after a reload.
