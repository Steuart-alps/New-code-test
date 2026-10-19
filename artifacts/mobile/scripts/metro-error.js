// Turns a failed Metro response into a readable build-log message. Metro
// answers a bundle it cannot build with HTTP 500 and a JSON body (type,
// message, file, line, code snippet); without this the publish build only
// logged "HTTP 500" and the parser error was lost.
//
// The body is read up to MAX_BODY_BYTES and the message is capped at
// MAX_MESSAGE_CHARS, with terminal colour codes and other control characters
// removed, so a huge or binary response can't flood or garble the log.

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;

async function readBoundedText(response, maxBytes = MAX_BODY_BYTES) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      chunks.push(value.length > room ? value.subarray(0, room) : value);
      size += Math.min(value.length, room);
      if (value.length > room) truncated = true;
    }
    if (!truncated && size >= maxBytes) {
      const { done } = await reader.read();
      truncated = !done;
    }
  } finally {
    // Stop downloading the rest; ignore errors from an already-closed stream.
    reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

function cleanText(text) {
  return String(text)
    // ANSI colour and cursor codes (Metro colours its code frames).
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Other control characters, keeping tabs and newlines.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function cap(text, max = MAX_MESSAGE_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

// Metro's JSON error shape: { type, message, filename?, lineNumber?, column?,
// snippet?, errors?: [{ description }] }. Anything else is shown as text.
function formatMetroError(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: an HTML or plain-text error page.
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cleanText(text);

  const lines = [];
  const heading = [parsed.type, parsed.message].filter((part) => typeof part === 'string' && part.trim()).join(': ');
  if (heading) lines.push(heading);
  if (typeof parsed.filename === 'string' && parsed.filename) {
    const position = [parsed.lineNumber, parsed.column].filter((n) => Number.isFinite(Number(n)) && n !== null).join(':');
    lines.push(`at ${parsed.filename}${position ? `:${position}` : ''}`);
  }
  if (typeof parsed.snippet === 'string' && parsed.snippet.trim()) lines.push(parsed.snippet);
  if (Array.isArray(parsed.errors)) {
    for (const error of parsed.errors) {
      const description = error && typeof error.description === 'string' ? error.description : null;
      if (description && !heading.includes(description.trim())) lines.push(description);
    }
  }
  return lines.length > 0 ? cleanText(lines.join('\n')) : cleanText(text);
}

/**
 * An Error for a non-OK Metro response whose message carries the status and
 * Metro's own explanation, e.g. "HTTP 500 from Metro for ios bundle:
 * SyntaxError: ... at app/x.tsx:12:4". Never throws while reading the body.
 */
async function metroResponseError(response, what) {
  let detail = '';
  try {
    const { text, truncated } = await readBoundedText(response);
    detail = formatMetroError(text);
    if (truncated) detail += '\n… (response truncated)';
  } catch (error) {
    detail = `(could not read the response body: ${error && error.message ? error.message : error})`;
  }
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  const message = detail ? `${status} from Metro for ${what}:\n${cap(detail)}` : `${status} from Metro for ${what} (empty response body)`;
  const error = new Error(message);
  error.status = response.status;
  return error;
}

module.exports = { metroResponseError, formatMetroError, readBoundedText, cleanText, MAX_BODY_BYTES, MAX_MESSAGE_CHARS };
