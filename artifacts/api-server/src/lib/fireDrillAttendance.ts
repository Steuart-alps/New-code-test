import { db } from "@workspace/db";
import { fireDrillAttendanceTable } from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { visibleSiteIdsSql } from "./departmentSites";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A person ticked as present at a fire drill. */
export type DrillAttendee = { staffRosterId: number | null; name: string };

/** Everyone should take part in a fire drill at least once in this many months. */
export const DRILL_ATTENDANCE_MONTHS = 12;

/**
 * Check the roster ids ticked on a drill. A new tick must be an active roster
 * member of this business whose site the caller can see; someone already on
 * the record stays on it (with the name recorded then) even if they have
 * since left the roster or moved site.
 */
export async function resolveDrillAttendees(
  clientId: number, departmentId: number | null, ids: number[], existingCheckId?: number,
): Promise<{ attendees: { staffRosterId: number; name: string }[] } | { error: string }> {
  const wanted = Array.from(new Set(ids));
  const recorded = new Map<number, string>();
  if (existingCheckId !== undefined) {
    const rows = await db.select({ staffRosterId: fireDrillAttendanceTable.staffRosterId, staffName: fireDrillAttendanceTable.staffName })
      .from(fireDrillAttendanceTable)
      .where(and(eq(fireDrillAttendanceTable.clientId, clientId), eq(fireDrillAttendanceTable.fireCheckId, existingCheckId)));
    for (const row of rows) if (row.staffRosterId != null) recorded.set(row.staffRosterId, row.staffName);
  }
  const added = wanted.filter(id => !recorded.has(id));
  const names = new Map<number, string>();
  if (added.length > 0) {
    const result = await db.execute(sql`
      SELECT sr.id, sr.name FROM staff_roster sr
      WHERE sr.client_id = ${clientId} AND sr.active = true
        AND sr.id IN (${sql.join(added.map(id => sql`${id}`), sql`, `)})
        ${departmentId === null ? sql`` : sql`AND (sr.site_id IS NULL OR sr.site_id IN (${visibleSiteIdsSql(clientId, departmentId)}))`}
    `);
    for (const row of (result.rows ?? []) as { id: number; name: string }[]) names.set(Number(row.id), row.name);
    if (names.size !== added.length) return { error: "Tick staff from the staff roster" };
  }
  return { attendees: wanted.map(id => ({ staffRosterId: id, name: recorded.get(id) ?? names.get(id)! })) };
}

/**
 * Record who was present at a drill. On an edit the ticked list replaces the
 * old one; a row whose roster entry has since been deleted cannot be ticked
 * again, so it is kept.
 */
export async function saveDrillAttendees(
  tx: Tx, clientId: number, fireCheckId: number, attendees: { staffRosterId: number; name: string }[],
) {
  const ids = attendees.map(a => a.staffRosterId);
  await tx.delete(fireDrillAttendanceTable).where(and(
    eq(fireDrillAttendanceTable.clientId, clientId),
    eq(fireDrillAttendanceTable.fireCheckId, fireCheckId),
    isNotNull(fireDrillAttendanceTable.staffRosterId),
    ...(ids.length > 0 ? [notInArray(fireDrillAttendanceTable.staffRosterId, ids)] : []),
  ));
  if (attendees.length === 0) return;
  await tx.insert(fireDrillAttendanceTable)
    .values(attendees.map(a => ({ clientId, fireCheckId, staffRosterId: a.staffRosterId, staffName: a.name })))
    .onConflictDoNothing();
}

/** Staff present at each of these drills, by check id, in name order. */
export async function listDrillAttendees(clientId: number, fireCheckIds: number[]): Promise<Map<number, DrillAttendee[]>> {
  const byCheck = new Map<number, DrillAttendee[]>();
  if (fireCheckIds.length === 0) return byCheck;
  const rows = await db.select().from(fireDrillAttendanceTable)
    .where(and(eq(fireDrillAttendanceTable.clientId, clientId), inArray(fireDrillAttendanceTable.fireCheckId, fireCheckIds)))
    .orderBy(fireDrillAttendanceTable.staffName, fireDrillAttendanceTable.id);
  for (const row of rows) {
    const list = byCheck.get(row.fireCheckId) ?? [];
    list.push({ staffRosterId: row.staffRosterId, name: row.staffName });
    byCheck.set(row.fireCheckId, list);
  }
  return byCheck;
}

/** The ISO date `months` calendar months before `isoDate` (clamped to month end). */
export function monthsBefore(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export type StaffDrillStatus = {
  staffRosterId: number;
  name: string;
  siteId: number | null;
  siteName: string | null;
  lastDrillDate: string | null;
  /** True when they have not been at a drill in the last DRILL_ATTENDANCE_MONTHS months. */
  due: boolean;
};

/**
 * Every active roster member the caller can see, with the latest drill they
 * were ticked present at. With a site, staff at that site and staff with no
 * site (who work across the business).
 */
export async function staffDrillStatuses(
  clientId: number, departmentId: number | null, siteId: number | null, today: string,
): Promise<StaffDrillStatus[]> {
  const result = await db.execute(sql`
    SELECT sr.id, sr.name, sr.site_id, s.name AS site_name, last.last_drill_date
    FROM staff_roster sr
    LEFT JOIN sites s ON s.id = sr.site_id AND s.client_id = sr.client_id
    LEFT JOIN LATERAL (
      SELECT max(f.check_date)::text AS last_drill_date
      FROM fire_drill_attendance a
      JOIN fire_safety_checks f ON f.id = a.fire_check_id AND f.client_id = a.client_id
      WHERE a.client_id = ${clientId} AND a.staff_roster_id = sr.id AND f.check_type = 'fire_drill'
    ) last ON true
    WHERE sr.client_id = ${clientId} AND sr.active = true
      ${departmentId === null ? sql`` : sql`AND (sr.site_id IS NULL OR sr.site_id IN (${visibleSiteIdsSql(clientId, departmentId)}))`}
      ${siteId === null ? sql`` : sql`AND (sr.site_id IS NULL OR sr.site_id = ${siteId})`}
    ORDER BY sr.name ASC, sr.id ASC
  `);
  const cutoff = monthsBefore(today, DRILL_ATTENDANCE_MONTHS);
  return ((result.rows ?? []) as any[]).map(row => {
    const lastDrillDate = row.last_drill_date ? String(row.last_drill_date) : null;
    return {
      staffRosterId: Number(row.id),
      name: String(row.name),
      siteId: row.site_id == null ? null : Number(row.site_id),
      siteName: row.site_name ?? null,
      lastDrillDate,
      due: lastDrillDate === null || lastDrillDate <= cutoff,
    };
  });
}
