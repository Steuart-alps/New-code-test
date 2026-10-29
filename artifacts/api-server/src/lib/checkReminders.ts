/**
 * Shared logic for computing overdue / due-soon safety check alerts.
 * Queries the DB directly (no HTTP calls) so it can be used from both
 * the API route and the daily email job.
 */

import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { approvedFrequencies } from "./waterMonitoringPlan";
import { getAccountTimezone, localDateIn, zonedDateTimeToUtc } from "./accountClock";
import { logger } from "./logger";
import { linkedTaskCompletions } from "./trackTaskLink";

export interface CheckAlert {
  module: "fire" | "legionella" | "pool" | "hot_tub" | "coshh";
  moduleLabel: string;
  modulePath: string;
  checkType: string;
  checkLabel: string;
  status: "overdue" | "due_soon" | "never" | "action_required" | "plan_required";
  lastDate: string | null;
  dueDate: string | null;
  /** Days from today to the due date: negative = overdue by that many days, zero = due today, positive = days remaining. */
  daysUntilDue: number | null;
  frequencyLabel: string;
  /** The site the alert belongs to (null for a business without sites). */
  siteId?: number | null;
  siteName?: string | null;
}

// ── Fire safety ───────────────────────────────────────────────────────────────

export const FIRE_CHECK_TYPES = [
  "alarm", "emergency_lights", "extinguishers",
  "fire_doors", "fire_drill", "fire_walk", "alarm_panel",
  "emergency_lights_annual", "alarm_service", "extinguisher_service",
] as const;
export type FireCheckType = (typeof FIRE_CHECK_TYPES)[number];

/** Default check frequencies, in days. */
export const FIRE_FREQUENCY_DAYS: Record<FireCheckType, number> = {
  alarm: 7, emergency_lights: 30, extinguishers: 7,
  fire_doors: 90, fire_drill: 180, fire_walk: 7, alarm_panel: 7,
  emergency_lights_annual: 365, alarm_service: 180, extinguisher_service: 365,
};

/**
 * A site's risk-assessed fire frequencies: defaults, then the business-wide
 * `fire_frequency_days` setting, then the site's control profile.
 */
export function effectiveFireFrequencies(raw: unknown, profile: unknown = null): Record<FireCheckType, number> {
  const result = { ...FIRE_FREQUENCY_DAYS };
  const apply = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const key of FIRE_CHECK_TYPES) {
      const days = (value as Record<string, unknown>)[key];
      if (typeof days === "number" && Number.isInteger(days) && days > 0 && days <= 3650) result[key] = days;
    }
  };
  if (typeof raw === "string") {
    try { apply(JSON.parse(raw)); } catch { /* use defaults */ }
  }
  if (profile && typeof profile === "object") apply((profile as Record<string, unknown>).frequencyDays);
  return result;
}

const FIRE_LABELS: Record<string, string> = {
  alarm: "Alarm test",
  emergency_lights: "Emergency lighting flick test",
  extinguishers: "Fire extinguisher check",
  fire_doors: "Fire door inspection",
  fire_drill: "Fire drill",
  fire_walk: "Fire walk",
  alarm_panel: "Alarm panel check",
  emergency_lights_annual: "Annual 3-hour emergency lighting discharge test",
  alarm_service: "6-monthly fire alarm service",
  extinguisher_service: "Annual fire extinguisher service",
};

function frequencyDaysLabel(days: number): string {
  if (days === 1) return "Daily";
  if (days === 7) return "Weekly";
  if (days === 14) return "Fortnightly";
  if (days === 30) return "Monthly";
  if (days === 90) return "Quarterly";
  if (days === 180) return "6-monthly";
  if (days === 365) return "Annual";
  return `Every ${days} days`;
}

// ── Legionella ────────────────────────────────────────────────────────────────

// HSG274 Part 2 Table 2.1
export const LEGIONELLA_CHECK_TYPES = [
  "calorifier_temp", "hot_sentinel_temp", "hot_nonsent_temp",
  "cold_tank_temp", "cold_sentinel_temp", "cold_nonsent_temp",
  "cold_tank_inspection", "cold_tank_clean",
  "calorifier_inspection", "calorifier_clean",
  "shower_clean", "tmv_service", "outlet_flush",
] as const;

const LEGIONELLA_LABELS: Record<string, string> = {
  calorifier_temp:       "Calorifier temperature",
  hot_sentinel_temp:     "Hot water sentinel outlet temperature",
  hot_nonsent_temp:      "Hot water representative outlet temperature",
  cold_tank_temp:        "Cold water storage temperature",
  cold_sentinel_temp:    "Cold water sentinel outlet temperature",
  cold_nonsent_temp:     "Cold water representative outlet temperature",
  cold_tank_inspection:  "Cold water storage tank inspection",
  cold_tank_clean:       "Cold water storage tank clean & disinfect",
  calorifier_inspection: "Calorifier internal inspection",
  calorifier_clean:      "Calorifier clean & disinfect",
  shower_clean:          "Shower head / hose descale & disinfect",
  tmv_service:           "TMV service & verify",
  outlet_flush:          "Little-used outlet flush (5 min)",
};

// ── Pool ──────────────────────────────────────────────────────────────────────

const POOL_CHECK_TYPES = ["routine", "opening", "closing", "weekly"] as const;

const POOL_LABELS: Record<string, string> = {
  routine: "Routine pool check",
  opening: "Pool opening check",
  closing: "Pool closing check",
  weekly: "Full pool balance check",
};
export const TUB_CHECK_TYPES = ["water_chemistry", "temperature", "filter_clean",
  "cover_inspection", "drain_refill", "microbiological_test", "risk_assessment"] as const;
const TUB_LABELS: Record<string, string> = {
  water_chemistry: "Water chemistry check", temperature: "Temperature check",
  filter_clean: "Filter clean", cover_inspection: "Cover inspection",
  drain_refill: "Drain & refill", microbiological_test: "Microbiological test",
  risk_assessment: "Risk assessment review",
};

function frequencyHoursLabel(hours: number): string {
  if (hours < 1) return `Every ${hours * 60} minutes`;
  if (hours === 1) return "Hourly";
  if (hours < 24) return `Every ${hours} hours`;
  if (hours === 24) return "Daily";
  if (hours === 48) return "Every 2 days";
  if (hours === 168) return "Weekly";
  return `Every ${hours}h`;
}

// ── Shared scope helpers ──────────────────────────────────────────────────────

export interface CheckScope { siteId?: number | null; accessibleSiteIds?: number[] | null }
interface ScopeSite { id: number; name: string }

const MS_DAY = 24 * 60 * 60 * 1000;
const toUtcDays = (iso: string) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / MS_DAY);
const fromUtcDays = (days: number) => new Date(days * MS_DAY).toISOString().slice(0, 10);
const idList = (ids: number[]) => sql.join(ids.map(id => sql`${id}`), sql`, `);

/** The tenant's sites the caller may see, narrowed to the selected site. */
async function loadScopeSites(clientId: number, scope: CheckScope): Promise<ScopeSite[]> {
  const result = await db.execute(sql`
    SELECT id, name FROM sites WHERE client_id = ${clientId}
    ${scope.siteId != null ? sql`AND id = ${scope.siteId}`
      : scope.accessibleSiteIds != null ? scope.accessibleSiteIds.length
        ? sql`AND id IN (${idList(scope.accessibleSiteIds)})`
        : sql`AND false` : sql``}
    ORDER BY name, id
  `);
  return ((result.rows ?? []) as { id: number | string; name: string }[])
    .map(row => ({ id: Number(row.id), name: row.name }));
}

/**
 * Registered legionella outlets with no reading recorded at their site. Each
 * counts as a "never recorded" unit for its check type, so adding an outlet
 * cannot leave the site green until it has been tested.
 * Keys are `${siteId}:${checkType}`.
 */
export async function unreadLegionellaOutletUnits(clientId: number, siteIds: number[]): Promise<Set<string>> {
  if (!siteIds.length) return new Set();
  const result = await db.execute(sql`
    SELECT DISTINCT o.site_id,
      CASE o.type WHEN 'cold' THEN 'cold_sentinel_temp' WHEN 'calorifier' THEN 'calorifier_temp'
        WHEN 'little_used' THEN 'outlet_flush' ELSE 'hot_sentinel_temp' END AS check_type
    FROM legionella_sentinel_outlets o
    WHERE o.client_id = ${clientId} AND o.active = true AND o.site_id IN (${idList(siteIds)})
      AND NOT EXISTS (
        SELECT 1 FROM legionella_checks c
        WHERE c.client_id = o.client_id AND c.outlet_id = o.id AND c.site_id = o.site_id
      )
  `);
  return new Set(((result.rows ?? []) as { site_id: number; check_type: string }[])
    .map(row => `${Number(row.site_id)}:${row.check_type}`));
}

/** Tub-level checks: the annual risk assessment review covers the whole site. */
export const PER_TUB_CHECK_TYPES = new Set<string>(TUB_CHECK_TYPES.filter(type => type !== "risk_assessment"));

/**
 * Sites with an active registered spa tub that has no readings at all. A new
 * tub is "never recorded" for every per-tub check until it is first checked.
 */
export async function sitesWithUnreadHotTubs(clientId: number, siteIds: number[]): Promise<Set<number>> {
  if (!siteIds.length) return new Set();
  const result = await db.execute(sql`
    SELECT DISTINCT t.site_id
    FROM hot_tubs t
    WHERE t.client_id = ${clientId} AND t.active = true AND t.site_id IN (${idList(siteIds)})
      AND NOT EXISTS (
        SELECT 1 FROM hot_tub_checks c
        WHERE c.client_id = t.client_id AND c.hot_tub_id = t.id
      )
  `);
  return new Set(((result.rows ?? []) as { site_id: number }[]).map(row => Number(row.site_id)));
}

// ── FireTrack per-site status ─────────────────────────────────────────────────

export type FireStatus = "ok" | "due_soon" | "overdue" | "never";

export interface FireSiteStatus {
  /** Null only for a business that has no sites yet. */
  siteId: number | null;
  siteName: string | null;
  checkType: FireCheckType;
  frequencyDays: number;
  lastDate: string | null;
  lastResult: string | null;
  dueDate: string | null;
  daysUntilDue: number | null;
  status: FireStatus;
}

/**
 * Fire check status for every site in scope. Each site is judged on its own
 * records and its own risk-assessed frequencies, so a check at one site never
 * makes another site up to date, and a site with no checks is "never".
 *
 * Checks recorded with "No specific site" are business-wide (as in the fire
 * log's site filter) and count for every site; a site's own later check wins.
 */
async function fireSiteStatusesFor(
  clientId: number, scope: CheckScope, sites: ScopeSite[], todayIso: string,
): Promise<FireSiteStatus[]> {
  let units: { id: number | null; name: string | null }[] = sites;
  if (!units.length && scope.siteId == null) {
    const totals = await db.execute(sql`SELECT count(*)::int AS total FROM sites WHERE client_id = ${clientId}`);
    const totalSites = Number(((totals.rows ?? [])[0] as { total?: number } | undefined)?.total ?? 0);
    if (totalSites === 0) units = [{ id: null, name: null }];
  }
  if (!units.length) return [];
  const siteIds = units.flatMap(unit => unit.id == null ? [] : [unit.id]);
  const conditions: SQL[] = [sql`site_id IS NULL`];
  if (siteIds.length) conditions.push(sql`site_id IN (${idList(siteIds)})`);

  const [latestRows, settingRows, profileRows, sleepingRows] = await Promise.all([
    db.execute(sql`
      SELECT DISTINCT ON (site_id, check_type) id, site_id, check_type, check_date, result
      FROM fire_safety_checks
      WHERE client_id = ${clientId} AND (${sql.join(conditions, sql` OR `)})
      ORDER BY site_id, check_type, check_date DESC, id DESC
    `),
    db.execute(sql`SELECT value FROM app_settings WHERE client_id = ${clientId} AND key = 'fire_frequency_days' LIMIT 1`),
    siteIds.length ? db.execute(sql`
      SELECT site_id, profile FROM track_control_profiles
      WHERE client_id = ${clientId} AND module = 'fire' AND site_id IN (${idList(siteIds)})
    `) : Promise.resolve({ rows: [] as unknown[] }),
    siteIds.length ? db.execute(sql`
      SELECT id, sleeping_accommodation FROM sites WHERE client_id = ${clientId} AND id IN (${idList(siteIds)})
    `) : Promise.resolve({ rows: [] as unknown[] }),
  ]);
  const sleeping = new Map<number, boolean | null>(
    ((sleepingRows.rows ?? []) as { id: number; sleeping_accommodation: boolean | null }[])
      .map(row => [Number(row.id), row.sleeping_accommodation]),
  );
  type Latest = { id: number; check_date: string; result: string | null };
  const latest = new Map<string, Latest>();
  for (const row of (latestRows.rows ?? []) as (Latest & { site_id: number | null; check_type: string })[]) {
    latest.set(`${row.site_id == null ? "none" : Number(row.site_id)}:${row.check_type}`, row);
  }
  // A completed ComplyTrack task that mirrors a FireTrack check (the annual
  // emergency lighting discharge test, the fire alarm and extinguisher
  // services) counts as a passed check on its date, so completions from
  // before the two were linked still show.
  for (const [key, completedOn] of await linkedTaskCompletions(clientId, "fire")) {
    const recorded = latest.get(key);
    if (!recorded || String(recorded.check_date).slice(0, 10) < completedOn) {
      latest.set(key, { id: 0, check_date: completedOn, result: "pass" });
    }
  }
  const frequencySetting = ((settingRows.rows ?? [])[0] as { value?: unknown } | undefined)?.value;
  const profiles = new Map<number, unknown>(
    ((profileRows.rows ?? []) as { site_id: number; profile: unknown }[]).map(row => [Number(row.site_id), row.profile]),
  );
  const todayDays = toUtcDays(todayIso);

  const statuses: FireSiteStatus[] = [];
  for (const unit of units) {
    const frequencies = effectiveFireFrequencies(frequencySetting, unit.id == null ? null : profiles.get(unit.id));
    for (const checkType of FIRE_CHECK_TYPES) {
      const own = unit.id == null ? undefined : latest.get(`${unit.id}:${checkType}`);
      const unassigned = latest.get(`none:${checkType}`);
      // The escape route sign-off is only for sites with sleeping
      // accommodation. A site not yet answered keeps it only if fire walks
      // have been recorded for it, so nothing new appears unasked.
      if (checkType === "fire_walk") {
        const answer = unit.id == null ? null : sleeping.get(unit.id) ?? null;
        if (answer === false || (answer === null && !own && !unassigned)) continue;
      }
      const last = !own ? unassigned : !unassigned ? own
        : String(unassigned.check_date) > String(own.check_date) ? unassigned : own;
      const frequencyDays = frequencies[checkType];
      const common = { siteId: unit.id, siteName: unit.name, checkType, frequencyDays };
      if (!last) {
        statuses.push({ ...common, lastDate: null, lastResult: null, dueDate: null, daysUntilDue: null, status: "never" });
        continue;
      }
      const lastDate = String(last.check_date).slice(0, 10);
      const dueDays = toUtcDays(lastDate) + frequencyDays;
      const daysUntilDue = dueDays - todayDays;
      const dueSoonWindow = Math.max(1, Math.ceil(frequencyDays * 0.2));
      const status: FireStatus = daysUntilDue < 0 ? "overdue" : daysUntilDue <= dueSoonWindow ? "due_soon" : "ok";
      statuses.push({ ...common, lastDate, lastResult: last.result ?? null, dueDate: fromUtcDays(dueDays), daysUntilDue, status });
    }
  }
  return statuses;
}

export async function getFireSiteStatuses(clientId: number, scope: CheckScope = {}): Promise<FireSiteStatus[]> {
  const [sites, timeZone] = await Promise.all([loadScopeSites(clientId, scope), getAccountTimezone(clientId)]);
  return fireSiteStatusesFor(clientId, scope, sites, localDateIn(timeZone));
}

const fireSeverity = (row: FireSiteStatus) =>
  row.status === "overdue" ? 4 : row.status === "never" ? 3
    : row.lastResult === "fail" || row.lastResult === "action_required" ? 2
    : row.status === "due_soon" ? 1 : 0;

/**
 * One row per check type for an all-sites view: the worst site's status, with
 * how many sites are not up to date.
 */
export function worstFireStatusByType(statuses: FireSiteStatus[]) {
  return FIRE_CHECK_TYPES.flatMap(checkType => {
    const rows = statuses.filter(row => row.checkType === checkType);
    if (!rows.length) return [];
    const worst = rows.reduce((current, row) => {
      const difference = fireSeverity(row) - fireSeverity(current);
      if (difference !== 0) return difference > 0 ? row : current;
      // Among equally bad sites, the one furthest past (or nearest) its due date.
      return (row.daysUntilDue ?? 0) < (current.daysUntilDue ?? 0) ? row : current;
    });
    return [{
      checkType,
      frequencyDays: worst.frequencyDays,
      lastDate: worst.lastDate,
      lastResult: worst.lastResult,
      dueDate: worst.dueDate,
      status: worst.status,
      siteId: worst.siteId,
      siteName: worst.siteName,
      siteCount: rows.length,
      // Sites that are overdue or have never recorded the check.
      sitesAffected: rows.filter(row => row.status === "overdue" || row.status === "never").length,
    }];
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getCheckAlerts(clientId: number, scope: CheckScope = {}, now = new Date()): Promise<CheckAlert[]> {
  const alerts: CheckAlert[] = [];

  const timeZone = await getAccountTimezone(clientId);
  const todayIso = localDateIn(timeZone, now);
  const todayDays = toUtcDays(todayIso);
  const siteClause = scope.siteId != null
    ? sql`AND site_id = ${scope.siteId}`
    : scope.accessibleSiteIds != null
    ? scope.accessibleSiteIds.length
      ? sql`AND (site_id IS NULL OR site_id IN (${idList(scope.accessibleSiteIds)}))`
      : sql`AND site_id IS NULL`
    : sql``;
  const warn = (err: unknown, module: string) =>
    logger.warn({ err, clientId, module }, "Unable to evaluate check reminders for a module");

  // A site without a current approved plan has no calculable water due date.
  // Fetch sites even when they have no checks, so the dashboard can surface
  // the missing plan instead of treating the site as up to date.
  const waterSites = await loadScopeSites(clientId, scope);
  const waterSiteIds = waterSites.map(site => site.id);
  const profileBySite = new Map<string, unknown>();
  if (waterSites.length) {
    const profiles = await db.execute(sql`
      SELECT site_id, module, profile FROM track_control_profiles
      WHERE client_id = ${clientId}
        AND site_id IN (${idList(waterSiteIds)})
        AND module IN ('legionella', 'pool', 'hot_tub')
    `);
    for (const row of (profiles.rows ?? []) as { site_id: number; module: string; profile: unknown }[]) {
      profileBySite.set(`${row.module}:${row.site_id}`, row.profile);
    }
  }
  const planFor = (siteId: number, module: string, types: readonly string[], unit: "frequencyDays" | "frequencyHours") =>
    approvedFrequencies(profileBySite.get(`${module}:${siteId}`), types, unit);
  const needsPlan = (site: { id: number; name: string }, module: CheckAlert["module"], label: string, path: string) => {
    alerts.push({
      module, moduleLabel: label, modulePath: path, checkType: "monitoring_plan",
      checkLabel: `${site.name}: monitoring plan`, status: "plan_required",
      lastDate: null, dueDate: null, daysUntilDue: null,
      frequencyLabel: "Review risk assessment, written scheme and competent person",
      siteId: site.id, siteName: site.name,
    });
  };

  // ── Fire safety ──────────────────────────────────────────────────────────
  try {
    for (const row of await fireSiteStatusesFor(clientId, scope, waterSites, todayIso)) {
      if (row.status === "ok") continue;
      const label = FIRE_LABELS[row.checkType] ?? row.checkType;
      alerts.push({
        module: "fire", moduleLabel: "Fire Safety", modulePath: "/fire-safety",
        checkType: row.checkType, checkLabel: row.siteName ? `${row.siteName}: ${label}` : label,
        status: row.status, lastDate: row.lastDate, dueDate: row.dueDate, daysUntilDue: row.daysUntilDue,
        frequencyLabel: frequencyDaysLabel(row.frequencyDays),
        siteId: row.siteId, siteName: row.siteName,
      });
    }
  } catch (err) {
    warn(err, "fire");
  }

  // ── Legionella ───────────────────────────────────────────────────────────
  try {
    const legRows = await db.execute(sql`
      SELECT site_id, check_type, MIN(check_date) AS last_date
      FROM (
        SELECT DISTINCT ON (site_id, check_type, COALESCE(outlet_id, 0))
          site_id, check_type, outlet_id, check_date
        FROM legionella_checks
        WHERE client_id = ${clientId} AND site_id IS NOT NULL ${siteClause}
        ORDER BY site_id, check_type, COALESCE(outlet_id, 0), check_date DESC, id DESC
      ) latest_units
      GROUP BY site_id, check_type
    `);
    const legByType = new Map<string, string>(
      ((legRows as any).rows ?? []).map((r: any) => [`${r.site_id}:${r.check_type}`, String(r.last_date).slice(0, 10)]),
    );
    // A completed ComplyTrack task that mirrors a water check (cleaning the
    // cold water tanks) counts as a check on its date.
    for (const [key, completedOn] of await linkedTaskCompletions(clientId, "legionella")) {
      const recorded = legByType.get(key);
      if (!recorded || recorded < completedOn) legByType.set(key, completedOn);
    }
    const unreadOutlets = await unreadLegionellaOutletUnits(clientId, waterSiteIds);
    for (const site of waterSites) {
      const frequencies = planFor(site.id, "legionella", LEGIONELLA_CHECK_TYPES, "frequencyDays");
      if (!frequencies) {
        needsPlan(site, "legionella", "Water Safety (Legionella)", "/legionella");
        continue;
      }
      for (const ct of LEGIONELLA_CHECK_TYPES) {
        const lastDate = unreadOutlets.has(`${site.id}:${ct}`) ? null : legByType.get(`${site.id}:${ct}`) ?? null;
        const freq = frequencies[ct]!;
        const common = {
          module: "legionella" as const, moduleLabel: "Water Safety (Legionella)", modulePath: "/legionella",
          checkType: ct, checkLabel: `${site.name}: ${LEGIONELLA_LABELS[ct] ?? ct}`,
          frequencyLabel: frequencyDaysLabel(freq), siteId: site.id, siteName: site.name,
        };
        if (!lastDate) {
          alerts.push({ ...common, status: "never", lastDate: null, dueDate: null, daysUntilDue: null });
          continue;
        }
        const dueDays = toUtcDays(lastDate) + freq;
        const daysUntilDue = dueDays - todayDays;
        const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= Math.max(1, Math.ceil(freq * 0.2)) ? "due_soon" : null;
        if (status) alerts.push({ ...common, status, lastDate, dueDate: fromUtcDays(dueDays), daysUntilDue });
      }
    }
  } catch (err) {
    warn(err, "legionella");
  }

  // ── Pool ─────────────────────────────────────────────────────────────────
  try {
    const poolRows = await db.execute(sql`
      SELECT DISTINCT ON (site_id, check_type)
        site_id, check_type, check_date, check_time
      FROM pool_checks
      WHERE client_id = ${clientId} AND site_id IS NOT NULL ${siteClause}
      ORDER BY site_id, check_type, check_date DESC, check_time DESC NULLS LAST
    `);
    const poolByType = new Map<string, { check_date: string; check_time: string | null }>(
      ((poolRows as any).rows ?? []).map((r: any) => [`${r.site_id}:${r.check_type}`, r]),
    );
    for (const site of waterSites) {
      if (!profileBySite.has(`pool:${site.id}`) &&
          !POOL_CHECK_TYPES.some(ct => poolByType.has(`${site.id}:${ct}`))) continue;
      const frequencies = planFor(site.id, "pool", POOL_CHECK_TYPES, "frequencyHours");
      if (!frequencies) {
        needsPlan(site, "pool", "AquaTrack", "/aqua-track");
        continue;
      }
      for (const ct of POOL_CHECK_TYPES) {
        const latest = poolByType.get(`${site.id}:${ct}`) ?? null;
        const freqHours = frequencies[ct]!;
        const common = {
          module: "pool" as const, moduleLabel: "AquaTrack", modulePath: "/aqua-track",
          checkType: ct, checkLabel: `${site.name}: ${POOL_LABELS[ct] ?? ct}`,
          frequencyLabel: frequencyHoursLabel(freqHours), siteId: site.id, siteName: site.name,
        };
        if (!latest) {
          alerts.push({ ...common, status: "never", lastDate: null, dueDate: null, daysUntilDue: null });
          continue;
        }
        // Check times are recorded on the site's local clock.
        const lastDt = zonedDateTimeToUtc(String(latest.check_date), latest.check_time, timeZone);
        const hoursUntilDue = (lastDt.getTime() + freqHours * 3600000 - now.getTime()) / 3600000;
        const status = hoursUntilDue < 0 ? "overdue"
          : hoursUntilDue <= Math.max(1, freqHours * 0.2) ? "due_soon" : null;
        if (status) alerts.push({ ...common, status, lastDate: latest.check_date,
          dueDate: new Date(lastDt.getTime() + freqHours * 3600000).toISOString(),
          daysUntilDue: Math.floor(hoursUntilDue / 24) });
      }
    }
  } catch (err) {
    warn(err, "pool");
  }

  // ── Spa tubs ──────────────────────────────────────────────────────────────
  try {
    const tubRows = await db.execute(sql`
      SELECT site_id, check_type, MIN(check_date) AS last_date
      FROM (
        SELECT DISTINCT ON (site_id, check_type, COALESCE(hot_tub_id, 0))
          site_id, check_type, hot_tub_id, check_date
        FROM hot_tub_checks
        WHERE client_id = ${clientId} AND site_id IS NOT NULL ${siteClause}
        ORDER BY site_id, check_type, COALESCE(hot_tub_id, 0), check_date DESC, id DESC
      ) latest_units
      GROUP BY site_id, check_type
    `);
    const tubByType = new Map<string, string>(
      (tubRows.rows ?? []).map((r: any) => [`${r.site_id}:${r.check_type}`, r.last_date]),
    );
    const registeredTubs = await db.execute(sql`
      SELECT DISTINCT site_id FROM hot_tubs
      WHERE client_id = ${clientId} AND active = true AND site_id IS NOT NULL ${siteClause}
    `);
    const tubSites = new Set((registeredTubs.rows ?? []).map((r: any) => Number(r.site_id)));
    const unreadTubSites = await sitesWithUnreadHotTubs(clientId, waterSiteIds);
    for (const site of waterSites) {
      if (!profileBySite.has(`hot_tub:${site.id}`) && !tubSites.has(Number(site.id)) &&
          !TUB_CHECK_TYPES.some(ct => tubByType.has(`${site.id}:${ct}`))) continue;
      const frequencies = planFor(site.id, "hot_tub", TUB_CHECK_TYPES, "frequencyDays");
      if (!frequencies) {
        needsPlan(site, "hot_tub", "TubTrack", "/hot-tub");
        continue;
      }
      for (const ct of TUB_CHECK_TYPES) {
        const lastDate = unreadTubSites.has(site.id) && PER_TUB_CHECK_TYPES.has(ct)
          ? null : tubByType.get(`${site.id}:${ct}`) ?? null;
        const freq = frequencies[ct]!;
        const common = {
          module: "hot_tub" as const, moduleLabel: "TubTrack", modulePath: "/hot-tub",
          checkType: ct, checkLabel: `${site.name}: ${TUB_LABELS[ct] ?? ct}`,
          frequencyLabel: frequencyDaysLabel(freq), siteId: site.id, siteName: site.name,
        };
        if (!lastDate) {
          alerts.push({ ...common, status: "never", lastDate: null, dueDate: null, daysUntilDue: null });
          continue;
        }
        const dueDays = toUtcDays(lastDate) + freq;
        const daysUntilDue = dueDays - todayDays;
        const status = daysUntilDue < 0 ? "overdue"
          : daysUntilDue <= Math.max(1, Math.ceil(freq * 0.2)) ? "due_soon" : null;
        if (status) alerts.push({ ...common, status, lastDate, dueDate: fromUtcDays(dueDays), daysUntilDue });
      }
    }
  } catch (err) {
    warn(err, "hot_tub");
  }

  // The latest observation for each site/check type is the same persisted
  // server-evaluated result used by the dashboard and check forms. Keep
  // unsafe results actionable even when the next scheduled check is not due.
  for (const source of [
    { table: sql`legionella_checks`, group: sql`COALESCE(outlet_id, 0)`, module: "legionella" as const, label: "Water Safety (Legionella)", path: "/legionella" },
    { table: sql`hot_tub_checks`, group: sql`COALESCE(hot_tub_id, 0)`, module: "hot_tub" as const, label: "TubTrack", path: "/hot-tub" },
  ]) {
    try {
      const latest = await db.execute(sql`
        SELECT check_type, check_date, result, location FROM (
          SELECT DISTINCT ON (site_id, check_type, ${source.group}) check_type, check_date, result, location
          FROM ${source.table} WHERE client_id = ${clientId} ${siteClause}
          ORDER BY site_id, check_type, ${source.group}, check_date DESC, id DESC
        ) recent WHERE result IN ('fail', 'action_required')
      `);
      for (const row of (latest.rows ?? []) as { check_type: string; check_date: string; location: string | null }[]) {
        alerts.push({
          module: source.module, moduleLabel: source.label, modulePath: source.path,
          checkType: row.check_type, checkLabel: `${row.check_type.replace(/_/g, " ")}${row.location ? ` — ${row.location}` : ""}`,
          status: "action_required", lastDate: row.check_date, dueDate: null,
          daysUntilDue: null, frequencyLabel: "Recorded result requires follow-up",
        });
      }
    } catch (err) {
      // The reminder should remain available on installations predating a module.
      warn(err, source.module);
    }
  }

  return alerts;
}
