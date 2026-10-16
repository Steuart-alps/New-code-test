import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { getEntitledServices, isEntitled, type Entitlements, type ServiceKey } from "./services";
import { getUnscopedComplianceReport } from "./unscopedComplianceReport";
import { approvedFrequencies } from "./waterMonitoringPlan";
import { riddorDeadline, ukToday, type RiddorDeadlineState } from "./riddor";
import { addCalendarDays, addCalendarMonths, siteScopeSql, type SiteAccessScope } from "./siteAccessScope";
import { actionStateLabel, itemActionStates } from "./certificateOutcomes";

/**
 * Data for the one-click inspection pack (GET /reports/inspection-pack): a
 * short, read-only summary of one site (or every site in the user's scope)
 * for a date range, for a manager to hand to an EHO, fire officer or insurer.
 *
 * Sections are included only for modules the business is entitled to. Each
 * section gives counts and lists the exceptions in full, capped at
 * EXCEPTION_LIMIT rows ("N more in the CSV export"). Incidents carry no
 * personal, injury or health details because the pack may leave the business.
 */

export const EXCEPTION_LIMIT = 25;
/** Expiry dates within this many days of today count as "due soon". */
export const DUE_SOON_DAYS = 60;

export type SummaryRow = {
  module: string;
  /** Records the schedule expects in the period, or null when not scheduled. */
  due: number | null;
  recorded: number;
  exceptions: number | null;
  overdue: number | null;
  openActions: number | null;
};

export type ComplianceCheckRow = {
  title: string; category: string | null; siteName: string | null;
  lastCompleted: string | null; nextDue: string | null;
  status: "Action required" | "Overdue" | "Due soon" | "Scheduled" | "Completed" | "No due date";
  certificates: string[];
  /** Set when the newest certificate is unsatisfactory or has open remedial defects. */
  actionNote?: string | null;
};

export type CheckTypeRow = {
  label: string; recorded: number; failed: number;
  lastDone: string | null; nextDue: string | null; status: string;
};

export type CheckExceptionRow = {
  date: string; siteName: string | null; check: string;
  reading: string | null; location: string | null; notes: string | null;
};

export type KitchenFailureRow = {
  date: string; siteName: string | null; reading: string;
  correctiveAction: string | null; status: string;
};

export type ChecklistRow = {
  siteName: string; period: "AM" | "PM"; expected: number; submitted: number; missed: number;
};

export type IncidentRow = {
  date: string; siteName: string | null; type: string; severity: string; status: string;
  riddorReportable: boolean; riddorCategory: string | null;
  riddorState: RiddorDeadlineState | null; reportBy: string | null;
  reportedToHse: boolean; openActions: number;
};

export type ContractorRow = {
  name: string; publicLiabilityExpiry: string | null; indemnityExpiry: string | null;
  dbsRecheck: string | null; nextAccreditationExpiry: string | null;
  nextAccreditationName: string | null; status: "Expired" | "Due soon" | "OK" | "Not recorded";
};

export type TrainingRow = {
  staffName: string; training: string; siteName: string | null; expiryDate: string;
  status: "Expired" | "Due soon";
};

export type Capped<T> = { rows: T[]; total: number };

export type InspectionPackData = {
  businessName: string;
  siteLabel: string;
  from: string;
  to: string;
  totalDays: number;
  today: string;
  generatedAt: Date;
  generatedBy: string;
  summary: SummaryRow[];
  /** Checks with a due date or a completion; `unscheduled` counts the rest. */
  compliance: Capped<ComplianceCheckRow> & { unscheduled: number };
  fire: { types: CheckTypeRow[]; exceptions: Capped<CheckExceptionRow> } | null;
  legionella: {
    types: CheckTypeRow[]; exceptions: Capped<CheckExceptionRow>; sitesWithoutPlan: string[];
  } | null;
  kitchen: {
    sites: Array<{ siteName: string; submittedDays: number; expectedDays: number }>;
    failures: Capped<KitchenFailureRow>;
    openActions: number;
  } | null;
  checklists: ChecklistRow[] | null;
  incidents: Capped<IncidentRow> | null;
  contractors: Capped<ContractorRow> & { exceptions: number };
  training: Capped<TrainingRow> | null;
};

type Row = Record<string, any>;
const rowsOf = async (query: SQL) => (await db.execute(query)).rows as Row[];
const num = (value: unknown) => Number(value ?? 0);
const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));

function capped<T>(rows: T[]): Capped<T> {
  return { rows: rows.slice(0, EXCEPTION_LIMIT), total: rows.length };
}

const any = (services: Entitlements, ...keys: ServiceKey[]) => keys.some(key => isEntitled(services, key));

// ── Fire and water check catalogues (mirrors routes/fire-safety.ts and
//    routes/legionella.ts; labels mirror the web pages) ────────────────────────

const FIRE_TYPES: Record<string, { label: string; days: number }> = {
  alarm: { label: "Weekly fire alarm test", days: 7 },
  emergency_lights: { label: "Monthly emergency lighting flick test", days: 30 },
  extinguishers: { label: "Weekly extinguisher visual check", days: 7 },
  fire_doors: { label: "Fire door check", days: 90 },
  fire_drill: { label: "Fire drill (6-monthly, with night staff)", days: 180 },
  fire_walk: { label: "Fire walk — escape route sign-off", days: 7 },
  alarm_panel: { label: "Alarm panel check", days: 7 },
};

const LEGIONELLA_TYPES: Record<string, string> = {
  calorifier_temp: "Calorifier flow / return temperature",
  hot_sentinel_temp: "Hot water — sentinel outlet temperature",
  hot_nonsent_temp: "Hot water — representative outlet temperature",
  cold_tank_temp: "Cold water storage temperature",
  cold_sentinel_temp: "Cold water — sentinel outlet temperature",
  cold_nonsent_temp: "Cold water — representative outlet temperature",
  cold_tank_inspection: "Cold water storage tank — visual inspection",
  cold_tank_clean: "Cold water storage tank — clean & disinfect",
  calorifier_inspection: "Calorifier — internal inspection",
  calorifier_clean: "Calorifier — clean & disinfect",
  shower_clean: "Shower head / hose — descale & disinfect",
  tmv_service: "Thermostatic mixing valve (TMV) — service & verify",
  outlet_flush: "Little-used outlet — 5-minute flush",
};

/** Client default cadence, then the site's control profile (as /fire-safety/status). */
function fireFrequencies(clientSetting: unknown, profile: unknown): Record<string, number> {
  const result = Object.fromEntries(Object.entries(FIRE_TYPES).map(([key, value]) => [key, value.days]));
  const apply = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(FIRE_TYPES)) {
      const days = (value as Record<string, unknown>)[key];
      if (typeof days === "number" && Number.isInteger(days) && days > 0 && days <= 3650) result[key] = days;
    }
  };
  if (typeof clientSetting === "string") {
    try { apply(JSON.parse(clientSetting)); } catch { /* defaults */ }
  }
  if (profile && typeof profile === "object") apply((profile as Record<string, unknown>).frequencyDays);
  return result;
}

type SiteTypeState = { lastDone: string | null; frequency: number | null };

/**
 * Per check type, across the scope's sites: counts in the period plus the
 * due state as at today. A site's next due date is its last check plus the
 * cadence; a type with no cadence (no approved plan) has no due state.
 */
function checkTypeRows(
  labels: Record<string, string>,
  siteNames: Map<number, string>,
  periodCounts: Row[],
  state: Map<string, SiteTypeState>,
  siteIds: number[],
  today: string,
  totalDays: number,
) {
  let due = 0;
  let overdueToday = 0;
  const types: CheckTypeRow[] = Object.entries(labels).map(([key, label]) => {
    const counts = periodCounts.filter(row => row.check_type === key);
    const overdueSites: string[] = [];
    const neverSites: string[] = [];
    let lastDone: string | null = null;
    let nextDue: string | null = null;
    for (const siteId of siteIds) {
      const site = state.get(`${siteId}:${key}`) ?? { lastDone: null, frequency: null };
      if (site.frequency !== null) due += Math.floor(totalDays / site.frequency);
      if (site.lastDone && (!lastDone || site.lastDone > lastDone)) lastDone = site.lastDone;
      if (site.frequency === null) continue;
      if (!site.lastDone) { neverSites.push(siteNames.get(siteId) ?? `Site ${siteId}`); continue; }
      const siteDue = addCalendarDays(site.lastDone, site.frequency);
      if (!nextDue || siteDue < nextDue) nextDue = siteDue;
      if (siteDue < today) overdueSites.push(siteNames.get(siteId) ?? `Site ${siteId}`);
    }
    overdueToday += overdueSites.length;
    const status = overdueSites.length
      ? `Overdue${siteIds.length > 1 ? `: ${overdueSites.join(", ")}` : ""}`
      : neverSites.length
        ? `Never recorded${siteIds.length > 1 ? `: ${neverSites.join(", ")}` : ""}`
        : nextDue ? "Up to date" : "No schedule";
    return {
      label,
      recorded: counts.reduce((total, row) => total + num(row.records), 0),
      failed: counts.reduce((total, row) => total + num(row.failed), 0),
      lastDone, nextDue, status,
    };
  });
  return { types, due, overdueToday };
}

/** Sites with any record in a module, plus the selected site. */
function activeSiteIds(scope: SiteAccessScope, rows: Row[]): number[] {
  const used = new Set(rows.map(row => Number(row.site_id)));
  return scope.sites.map(site => site.id).filter(id => scope.siteId === id || used.has(id));
}

// ── Sections ─────────────────────────────────────────────────────────────────

async function complianceSection(scope: SiteAccessScope, from: string, to: string, today: string) {
  const items = await rowsOf(sql`
    SELECT ci.id, ci.title, ci.status, c.name AS category, s.name AS site_name,
           to_char(ci.completed_at, 'YYYY-MM-DD') AS completed_at,
           to_char(ci.due_date, 'YYYY-MM-DD') AS due_date
    FROM compliance_items ci
    LEFT JOIN categories c ON c.id = ci.category_id
    LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = ci.client_id
    WHERE ci.client_id = ${scope.clientId} AND ${siteScopeSql(scope, sql`ci.site_id`)}
    ORDER BY ci.due_date ASC NULLS LAST, ci.title ASC, ci.id ASC
  `);
  // Certificates have no client_id: their owning item is already tenant-scoped.
  const ids = items.map(item => Number(item.id));
  const certificates = ids.length ? await rowsOf(sql`
    SELECT item_id, name FROM certificates
    WHERE item_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
    ORDER BY created_at, id
  `) : [];
  const actionStates = await itemActionStates(scope.clientId, ids);
  const soon = addCalendarDays(today, 30);
  let overdue = 0;
  let actionRequired = 0;
  const rows: ComplianceCheckRow[] = items.map(item => {
    const nextDue = text(item.due_date);
    const completed = item.status === "completed";
    const action = actionStates.get(Number(item.id));
    let status: ComplianceCheckRow["status"];
    if (action?.needsAction) { status = "Action required"; actionRequired++; }
    else if (!completed && nextDue && nextDue < today) { status = "Overdue"; overdue++; }
    else if (!completed && nextDue && nextDue <= soon) status = "Due soon";
    else if (!completed && nextDue) status = "Scheduled";
    else if (completed) status = "Completed";
    else status = "No due date";
    return {
      title: item.title, category: text(item.category), siteName: text(item.site_name),
      lastCompleted: text(item.completed_at), nextDue, status,
      certificates: certificates.filter(cert => Number(cert.item_id) === Number(item.id)).map(cert => String(cert.name)),
      actionNote: action?.needsAction ? actionStateLabel(action) : null,
    };
  });
  // Action required and overdue first, then due soon: the exceptions lead the list.
  const rank = { "Action required": 0, Overdue: 1, "Due soon": 2, Scheduled: 3, "No due date": 4, Completed: 5 } as const;
  rows.sort((a, b) => rank[a.status] - rank[b.status]);
  const summary: SummaryRow = {
    module: "Compliance checks",
    due: items.filter(item => item.due_date && item.due_date >= from && item.due_date <= to).length,
    recorded: items.filter(item => item.completed_at && item.completed_at >= from && item.completed_at <= to).length,
    exceptions: null,
    overdue,
    // Checks whose newest certificate is unsatisfactory or has open defects.
    openActions: actionRequired,
  };
  // Checks never scheduled or completed (e.g. unused starter checks) are
  // counted, not listed, so the dated checks stay readable.
  const listed = rows.filter(row => row.status !== "No due date" || row.lastCompleted || row.certificates.length);
  return { section: { ...capped(listed), unscheduled: rows.length - listed.length }, summary };
}

async function fireSection(scope: SiteAccessScope, from: string, to: string, today: string, totalDays: number) {
  const siteScope = siteScopeSql(scope, sql`f.site_id`);
  const [counts, failures, latest, setting, profiles] = await Promise.all([
    rowsOf(sql`
      SELECT check_type, COUNT(*)::int AS records, COUNT(*) FILTER (WHERE result = 'fail')::int AS failed
      FROM fire_safety_checks f
      WHERE f.client_id = ${scope.clientId} AND f.check_date BETWEEN ${from} AND ${to} AND ${siteScope}
      GROUP BY check_type
    `),
    rowsOf(sql`
      SELECT f.check_date::text AS check_date, f.check_type, f.location, f.call_point, f.notes, s.name AS site_name
      FROM fire_safety_checks f
      LEFT JOIN sites s ON s.id = f.site_id AND s.client_id = f.client_id
      WHERE f.client_id = ${scope.clientId} AND f.check_date BETWEEN ${from} AND ${to}
        AND f.result = 'fail' AND ${siteScope}
      ORDER BY f.check_date, f.id
    `),
    rowsOf(sql`
      SELECT f.site_id, f.check_type, MAX(f.check_date)::text AS last_done
      FROM fire_safety_checks f
      WHERE f.client_id = ${scope.clientId} AND f.site_id IS NOT NULL AND f.check_date <= ${to}
        AND ${siteScope}
      GROUP BY f.site_id, f.check_type
    `),
    rowsOf(sql`SELECT value FROM app_settings WHERE client_id = ${scope.clientId} AND key = 'fire_frequency_days' LIMIT 1`),
    rowsOf(sql`SELECT site_id, profile FROM track_control_profiles WHERE client_id = ${scope.clientId} AND module = 'fire'`),
  ]);
  const siteIds = activeSiteIds(scope, latest);
  const state = new Map<string, SiteTypeState>();
  for (const siteId of siteIds) {
    const profile = profiles.find(row => Number(row.site_id) === siteId)?.profile ?? null;
    const frequencies = fireFrequencies(setting[0]?.value, profile);
    for (const key of Object.keys(FIRE_TYPES)) {
      const last = latest.find(row => Number(row.site_id) === siteId && row.check_type === key);
      state.set(`${siteId}:${key}`, { lastDone: text(last?.last_done), frequency: frequencies[key] });
    }
  }
  const siteNames = new Map(scope.sites.map(site => [site.id, site.name]));
  const labels = Object.fromEntries(Object.entries(FIRE_TYPES).map(([key, value]) => [key, value.label]));
  const result = checkTypeRows(labels, siteNames, counts, state, siteIds, today, totalDays);
  const exceptions = failures.map(row => ({
    date: row.check_date, siteName: text(row.site_name),
    check: FIRE_TYPES[row.check_type]?.label ?? row.check_type,
    reading: null, location: text(row.call_point) ? `Call point: ${row.call_point}` : text(row.location), notes: text(row.notes),
  }));
  return {
    section: { types: result.types, exceptions: capped(exceptions) },
    summary: {
      module: "FireTrack checks", due: result.due,
      recorded: result.types.reduce((total, row) => total + row.recorded, 0),
      exceptions: failures.length, overdue: result.overdueToday, openActions: null,
    } satisfies SummaryRow,
  };
}

async function legionellaSection(scope: SiteAccessScope, from: string, to: string, today: string, totalDays: number) {
  const siteScope = siteScopeSql(scope, sql`l.site_id`);
  const [counts, exceptions, latest, profiles] = await Promise.all([
    rowsOf(sql`
      SELECT check_type, COUNT(*)::int AS records,
             COUNT(*) FILTER (WHERE result IN ('fail', 'action_required'))::int AS failed
      FROM legionella_checks l
      WHERE l.client_id = ${scope.clientId} AND l.check_date BETWEEN ${from} AND ${to} AND ${siteScope}
      GROUP BY check_type
    `),
    // A reading outside the site's limits is saved as a fail, so failed
    // temperature checks are the out-of-range readings.
    rowsOf(sql`
      SELECT l.check_date::text AS check_date, l.check_type, l.temperature::text AS temperature,
             l.location, l.notes, s.name AS site_name
      FROM legionella_checks l
      LEFT JOIN sites s ON s.id = l.site_id AND s.client_id = l.client_id
      WHERE l.client_id = ${scope.clientId} AND l.check_date BETWEEN ${from} AND ${to}
        AND l.result IN ('fail', 'action_required') AND ${siteScope}
      ORDER BY l.check_date, l.id
    `),
    // Oldest outlet's latest reading sets the due state, as on /legionella/status.
    rowsOf(sql`
      SELECT site_id, check_type, MIN(last_done)::text AS last_done FROM (
        SELECT DISTINCT ON (l.site_id, l.check_type, COALESCE(l.outlet_id, 0))
               l.site_id, l.check_type, l.check_date AS last_done
        FROM legionella_checks l
        WHERE l.client_id = ${scope.clientId} AND l.site_id IS NOT NULL AND l.check_date <= ${to}
          AND ${siteScope}
        ORDER BY l.site_id, l.check_type, COALESCE(l.outlet_id, 0), l.check_date DESC, l.id DESC
      ) latest
      GROUP BY site_id, check_type
    `),
    rowsOf(sql`SELECT site_id, profile FROM track_control_profiles WHERE client_id = ${scope.clientId} AND module = 'legionella'`),
  ]);
  const siteIds = activeSiteIds(scope, latest);
  const sitesWithoutPlan: string[] = [];
  const state = new Map<string, SiteTypeState>();
  for (const siteId of siteIds) {
    const profile = profiles.find(row => Number(row.site_id) === siteId)?.profile ?? null;
    const frequencies = approvedFrequencies(profile, Object.keys(LEGIONELLA_TYPES), "frequencyDays");
    if (!frequencies) sitesWithoutPlan.push(scope.sites.find(site => site.id === siteId)?.name ?? `Site ${siteId}`);
    for (const key of Object.keys(LEGIONELLA_TYPES)) {
      const last = latest.find(row => Number(row.site_id) === siteId && row.check_type === key);
      state.set(`${siteId}:${key}`, { lastDone: text(last?.last_done), frequency: frequencies?.[key] ?? null });
    }
  }
  const siteNames = new Map(scope.sites.map(site => [site.id, site.name]));
  const result = checkTypeRows(LEGIONELLA_TYPES, siteNames, counts, state, siteIds, today, totalDays);
  const rows = exceptions.map(row => ({
    date: row.check_date, siteName: text(row.site_name),
    check: LEGIONELLA_TYPES[row.check_type] ?? row.check_type,
    reading: row.temperature === null ? null : `${Number(row.temperature)}°C`,
    location: text(row.location), notes: text(row.notes),
  }));
  return {
    section: { types: result.types, exceptions: capped(rows), sitesWithoutPlan },
    summary: {
      module: "LegionellaTrack checks",
      due: sitesWithoutPlan.length === siteIds.length ? null : result.due,
      recorded: result.types.reduce((total, row) => total + row.recorded, 0),
      exceptions: exceptions.length,
      overdue: sitesWithoutPlan.length === siteIds.length ? null : result.overdueToday,
      openActions: null,
    } satisfies SummaryRow,
  };
}

/** "Diary 2026-09-01. Fridge 1 · temperature: 9°C. Required range: …" → parts. */
function kitchenReading(title: string, instruction: string | null): string {
  const match = instruction?.match(/^Diary [^.]*\. (.+?)\. Required range: (.+?)\. Initial action taken:/s);
  if (match) {
    // "minimum 0; maximum 8; °C" → "minimum 0, maximum 8 °C"
    const parts = match[2].split(";").map(part => part.trim()).filter(Boolean);
    const unit = parts.length > 1 ? ` ${parts.pop()}` : "";
    return `${match[1]} (required: ${parts.join(", ")}${unit})`;
  }
  return title.replace(/^Failed temperature: /, "");
}

async function kitchenSection(scope: SiteAccessScope, from: string, to: string, totalDays: number) {
  const siteScope = siteScopeSql(scope, sql`d.site_id`);
  const [diaries, everUsed, failures] = await Promise.all([
    rowsOf(sql`
      SELECT d.site_id, COUNT(DISTINCT d.record_date)::int AS submitted_days
      FROM food_safety_records d
      WHERE d.client_id = ${scope.clientId} AND d.site_id IS NOT NULL
        AND d.record_date BETWEEN ${from} AND ${to} AND d.submitted_at IS NOT NULL AND ${siteScope}
      GROUP BY d.site_id
    `),
    rowsOf(sql`
      SELECT DISTINCT d.site_id FROM food_safety_records d
      WHERE d.client_id = ${scope.clientId} AND d.site_id IS NOT NULL AND ${siteScope}
    `),
    // Each failed reading opens one kitchen action linked to its diary.
    rowsOf(sql`
      SELECT d.record_date::text AS record_date, s.name AS site_name, a.title, a.instruction,
             a.remedial_action, a.status
      FROM track_actions a
      JOIN food_safety_records d ON d.id = a.source_record_id AND d.client_id = a.client_id
      LEFT JOIN sites s ON s.id = d.site_id AND s.client_id = d.client_id
      WHERE a.client_id = ${scope.clientId} AND a.module = 'kitchen'
        AND left(a.source_kind, 20) = 'kitchen_temperature_'
        AND d.record_date BETWEEN ${from} AND ${to} AND ${siteScope}
      ORDER BY d.record_date, a.id
    `),
  ]);
  const siteIds = activeSiteIds(scope, everUsed);
  const sites = siteIds.map(id => ({
    siteName: scope.sites.find(site => site.id === id)?.name ?? `Site ${id}`,
    submittedDays: num(diaries.find(row => Number(row.site_id) === id)?.submitted_days),
    expectedDays: totalDays,
  }));
  const rows: KitchenFailureRow[] = failures.map(row => ({
    date: row.record_date, siteName: text(row.site_name),
    reading: kitchenReading(row.title, text(row.instruction)),
    correctiveAction: text(row.remedial_action),
    status: row.status === "resolved" ? "Closed" : "Open",
  }));
  const submitted = sites.reduce((total, site) => total + site.submittedDays, 0);
  const expected = sites.reduce((total, site) => total + site.expectedDays, 0);
  return {
    section: { sites, failures: capped(rows), openActions: rows.filter(row => row.status === "Open").length },
    summary: {
      module: "KitchenTrack daily diary (days)", due: expected, recorded: submitted,
      exceptions: rows.length, overdue: Math.max(0, expected - submitted), openActions: null,
    } satisfies SummaryRow,
  };
}

async function incidentSection(scope: SiteAccessScope, from: string, to: string, today: string) {
  // Deliberately no description, people, injury or first-aid fields.
  const incidents = await rowsOf(sql`
    SELECT i.id, i.incident_date::text AS incident_date, i.incident_type, i.severity, i.status,
           i.riddor_reportable, i.riddor_category, i.reported_to_hse, s.name AS site_name
    FROM incidents i
    LEFT JOIN sites s ON s.id = i.site_id AND s.client_id = i.client_id
    WHERE i.client_id = ${scope.clientId} AND i.incident_date BETWEEN ${from} AND ${to}
      AND ${siteScopeSql(scope, sql`i.site_id`)}
    ORDER BY i.incident_date, i.id
  `);
  const ids = incidents.map(row => String(row.id));
  const actions = ids.length ? await rowsOf(sql`
    SELECT source_record_id, COUNT(*)::int AS open_actions FROM compliance_actions
    WHERE client_id = ${scope.clientId} AND source_track = 'IncidentTrack' AND status <> 'verified'
      AND source_record_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
    GROUP BY source_record_id
  `) : [];
  const rows: IncidentRow[] = incidents.map(row => {
    const deadline = riddorDeadline({
      riddorCategory: text(row.riddor_category), incidentDate: row.incident_date,
      reportedToHse: Boolean(row.reported_to_hse),
    }, today);
    return {
      date: row.incident_date, siteName: text(row.site_name), type: row.incident_type,
      severity: row.severity, status: row.status,
      riddorReportable: Boolean(row.riddor_reportable), riddorCategory: text(row.riddor_category),
      riddorState: deadline?.state ?? null,
      reportBy: deadline?.reportBy ?? null,
      reportedToHse: Boolean(row.reported_to_hse),
      openActions: num(actions.find(action => action.source_record_id === String(row.id))?.open_actions),
    };
  });
  const reportable = rows.filter(row => row.riddorState !== null
    ? row.riddorState !== "record_only" : row.riddorReportable);
  return {
    section: capped(rows),
    summary: {
      module: "IncidentTrack incidents", due: null, recorded: rows.length,
      exceptions: reportable.length,
      overdue: rows.filter(row => row.riddorState === "overdue").length,
      openActions: rows.reduce((total, row) => total + row.openActions, 0),
    } satisfies SummaryRow,
  };
}

async function contractorSection(clientId: number, today: string) {
  const [contractors, accreditations] = await Promise.all([
    rowsOf(sql`
      SELECT id, name, company, dbs_type,
             to_char(public_liability_expiry, 'YYYY-MM-DD') AS public_liability_expiry,
             to_char(professional_indemnity_expiry, 'YYYY-MM-DD') AS indemnity_expiry,
             to_char(dbs_expiry_date, 'YYYY-MM-DD') AS dbs_expiry_date,
             to_char(dbs_check_date, 'YYYY-MM-DD') AS dbs_check_date
      FROM contractors WHERE client_id = ${clientId}
      ORDER BY name, id
    `),
    rowsOf(sql`
      SELECT contractor_id, certificate_name, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
      FROM contractor_certificates
      WHERE client_id = ${clientId} AND expiry_date IS NOT NULL
      ORDER BY expiry_date, id
    `),
  ]);
  const soon = addCalendarDays(today, DUE_SOON_DAYS);
  const rows: ContractorRow[] = contractors.map(row => {
    // An explicit DBS/PVG expiry wins; older records are rechecked 3 years after the check.
    const dbsRecheck = row.dbs_type === "None" ? null
      : text(row.dbs_expiry_date) ?? (row.dbs_check_date ? addCalendarMonths(row.dbs_check_date, 36) : null);
    const next = accreditations.find(cert => Number(cert.contractor_id) === Number(row.id));
    const dates = [text(row.public_liability_expiry), text(row.indemnity_expiry), dbsRecheck, text(next?.expiry_date)]
      .filter((date): date is string => date !== null);
    const status: ContractorRow["status"] = dates.length === 0 ? "Not recorded"
      : dates.some(date => date < today) ? "Expired"
        : dates.some(date => date <= soon) ? "Due soon" : "OK";
    return {
      name: [row.name, row.company].filter(Boolean).join(" — "),
      publicLiabilityExpiry: text(row.public_liability_expiry), indemnityExpiry: text(row.indemnity_expiry),
      dbsRecheck, nextAccreditationExpiry: text(next?.expiry_date),
      nextAccreditationName: text(next?.certificate_name), status,
    };
  });
  const rank = { Expired: 0, "Due soon": 1, "Not recorded": 2, OK: 3 } as const;
  rows.sort((a, b) => rank[a.status] - rank[b.status]);
  const exceptions = rows.filter(row => row.status === "Expired" || row.status === "Due soon").length;
  return { ...capped(rows), exceptions };
}

async function trainingSection(scope: SiteAccessScope, from: string, to: string, today: string) {
  const soon = addCalendarDays(today, DUE_SOON_DAYS);
  const siteScope = siteScopeSql(scope, sql`r.site_id`);
  const [expiring, completed] = await Promise.all([
    // A newer record of the same training for the same person supersedes an older one.
    rowsOf(sql`
      SELECT r.staff_name, COALESCE(r.training_type, r.document_title, 'Training') AS training,
             r.expiry_date::text AS expiry_date, s.name AS site_name
      FROM train_track_records r
      LEFT JOIN sites s ON s.id = r.site_id AND s.client_id = r.client_id
      WHERE r.client_id = ${scope.clientId} AND r.expiry_date IS NOT NULL AND r.expiry_date <= ${soon}
        AND ${siteScope}
        AND NOT EXISTS (
          SELECT 1 FROM train_track_records newer
          WHERE newer.client_id = r.client_id AND newer.id <> r.id
            AND COALESCE(newer.training_type, newer.document_title, '') = COALESCE(r.training_type, r.document_title, '')
            AND (CASE WHEN r.staff_roster_id IS NOT NULL THEN newer.staff_roster_id = r.staff_roster_id
                      ELSE lower(newer.staff_name) = lower(r.staff_name) END)
            AND (newer.completed_date > r.completed_date
                 OR (newer.completed_date = r.completed_date AND newer.id > r.id))
        )
      ORDER BY r.expiry_date, r.staff_name, r.id
    `),
    rowsOf(sql`
      SELECT COUNT(*)::int AS records FROM train_track_records r
      WHERE r.client_id = ${scope.clientId} AND r.completed_date BETWEEN ${from} AND ${to} AND ${siteScope}
    `),
  ]);
  const rows: TrainingRow[] = expiring.map(row => ({
    staffName: row.staff_name, training: row.training, siteName: text(row.site_name),
    expiryDate: row.expiry_date, status: row.expiry_date < today ? "Expired" : "Due soon",
  }));
  const expired = rows.filter(row => row.status === "Expired").length;
  return {
    section: capped(rows),
    summary: {
      module: "TrainTrack records", due: null, recorded: num(completed[0]?.records),
      exceptions: rows.length, overdue: expired, openActions: null,
    } satisfies SummaryRow,
  };
}

/** Modules without their own section: counts from the compliance report. */
const OTHER_MODULES: Array<{ report: string; label: string; services: ServiceKey[]; action: string | null }> = [
  { report: "KitchenTrack", label: "Kitchen cleaning logs", services: ["kitchentrack"], action: null },
  { report: "TubTrack", label: "TubTrack checks", services: ["hottubtrack"], action: "hot_tub" },
  { report: "PoolTrack", label: "AquaTrack pool checks", services: ["aquatrack", "pooltrack"], action: "pool" },
  { report: "SwimTrack", label: "AquaTrack swim sessions", services: ["aquatrack", "swimtrack"], action: "swim" },
  { report: "PremisesTrack", label: "PremisesTrack inspections", services: ["premisestrack"], action: "premises" },
  { report: "PestTrack", label: "PestTrack visits", services: ["pesttrack"], action: "pest" },
  { report: "PATtrack", label: "PATtrack tests", services: ["pattrack"], action: "pat" },
  { report: "FixTrack", label: "FixTrack issues reported", services: ["fixtrack"], action: "fix" },
  { report: "TreeTrack", label: "TreeTrack inspections", services: ["treetrack"], action: "tree" },
];

export async function buildInspectionPack(options: {
  scope: SiteAccessScope;
  from: string;
  to: string;
  totalDays: number;
  generatedBy: string;
  now?: Date;
}): Promise<InspectionPackData> {
  const { scope, from, to, totalDays } = options;
  const now = options.now ?? new Date();
  const today = ukToday(now);
  const [clientRows, services, report, openActionRows] = await Promise.all([
    rowsOf(sql`SELECT name FROM clients WHERE id = ${scope.clientId} LIMIT 1`),
    getEntitledServices(scope.clientId),
    // Existing report query: the single source of daily checklist counting.
    getUnscopedComplianceReport(scope.clientId, from, to),
    rowsOf(sql`
      SELECT a.module, COUNT(*)::int AS open_actions FROM track_actions a
      WHERE a.client_id = ${scope.clientId} AND a.status <> 'resolved' AND ${siteScopeSql(scope, sql`a.site_id`)}
      GROUP BY a.module
    `),
  ]);
  const openActions = (module: string) => num(openActionRows.find(row => row.module === module)?.open_actions);
  const scopeSiteIds = new Set(scope.sites.map(site => site.id));

  const amPm = {
    am: any(services, "dailytrack_am", "kitchentrack", "premisestrack"),
    pm: any(services, "dailytrack_pm", "kitchentrack", "premisestrack"),
  };
  const checklistRows: ChecklistRow[] | null = amPm.am || amPm.pm
    ? report.dailyChecklists
      .filter(row => scopeSiteIds.has(row.siteId) && amPm[row.type])
      .map(row => ({
        siteName: row.siteName, period: row.type === "am" ? "AM" : "PM",
        expected: row.expected, submitted: row.submitted, missed: row.missed,
      }))
    : null;

  const [compliance, fire, legionella, kitchen, incidents, contractors, training] = await Promise.all([
    complianceSection(scope, from, to, today),
    isEntitled(services, "firetrack") ? fireSection(scope, from, to, today, totalDays) : null,
    isEntitled(services, "legionellatrack") ? legionellaSection(scope, from, to, today, totalDays) : null,
    isEntitled(services, "kitchentrack") ? kitchenSection(scope, from, to, totalDays) : null,
    isEntitled(services, "incidenttrack") ? incidentSection(scope, from, to, today) : null,
    contractorSection(scope.clientId, today),
    isEntitled(services, "traintrack") ? trainingSection(scope, from, to, today) : null,
  ]);

  const summary: SummaryRow[] = [compliance.summary];
  if (checklistRows) {
    summary.push({
      module: "Daily checklists (AM/PM)",
      due: checklistRows.reduce((total, row) => total + row.expected, 0),
      recorded: checklistRows.reduce((total, row) => total + row.submitted, 0),
      exceptions: null,
      overdue: checklistRows.reduce((total, row) => total + row.missed, 0),
      openActions: openActions("daily_am") + openActions("daily_pm"),
    });
  }
  if (fire) summary.push({ ...fire.summary, openActions: openActions("fire") });
  if (legionella) summary.push({ ...legionella.summary, openActions: openActions("legionella") });
  if (kitchen) summary.push({ ...kitchen.summary, openActions: openActions("kitchen") });
  if (incidents) summary.push(incidents.summary);
  if (training) summary.push({ ...training.summary, openActions: openActions("train") });
  summary.push({
    module: "Contractors", due: null, recorded: contractors.total,
    exceptions: contractors.exceptions, overdue: null, openActions: null,
  });

  const otherModules = OTHER_MODULES
    .filter(module => any(services, ...module.services))
    .map(module => ({
      module: module.label, due: null,
      recorded: report.moduleActivity
        .filter(row => row.module === module.report && scopeSiteIds.has(row.siteId))
        .reduce((total, row) => total + row.count, 0),
      exceptions: null, overdue: null,
      openActions: module.action ? openActions(module.action) : null,
    }));

  const siteLabel = scope.siteId !== null
    ? scope.sites[0]?.name ?? "Selected site"
    : scope.departmentId === null
      ? `All sites (${scope.sites.length})`
      : `All sites you can access (${scope.sites.length})`;

  return {
    businessName: clientRows[0]?.name ?? "",
    siteLabel, from, to, totalDays, today,
    generatedAt: now, generatedBy: options.generatedBy,
    summary: [...summary, ...otherModules],
    compliance: compliance.section,
    fire: fire?.section ?? null,
    legionella: legionella?.section ?? null,
    kitchen: kitchen?.section ?? null,
    checklists: checklistRows,
    incidents: incidents?.section ?? null,
    contractors,
    training: training?.section ?? null,
  };
}
