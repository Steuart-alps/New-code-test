/**
 * Content filter for user-supplied name fields.
 *
 * Blocks two categories:
 *   1. Offensive / profane words — basic English blocklist, UK-appropriate
 *   2. Code injection patterns — HTML tags, script payloads, SQL keywords
 *      stuffed into a name field
 *
 * This is a best-effort first line of defence, not a content moderation
 * platform. It catches accidental and casual abuse; determined attackers
 * are handled at the HTML-escaping layer in emails and React's JSX
 * auto-escaping in the frontend.
 */

// ── Injection pattern detection ───────────────────────────────────────────────

/** Returns true if the string appears to contain HTML/script/SQL injection. */
export function containsInjection(value: string): boolean {
  const lower = value.toLowerCase();
  // HTML tags
  if (/<[a-z!/?]/.test(lower)) return true;
  // Javascript: protocol in URLs (href=javascript:…)
  if (/javascript\s*:/i.test(lower)) return true;
  // Common XSS payloads
  if (/on\w+\s*=|<script|<iframe|<img\b.*\bsrc\s*=|<svg\b.*\bon/.test(lower)) return true;
  // SQL injection signals (only in name context — very specific patterns)
  if (/'\s*(or|and)\s+'?\s*[0-9']/i.test(lower)) return true;
  if (/;\s*drop\s+table|;\s*delete\s+from|;\s*insert\s+into|union\s+select/i.test(lower)) return true;
  return false;
}

// ── Profanity blocklist ───────────────────────────────────────────────────────

/**
 * Minimal blocklist of clearly offensive English words likely to appear in
 * a UK business context. Words are checked as whole words (word-boundary
 * match) so "assassin", "scunthorpe", "penistone" etc. are not blocked.
 *
 * Extend this list as moderation needs grow.
 */
const BLOCKED_WORDS = [
  "fuck", "fucker", "fucking", "fucked",
  "shit", "shite", "shitting", "bullshit",
  "cunt", "cunts",
  "cock", "cocks", "cockhead",
  "dick", "dicks", "dickhead",
  "ass", "asshole", "arsehole", "arse",
  "bitch", "bitches",
  "bastard", "bastards",
  "wank", "wanker", "wanking",
  "twat", "twats",
  "prick", "pricks",
  "slag", "slags",
  "whore", "whores",
  "nigger", "nigga",
  "chink", "kike", "spic", "wetback",
  "faggot", "fag",
  "retard", "retarded",
  "nazi", "nazis",
];

// Build word-boundary regex once
const BLOCKED_RE = new RegExp(
  `\\b(${BLOCKED_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/** Returns true if the string contains a blocked word. */
export function containsProfanity(value: string): boolean {
  return BLOCKED_RE.test(value);
}

// ── Combined validator ────────────────────────────────────────────────────────

export type FilterResult =
  | { ok: true }
  | { ok: false; reason: "injection"; message: string }
  | { ok: false; reason: "profanity"; message: string };

export function filterName(value: string): FilterResult {
  if (containsInjection(value)) {
    return { ok: false, reason: "injection", message: "This name contains invalid characters or code." };
  }
  if (containsProfanity(value)) {
    return { ok: false, reason: "profanity", message: "Please use an appropriate name." };
  }
  return { ok: true };
}

/**
 * Zod `.refine()` compatible function — use directly in a schema:
 *
 *   z.string().min(2).refine(nameIsClean, { message: "Please use an appropriate name." })
 *
 * For a richer error, use `filterName` instead.
 */
export function nameIsClean(value: string): boolean {
  return filterName(value).ok;
}
