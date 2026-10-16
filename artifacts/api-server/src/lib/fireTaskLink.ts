import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { complianceItemsTable, fireSafetyChecksTable, sitesTable } from "@workspace/db/schema";
import { appendAuditEvent } from "./audit";
import { completionDateFromDay, completionFields } from "./complianceCompletion";
import { supersedeStaleReminderCycles } from "./reminderCycles";
import { getActiveDepartmentId } from "../middleware/requireAuth";

/**
 * FireTrack checks that a ComplyTrack task also covers, keyed by the task's
 * starter title (lib/seedStarterContent.ts). The annual 3-hour emergency
 * lighting discharge test lives in both places, and completing it in either
 * one updates the other:
 * - a passed FireTrack record completes the matching task(s), which then
 *   reopen for next year if they repeat;
 * - completing the task records the test in the FireTrack log.
 */
export const FIRE_LINKED_TASK_TITLES = {
  emergency_lights_annual: "Emergency Light Maintenance",
} as const;
export type FireLinkedCheckType = keyof typeof FIRE_LINKED_TASK_TITLES;

const normalise = (title: string) => title.trim().toLowerCase();

/** The FireTrack check a ComplyTrack task mirrors, if any. */
export function fireCheckTypeForTask(title: string | null | undefined): FireLinkedCheckType | null {
  if (!title) return null;
  const key = normalise(title);
  for (const [checkType, taskTitle] of Object.entries(FIRE_LINKED_TASK_TITLES)) {
    if (normalise(taskTitle) === key) return checkType as FireLinkedCheckType;
  }
  return null;
}

function isLinkedCheckType(checkType: string): checkType is FireLinkedCheckType {
  return Object.prototype.hasOwnProperty.call(FIRE_LINKED_TASK_TITLES, checkType);
}

/** The SQL condition matching a check type's linked tasks by title. */
export function linkedTaskTitleCondition(checkType: FireLinkedCheckType) {
  return sql`lower(trim(${complianceItemsTable.title})) = ${normalise(FIRE_LINKED_TASK_TITLES[checkType])}`;
}

type FireCheck = typeof fireSafetyChecksTable.$inferSelect;
type Task = typeof complianceItemsTable.$inferSelect;

/**
 * A passed FireTrack record completes the linked ComplyTrack task(s) for the
 * same site. A record with no site covers every site, as in the FireTrack
 * status. A task with no site covers the whole business, so one site's test
 * completes it only when the business has a single site; otherwise that site's
 * test would make every other site look tested. A failed test completes
 * nothing, and a task already completed on or after the test date is left
 * alone. Returns the ids of the tasks completed.
 */
export async function completeLinkedTasksFromFireCheck(req: Request, check: FireCheck): Promise<number[]> {
  if (!isLinkedCheckType(check.checkType) || check.result !== "pass") return [];
  const conditions = [
    eq(complianceItemsTable.clientId, check.clientId),
    linkedTaskTitleCondition(check.checkType),
  ];
  if (check.siteId != null) {
    const [{ siteCount }] = await db.select({ siteCount: sql<number>`count(*)::int` }).from(sitesTable)
      .where(eq(sitesTable.clientId, check.clientId));
    conditions.push(Number(siteCount) === 1
      ? sql`(${complianceItemsTable.siteId} IS NULL OR ${complianceItemsTable.siteId} = ${check.siteId})`
      : eq(complianceItemsTable.siteId, check.siteId));
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
    if (deptId !== null && ((siteDepartmentId != null && siteDepartmentId !== deptId)
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
        fromFireSafetyCheck: check.id,
        ...(completion.recurring ? { recurringCompletion: { completedAt, nextDueDate: completion.fields.dueDate } } : {}),
      },
    });
    completed.push(task.id);
  }
  return completed;
}

/**
 * Completing a linked ComplyTrack task records the test in the FireTrack log
 * (a pass on the date done, at the task's site), unless that site already has
 * one on that date — for instance the record that completed the task.
 * Returns the new FireTrack record, if one was made.
 */
export async function recordFireCheckFromTask(req: Request, task: Task, completedAt: Date | string | null): Promise<FireCheck | null> {
  const checkType = fireCheckTypeForTask(task.title);
  if (!checkType || !completedAt) return null;
  const checkDate = new Date(completedAt).toISOString().slice(0, 10);
  const [already] = await db.select({ id: fireSafetyChecksTable.id }).from(fireSafetyChecksTable).where(and(
    eq(fireSafetyChecksTable.clientId, task.clientId),
    eq(fireSafetyChecksTable.checkType, checkType),
    eq(fireSafetyChecksTable.checkDate, checkDate),
    task.siteId == null ? sql`${fireSafetyChecksTable.siteId} IS NULL` : eq(fireSafetyChecksTable.siteId, task.siteId),
  )).limit(1);
  if (already) return null;
  const [inserted] = await db.insert(fireSafetyChecksTable).values({
    clientId: task.clientId,
    siteId: task.siteId,
    checkType,
    checkDate,
    result: "pass",
    notes: `Recorded from the ComplyTrack task "${task.title}".`,
    createdBy: req.currentUser?.id ?? null,
  }).returning();
  await appendAuditEvent(req, {
    clientId: task.clientId, entityType: "fire_safety_check", entityId: inserted.id,
    action: "created", after: inserted, metadata: { fromComplianceItem: task.id },
  });
  return inserted;
}
