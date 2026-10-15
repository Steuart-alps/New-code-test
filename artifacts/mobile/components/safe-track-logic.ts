/**
 * SafeTrack on the phone: whether the signed-in user has already acknowledged
 * a risk assessment, SOP or handbook, from
 * GET /api/safe-track/:sub/:id/acknowledgements.
 *
 * The rows come back in more than one shape. Some API versions return
 * `acknowledged_by` (the account that recorded the row) or nothing to match
 * on; newer ones also return `acknowledged_by_me`, because `acknowledged_by`
 * is whoever recorded the row (a manager's bulk sign-off records it against
 * every staff member) and the user's own acknowledgement is matched by roster
 * entry. Either key case (snake or camel) is read.
 *
 * Import-free so tests can load it directly with Node.
 */

type Row = Record<string, unknown>;

/** A field under its snake_case or camelCase key, whichever the API sent. */
const pick = (row: Row, snake: string, camel: string): unknown => row[snake] ?? row[camel];

/** One acknowledgement row: the API's own-row flag when present, else the recorder's account. */
export function isOwnAcknowledgement(row: unknown, userId: number | null): boolean {
  if (!row || typeof row !== 'object') return false;
  const own = pick(row as Row, 'acknowledged_by_me', 'acknowledgedByMe');
  if (typeof own === 'boolean') return own;
  const by = pick(row as Row, 'acknowledged_by', 'acknowledgedBy');
  return userId != null && by != null && Number(by) === userId;
}

/** Whether any row of the acknowledgement list is the signed-in user's own. */
export function acknowledgedByCurrentUser(response: unknown, userId: number | null): boolean {
  return Array.isArray(response) && response.some((row) => isOwnAcknowledgement(row, userId));
}
