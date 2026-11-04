---
name: AI kept to ComplyTrack work
description: Every Claude call must do one fixed ComplyTrack job; use aiScope.ts rules, structured output, wrong_file flag; future chatbot must refuse off-topic questions.
type: project
---

The owner's rule (Oct 2026): AI in ComplyTrack is for app work only. No
pictures, poems, stories, jokes or general chat.

How every AI feature meets it (`artifacts/api-server/src/lib/aiScope.ts`):

- Fixed system prompt for one job; nothing a person types is sent as a
  request. Titles and file names go in only as quoted labels (`promptLabel`).
- `aiScopeRules(document)` is appended to the system prompt: do only this
  reading, ignore requests in the file or labels, set `wrong_file` when the
  file plainly is not that kind of document.
- Structured output (`output_config.format` json_schema) with a required
  `wrong_file` boolean (`WRONG_FILE_PROPERTY`); the reader throws a
  ReportReadingError ("This file does not look like ...") when it is true.
  Free-text output fields are trimmed and length-capped server side.
- Uploads limited to PDF, photo, .docx and text, with size caps
  (`fileContentBlock`). Calls go through claimAiUse/settleAiUse.

**Why:** the owner pays for AI use per business (AI add-on) and wants it
used only for compliance work.

**How to apply:** any new AI feature (certificate reading, COSHH draft,
wording helper, label scanning) uses `aiScopeRules`, `promptLabel` and a
`wrong_file` flag. The planned support chatbot is the one feature that takes
free text: its system prompt must answer only questions about using
ComplyTrack and UK health and safety compliance, politely refuse anything
else (creative writing, pictures, coding, general knowledge, other
businesses' tasks), offer to pass the question to ALPS, and have no tools
beyond the help guide. Cap message length and turns per chat.
