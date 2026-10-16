/**
 * Daily in-app reminders for uncompleted checks, sent to each track's owner
 * (lib/trackOwners.ts) as notifications: the header bell on the web and an
 * Expo push on the phone. This job never sends email.
 *
 * Runs hourly; each business is evaluated on its own clock (Settings
 * timezone, default Europe/London). A phase runs during a three-hour window
 * from its start hour, so a restart or deploy at the start hour does not
 * skip the day; the per-user dedupe key keeps it to one notification per
 * owner, kind, site and day.
 *   09:00  overdue checks: FireTrack, LegionellaTrack, AquaTrack and TubTrack
 *          checks (getCheckAlerts), overdue compliance checks, and open track
 *          actions past their due date.
 *   11:00  today's AM (opening) checklist not submitted, per site.
 *   21:00  today's PM (closing) checklist and today's KitchenTrack diary not
 *          submitted, per site.
 * Daily checklists and the kitchen diary are only chased at sites that have
 * used them in the last 30 days, or once an owner has been set for the track,
 * so a business trialling every module is not reminded about tracks it does
 * not use.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { addCalendarDays, getAccountTimezone, localDateIn } from "./accountClock";
import { getCheckAlerts, type CheckAlert } from "./checkReminders";
import { getDailyChecklistCompletionBySite, submittedDailyChecklists } from "./dailyChecklistCompletion";
import { logger } from "./logger";
import { sendPushToUsers } from "./pushNotifications";
import { getEntitledServices, isEntitled, type Entitlements } from "./services";
import { getTrackModule, isTrackModuleKey } from "./trackModules";
import { isClientBillingLocked } from "./trialLock";
import { hasExplicitOwner, loadOwnerContext, resolveOwnersFromContext, type OwnerContext } from "./trackOwners";
import { createUserNotifications, purgeOldUserNotifications, type NewUserNotification } from "./userNotifications";

export const TRACK_REMINDER_HOURS = { overdue: 9, am: 11, pm: 21 } as const;
/** Hours after the start hour during which a missed phase still runs. */
export const TRACK_REMINDER_WINDOW_HOURS = 3;
/** A site "uses" a daily track when it recorded one in this many days. */
const IN_USE_DAYS = 30;
const MAX_BODY_ITEMS = 5;

export interface TrackReminderJobOptions {
  /** Clock override (tests). */
  now?: Date;
  /** Only these businesses (tests); default every active business. */
  clientIds?: number[];
  sendPush?: typeof sendPushToUsers;
  /** Skip the retention purge (tests). */
  skipPurge?: boolean;
}

export interface TrackReminderJobResult {
  clientsChecked: number;
  notificationsCreated: number;
  purged: number;
  errors: number;
}

interface Site { id: number; name: string }

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

/** Local wall-clock hour (0-23) at `now` in the timezone. */
export function localHourIn(timeZone: string, now: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now).find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0);
}

function inWindow(hour: number, start: number): boolean {
  return hour >= start && hour < start + TRACK_REMINDER_WINDOW_HOURS;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function summarise(items: string[]): string {
  const shown = items.slice(0, MAX_BODY_ITEMS).join(", ");
  return items.length > MAX_BODY_ITEMS ? `${shown} and ${items.length - MAX_BODY_ITEMS} more` : shown;
}

class ReminderBatch {
  readonly items: NewUserNotification[] = [];
  constructor(private ctx: OwnerContext, private today: string) {}

  /** Queue one notification per resolved owner of the module at the site. */
  add(input: { module: string; siteId: number | null; kind: string; title: string; body: string; linkPath: string }) {
    const scope = input.siteId != null ? `site:${input.siteId}` : `client:${this.ctx.clientId}`;
    for (const userId of resolveOwnersFromContext(this.ctx, input.module, input.siteId)) {
      this.items.push({
        clientId: this.ctx.clientId,
        userId,
        module: input.module,
        siteId: input.siteId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        linkPath: input.linkPath,
        dedupeKey: `${input.kind}:${scope}:${this.today}`,
      });
    }
  }
}

const entitledTo = (services: Entitlements, module: string) =>
  getTrackModule(module)?.services.some((key) => isEntitled(services, key)) ?? false;

async function dailyChecklistReminders(
  batch: ReminderBatch, ctx: OwnerContext, clientId: number, sites: Site[], today: string, period: "am" | "pm",
): Promise<void> {
  if (sites.length === 0) return;
  const module = period === "am" ? "daily_am" : "daily_pm";
  const recent = await db.execute(sql`
    SELECT site_id, BOOL_OR(period = ${period}) AS used
    FROM ${submittedDailyChecklists(clientId, addCalendarDays(today, -IN_USE_DAYS), today)} checklists
    WHERE site_id IS NOT NULL
    GROUP BY site_id
  `);
  const inUse = new Set(rowsOf<{ site_id: number; used: unknown }>(recent)
    .filter((row) => row.used === true || row.used === "true")
    .map((row) => Number(row.site_id)));
  const candidates = sites.filter((site) => inUse.has(site.id) || hasExplicitOwner(ctx, module, site.id));
  if (candidates.length === 0) return;
  const completion = await getDailyChecklistCompletionBySite(clientId, today, candidates.map((site) => site.id));
  const label = period === "am" ? "AM" : "PM";
  const description = period === "am" ? "opening (AM)" : "closing (PM)";
  for (const site of candidates) {
    if (completion.get(site.id)?.[period]) continue;
    batch.add({
      module, siteId: site.id, kind: module,
      title: `${label} checklist not done — ${site.name}`,
      body: `Today's ${description} checklist for ${site.name} hasn't been submitted yet.`,
      linkPath: getTrackModule(module)!.path,
    });
  }
}

async function kitchenDiaryReminders(
  batch: ReminderBatch, ctx: OwnerContext, clientId: number, sites: Site[], businessName: string, today: string,
): Promise<void> {
  // The diary is per site; a business without sites keeps one whole-business diary.
  const units: Array<{ id: number | null; name: string }> = sites.length ? sites : [{ id: null, name: businessName }];
  const rows = rowsOf<{ site_id: number | null; used: unknown; done: unknown }>(await db.execute(sql`
    SELECT site_id,
           TRUE AS used,
           BOOL_OR(record_date = ${today}::date AND submitted_at IS NOT NULL) AS done
    FROM food_safety_records
    WHERE client_id = ${clientId}
      AND record_date BETWEEN ${addCalendarDays(today, -IN_USE_DAYS)}::date AND ${today}::date
    GROUP BY site_id
  `));
  const key = (siteId: number | null) => (siteId == null ? "none" : String(siteId));
  const bySite = new Map(rows.map((row) => [key(row.site_id == null ? null : Number(row.site_id)), row]));
  for (const unit of units) {
    const row = bySite.get(key(unit.id));
    const inUse = Boolean(row) || hasExplicitOwner(ctx, "kitchen", unit.id);
    if (!inUse) continue;
    if (row && (row.done === true || row.done === "true")) continue;
    batch.add({
      module: "kitchen", siteId: unit.id, kind: "kitchen_diary",
      title: `Kitchen diary not done — ${unit.name}`,
      body: `Today's KitchenTrack diary for ${unit.name} hasn't been submitted yet.`,
      linkPath: getTrackModule("kitchen")!.path,
    });
  }
}

async function overdueReminders(
  batch: ReminderBatch, clientId: number, services: Entitlements, businessName: string, today: string,
): Promise<void> {
  const where = (siteName: string | null) => siteName ?? businessName;

  // Periodic safety checks (fire, legionella, pool, hot tub), per site.
  let alerts: CheckAlert[] = [];
  try {
    alerts = await getCheckAlerts(clientId);
  } catch (err) {
    logger.warn({ err, clientId }, "Track reminders: could not evaluate check alerts");
  }
  const groups = new Map<string, CheckAlert[]>();
  for (const alert of alerts) {
    if (alert.status !== "overdue" || !entitledTo(services, alert.module)) continue;
    const groupKey = `${alert.module}:${alert.siteId ?? ""}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), alert]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const module = getTrackModule(first.module)!;
    const siteName = first.siteName ?? null;
    const labels = group.map((alert) =>
      siteName && alert.checkLabel.startsWith(`${siteName}: `) ? alert.checkLabel.slice(siteName.length + 2) : alert.checkLabel);
    batch.add({
      module: first.module, siteId: first.siteId ?? null, kind: `overdue_${first.module}`,
      title: `${plural(group.length, `${module.label} check`)} overdue — ${where(siteName)}`,
      body: `Overdue: ${summarise(labels)}.`,
      linkPath: first.modulePath || module.path,
    });
  }

  // Compliance checks (gas, EICR, LOLER...) past their due date.
  const compliance = rowsOf<{ site_id: number | null; site_name: string | null; titles: string[] }>(await db.execute(sql`
    SELECT s.id AS site_id, s.name AS site_name,
           array_agg(ci.title ORDER BY ci.due_date, ci.id) AS titles
    FROM compliance_items ci
    LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = ci.client_id
    WHERE ci.client_id = ${clientId}
      AND (ci.site_id IS NULL OR s.id IS NOT NULL)
      AND ci.status <> 'completed'
      AND ci.due_date IS NOT NULL
      AND ci.due_date::date < ${today}::date
    GROUP BY s.id, s.name
  `));
  for (const row of compliance) {
    const titles = row.titles ?? [];
    batch.add({
      module: "compliance", siteId: row.site_id == null ? null : Number(row.site_id), kind: "overdue_compliance",
      title: `${plural(titles.length, "compliance check")} overdue — ${where(row.site_name)}`,
      body: `Overdue: ${summarise(titles)}.`,
      linkPath: getTrackModule("compliance")!.path,
    });
  }

  // Open track actions past their due date, by module.
  const actions = rowsOf<{ module: string; site_id: number | null; site_name: string | null; titles: string[] }>(await db.execute(sql`
    SELECT a.module, s.id AS site_id, s.name AS site_name,
           array_agg(a.title ORDER BY a.due_date, a.id) AS titles
    FROM track_actions a
    LEFT JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
    WHERE a.client_id = ${clientId}
      AND (a.site_id IS NULL OR s.id IS NOT NULL)
      AND a.status <> 'resolved'
      AND a.due_date IS NOT NULL
      AND a.due_date < ${today}::date
    GROUP BY a.module, s.id, s.name
  `));
  for (const row of actions) {
    if (!isTrackModuleKey(row.module) || !entitledTo(services, row.module)) continue;
    const module = getTrackModule(row.module)!;
    const titles = row.titles ?? [];
    batch.add({
      module: row.module, siteId: row.site_id == null ? null : Number(row.site_id), kind: `overdue_actions_${row.module}`,
      title: `${plural(titles.length, `${module.label} action`)} overdue — ${where(row.site_name)}`,
      body: `Overdue: ${summarise(titles)}.`,
      linkPath: module.path,
    });
  }
}

/** Evaluate one business at `now`; returns the notifications to create. */
export async function collectTrackReminders(clientId: number, now: Date): Promise<NewUserNotification[]> {
  const timeZone = await getAccountTimezone(clientId);
  const hour = localHourIn(timeZone, now);
  const phases = {
    overdue: inWindow(hour, TRACK_REMINDER_HOURS.overdue),
    am: inWindow(hour, TRACK_REMINDER_HOURS.am),
    pm: inWindow(hour, TRACK_REMINDER_HOURS.pm),
  };
  if (!phases.overdue && !phases.am && !phases.pm) return [];
  // A business locked out by an ended trial can't open the reminders anyway.
  if (await isClientBillingLocked(clientId).catch(() => false)) return [];

  const today = localDateIn(timeZone, now);
  const [services, ctx, siteResult, clientResult] = await Promise.all([
    getEntitledServices(clientId),
    loadOwnerContext(clientId),
    db.execute(sql`SELECT id, name FROM sites WHERE client_id = ${clientId} ORDER BY name, id`),
    db.execute(sql`SELECT name FROM clients WHERE id = ${clientId}`),
  ]);
  const sites = rowsOf<{ id: number; name: string }>(siteResult).map((row) => ({ id: Number(row.id), name: row.name }));
  const businessName = rowsOf<{ name: string }>(clientResult)[0]?.name ?? "your business";
  const batch = new ReminderBatch(ctx, today);

  if (phases.overdue) await overdueReminders(batch, clientId, services, businessName, today);
  if (phases.am && entitledTo(services, "daily_am")) {
    await dailyChecklistReminders(batch, ctx, clientId, sites, today, "am");
  }
  if (phases.pm) {
    if (entitledTo(services, "daily_pm")) await dailyChecklistReminders(batch, ctx, clientId, sites, today, "pm");
    if (entitledTo(services, "kitchen")) await kitchenDiaryReminders(batch, ctx, clientId, sites, businessName, today);
  }
  return batch.items;
}

export async function runTrackReminderJob(options: TrackReminderJobOptions = {}): Promise<TrackReminderJobResult> {
  const now = options.now ?? new Date();
  const result: TrackReminderJobResult = { clientsChecked: 0, notificationsCreated: 0, purged: 0, errors: 0 };
  const clientFilter = options.clientIds
    ? options.clientIds.length
      ? sql`AND id IN (${sql.join(options.clientIds.map((id) => sql`${id}`), sql`, `)})`
      : sql`AND false`
    : sql``;
  const clients = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT id FROM clients WHERE active = true ${clientFilter} ORDER BY id
  `));
  for (const client of clients) {
    result.clientsChecked++;
    try {
      const reminders = await collectTrackReminders(Number(client.id), now);
      if (reminders.length) {
        result.notificationsCreated += await createUserNotifications(reminders, { sendPush: options.sendPush });
      }
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Track reminder evaluation failed");
    }
  }
  if (!options.skipPurge) {
    try {
      result.purged = await purgeOldUserNotifications();
    } catch (err) {
      logger.warn({ err }, "Could not purge old notifications");
    }
  }
  return result;
}
