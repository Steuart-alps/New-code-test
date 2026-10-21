/**
 * Contractor visits kept on the tracks (pest control, water system servicing,
 * fire servicing, PAT testing, machine servicing and examinations, tree
 * surveys, spa lab tests) reach the contractor through the one contractor
 * reminder: a ComplyTrack compliance check with a contractor and a due date,
 * which the 08:00 job (routes/notifications.ts runReminderJob) drafts into
 * Contractor Approvals.
 *
 * Each visit type has one linked check per site, found by its title (as in
 * lib/trackTaskLink.ts). The track decides when the visit is next due, so
 * syncContractorVisitChecks moves each linked check's due date to the
 * track's; the check holds the contractor. A business-wide check counts at a
 * business with a single site. Checks are created only when someone picks a
 * contractor for a visit, never in bulk.
 */
import { db } from "@workspace/db";
import { auditEventsTable, complianceItemsTable, sitesTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  getFireSiteStatuses, LEGIONELLA_CHECK_TYPES, TUB_CHECK_TYPES, type FireCheckType,
} from "./checkReminders";
import { approvedFrequencies } from "./waterMonitoringPlan";
import { linkedTaskCompletions, TRACK_TASK_LINKS } from "./trackTaskLink";
import { getEntitledServices, isEntitled, type ServiceKey } from "./services";
import { reminderCycleOf, supersedeStaleReminderCycles } from "./reminderCycles";
import { TREE_FREQUENCY_DAYS } from "../routes/tree-track";

export interface ContractorVisitType {
  key: string;
  /** Track module key (lib/trackModules.ts). */
  module: string;
  trackLabel: string;
  services: ServiceKey[];
  /** Title of the linked compliance check. */
  title: string;
  /** Plain description of the visit. */
  label: string;
  description: string;
  /** Repeat interval for a newly created check. */
  frequencyMonths: number | null;
  /**
   * "track": the track's due date always wins. "later": the later of the
   * track's date and the check's own (a review date typed on a template).
   * "check": the track has no due date; the check's own date is used.
   */
  dueFrom: "track" | "later" | "check";
}

/** Title of the compliance check kept in step with PestTrack visits. */
export const PEST_VISIT_CHECK_TITLE = "Pest Control Visit";

const fireTitle = (checkType: keyof typeof TRACK_TASK_LINKS.fire) => TRACK_TASK_LINKS.fire[checkType];
const waterTitle = (checkType: keyof typeof TRACK_TASK_LINKS.legionella) => TRACK_TASK_LINKS.legionella[checkType];

export const CONTRACTOR_VISIT_TYPES: readonly ContractorVisitType[] = [
  {
    key: "pest:visit", module: "pest", trackLabel: "PestTrack", services: ["pesttrack"],
    title: PEST_VISIT_CHECK_TITLE, label: "Routine pest control visit",
    description: "Routine visit by the pest control contractor. Recording the visit in PestTrack completes this check, and completing this check records the visit in PestTrack.",
    frequencyMonths: 3, dueFrom: "track",
  },
  {
    key: "legionella:cold_tank_clean", module: "legionella", trackLabel: "Water Safety", services: ["legionellatrack"],
    title: waterTitle("cold_tank_clean"), label: "Cold water tank clean and disinfect",
    description: "Annual inspection of cold water storage tanks, with cleaning and disinfection when the inspection shows it is needed (HSG274).",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "legionella:calorifier_inspection", module: "legionella", trackLabel: "Water Safety", services: ["legionellatrack"],
    title: waterTitle("calorifier_inspection"), label: "Calorifier internal inspection",
    description: "Internal inspection of calorifiers (HSG274). Kept in step with the Water Safety log.",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "legionella:calorifier_clean", module: "legionella", trackLabel: "Water Safety", services: ["legionellatrack"],
    title: waterTitle("calorifier_clean"), label: "Calorifier clean and disinfect",
    description: "Cleaning and disinfection of calorifiers (HSG274). Kept in step with the Water Safety log.",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "legionella:tmv_service", module: "legionella", trackLabel: "Water Safety", services: ["legionellatrack"],
    title: waterTitle("tmv_service"), label: "Thermostatic mixing valve (TMV) service",
    description: "Service and verification of thermostatic mixing valves. Kept in step with the Water Safety log.",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "legionella:risk_assessment", module: "legionella", trackLabel: "Water Safety", services: ["legionellatrack"],
    title: "Legionella Risk Assessment", label: "Legionella risk assessment review",
    description: "Review of the legionella risk assessment by your competent person (ACOP L8; HSG274). Its due date follows the review date on the site's Water Safety template; change that date there after each review.",
    frequencyMonths: null, dueFrom: "later",
  },
  {
    key: "legionella:water_sampling", module: "legionella", trackLabel: "Water Safety", services: ["legionellatrack"],
    title: "Legionella Water Sampling", label: "Legionella water sampling (laboratory)",
    description: "Water samples taken and analysed by an accredited laboratory, where the risk assessment or written scheme calls for sampling (HSG274).",
    frequencyMonths: 12, dueFrom: "check",
  },
  {
    key: "fire:alarm_service", module: "fire", trackLabel: "FireTrack", services: ["firetrack"],
    title: fireTitle("alarm_service"), label: "Fire alarm service (6-monthly)",
    description: "Six-monthly servicing of the fire alarm system by a competent contractor (BS 5839).",
    frequencyMonths: 6, dueFrom: "track",
  },
  {
    key: "fire:extinguisher_service", module: "fire", trackLabel: "FireTrack", services: ["firetrack"],
    title: fireTitle("extinguisher_service"), label: "Fire extinguisher service (annual)",
    description: "Annual service of all portable fire extinguishers (BS 5306-3).",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "fire:emergency_lights_annual", module: "fire", trackLabel: "FireTrack", services: ["firetrack"],
    title: fireTitle("emergency_lights_annual"), label: "Emergency lighting 3-hour test (annual)",
    description: "Annual three-hour duration test and certification of emergency lighting (BS 5266).",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "fire:risk_assessment", module: "fire", trackLabel: "FireTrack", services: ["firetrack"],
    title: "Fire Risk Assessment Review", label: "Fire risk assessment review",
    description: "Review of the fire risk assessment by your assessor. Its due date follows the next review date on the site's FireTrack template; change that date there after each review.",
    frequencyMonths: 12, dueFrom: "later",
  },
  {
    key: "pat:testing", module: "pat", trackLabel: "PATtrack", services: ["pattrack"],
    title: "Electrical Appliance Testing (PAT)", label: "PAT testing visit",
    description: "Portable appliance testing. Due when the first appliance at the site is due for its next test; record the results in PATtrack.",
    frequencyMonths: null, dueFrom: "track",
  },
  {
    key: "green:service", module: "green", trackLabel: "GreenTrack", services: ["greentrack"],
    title: "GreenTrack Machine Servicing", label: "Machine servicing",
    description: "Servicing of grounds machinery. Due when the first machine at the site is due a service; record each service in GreenTrack.",
    frequencyMonths: null, dueFrom: "track",
  },
  {
    key: "green:examination", module: "green", trackLabel: "GreenTrack", services: ["greentrack"],
    title: "GreenTrack Statutory Examinations", label: "Statutory examinations and inspections (PUWER, LOLER and others)",
    description: "Thorough examinations and statutory inspections of machinery. Due when the first machine at the site is due one; record each in GreenTrack.",
    frequencyMonths: null, dueFrom: "track",
  },
  {
    key: "tree:visual_assessment", module: "tree", trackLabel: "TreeTrack", services: ["treetrack"],
    title: "Tree Safety Survey", label: "Annual tree survey (arborist)",
    description: "Annual visual tree assessment by a competent arborist (BS 5837 / NTSG). Record the survey in TreeTrack.",
    frequencyMonths: 12, dueFrom: "track",
  },
  {
    key: "hot_tub:microbiological_test", module: "hot_tub", trackLabel: "TubTrack", services: ["hottubtrack"],
    title: "Spa Microbiological Test", label: "Spa microbiological test (laboratory)",
    description: "Microbiological testing of spa pool water by an accredited laboratory (HSG282). Record the result in TubTrack.",
    frequencyMonths: 3, dueFrom: "track",
  },
];

export function getContractorVisitType(key: string): ContractorVisitType | undefined {
  return CONTRACTOR_VISIT_TYPES.find((type) => type.key === key);
}

const normalise = (title: string) => title.trim().toLowerCase();
const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
/** YYYY-MM-DD from a DATE column (a string) or a timestamp (a Date, UTC). */
const day = (value: unknown) =>
  value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const MS_DAY = 86_400_000;
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_DAY).toISOString().slice(0, 10);

/** When each visit is next due at each site, according to its track. */
export type TrackDueDates = Map<string, Map<number, string>>;

async function dueByKey(rows: { site_id: number; due: unknown }[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const row of rows) {
    const due = day(row.due);
    if (due) result.set(Number(row.site_id), due);
  }
  return result;
}

/** Last done date per site and check type, from the water or spa log. */
async function lastBySite(table: "legionella_checks" | "hot_tub_checks", unit: "outlet_id" | "hot_tub_id", clientId: number) {
  const result = await db.execute(sql`
    SELECT site_id, check_type, MIN(check_date) AS last_date
    FROM (
      SELECT DISTINCT ON (site_id, check_type, COALESCE(${sql.raw(unit)}, 0)) site_id, check_type, check_date
      FROM ${sql.raw(table)}
      WHERE client_id = ${clientId} AND site_id IS NOT NULL
      ORDER BY site_id, check_type, COALESCE(${sql.raw(unit)}, 0), check_date DESC, id DESC
    ) latest_units
    GROUP BY site_id, check_type
  `);
  return new Map(rowsOf<{ site_id: number; check_type: string; last_date: unknown }>(result)
    .map((row) => [`${Number(row.site_id)}:${row.check_type}`, day(row.last_date)!]));
}

async function profiles(clientId: number, module: string) {
  const result = await db.execute(sql`
    SELECT site_id, profile FROM track_control_profiles
    WHERE client_id = ${clientId} AND module = ${module} AND site_id IS NOT NULL
  `);
  return new Map(rowsOf<{ site_id: number; profile: unknown }>(result).map((row) => [Number(row.site_id), row.profile]));
}

/**
 * The next due date of each entitled visit type at each site, from its track.
 * A site with nothing recorded yet has no date.
 */
export async function trackDueDates(clientId: number, types: readonly ContractorVisitType[]): Promise<TrackDueDates> {
  const wanted = new Set(types.map((type) => type.key));
  const due: TrackDueDates = new Map();
  const set = (key: string, dates: Map<number, string>) => { if (wanted.has(key)) due.set(key, dates); };
  const needs = (prefix: string) => [...wanted].some((key) => key.startsWith(prefix));

  if (wanted.has("pest:visit")) {
    set("pest:visit", await dueByKey(rowsOf(await db.execute(sql`
      SELECT site_id, next_visit_date AS due FROM (
        SELECT DISTINCT ON (site_id) site_id, next_visit_date FROM pest_visits
        WHERE client_id = ${clientId} AND site_id IS NOT NULL
        ORDER BY site_id, visit_date DESC, id DESC
      ) latest
    `))));
  }

  if (needs("fire:")) {
    const statuses = await getFireSiteStatuses(clientId);
    for (const checkType of ["alarm_service", "extinguisher_service", "emergency_lights_annual"] as FireCheckType[]) {
      const dates = new Map<number, string>();
      for (const row of statuses) {
        if (row.checkType === checkType && row.siteId != null && row.dueDate) dates.set(row.siteId, row.dueDate);
      }
      set(`fire:${checkType}`, dates);
    }
    const reviewDates = new Map<number, string>();
    for (const [siteId, profile] of await profiles(clientId, "fire")) {
      const date = day((profile as { nextReviewDate?: unknown } | null)?.nextReviewDate);
      if (date) reviewDates.set(siteId, date);
    }
    set("fire:risk_assessment", reviewDates);
  }

  if (needs("legionella:")) {
    const [last, plans] = await Promise.all([lastBySite("legionella_checks", "outlet_id", clientId), profiles(clientId, "legionella")]);
    for (const [key, completedOn] of await linkedTaskCompletions(clientId, "legionella")) {
      const recorded = last.get(key);
      if (!recorded || recorded < completedOn) last.set(key, completedOn);
    }
    for (const checkType of ["cold_tank_clean", "calorifier_inspection", "calorifier_clean", "tmv_service"]) {
      const dates = new Map<number, string>();
      for (const [siteId, profile] of plans) {
        // Only a current approved plan gives a water due date.
        const frequencies = approvedFrequencies(profile, LEGIONELLA_CHECK_TYPES, "frequencyDays");
        const lastDate = last.get(`${siteId}:${checkType}`);
        if (frequencies && lastDate) dates.set(siteId, addDays(lastDate, frequencies[checkType]!));
      }
      set(`legionella:${checkType}`, dates);
    }
    const reviewDates = new Map<number, string>();
    for (const [siteId, profile] of plans) {
      const date = day((profile as { riskAssessmentReviewDate?: unknown } | null)?.riskAssessmentReviewDate);
      if (date) reviewDates.set(siteId, date);
    }
    set("legionella:risk_assessment", reviewDates);
  }

  if (wanted.has("pat:testing")) {
    set("pat:testing", await dueByKey(rowsOf(await db.execute(sql`
      SELECT a.site_id, MIN(last.next_test_date) AS due
      FROM pat_appliances a
      JOIN LATERAL (
        SELECT next_test_date FROM pat_tests t
        WHERE t.appliance_id = a.id AND t.client_id = a.client_id
        ORDER BY t.test_date DESC, t.id DESC LIMIT 1
      ) last ON true
      WHERE a.client_id = ${clientId} AND a.active = true AND a.site_id IS NOT NULL AND last.next_test_date IS NOT NULL
      GROUP BY a.site_id
    `))));
  }

  if (wanted.has("green:service")) {
    set("green:service", await dueByKey(rowsOf(await db.execute(sql`
      SELECT m.site_id, MIN(s.next_service_date) AS due
      FROM green_machines m
      JOIN LATERAL (
        SELECT next_service_date FROM green_service_records
        WHERE machine_id = m.id AND client_id = m.client_id
        ORDER BY service_date DESC, id DESC LIMIT 1
      ) s ON true
      WHERE m.client_id = ${clientId} AND m.active = true AND m.site_id IS NOT NULL AND s.next_service_date IS NOT NULL
      GROUP BY m.site_id
    `))));
  }

  // Every kind of examination or inspection in GreenTrack's statutory log,
  // each machine's latest of each kind.
  if (wanted.has("green:examination")) {
    set("green:examination", await dueByKey(rowsOf(await db.execute(sql`
      SELECT m.site_id, MIN(p.next_inspection_date) AS due
      FROM green_machines m
      JOIN (
        SELECT DISTINCT ON (machine_id, inspection_type) machine_id, next_inspection_date
        FROM green_puwer_inspections
        WHERE client_id = ${clientId}
        ORDER BY machine_id, inspection_type, inspection_date DESC, id DESC
      ) p ON p.machine_id = m.id
      WHERE m.client_id = ${clientId} AND m.active = true AND m.site_id IS NOT NULL AND p.next_inspection_date IS NOT NULL
      GROUP BY m.site_id
    `))));
  }

  if (wanted.has("tree:visual_assessment")) {
    const rows = rowsOf<{ site_id: number; last_date: unknown }>(await db.execute(sql`
      SELECT site_id, MAX(check_date) AS last_date FROM tree_inspections
      WHERE client_id = ${clientId} AND site_id IS NOT NULL AND check_type = 'visual_assessment'
      GROUP BY site_id
    `));
    set("tree:visual_assessment", new Map(rows.map((row) =>
      [Number(row.site_id), addDays(day(row.last_date)!, TREE_FREQUENCY_DAYS.visual_assessment)])));
  }

  if (wanted.has("hot_tub:microbiological_test")) {
    const [last, plans] = await Promise.all([lastBySite("hot_tub_checks", "hot_tub_id", clientId), profiles(clientId, "hot_tub")]);
    const dates = new Map<number, string>();
    for (const [siteId, profile] of plans) {
      const frequencies = approvedFrequencies(profile, TUB_CHECK_TYPES, "frequencyDays");
      const lastDate = last.get(`${siteId}:microbiological_test`);
      if (frequencies && lastDate) dates.set(siteId, addDays(lastDate, frequencies.microbiological_test!));
    }
    set("hot_tub:microbiological_test", dates);
  }

  return due;
}

/** The visit types the business's subscription covers. */
export async function entitledVisitTypes(clientId: number): Promise<ContractorVisitType[]> {
  const services = await getEntitledServices(clientId);
  return CONTRACTOR_VISIT_TYPES.filter((type) => type.services.some((key) => isEntitled(services, key)));
}

type Check = typeof complianceItemsTable.$inferSelect;
export interface LinkedVisitCheck { type: ContractorVisitType; siteId: number; check: Check }

/**
 * The compliance checks linked to the visit types, with the site each one
 * covers: its own, or the only site for a business-wide check at a business
 * with one site. A site's own check wins over a business-wide one.
 */
export async function linkedVisitChecks(clientId: number, types: readonly ContractorVisitType[]): Promise<LinkedVisitCheck[]> {
  if (!types.length) return [];
  const byTitle = new Map(types.map((type) => [normalise(type.title), type]));
  const [checks, sites] = await Promise.all([
    db.select().from(complianceItemsTable).where(and(
      eq(complianceItemsTable.clientId, clientId),
      sql`lower(trim(${complianceItemsTable.title})) IN (${sql.join([...byTitle.keys()].map((title) => sql`${title}`), sql`, `)})`,
    )).orderBy(complianceItemsTable.id),
    db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.clientId, clientId)).limit(2),
  ]);
  const soleSiteId = sites.length === 1 ? sites[0].id : null;
  const linked = new Map<string, LinkedVisitCheck>();
  for (const check of checks) {
    const type = byTitle.get(normalise(check.title));
    const siteId = check.siteId ?? soleSiteId;
    if (!type || siteId == null) continue;
    const key = `${type.key}@${siteId}`;
    const existing = linked.get(key);
    if (existing && (existing.check.siteId != null || check.siteId == null)) continue;
    linked.set(key, { type, siteId, check });
  }
  return [...linked.values()];
}

function syncedDueDate(type: ContractorVisitType, trackDue: string | undefined, check: Check): string | null {
  const checkDue = day(check.dueDate);
  if (type.dueFrom === "check" || !trackDue || trackDue === checkDue) return null;
  if (type.dueFrom === "later" && checkDue && checkDue > trackDue) return null;
  // A track date on or before the check was last done means the visit was
  // marked done on the check but not recorded on the track; the check keeps
  // its own date (or stays completed) until the track moves past it.
  if (check.completedAt && trackDue <= new Date(check.completedAt).toISOString().slice(0, 10)) return null;
  return trackDue;
}

/**
 * Move each linked check's due date to the date its track gives, reopening a
 * completed one-off check. A changed due date starts a new reminder cycle, so
 * the contractor is reminded about the new date and stale drafts are
 * withdrawn. Returns how many checks changed.
 */
export async function syncContractorVisitChecks(clientId: number, onlyKeys?: readonly string[]): Promise<number> {
  const types = (await entitledVisitTypes(clientId)).filter((type) => !onlyKeys || onlyKeys.includes(type.key));
  if (!types.length) return 0;
  const [due, linked] = await Promise.all([trackDueDates(clientId, types), linkedVisitChecks(clientId, types)]);
  let changed = 0;
  for (const { type, siteId, check } of linked) {
    const next = syncedDueDate(type, due.get(type.key)?.get(siteId), check);
    if (!next) continue;
    const dueDate = new Date(`${next}T00:00:00Z`);
    const cycleChanged = !check.dueDate || reminderCycleOf(new Date(check.dueDate)) !== reminderCycleOf(dueDate);
    await db.transaction(async (tx) => {
      const [after] = await tx.update(complianceItemsTable).set({
        dueDate,
        ...(check.status === "completed" ? { status: "pending" as const } : {}),
        ...(cycleChanged ? { notificationSentAt: null } : {}),
        updatedAt: new Date(),
      }).where(and(eq(complianceItemsTable.id, check.id), eq(complianceItemsTable.clientId, clientId))).returning();
      await supersedeStaleReminderCycles(tx, clientId, check.id);
      await tx.insert(auditEventsTable).values({
        clientId, actorId: null, entityType: "compliance_item", entityId: check.id, action: "updated",
        before: check, after, metadata: { dueDateFromTrack: { visit: type.key, siteId, dueDate: next } },
      });
    });
    changed++;
  }
  return changed;
}
