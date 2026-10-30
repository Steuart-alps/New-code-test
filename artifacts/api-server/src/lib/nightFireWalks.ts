/**
 * Night porter fire walks. A site with sleeping accommodation and a night
 * porter needs three signed fire walks every night, at 22:00, 02:00 and
 * 06:00 (the business's local time). Each is a FireTrack record of type
 * "night_walk" whose check_date is the day the walk fell on, so the 02:00 and
 * 06:00 walks of the night of 29 October are dated 30 October.
 *
 * A walk is "due" from its time until an hour after, then "missed". The
 * morning after, any missed walk raises one Urgent FireTrack action per site
 * (runNightFireWalkChaseJob), which the same-day alerts send to the Managers
 * who cover the site and the Owners. Nobody is woken in the night.
 */
import { db } from "@workspace/db";
import { trackActionsTable, auditEventsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { addCalendarDays, getAccountTimezone, localDateIn, zonedDateTimeToUtc } from "./accountClock";
import { logger } from "./logger";
import { getEntitledServices, isEntitled } from "./services";
import { isClientBillingLocked } from "./trialLock";

export const NIGHT_WALK_TIMES = ["22:00", "02:00", "06:00"] as const;
export type NightWalkTime = (typeof NIGHT_WALK_TIMES)[number];
/** A walk counts as missed this long after its time. */
export const NIGHT_WALK_GRACE_MINUTES = 60;
/** A walk can be recorded up to this long before its time (a porter starting early). */
export const NIGHT_WALK_EARLY_MINUTES = 60;
/** Tonight plus the six nights before. */
export const NIGHT_WALK_NIGHTS = 7;
/** The morning chase runs from this local time, once every walk of the night has passed. */
const CHASE_FROM_HOUR = 7;
export const NIGHT_WALK_ACTION_KIND = "night_fire_walk_missed";

export type NightWalkStatus = "done" | "failed" | "due" | "missed" | "upcoming" | "not_needed";

export interface NightWalk {
  date: string;
  time: NightWalkTime;
  status: NightWalkStatus;
  checkId: number | null;
  performedBy: string | null;
}

export interface NightWalkSite {
  siteId: number;
  siteName: string;
  nights: { nightOf: string; walks: NightWalk[] }[];
  missedCount: number;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

/** The evening a walk's night starts: the 02:00 and 06:00 walks belong to the night before. */
export function nightOfWalk(date: string, time: NightWalkTime): string {
  return time === "22:00" ? date : addCalendarDays(date, -1);
}

/** The calendar day of each walk of a night. */
export function walksOfNight(nightOf: string): { date: string; time: NightWalkTime }[] {
  return NIGHT_WALK_TIMES.map(time => ({ time, date: time === "22:00" ? nightOf : addCalendarDays(nightOf, 1) }));
}

/** From midday the night ahead is "tonight"; before midday it is the night just ending. */
export function currentNightOf(timeZone: string, now: Date): string {
  const today = localDateIn(timeZone, now);
  return now >= zonedDateTimeToUtc(today, "12:00", timeZone) ? today : addCalendarDays(today, -1);
}

/** When the walk was due, as an instant. */
export function walkInstant(date: string, time: NightWalkTime, timeZone: string): Date {
  return zonedDateTimeToUtc(date, time, timeZone);
}

function walkStatus(
  slot: { date: string; time: NightWalkTime }, recorded: { id: number; result: string; performed_by: string | null } | undefined,
  timeZone: string, now: Date, since: Date | null,
): NightWalk {
  const base = { ...slot, checkId: recorded ? Number(recorded.id) : null, performedBy: recorded?.performed_by ?? null };
  if (recorded) return { ...base, status: recorded.result === "fail" ? "failed" : "done" };
  const at = walkInstant(slot.date, slot.time, timeZone).getTime();
  if (since && at < since.getTime()) return { ...base, status: "not_needed" };
  if (now.getTime() < at) return { ...base, status: "upcoming" };
  if (now.getTime() < at + NIGHT_WALK_GRACE_MINUTES * 60_000) return { ...base, status: "due" };
  return { ...base, status: "missed" };
}

/**
 * Night walks for each site with a night porter in scope, tonight first and
 * then the nights before. `accessibleSiteIds` null means every site.
 */
export async function nightWalkSites(
  clientId: number,
  scope: { siteId?: number | null; accessibleSiteIds?: number[] | null; nights?: number; lastNightOf?: string },
  now: Date = new Date(),
): Promise<NightWalkSite[]> {
  const conditions = [sql`client_id = ${clientId}`, sql`night_porter = true`];
  if (scope.siteId != null) conditions.push(sql`id = ${scope.siteId}`);
  if (scope.accessibleSiteIds) {
    if (!scope.accessibleSiteIds.length) return [];
    conditions.push(sql`id IN (${sql.join(scope.accessibleSiteIds.map(id => sql`${id}`), sql`, `)})`);
  }
  const sites = rowsOf<{ id: number; name: string; night_porter_since: string | Date | null }>(await db.execute(sql`
    SELECT id, name, night_porter_since FROM sites WHERE ${sql.join(conditions, sql` AND `)} ORDER BY name, id
  `));
  if (!sites.length) return [];
  const timeZone = await getAccountTimezone(clientId);
  const latestNight = scope.lastNightOf ?? currentNightOf(timeZone, now);
  const nightCount = scope.nights ?? NIGHT_WALK_NIGHTS;
  const nights = Array.from({ length: nightCount }, (_, index) => addCalendarDays(latestNight, -index));
  const from = nights[nights.length - 1]!;
  const to = addCalendarDays(latestNight, 1);
  const siteIds = sites.map(site => Number(site.id));
  const records = rowsOf<{ id: number; site_id: number; check_date: string; walk_time: string; result: string; performed_by: string | null }>(
    await db.execute(sql`
      SELECT DISTINCT ON (site_id, check_date, walk_time) id, site_id, check_date::text AS check_date, walk_time, result, performed_by
      FROM fire_safety_checks
      WHERE client_id = ${clientId} AND check_type = 'night_walk'
        AND site_id IN (${sql.join(siteIds.map(id => sql`${id}`), sql`, `)})
        AND check_date BETWEEN ${from} AND ${to}
      ORDER BY site_id, check_date, walk_time, id DESC
    `),
  );
  const byKey = new Map(records.map(row => [`${Number(row.site_id)}:${String(row.check_date).slice(0, 10)}:${row.walk_time}`, row]));
  return sites.map(site => {
    const since = site.night_porter_since ? new Date(site.night_porter_since) : null;
    const siteNights = nights.map(nightOf => ({
      nightOf,
      walks: walksOfNight(nightOf).map(slot =>
        walkStatus(slot, byKey.get(`${Number(site.id)}:${slot.date}:${slot.time}`), timeZone, now, since)),
    }));
    return {
      siteId: Number(site.id),
      siteName: site.name,
      nights: siteNights,
      missedCount: siteNights.reduce((total, night) => total + night.walks.filter(walk => walk.status === "missed").length, 0),
    };
  });
}

function dayLabel(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export interface NightWalkChaseResult {
  clientsChecked: number;
  actionsRaised: number;
  errors: number;
}

/**
 * The morning after: one Urgent FireTrack action per site for the night's
 * missed walks, at most once per site and night. Hourly; each business is
 * handled from its own local 07:00, once all three walks have passed.
 */
export async function runNightFireWalkChaseJob(options: { now?: Date; clientIds?: number[] } = {}): Promise<NightWalkChaseResult> {
  const now = options.now ?? new Date();
  const result: NightWalkChaseResult = { clientsChecked: 0, actionsRaised: 0, errors: 0 };
  const clientFilter = options.clientIds?.length
    ? sql`AND client_id IN (${sql.join(options.clientIds.map(id => sql`${id}`), sql`, `)})` : sql``;
  const clients = rowsOf<{ client_id: number }>(await db.execute(sql`
    SELECT DISTINCT client_id FROM sites WHERE night_porter = true ${clientFilter}
  `));
  for (const { client_id } of clients) {
    const clientId = Number(client_id);
    try {
      const timeZone = await getAccountTimezone(clientId);
      const today = localDateIn(timeZone, now);
      if (now < zonedDateTimeToUtc(today, `${String(CHASE_FROM_HOUR).padStart(2, "0")}:00`, timeZone)) continue;
      if (!isEntitled(await getEntitledServices(clientId), "firetrack")) continue;
      if (await isClientBillingLocked(clientId)) continue;
      result.clientsChecked += 1;
      const nightOf = addCalendarDays(today, -1);
      for (const site of await nightWalkSites(clientId, { nights: 1, lastNightOf: nightOf }, now)) {
        const missed = site.nights[0]!.walks.filter(walk => walk.status === "missed");
        if (!missed.length) continue;
        const sourceKind = `${NIGHT_WALK_ACTION_KIND}:${nightOf}`;
        const raised = await db.transaction(async (tx) => {
          // One action per site and night, however often the job runs.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${clientId}:${site.siteId}:${sourceKind}`}))`);
          const existing = rowsOf(await tx.execute(sql`
            SELECT 1 FROM track_actions WHERE client_id = ${clientId} AND site_id = ${site.siteId} AND source_kind = ${sourceKind} LIMIT 1
          `));
          if (existing.length) return false;
          const times = missed.map(walk => walk.time);
          const [action] = await tx.insert(trackActionsTable).values({
            clientId, siteId: site.siteId, module: "fire",
            sourceKind, provenance: "product_default", severity: "urgent", status: "open",
            title: `Night fire walk${times.length === 1 ? "" : "s"} missed: ${times.join(", ")} (night of ${dayLabel(nightOf)})`,
            instruction: `${site.siteName}: the night porter's fire walk${times.length === 1 ? " was" : "s were"} not recorded at ${times.join(", ")} `
              + `on the night of ${dayLabel(nightOf)}. Find out why. If a walk was done, record it in FireTrack with a note. `
              + "Say what has been done so walks are not missed again, then resolve this action.",
            dueDate: today,
          }).returning();
          await tx.insert(auditEventsTable).values({
            clientId, actorId: null, entityType: "track_action", entityId: action!.id,
            action: "night_fire_walk_missed", after: action, metadata: { module: "fire", siteId: site.siteId, nightOf, times },
          });
          return true;
        });
        if (raised) result.actionsRaised += 1;
      }
    } catch (err) {
      result.errors += 1;
      logger.warn({ err, clientId }, "Night fire walk chase failed for a business");
    }
  }
  return result;
}
