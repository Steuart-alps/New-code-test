/**
 * Monthly staff roster check: a task per site, due on the 1st of each month,
 * asking "Any changes to the staff roster? Yes / No / N/A".
 *
 *  - No / N/A is recorded on the task (POST /tasks/:id/complete with an answer).
 *  - Yes means uploading the updated roster for the site
 *    (POST /staff-roster/reconcile with `rosterCheck`): people missing from it
 *    are marked as left (never deleted, so their training and sign-off
 *    history stays), new starters join the roster and so TrainTrack, and the
 *    task is recorded as done in the same transaction.
 *
 * The task stays open for the whole month until it is answered (a normal
 * monthly task is only shown on its day). It is reminded like any other task
 * (lib/dueItems.ts): the person it is assigned to the day before and when
 * overdue, the Owner in the Owner update.
 *
 * ensureRosterCheckTasks() creates the task for every site of a business that
 * has a staff roster, once: an archived roster check is never recreated.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getAccountToday } from "./accountClock";
import { candidateCanSeeSite, loadEligibleOwners } from "./trackOwners";
import { logger } from "./logger";

export const ROSTER_CHECK_MODULE = "roster_check";
export const ROSTER_CHECK_TITLE = "Staff roster check";
export const ROSTER_CHECK_INSTRUCTION = "Any changes to the staff roster this month? Answer Yes, No or N/A. "
  + "If Yes, upload the updated roster: anyone no longer on it is marked as left (their records are kept) "
  + "and new starters are added to TrainTrack.";

export type RosterCheckAnswer = "yes" | "no" | "na";
export const ROSTER_CHECK_NOTES: Record<Exclude<RosterCheckAnswer, "yes">, string> = {
  no: "No changes to the staff roster",
  na: "Not applicable",
};

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

/** The 1st of the month a calendar day falls in. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * The roster check occurrence open on a day: the 1st of that month, once the
 * task has started. Null before its first month.
 */
export function rosterCheckOccurrence(task: { startsOn: string }, day: string): string | null {
  const occurrence = monthStart(day);
  return occurrence >= monthStart(task.startsOn) ? occurrence : null;
}

export function isRosterCheck(task: { module: string | null }): boolean {
  return task.module === ROSTER_CHECK_MODULE;
}

/** "Roster updated: 2 new starters (A, B); 1 left (C)". Notes are capped at 1000 characters. */
export function rosterUpdateNote(changes: { created: string[]; deactivated: string[]; reactivated: string[] }): string {
  const part = (count: number, one: string, many: string, names: string[]) =>
    count ? `${count} ${count === 1 ? one : many} (${names.join(", ")})` : null;
  const parts = [
    part(changes.created.length, "new starter", "new starters", changes.created),
    part(changes.reactivated.length, "returned", "returned", changes.reactivated),
    part(changes.deactivated.length, "left", "left", changes.deactivated),
  ].filter(Boolean);
  const note = `Roster updated: ${parts.length ? parts.join("; ") : "no one joined or left"}`;
  return note.length > 1000 ? `${note.slice(0, 997)}...` : note;
}

/**
 * Who a new roster check goes to: the one Manager who looks after the site
 * (a Manager over every department only when no Manager is given that site),
 * otherwise every Manager and Owner who can see it (the "Managers" group).
 */
function assigneeFor(
  managers: Awaited<ReturnType<typeof loadEligibleOwners>>,
  site: { id: number; departmentId: number | null } | null,
): { assigneeUserId: number | null; assigneeRole: "managers" | null } {
  const covering = site ? managers.filter((user) => candidateCanSeeSite(user, site.departmentId, site.id)) : managers;
  const own = covering.filter((user) => !user.allDepartments);
  const pick = own.length ? own : covering;
  return pick.length === 1 ? { assigneeUserId: pick[0]!.id, assigneeRole: null } : { assigneeUserId: null, assigneeRole: "managers" };
}

/** Create the monthly roster check for each site that has none yet. Returns how many were created. */
export async function ensureRosterChecksForClient(clientId: number): Promise<number> {
  const hasRoster = rowsOf(await db.execute(sql`SELECT 1 FROM staff_roster WHERE client_id = ${clientId} LIMIT 1`)).length > 0;
  if (!hasRoster) return 0;
  const sites = rowsOf<{ id: number; department_id: number | null }>(await db.execute(sql`
    SELECT id, department_id FROM sites WHERE client_id = ${clientId} ORDER BY id
  `)).map((row) => ({ id: Number(row.id), departmentId: row.department_id == null ? null : Number(row.department_id) }));
  const existing = new Set(rowsOf<{ site_id: number | null }>(await db.execute(sql`
    SELECT site_id FROM tasks WHERE client_id = ${clientId} AND module = ${ROSTER_CHECK_MODULE}
  `)).map((row) => (row.site_id == null ? null : Number(row.site_id))));
  // A business without sites has one check for the whole business.
  const targets = (sites.length ? sites : [null]).filter((site) => !existing.has(site?.id ?? null));
  if (!targets.length) return 0;
  const managers = (await loadEligibleOwners(clientId)).filter((user) => user.role === "client_manager");
  const startsOn = monthStart(await getAccountToday(clientId));
  let created = 0;
  for (const site of targets) {
    const { assigneeUserId, assigneeRole } = assigneeFor(managers, site);
    // NOT EXISTS keeps a concurrent run from adding a second check for the site.
    const inserted = rowsOf(await db.execute(sql`
      INSERT INTO tasks (client_id, site_id, title, instruction, module, assignee_user_id, assignee_role, recurrence, starts_on)
      SELECT ${clientId}, ${site?.id ?? null}, ${ROSTER_CHECK_TITLE}, ${ROSTER_CHECK_INSTRUCTION}, ${ROSTER_CHECK_MODULE},
             ${assigneeUserId}, ${assigneeRole}, 'monthly', ${startsOn}::date
      WHERE NOT EXISTS (
        SELECT 1 FROM tasks WHERE client_id = ${clientId} AND module = ${ROSTER_CHECK_MODULE}
          AND site_id IS NOT DISTINCT FROM ${site?.id ?? null}::integer
      )
      RETURNING id
    `));
    created += inserted.length;
  }
  return created;
}

/** Every active business: run at start-up and nightly, so new sites and new rosters get their check. */
export async function ensureRosterCheckTasks(): Promise<{ clients: number; created: number; errors: number }> {
  const clients = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT c.id FROM clients c
    WHERE c.active = true AND c.cancelled_at IS NULL
      AND EXISTS (SELECT 1 FROM staff_roster sr WHERE sr.client_id = c.id)
    ORDER BY c.id
  `));
  const result = { clients: clients.length, created: 0, errors: 0 };
  for (const { id } of clients) {
    try {
      result.created += await ensureRosterChecksForClient(Number(id));
    } catch (err) {
      result.errors++;
      logger.warn({ err, clientId: id }, "Roster checks: could not create the monthly roster check");
    }
  }
  return result;
}
