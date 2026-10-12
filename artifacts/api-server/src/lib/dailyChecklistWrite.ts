import { db } from "@workspace/db";
import { dailyChecklistsTable, type DailyChecklist } from "@workspace/db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

type ChecklistValues = {
  clientId: number;
  siteId: number | null;
  checklistType: string;
  checkDate: string;
  items?: unknown[];
  managerNote?: string | null;
  submittedAt: Date | null;
  createdBy: number;
};

type Performer = { staffRosterId?: number | null; performedBy: string | null };

export type SaveDailyChecklistResult =
  | { outcome: "created" | "updated" | "already_submitted"; row: DailyChecklist }
  | { outcome: "invalid_performer" };

/**
 * Creates the checklist for a client/site/type/date, or updates its existing
 * draft, so a double submit or retry never adds a second row.
 *
 * There is no unique key on daily_checklists: older databases may already
 * hold duplicates, which a unique index would reject at start-up. Writers for
 * the same slot are serialised with a transaction-scoped advisory lock
 * instead. site_id may be NULL ("no site"), which is its own slot.
 * When duplicates already exist, a submitted row wins, else the newest draft.
 * `resolvePerformer` receives that draft (if any) and returns null for an
 * invalid staff roster member.
 */
export async function saveDailyChecklist(
  values: ChecklistValues,
  resolvePerformer: (existing: DailyChecklist | undefined) => Promise<Performer | null>,
): Promise<SaveDailyChecklistResult> {
  return db.transaction(async (tx) => {
    const slot = `daily_checklists:${values.clientId}:${values.siteId ?? "none"}:${values.checklistType}:${values.checkDate}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${slot}, 0))`);

    const [existing] = await tx.select().from(dailyChecklistsTable)
      .where(and(
        eq(dailyChecklistsTable.clientId, values.clientId),
        values.siteId == null ? isNull(dailyChecklistsTable.siteId) : eq(dailyChecklistsTable.siteId, values.siteId),
        eq(dailyChecklistsTable.checklistType, values.checklistType),
        eq(dailyChecklistsTable.checkDate, values.checkDate),
      ))
      .orderBy(sql`${dailyChecklistsTable.submittedAt} IS NULL`, desc(dailyChecklistsTable.id))
      .limit(1);

    if (existing?.submittedAt) return { outcome: "already_submitted", row: existing };
    const performer = await resolvePerformer(existing);
    if (!performer) return { outcome: "invalid_performer" };

    if (!existing) {
      const [row] = await tx.insert(dailyChecklistsTable).values({
        clientId: values.clientId,
        siteId: values.siteId,
        checklistType: values.checklistType,
        checkDate: values.checkDate,
        items: (values.items ?? []) as any,
        completedBy: performer.performedBy,
        staffRosterId: performer.staffRosterId ?? null,
        managerNote: values.managerNote ?? null,
        submittedAt: values.submittedAt,
        createdBy: values.createdBy,
      } as any).returning();
      return { outcome: "created", row };
    }

    // Same merge as PUT /:id: only the fields this request supplied change.
    const [row] = await tx.update(dailyChecklistsTable)
      .set({
        ...(values.items !== undefined ? { items: values.items as any } : {}),
        completedBy: performer.performedBy,
        staffRosterId: performer.staffRosterId ?? null,
        ...(values.managerNote !== undefined ? { managerNote: values.managerNote } : {}),
        ...(values.submittedAt ? { submittedAt: values.submittedAt } : {}),
        updatedAt: new Date(),
      } as any)
      .where(and(eq(dailyChecklistsTable.id, existing.id), eq(dailyChecklistsTable.clientId, values.clientId)))
      .returning();
    return { outcome: "updated", row };
  });
}
