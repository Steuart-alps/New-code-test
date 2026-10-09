/**
 * Lifecycle of compliance reminder cycles in the contractor email queue.
 *
 * A reminder draft belongs to one cycle: the compliance item's due date (as
 * the UTC calendar day stored in `reminder_cycle`), contractor and open
 * status at the time it was rendered. When any of those change, a *pending*
 * draft of the old cycle is obsolete. It moves to the terminal `superseded`
 * state with a reason, so it can never be approved or sent. Drafts already
 * `sending` or `sent` are never touched: they were approved against the
 * state at the time, and their links stay valid as promised.
 *
 * Lock order is always compliance item, then queue rows. Item edits update
 * the item row first, while the scheduler and approval lock it explicitly
 * first, so concurrent edits, scheduler runs and approvals serialise without
 * deadlocks, and the state a cycle is checked against cannot change before
 * the check's transaction commits.
 */
import { sql } from "drizzle-orm";
import type { db } from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The cycle key used in reminder idempotency keys and `reminder_cycle`. */
export function reminderCycleOf(dueDate: Date): string {
  return dueDate.toISOString().slice(0, 10);
}

/** Lock a compliance item (FOR UPDATE or FOR SHARE) and return the state a
 *  reminder cycle depends on, or null when it no longer exists. */
export async function lockReminderItem(
  tx: Tx,
  clientId: number,
  itemId: number,
  mode: "update" | "share",
): Promise<{ status: string; cycle: string | null; contractorId: number | null } | null> {
  const rows = await tx.execute(sql`SELECT status, to_char(due_date, 'YYYY-MM-DD') AS cycle, contractor_id
    FROM compliance_items WHERE id=${itemId} AND client_id=${clientId}
    ${mode === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`}`);
  const row = (rows.rows as any[])[0];
  return row ? { status: String(row.status), cycle: row.cycle ?? null, contractorId: row.contractor_id ?? null } : null;
}

/**
 * Supersede every pending reminder-cycle draft of an item that no longer
 * matches its current state (deleted, completed, contractor changed, due
 * date changed or removed). Pass `exceptCycle` from the scheduler to also
 * retire pending drafts of any other cycle before it queues that one.
 * Returns the ids superseded.
 */
export async function supersedeStaleReminderCycles(
  tx: Tx,
  clientId: number,
  itemId: number,
  options: { exceptCycle?: string } = {},
): Promise<number[]> {
  const result = await tx.execute(sql`
    UPDATE contractor_email_queue q SET
      status='superseded', superseded_at=now(), updated_at=now(),
      superseded_reason = CASE
        WHEN ci.id IS NULL THEN 'Compliance check deleted'
        WHEN ci.status = 'completed' THEN 'Compliance check completed'
        WHEN ci.contractor_id IS DISTINCT FROM q.contractor_id THEN 'Contractor changed'
        WHEN ci.due_date IS NULL THEN 'Due date removed'
        WHEN to_char(ci.due_date, 'YYYY-MM-DD') <> q.reminder_cycle THEN 'Due date changed'
        ELSE 'Replaced by a newer reminder cycle'
      END
    FROM contractor_email_queue target
    LEFT JOIN compliance_items ci ON ci.id=target.entity_id AND ci.client_id=target.client_id
    WHERE q.id = target.id
      AND q.client_id=${clientId} AND q.entity_type='compliance' AND q.entity_id=${itemId}
      AND q.status='pending' AND q.reminder_cycle IS NOT NULL
      AND (
        ci.id IS NULL OR ci.status = 'completed' OR ci.due_date IS NULL
        OR ci.contractor_id IS DISTINCT FROM q.contractor_id
        OR to_char(ci.due_date, 'YYYY-MM-DD') <> q.reminder_cycle
        ${options.exceptCycle === undefined ? sql`` : sql`OR q.reminder_cycle <> ${options.exceptCycle}`}
      )
    RETURNING q.id`);
  return (result.rows as any[]).map((row) => Number(row.id));
}

/**
 * Before a manager claims a draft: if it is a compliance reminder-cycle
 * draft, lock its item and supersede it when its cycle is obsolete. Returns
 * true when the draft is still current (or is not a cycle draft).
 */
export async function reminderDraftStillCurrent(
  tx: Tx,
  draft: { id: number; client_id: number; entity_type: string; entity_id: number | null; reminder_cycle: string | null },
): Promise<boolean> {
  if (draft.entity_type !== "compliance" || !draft.reminder_cycle || draft.entity_id == null) return true;
  await lockReminderItem(tx, draft.client_id, draft.entity_id, "share");
  const superseded = await supersedeStaleReminderCycles(tx, draft.client_id, draft.entity_id);
  return !superseded.includes(Number(draft.id));
}

export const SUPERSEDED_REMINDER_ERROR =
  "This reminder is out of date because the compliance check changed after it was drafted. It has been withdrawn; a fresh reminder will be drafted for the current due date.";
