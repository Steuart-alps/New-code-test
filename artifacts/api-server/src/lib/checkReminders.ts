/**
 * Shared logic for computing overdue / due-soon safety check alerts.
 * Queries the DB directly (no HTTP calls) so it can be used from both
 * the API route and the daily email job.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { approvedFrequencies } from "./waterMonitoringPlan";

export interface CheckAlert {
  module: "fire" | "legionella" | "pool" | "hot_tub";
  moduleLabel: string;
  modulePath: string;
  checkType: string;
  checkLabel: string;
  status: "overdue" | "due_soon" | "never" | "action_required" | "plan_required";
  lastDate: string | null;
  dueDate: string | null;
  /** Positive = overdue by N days. Zero = due today. Negative = N days remaining. */
  daysUntilDue: number | null;
  frequencyLabel: string;
}

// ── Fire safety ───────────────────────────────────────────────────────────────

const FIRE_CHECK_TYPES = [
  "alarm", "emergency_lights", "extinguishers",
  "fire_doors", "fire_drill", "fire_walk", "alarm_panel",
] as const;

const FIRE_FREQUENCY_DAYS: Record<string, number> = {
  alarm: 7, emergency_lights: 30, extinguishers: 7,
  fire_doors: 90, fire_drill: 180, fire_walk: 7, alarm_panel: 7,
};

const FIRE_LABELS: Record<string, string> = {
  alarm: "Alarm test",
  emergency_lights: "Emergency lights test",
  extinguishers: "Fire extinguisher check",
  fire_doors: "Fire door inspection",
  fire_drill: "Fire drill",
  fire_walk: "Fire walk",
  alarm_panel: "Alarm panel check",
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
const LEGIONELLA_CHECK_TYPES = [
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
const TUB_CHECK_TYPES = ["water_chemistry", "temperature", "filter_clean",
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

// ── Main export ───────────────────────────────────────────────────────────────

export async function getCheckAlerts(clientId: number, scope: { siteId?: number | null; accessibleSiteIds?: number[] | null } = {}): Promise<CheckAlert[]> {
  const alerts: CheckAlert[] = [];
  const MS_DAY = 24 * 60 * 60 * 1000;

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const toUtcDays = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);
  const todayDays = toUtcDays(todayIso);
  const siteClause = scope.siteId != null
    ? sql`AND site_id = ${scope.siteId}`
    : scope.accessibleSiteIds != null
    ? scope.accessibleSiteIds.length
      ? sql`AND (site_id IS NULL OR site_id IN (${sql.join(scope.accessibleSiteIds.map(id => sql`${id}`), sql`, `)}))`
      : sql`AND site_id IS NULL`
    : sql``;

  // A site without a current approved plan has no calculable water due date.
  // Fetch sites even when they have no checks, so the dashboard can surface
  // the missing plan instead of treating the site as up to date.
  const waterSiteRows = await db.execute(sql`
    SELECT id, name FROM sites WHERE client_id = ${clientId}
    ${scope.siteId != null ? sql`AND id = ${scope.siteId}`
      : scope.accessibleSiteIds != null ? scope.accessibleSiteIds.length
        ? sql`AND id IN (${sql.join(scope.accessibleSiteIds.map(id => sql`${id}`), sql`, `)})`
        : sql`AND false` : sql``}
  `);
  const waterSites = (waterSiteRows.rows ?? []) as { id: number; name: string }[];
  const profileBySite = new Map<string, unknown>();
  if (waterSites.length) {
    const profiles = await db.execute(sql`
      SELECT site_id, module, profile FROM track_control_profiles
      WHERE client_id = ${clientId}
        AND site_id IN (${sql.join(waterSites.map(site => sql`${site.id}`), sql`, `)})
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
    });
  };

  // ── Fire safety ──────────────────────────────────────────────────────────
  try {
    const fireRows = await db.execute(sql`
      SELECT check_type, MAX(check_date) AS last_date
      FROM fire_safety_checks
      WHERE client_id = ${clientId} ${siteClause}
      GROUP BY check_type
    `);
    const fireByType = new Map<string, string>(
      ((fireRows as any).rows ?? []).map((r: any) => [r.check_type, r.last_date]),
    );
    for (const ct of FIRE_CHECK_TYPES) {
      const lastDate = fireByType.get(ct) ?? null;
      const freq = FIRE_FREQUENCY_DAYS[ct]!;
      if (!lastDate) {
        alerts.push({
          module: "fire", moduleLabel: "Fire Safety", modulePath: "/fire-safety",
          checkType: ct, checkLabel: FIRE_LABELS[ct] ?? ct,
          status: "never", lastDate: null, dueDate: null, daysUntilDue: null,
          frequencyLabel: frequencyDaysLabel(freq),
        });
        continue;
      }
      const dueDays = toUtcDays(lastDate) + freq;
      const dueDate = new Date(dueDays * MS_DAY).toISOString().slice(0, 10);
      const daysUntilDue = dueDays - todayDays;
      const dueSoonWindow = Math.max(1, Math.ceil(freq * 0.2));
      const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= dueSoonWindow ? "due_soon" : null;
      if (status) {
        alerts.push({
          module: "fire", moduleLabel: "Fire Safety", modulePath: "/fire-safety",
          checkType: ct, checkLabel: FIRE_LABELS[ct] ?? ct,
          status, lastDate, dueDate, daysUntilDue,
          frequencyLabel: frequencyDaysLabel(freq),
        });
      }
    }
  } catch {
    // table may not exist yet; skip
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
      ((legRows as any).rows ?? []).map((r: any) => [`${r.site_id}:${r.check_type}`, r.last_date]),
    );
    for (const site of waterSites) {
      const frequencies = planFor(site.id, "legionella", LEGIONELLA_CHECK_TYPES, "frequencyDays");
      if (!frequencies) {
        needsPlan(site, "legionella", "Water Safety (Legionella)", "/legionella");
        continue;
      }
      for (const ct of LEGIONELLA_CHECK_TYPES) {
        const lastDate = legByType.get(`${site.id}:${ct}`) ?? null;
        const freq = frequencies[ct]!;
        const common = {
          module: "legionella" as const, moduleLabel: "Water Safety (Legionella)", modulePath: "/legionella",
          checkType: ct, checkLabel: `${site.name}: ${LEGIONELLA_LABELS[ct] ?? ct}`,
          frequencyLabel: frequencyDaysLabel(freq),
        };
        if (!lastDate) {
          alerts.push({ ...common, status: "never", lastDate: null, dueDate: null, daysUntilDue: null });
          continue;
        }
        const dueDays = toUtcDays(lastDate) + freq;
        const daysUntilDue = dueDays - todayDays;
        const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= Math.max(1, Math.ceil(freq * 0.2)) ? "due_soon" : null;
        if (status) alerts.push({ ...common, status, lastDate,
          dueDate: new Date(dueDays * MS_DAY).toISOString().slice(0, 10), daysUntilDue });
      }
    }
  } catch {
    // table may not exist yet; skip
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
        needsPlan(site, "pool", "PoolTrack", "/aqua-track");
        continue;
      }
      for (const ct of POOL_CHECK_TYPES) {
        const latest = poolByType.get(`${site.id}:${ct}`) ?? null;
        const freqHours = frequencies[ct]!;
        const common = {
          module: "pool" as const, moduleLabel: "PoolTrack", modulePath: "/aqua-track",
          checkType: ct, checkLabel: `${site.name}: ${POOL_LABELS[ct] ?? ct}`,
          frequencyLabel: frequencyHoursLabel(freqHours),
        };
        if (!latest) {
          alerts.push({ ...common, status: "never", lastDate: null, dueDate: null, daysUntilDue: null });
          continue;
        }
        const lastDt = new Date(`${latest.check_date}T${latest.check_time || "00:00:00"}`);
        const hoursUntilDue = (lastDt.getTime() + freqHours * 3600000 - now.getTime()) / 3600000;
        const status = hoursUntilDue < 0 ? "overdue"
          : hoursUntilDue <= Math.max(1, freqHours * 0.2) ? "due_soon" : null;
        if (status) alerts.push({ ...common, status, lastDate: latest.check_date,
          dueDate: new Date(lastDt.getTime() + freqHours * 3600000).toISOString(),
          daysUntilDue: Math.floor(hoursUntilDue / 24) });
      }
    }
  } catch {
    // table may not exist yet; skip
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
    for (const site of waterSites) {
      if (!profileBySite.has(`hot_tub:${site.id}`) && !tubSites.has(Number(site.id)) &&
          !TUB_CHECK_TYPES.some(ct => tubByType.has(`${site.id}:${ct}`))) continue;
      const frequencies = planFor(site.id, "hot_tub", TUB_CHECK_TYPES, "frequencyDays");
      if (!frequencies) {
        needsPlan(site, "hot_tub", "HotTubTrack", "/hot-tub");
        continue;
      }
      for (const ct of TUB_CHECK_TYPES) {
        const lastDate = tubByType.get(`${site.id}:${ct}`) ?? null;
        const freq = frequencies[ct]!;
        const common = {
          module: "hot_tub" as const, moduleLabel: "HotTubTrack", modulePath: "/hot-tub",
          checkType: ct, checkLabel: `${site.name}: ${TUB_LABELS[ct] ?? ct}`,
          frequencyLabel: frequencyDaysLabel(freq),
        };
        if (!lastDate) {
          alerts.push({ ...common, status: "never", lastDate: null, dueDate: null, daysUntilDue: null });
          continue;
        }
        const dueDays = toUtcDays(lastDate) + freq;
        const daysUntilDue = dueDays - todayDays;
        const status = daysUntilDue < 0 ? "overdue"
          : daysUntilDue <= Math.max(1, Math.ceil(freq * 0.2)) ? "due_soon" : null;
        if (status) alerts.push({ ...common, status, lastDate,
          dueDate: new Date(dueDays * MS_DAY).toISOString().slice(0, 10), daysUntilDue });
      }
    }
  } catch {
    // table may not exist yet; skip
  }

  // The latest observation for each site/check type is the same persisted
  // server-evaluated result used by the dashboard and check forms. Keep
  // unsafe results actionable even when the next scheduled check is not due.
  for (const source of [
    { table: sql`legionella_checks`, group: sql`COALESCE(outlet_id, 0)`, module: "legionella" as const, label: "Water Safety (Legionella)", path: "/legionella" },
    { table: sql`hot_tub_checks`, group: sql`COALESCE(hot_tub_id, 0)`, module: "hot_tub" as const, label: "HotTubTrack", path: "/hot-tub" },
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
    } catch {
      // The reminder should remain available on installations predating a module.
    }
  }

  return alerts;
}
