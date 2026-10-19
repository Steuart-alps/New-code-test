import type { Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { complianceItemsTable, fireSafetyChecksTable, legionellaChecksTable, sitesTable } from "@workspace/db/schema";
import { appendAuditEvent } from "./audit";
import { completionDateFromDay, completionFields } from "./complianceCompletion";
import { supersedeStaleReminderCycles } from "./reminderCycles";
import { getActiveDepartmentId } from "../middleware/requireAuth";
import { siteVisibleToDepartment } from "./departmentSites";

/**
 * Track checks that a ComplyTrack task also covers, keyed by the task's
 * starter title (lib/seedStarterContent.ts). Each job lives in both places,
 * and completing it in either one updates the other:
 * - a passed track record completes the matching task(s), which then reopen
 *   for the next round if they repeat;
 * - completing the task records the job, as a pass, in the track's log.
 */
export const TRACK_TASK_LINKS = {
  fire: {
    emergency_lights_annual: "Emergency Light Maintenance",
    alarm_service: "Fire Alarm Maintenance",
    extinguisher_service: "Fire Extinguishers Maintenance",
  },
  legionella: {
    cold_tank_clean: "Clean & Disinfect Water Tanks",
  },
} as const;
export type LinkedTrack = keyof typeof TRACK_TASK_LINKS;

const AUDIT_SOURCE_KEY: Record<LinkedTrack, string> = {
  fire: "fromFireSafetyCheck",
  legionella: "fromLegionellaCheck",
};
const AUDIT_ENTITY_TYPE: Record<LinkedTrack, string> = {
  fire: "fire_safety_check",
  legionella: "legionella_check",
};

const normalise = (title: string) => title.trim().toLowerCase();

/** The ComplyTrack task title a track check mirrors, if any. */
function linkedTaskTitle(track: LinkedTrack, checkType: string): string | null {
  const links: Record<string, string> = TRACK_TASK_LINKS[track];
  return Object.prototype.hasOwnProperty.call(links, checkType) ? links[checkType] : null;
}

/** The track check a ComplyTrack task mirrors, if any. */
export function trackCheckForTask(title: string | null | undefined): { track: LinkedTrack; checkType: string } | null {
  if (!title) return null;
  const key = normalise(title);
  for (const track of Object.keys(TRACK_TASK_LINKS) as LinkedTrack[]) {
    for (const [checkType, taskTitle] of Object.entries(TRACK_TASK_LINKS[track])) {
      if (normalise(taskTitle) === key) return { track, checkType };
    }
  }
  return null;
}

/** The business's only site, or null when it has none or several. */
async function soleSiteId(clientId: number): Promise<number | null> {
  const rows = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.clientId, clientId)).limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

type Task = typeof complianceItemsTable.$inferSelect;
type TrackCheck = { id: number; clientId: number; siteId: number | null; checkType: string; checkDate: string; result: string };

/**
 * A passed track record completes the linked ComplyTrack task(s) for the same
 * site. A task with no site covers the whole business, so one site's record
 * completes it only when the business has a single site; otherwise that
 * site's record would make every other site look done. A FireTrack record
 * with no site covers every site, as in the FireTrack status; water records
 * are judged per site, so one with no site completes only business-wide
 * tasks. A failed record completes nothing, and a task already completed on
 * or after the record's date is left alone. Returns the ids of the tasks
 * completed.
 */
export async function completeLinkedTasksFromCheck(req: Request, track: LinkedTrack, check: TrackCheck): Promise<number[]> {
  const title = linkedTaskTitle(track, check.checkType);
  if (!title || check.result !== "pass") return [];
  const conditions = [
    eq(complianceItemsTable.clientId, check.clientId),
    sql`lower(trim(${complianceItemsTable.title})) = ${normalise(title)}`,
  ];
  if (check.siteId != null) {
    conditions.push(await soleSiteId(check.clientId) === check.siteId
      ? sql`(${complianceItemsTable.siteId} IS NULL OR ${complianceItemsTable.siteId} = ${check.siteId})`
      : eq(complianceItemsTable.siteId, check.siteId));
  } else if (track === "legionella") {
    conditions.push(isNull(complianceItemsTable.siteId));
  }
  const rows = await db
    .select({ task: complianceItemsTable, siteDepartmentId: sitesTable.departmentId })
    .from(complianceItemsTable)
    .leftJoin(sitesTable, eq(sitesTable.id, complianceItemsTable.siteId))
    .where(and(...conditions));

  // Someone working in one department never completes another department's task.
  const deptId = getActiveDepartmentId(req);
  const completedAt = completionDateFromDay(String(check.checkDate).slice(0, 10));
  const completed: number[] = [];
  for (const { task, siteDepartmentId } of rows) {
    if (deptId !== null && ((task.siteId != null && !(await siteVisibleToDepartment({ id: task.siteId, departmentId: siteDepartmentId }, deptId)))
      || (task.departmentId != null && task.departmentId !== deptId))) continue;
    if (task.completedAt && new Date(task.completedAt).getTime() >= completedAt.getTime()) continue;
    const completion = completionFields(task.frequencyMonths, completedAt);
    const fields = { ...completion.fields, ...(completion.recurring ? { notificationSentAt: null } : {}), updatedAt: new Date() };
    let after: Task | undefined;
    await db.transaction(async (tx) => {
      [after] = await tx.update(complianceItemsTable).set(fields).where(eq(complianceItemsTable.id, task.id)).returning();
      await supersedeStaleReminderCycles(tx, task.clientId, task.id);
    });
    await appendAuditEvent(req, {
      clientId: task.clientId, entityType: "compliance_item", entityId: task.id,
      action: "status_changed", before: task, after,
      metadata: {
        [AUDIT_SOURCE_KEY[track]]: check.id,
        ...(completion.recurring ? { recurringCompletion: { completedAt, nextDueDate: completion.fields.dueDate } } : {}),
      },
    });
    completed.push(task.id);
  }
  return completed;
}

/**
 * Completing a linked ComplyTrack task records the job in the track's log (a
 * pass on the date done, at the task's site), unless that site already has
 * one on that date — for instance the record that completed the task. A
 * business-wide task goes in the FireTrack log with no site (covering every
 * site); in the water log, which is kept per site, it is recorded only at a
 * business with a single site. Returns the new record, if one was made.
 */
export async function recordTrackCheckFromTask(req: Request, task: Task, completedAt: Date | string | null) {
  const link = trackCheckForTask(task.title);
  if (!link || !completedAt) return null;
  const { track, checkType } = link;
  const siteId = task.siteId ?? (track === "legionella" ? await soleSiteId(task.clientId) : null);
  if (track === "legionella" && siteId == null) return null;
  const checkDate = new Date(completedAt).toISOString().slice(0, 10);
  const values = {
    clientId: task.clientId,
    siteId,
    checkType,
    checkDate,
    result: "pass",
    notes: `Recorded from the ComplyTrack task "${task.title}".`,
    createdBy: req.currentUser?.id ?? null,
  };

  let inserted: { id: number } | undefined;
  if (track === "fire") {
    const [already] = await db.select({ id: fireSafetyChecksTable.id }).from(fireSafetyChecksTable).where(and(
      eq(fireSafetyChecksTable.clientId, task.clientId),
      eq(fireSafetyChecksTable.checkType, checkType),
      eq(fireSafetyChecksTable.checkDate, checkDate),
      siteId == null ? isNull(fireSafetyChecksTable.siteId) : eq(fireSafetyChecksTable.siteId, siteId),
    )).limit(1);
    if (already) return null;
    [inserted] = await db.insert(fireSafetyChecksTable).values(values).returning();
  } else {
    const [already] = await db.select({ id: legionellaChecksTable.id }).from(legionellaChecksTable).where(and(
      eq(legionellaChecksTable.clientId, task.clientId),
      eq(legionellaChecksTable.checkType, checkType),
      eq(legionellaChecksTable.checkDate, checkDate),
      eq(legionellaChecksTable.siteId, siteId!),
    )).limit(1);
    if (already) return null;
    [inserted] = await db.insert(legionellaChecksTable).values(values).returning();
  }
  await appendAuditEvent(req, {
    clientId: task.clientId, entityType: AUDIT_ENTITY_TYPE[track], entityId: inserted!.id,
    action: "created", after: inserted, metadata: { fromComplianceItem: task.id },
  });
  return inserted!;
}

/**
 * The latest completion date (YYYY-MM-DD) of each task linked to a track,
 * keyed `${siteId}:${checkType}` (siteId "none" for a business-wide task).
 * Track statuses count these as passed records, so completions from before
 * the two were linked still show. For the water log a business-wide task
 * counts at the business's only site, and not at all with several sites.
 */
export async function linkedTaskCompletions(clientId: number, track: LinkedTrack): Promise<Map<string, string>> {
  const checkTypeByTitle = new Map(Object.entries(TRACK_TASK_LINKS[track]).map(([checkType, title]) => [normalise(title), checkType]));
  const result = await db.execute(sql`
    SELECT site_id, lower(trim(title)) AS title, to_char(max(completed_at), 'YYYY-MM-DD') AS completed_on
    FROM compliance_items
    WHERE client_id = ${clientId} AND completed_at IS NOT NULL
      AND lower(trim(title)) IN (${sql.join([...checkTypeByTitle.keys()].map(title => sql`${title}`), sql`, `)})
    GROUP BY site_id, lower(trim(title))
  `);
  const rows = (result.rows ?? []) as { site_id: number | null; title: string; completed_on: string }[];
  const businessWideSite = track === "legionella" && rows.some(row => row.site_id == null) ? await soleSiteId(clientId) : null;
  const latest = new Map<string, string>();
  for (const row of rows) {
    const checkType = checkTypeByTitle.get(row.title);
    if (!checkType) continue;
    let site: string;
    if (row.site_id != null) site = String(Number(row.site_id));
    else if (track === "fire") site = "none";
    else if (businessWideSite != null) site = String(businessWideSite);
    else continue;
    const key = `${site}:${checkType}`;
    const previous = latest.get(key);
    if (!previous || previous < row.completed_on) latest.set(key, row.completed_on);
  }
  return latest;
}
