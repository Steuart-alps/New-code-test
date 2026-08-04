/**
 * Shared logic for computing overdue / due-soon safety check alerts.
 * Queries the DB directly (no HTTP calls) so it can be used from both
 * the API route and the daily email job.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface CheckAlert {
  module: "fire" | "legionella" | "pool";
  moduleLabel: string;
  modulePath: string;
  checkType: string;
  checkLabel: string;
  status: "overdue" | "due_soon" | "never";
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
  "shower_clean", "tmv_service",
] as const;

const LEGIONELLA_FREQUENCY_DAYS: Record<string, number> = {
  calorifier_temp:       7,
  hot_sentinel_temp:     30,
  hot_nonsent_temp:      90,
  cold_tank_temp:        30,
  cold_sentinel_temp:    30,
  cold_nonsent_temp:     90,
  cold_tank_inspection:  183,
  cold_tank_clean:       365,
  calorifier_inspection: 365,
  calorifier_clean:      365,
  shower_clean:          90,
  tmv_service:           365,
};

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
};

// ── Pool ──────────────────────────────────────────────────────────────────────

const POOL_CHECK_TYPES = ["routine", "opening", "closing", "weekly"] as const;

const POOL_FREQUENCY_HOURS: Record<string, number> = {
  routine: 2, opening: 24, closing: 24, weekly: 168,
};

const POOL_LABELS: Record<string, string> = {
  routine: "Routine pool check",
  opening: "Pool opening check",
  closing: "Pool closing check",
  weekly: "Weekly pool test",
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

export async function getCheckAlerts(clientId: number): Promise<CheckAlert[]> {
  const alerts: CheckAlert[] = [];
  const MS_DAY = 24 * 60 * 60 * 1000;

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const toUtcDays = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);
  const todayDays = toUtcDays(todayIso);

  // ── Fire safety ──────────────────────────────────────────────────────────
  try {
    const fireRows = await db.execute(sql`
      SELECT check_type, MAX(check_date) AS last_date
      FROM fire_safety_checks
      WHERE client_id = ${clientId}
      GROUP BY check_type
    `);
    const fireByType = new Map<string, string>(
      ((fireRows as any).rows ?? fireRows as any[]).map((r: any) => [r.check_type, r.last_date]),
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
      SELECT check_type, MAX(check_date) AS last_date
      FROM legionella_checks
      WHERE client_id = ${clientId}
      GROUP BY check_type
    `);
    const legByType = new Map<string, string>(
      ((legRows as any).rows ?? legRows as any[]).map((r: any) => [r.check_type, r.last_date]),
    );
    for (const ct of LEGIONELLA_CHECK_TYPES) {
      const lastDate = legByType.get(ct) ?? null;
      const freq = LEGIONELLA_FREQUENCY_DAYS[ct]!;
      if (!lastDate) {
        alerts.push({
          module: "legionella", moduleLabel: "Water Safety (Legionella)", modulePath: "/legionella",
          checkType: ct, checkLabel: LEGIONELLA_LABELS[ct] ?? ct,
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
          module: "legionella", moduleLabel: "Water Safety (Legionella)", modulePath: "/legionella",
          checkType: ct, checkLabel: LEGIONELLA_LABELS[ct] ?? ct,
          status, lastDate, dueDate, daysUntilDue,
          frequencyLabel: frequencyDaysLabel(freq),
        });
      }
    }
  } catch {
    // table may not exist yet; skip
  }

  // ── Pool ─────────────────────────────────────────────────────────────────
  try {
    const poolRows = await db.execute(sql`
      SELECT DISTINCT ON (check_type)
        check_type, check_date, check_time
      FROM pool_checks
      WHERE client_id = ${clientId}
      ORDER BY check_type, check_date DESC, check_time DESC NULLS LAST
    `);
    const poolByType = new Map<string, { check_date: string; check_time: string | null }>(
      ((poolRows as any).rows ?? poolRows as any[]).map((r: any) => [r.check_type, r]),
    );
    for (const ct of POOL_CHECK_TYPES) {
      const latest = poolByType.get(ct) ?? null;
      const freqHours = POOL_FREQUENCY_HOURS[ct]!;
      if (!latest) {
        alerts.push({
          module: "pool", moduleLabel: "PoolTrack", modulePath: "/pool-track",
          checkType: ct, checkLabel: POOL_LABELS[ct] ?? ct,
          status: "never", lastDate: null, dueDate: null, daysUntilDue: null,
          frequencyLabel: frequencyHoursLabel(freqHours),
        });
        continue;
      }
      const lastDt = latest.check_time
        ? new Date(`${latest.check_date}T${latest.check_time}`)
        : new Date(`${latest.check_date}T00:00:00`);
      const hoursSince = (now.getTime() - lastDt.getTime()) / (1000 * 60 * 60);
      const status = hoursSince > freqHours * 1.5 ? "overdue"
        : hoursSince > freqHours ? "due_soon"
        : null;
      if (status) {
        // daysUntilDue in hours for pool (negative = overdue hours)
        const hoursUntilDue = freqHours - hoursSince;
        const dueDate = new Date(lastDt.getTime() + freqHours * 3600000).toISOString().slice(0, 10);
        alerts.push({
          module: "pool", moduleLabel: "PoolTrack", modulePath: "/pool-track",
          checkType: ct, checkLabel: POOL_LABELS[ct] ?? ct,
          status, lastDate: latest.check_date, dueDate,
          daysUntilDue: Math.round(hoursUntilDue / 24),
          frequencyLabel: frequencyHoursLabel(freqHours),
        });
      }
    }
  } catch {
    // table may not exist yet; skip
  }

  return alerts;
}
