# PDF Unicode font (HotTubTrack export)

- jsPDF's built-in Helvetica only encodes WinAnsi; non-Latin text (e.g.
  Cyrillic) is silently lost. `hot-tub-log-pdf.ts` embeds Noto Sans Regular
  and Bold (SIL OFL 1.1, licence in `src/assets/fonts/OFL.txt`) via
  `addFileToVFS`/`addFont(..., "Identity-H")` and uses it for every string.
- Fonts are Vite `?url` assets fetched with the lazy jsPDF imports, never in
  the main chunk. A failed fetch gives the reload/try-again message; unlike a
  failed `import()`, it is not cached, so the next attempt refetches.
- Coverage trade-off: subset (`scripts/subset-pdf-fonts.sh`, fontTools) to
  Latin + Latin Extended A/B/Additional, IPA, Greek (+ Extended), Cyrillic
  (+ Supplement), punctuation, currency, letterlike, arrows, maths, shapes.
  ~180 KB per face (~100 KB gzipped), down from ~630 KB. No hinting or
  GSUB/GPOS: jsPDF uses neither. CJK, Arabic, Hebrew, Indic and emoji are
  not covered: a CJK face alone is several MB, and jsPDF cannot fall back
  per glyph inside a cell, and has no shaping for RTL/Indic anyway.
- jsPDF drops characters missing from the cmap (and anything beyond the BMP)
  without error, so the generator checks every string against both faces'
  cmaps first and throws `HotTubLogPdfError` listing only the characters
  (`"漢" (U+6F22)`), never record text.
- Text is NFC-normalised; no-break spaces become spaces because jsPDF's
  ToUnicode map is per glyph, so one NBSP would make every space extract as
  NBSP. Control and zero-width characters are removed.
- No italic face is embedded; do not use `fontStyle: "italic"` with it.
