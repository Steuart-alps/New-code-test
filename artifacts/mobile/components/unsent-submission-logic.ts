/**
 * Device copies of check submissions that failed to send (network loss,
 * server error, rejected data). They survive closing the screen or the app so
 * typed data is never lost; the screen offers to retry or discard them.
 *
 * Copies are kept per client and user on a shared device and are hidden from
 * any other signed-in account. Import-free so tests can load it with Node.
 */
export interface UnsentOwner { clientId: number; userId: number }

export interface UnsentSubmission {
  id: string;
  /** The exact request body that failed (retry sends it unchanged). */
  body: Record<string, unknown>;
  /** Optional form values for screens that restore the form instead. */
  values?: Record<string, unknown>;
  label: string;
  savedAt: string;
  error: string;
}

const MAX_DRAFTS = 10;

/**
 * Whether resending the same request could succeed later: no response
 * (offline), an expired session, a timeout, rate limiting or a server error.
 * Other rejections need the form corrected, so no device copy is kept.
 */
export function isRetryableFailure(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status) : 0;
  return !status || status === 401 || status === 408 || status === 429 || status >= 500;
}

export const unsentSubmissionKey = (owner: UnsentOwner, formKey: string) =>
  `complytrack:unsent-submissions:v1:${owner.clientId}:${owner.userId}:${formKey}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Parse stored copies; unreadable data yields an empty list (never throws). */
export function parseUnsentSubmissions(raw: string | null): UnsentSubmission[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is UnsentSubmission =>
      isRecord(item)
      && typeof item.id === 'string'
      && isRecord(item.body)
      && (item.values === undefined || isRecord(item.values))
      && typeof item.label === 'string'
      && typeof item.savedAt === 'string'
      && typeof item.error === 'string');
  } catch {
    return [];
  }
}

const sameBody = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Record a failed submission. A retry of a saved copy (same body) updates
 * that copy's error and time instead of adding a duplicate.
 */
export function recordUnsent(
  drafts: UnsentSubmission[],
  input: { body: Record<string, unknown>; values?: Record<string, unknown>; label: string; error: string },
  now: Date,
  newId: () => string,
): UnsentSubmission[] {
  const body = JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
  const values = input.values === undefined
    ? undefined
    : JSON.parse(JSON.stringify(input.values)) as Record<string, unknown>;
  const existing = drafts.find((draft) => sameBody(draft.body, body));
  if (existing) {
    return drafts.map((draft) => draft === existing
      ? { ...draft, error: input.error, savedAt: now.toISOString(), ...(values ? { values } : {}) }
      : draft);
  }
  const next: UnsentSubmission = {
    id: newId(),
    body,
    ...(values ? { values } : {}),
    label: input.label,
    savedAt: now.toISOString(),
    error: input.error,
  };
  return drafts.concat(next).slice(-MAX_DRAFTS);
}

/** Remove the copy a successful submission delivered (matched by body). */
export function resolveUnsent(drafts: UnsentSubmission[], body: Record<string, unknown>): UnsentSubmission[] {
  return drafts.filter((draft) => !sameBody(draft.body, body));
}

export function discardUnsent(drafts: UnsentSubmission[], id: string): UnsentSubmission[] {
  return drafts.filter((draft) => draft.id !== id);
}
