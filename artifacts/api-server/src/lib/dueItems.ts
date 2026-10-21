/**
 * Everything a business has falling due, in one shape, for the personal
 * "due tomorrow" email and the Owner update (lib/personalReminders.ts).
 *
 * Each item names the track it belongs to, its site, its due (or expiry)
 * date and, where the record has one, the person it is assigned to. Who is
 * reminded is decided by responsibleFor():
 *   - the person assigned, while they are still an active member who can see
 *     the item's site;
 *   - a task assigned to a group ("Staff" or "Managers") goes on that group's
 *     bell only, never to a whole group's inboxes;
 *   - otherwise the track's owner for the site (lib/trackOwners.ts), and with
 *     no owner set, the business's Owners. Consultants are reminded only
 *     about tracks they own, so ALPS is not copied in on every business;
 *   - contractor documents go to the Maintenance managers, else the Owners;
 *   - a missing certificate after a contractor visit goes to the person
 *     assigned, else the site's Maintenance managers, else its Managers, else
 *     the Owners (responsibleForCertificate).
 *
 * A compliance check linked to a track visit (lib/contractorVisits.ts) stands
 * in for the track's own date, so a visit is listed once.
 *
 * Daily checks (AM/PM checklists, the kitchen diary, room checks, machine
 * pre-use checks, swim sessions, daily tasks) are not listed: a day-before
 * email would arrive every day. They keep their same-day bell
 * (lib/trackReminders.ts).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { addCalendarDays } from "./accountClock";
import { getCheckAlerts, type CheckAlert } from "./checkReminders";
import { getCoshhDueItems } from "./coshhTrack";
import {
  CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING,
  DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
  parseContractorComplianceLeadDays,
} from "./contractorComplianceReminders";
import { entitledVisitTypes, linkedVisitChecks, trackDueDates } from "./contractorVisits";
import { logger } from "./logger";
import { getEntitledServices, isEntitled, type Entitlements } from "./services";
import { occursOn } from "./taskSchedule";
import { getTrackModule } from "./trackModules";
import { candidateCanSeeSite, hasExplicitOwner, loadOwnerContext, resolveOwnersFromContext, type OwnerContext } from "./trackOwners";

/** How far ahead items are collected (the Owner update lists expiries 60 days out). */
export const DUE_ITEMS_HORIZON_DAYS = 60;
/** Staff training is reminded this many days before it expires, and the day before. */
export const TRAINING_EXPIRY_LEAD_DAYS = 30;

/** Pseudo-modules for items that belong to no track. */
export const TASKS_MODULE = "tasks";
export const CONTRACTORS_MODULE = "contractors";

export interface DueItem {
  /** Stable identity, e.g. "action:12". */
  id: string;
  /** Track module key (lib/trackModules.ts), or TASKS_MODULE / CONTRACTORS_MODULE. */
  module: string;
  trackLabel: string;
  siteId: number | null;
  siteName: string | null;
  title: string;
  /** YYYY-MM-DD: when it is due, or when it expires. */
  dueDate: string;
  kind: "due" | "expiry";
  /** For expiries: days before expiry of the early reminder (the other is 1 day before). */
  leadDays?: number;
  /** The person picked on the record. */
  assigneeUserId: number | null;
  /** The typed name on the record (shown; nobody is reminded through it). */
  assigneeName: string | null;
  /** A task assigned to a group: bell only. */
  groupRole?: "client_staff" | "managers";
  linkPath: string;
}

/** Something needing action today: a failed or unsafe check, or a new urgent FixTrack issue. */
export interface UrgentItem {
  id: string;
  module: string;
  trackLabel: string;
  siteId: number | null;
  siteName: string | null;
  title: string;
  detail: string;
  /** YYYY-MM-DD it was recorded or raised. */
  raisedOn: string;
  assigneeUserId: number | null;
  linkPath: string;
}

export interface DueItemsSnapshot {
  items: DueItem[];
  urgent: UrgentItem[];
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
const num = (value: unknown) => (value == null ? null : Number(value));
const day = (value: unknown) =>
  value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

function moduleLabel(module: string): string {
  if (module === TASKS_MODULE) return "Tasks";
  if (module === CONTRACTORS_MODULE) return "Contractors";
  return getTrackModule(module)?.label ?? module;
}

function modulePath(module: string): string {
  if (module === TASKS_MODULE) return "/tasks";
  if (module === CONTRACTORS_MODULE) return "/contractors";
  return getTrackModule(module)?.path ?? "/";
}

function entitledTo(services: Entitlements, module: string): boolean {
  if (module === TASKS_MODULE || module === CONTRACTORS_MODULE || module === "compliance") return true;
  return getTrackModule(module)?.services.some((key) => isEntitled(services, key)) ?? false;
}

/** Run one source; a failure is logged and the rest still run. */
async function source<T>(clientId: number, name: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (err) {
    logger.warn({ err, clientId, source: name }, "Due items: could not read a source");
    return [];
  }
}

async function contractorLeadDays(clientId: number): Promise<number> {
  const [row] = rowsOf<{ value: string | null }>(await db.execute(sql`
    SELECT value FROM app_settings WHERE client_id = ${clientId} AND key = ${CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING}
  `));
  return parseContractorComplianceLeadDays(row?.value) ?? DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS;
}

/**
 * Collect every open item due (or expiring) up to DUE_ITEMS_HORIZON_DAYS
 * after `today`, overdue ones included, and today's urgent items.
 */
export async function collectDueItems(clientId: number, today: string, now: Date): Promise<DueItemsSnapshot> {
  const horizon = addCalendarDays(today, DUE_ITEMS_HORIZON_DAYS);
  const services = await getEntitledServices(clientId);
  const siteNames = new Map(rowsOf<{ id: number; name: string }>(await db.execute(sql`
    SELECT id, name FROM sites WHERE client_id = ${clientId}
  `)).map((row) => [Number(row.id), row.name]));
  const siteName = (siteId: number | null) => (siteId == null ? null : siteNames.get(siteId) ?? null);
  const items: DueItem[] = [];
  const urgent: UrgentItem[] = [];
  const push = (item: Omit<DueItem, "trackLabel" | "siteName" | "linkPath"> & { linkPath?: string }) => {
    if (!entitledTo(services, item.module)) return;
    items.push({
      ...item,
      trackLabel: moduleLabel(item.module),
      siteName: siteName(item.siteId),
      linkPath: item.linkPath ?? modulePath(item.module),
    });
  };

  // Compliance checks linked to a track visit stand in for the track's date.
  const visitTypes = await source(clientId, "visit types", () => entitledVisitTypes(clientId));
  const linked = await source(clientId, "linked checks", () => linkedVisitChecks(clientId, visitTypes));
  const linkedModuleByCheck = new Map(linked.map((entry) => [entry.check.id, entry.type.module]));
  const linkedVisits = new Set(linked
    .filter((entry) => entry.check.status !== "completed")
    .map((entry) => `${entry.type.key}@${entry.siteId}`));

  // Compliance checks (gas, EICR, LOLER, linked contractor visits...).
  for (const row of await source(clientId, "compliance", async () => rowsOf<{
    id: number; title: string; site_id: number | null; due: string; assignee_user_id: number | null; assigned_to: string | null;
  }>(await db.execute(sql`
    SELECT id, title, site_id, due_date::date::text AS due, assignee_user_id, assigned_to
    FROM compliance_items
    WHERE client_id = ${clientId} AND status <> 'completed'
      AND due_date IS NOT NULL AND due_date::date <= ${horizon}::date
  `)))) {
    const siteId = num(row.site_id);
    push({
      id: `compliance:${row.id}`, module: linkedModuleByCheck.get(Number(row.id)) ?? "compliance",
      siteId, title: row.title, dueDate: day(row.due)!, kind: "due",
      assigneeUserId: num(row.assignee_user_id), assigneeName: row.assigned_to,
      linkPath: "/external",
    });
  }

  // Open track actions.
  for (const row of await source(clientId, "actions", async () => rowsOf<{
    id: number; module: string; title: string; site_id: number | null; due: string; assignee_user_id: number | null; owner_name: string | null;
  }>(await db.execute(sql`
    SELECT id, module, title, site_id, due_date::text AS due, assignee_user_id, owner_name
    FROM track_actions
    WHERE client_id = ${clientId} AND status <> 'resolved'
      AND due_date IS NOT NULL AND due_date <= ${horizon}::date
  `)))) {
    if (!getTrackModule(row.module)) continue;
    push({
      id: `action:${row.id}`, module: row.module, siteId: num(row.site_id), title: row.title,
      dueDate: day(row.due)!, kind: "due",
      assigneeUserId: num(row.assignee_user_id), assigneeName: row.owner_name,
    });
  }

  // Open FixTrack issues with a target date.
  for (const row of await source(clientId, "fixtrack", async () => rowsOf<{
    id: number; title: string; site_id: number | null; due: string; assignee_user_id: number | null; assigned_to: string | null;
  }>(await db.execute(sql`
    SELECT id, title, site_id, target_date::text AS due, assignee_user_id, assigned_to
    FROM fix_track_issues
    WHERE client_id = ${clientId} AND status IN ('reported', 'in_progress')
      AND target_date IS NOT NULL AND target_date <= ${horizon}::date
  `)))) {
    push({
      id: `fix:${row.id}`, module: "fix", siteId: num(row.site_id), title: row.title,
      dueDate: day(row.due)!, kind: "due",
      assigneeUserId: num(row.assignee_user_id), assigneeName: row.assigned_to,
      linkPath: `/fix-track/${row.id}`,
    });
  }

  // Staff tasks: the next week's occurrences not yet done, and one-off tasks
  // still not done. Daily tasks are left to the task list.
  const tasks = await source(clientId, "tasks", async () => rowsOf<{
    id: number; title: string; site_id: number | null; module: string | null; recurrence: string; starts_on: string;
    assignee_user_id: number | null; assignee_role: string | null; assignee_name: string | null;
  }>(await db.execute(sql`
    SELECT t.id, t.title, t.site_id, t.module, t.recurrence, t.starts_on::text AS starts_on,
           t.assignee_user_id, t.assignee_role, u.name AS assignee_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_user_id
    WHERE t.client_id = ${clientId} AND t.active = true AND t.recurrence <> 'daily'
      AND t.starts_on <= ${addCalendarDays(today, 7)}::date
  `)));
  if (tasks.length) {
    const done = new Set(rowsOf<{ task_id: number; occurrence_date: string }>(await db.execute(sql`
      SELECT task_id, occurrence_date::text AS occurrence_date FROM task_completions
      WHERE client_id = ${clientId} AND occurrence_date >= ${addCalendarDays(today, -35)}::date
    `)).map((row) => `${row.task_id}:${day(row.occurrence_date)}`));
    const oneOffDone = new Set(rowsOf<{ task_id: number }>(await db.execute(sql`
      SELECT DISTINCT c.task_id FROM task_completions c JOIN tasks t ON t.id = c.task_id
      WHERE c.client_id = ${clientId} AND t.recurrence = 'once'
    `)).map((row) => Number(row.task_id)));
    for (const task of tasks) {
      const startsOn = day(task.starts_on)!;
      const dates: string[] = [];
      if (task.recurrence === "once") {
        if (!oneOffDone.has(Number(task.id))) dates.push(startsOn);
      } else {
        for (let offset = -1; offset <= 7; offset++) {
          const date = addCalendarDays(today, offset);
          if (occursOn({ recurrence: task.recurrence, startsOn }, date) && !done.has(`${task.id}:${date}`)) dates.push(date);
        }
      }
      const role = task.assignee_role === "client_staff" || task.assignee_role === "managers" ? task.assignee_role : undefined;
      for (const date of dates) {
        push({
          id: `task:${task.id}:${date}`, module: TASKS_MODULE, siteId: num(task.site_id), title: task.title,
          dueDate: date, kind: "due",
          assigneeUserId: num(task.assignee_user_id), assigneeName: task.assignee_name,
          ...(role ? { groupRole: role } : {}),
        });
      }
    }
  }

  // FireTrack, LegionellaTrack, AquaTrack water tests and TubTrack checks.
  let alerts: CheckAlert[] = [];
  try {
    alerts = await getCheckAlerts(clientId, {}, now);
  } catch (err) {
    logger.warn({ err, clientId }, "Due items: could not evaluate check alerts");
  }
  for (const alert of alerts) {
    if (alert.module === "coshh") continue; // read below, item by item
    const siteId = alert.siteId ?? null;
    if (alert.status === "action_required") {
      if (!entitledTo(services, alert.module) || !alert.lastDate) continue;
      urgent.push({
        id: `unsafe:${alert.module}:${alert.checkType}:${siteId ?? ""}:${alert.checkLabel}`,
        module: alert.module, trackLabel: moduleLabel(alert.module), siteId, siteName: alert.siteName ?? siteName(siteId),
        title: alert.checkLabel, detail: `${alert.moduleLabel}: the last result needs follow-up`,
        raisedOn: day(alert.lastDate)!, assigneeUserId: null, linkPath: alert.modulePath || modulePath(alert.module),
      });
      continue;
    }
    if ((alert.status !== "overdue" && alert.status !== "due_soon") || !alert.dueDate) continue;
    if (siteId != null && linkedVisits.has(`${alert.module}:${alert.checkType}@${siteId}`)) continue;
    const label = alert.siteName && alert.checkLabel.startsWith(`${alert.siteName}: `)
      ? alert.checkLabel.slice(alert.siteName.length + 2) : alert.checkLabel;
    push({
      id: `check:${alert.module}:${alert.checkType}:${siteId ?? ""}:${label}`, module: alert.module, siteId,
      title: label, dueDate: day(alert.dueDate)!, kind: "due",
      assigneeUserId: null, assigneeName: null, linkPath: alert.modulePath || undefined,
    });
  }

  // COSHHTrack assessment reviews and checks.
  for (const item of await source(clientId, "coshh", () => getCoshhDueItems(clientId, {}, today))) {
    if (!item.dueDate || (item.status !== "overdue" && item.status !== "due_soon" && item.status !== "ok")) continue;
    if (item.dueDate > horizon) continue;
    push({
      id: `coshh:${item.kind}:${item.recordId}`, module: "coshh", siteId: item.siteId, title: item.label,
      dueDate: item.dueDate, kind: "due", assigneeUserId: null, assigneeName: null,
    });
  }

  // Track dates that no check alert covers: pest visits, PAT retests,
  // GreenTrack servicing and examinations, TreeTrack assessments and the
  // fire and water risk assessment reviews.
  const trackOnly = visitTypes.filter((type) => {
    const [module, checkType] = type.key.split(":");
    return !["fire", "legionella", "hot_tub"].includes(module!) || checkType === "risk_assessment";
  });
  const trackDates = trackOnly.length ? await trackDueDates(clientId, trackOnly).catch((err) => {
    logger.warn({ err, clientId }, "Due items: could not read track due dates");
    return new Map<string, Map<number, string>>();
  }) : new Map<string, Map<number, string>>();
  for (const type of trackOnly) {
    for (const [siteId, dueDate] of trackDates.get(type.key) ?? []) {
      if (linkedVisits.has(`${type.key}@${siteId}`) || dueDate > horizon) continue;
      push({
        id: `visit:${type.key}:${siteId}`, module: type.module, siteId, title: type.label, dueDate, kind: "due",
        assigneeUserId: null, assigneeName: null,
      });
    }
  }

  // PremisesTrack: the latest inspection of each type and area sets the next.
  for (const row of await source(clientId, "premises", async () => rowsOf<{
    site_id: number | null; inspection_type: string; area: string | null; due: string;
  }>(await db.execute(sql`
    SELECT site_id, inspection_type, area, next_inspection_date::text AS due FROM (
      SELECT DISTINCT ON (site_id, inspection_type, lower(trim(coalesce(area, ''))))
        site_id, inspection_type, area, next_inspection_date
      FROM premises_inspections
      WHERE client_id = ${clientId}
      ORDER BY site_id, inspection_type, lower(trim(coalesce(area, ''))), inspection_date DESC, id DESC
    ) latest
    WHERE next_inspection_date IS NOT NULL AND next_inspection_date <= ${horizon}::date
  `)))) {
    const type = row.inspection_type.replace(/_/g, " ");
    const title = `${type.charAt(0).toUpperCase()}${type.slice(1)} inspection${row.area?.trim() ? ` (${row.area.trim()})` : ""}`;
    push({
      id: `premises:${row.site_id ?? ""}:${row.inspection_type}:${row.area?.trim().toLowerCase() ?? ""}`, module: "premises",
      siteId: num(row.site_id), title, dueDate: day(row.due)!, kind: "due", assigneeUserId: null, assigneeName: null,
    });
  }

  // DocTrack document reviews and SafeTrack risk assessment reviews.
  for (const row of await source(clientId, "doc reviews", async () => rowsOf<{ id: number; title: string; site_id: number | null; due: string }>(
    await db.execute(sql`
      SELECT id, title, site_id, next_review_date::date::text AS due FROM doc_track_documents
      WHERE client_id = ${clientId} AND next_review_date IS NOT NULL AND next_review_date::date <= ${horizon}::date
    `)))) {
    push({
      id: `doc-review:${row.id}`, module: "doc", siteId: num(row.site_id), title: `Review: ${row.title}`,
      dueDate: day(row.due)!, kind: "due", assigneeUserId: null, assigneeName: null,
    });
  }
  for (const row of await source(clientId, "risk assessment reviews", async () => rowsOf<{ id: number; title: string; site_id: number | null; due: string }>(
    await db.execute(sql`
      SELECT id, title, site_id, review_date::text AS due FROM safe_risk_assessments
      WHERE client_id = ${clientId} AND review_date IS NOT NULL AND review_date <= ${horizon}::date
    `)))) {
    push({
      id: `ra-review:${row.id}`, module: "safe", siteId: num(row.site_id), title: `Review: ${row.title}`,
      dueDate: day(row.due)!, kind: "due", assigneeUserId: null, assigneeName: null, linkPath: "/safe-track",
    });
  }

  // BikeTrack services: each bike's latest service sets the next.
  for (const row of await source(clientId, "bike services", async () => rowsOf<{ id: number; name: string; site_id: number | null; due: string }>(
    await db.execute(sql`
      SELECT b.id, COALESCE(b.name, b.ref) AS name, b.site_id, s.next_service_date::text AS due
      FROM bikes b
      JOIN LATERAL (
        SELECT next_service_date FROM bike_services
        WHERE bike_id = b.id AND client_id = b.client_id
        ORDER BY service_date DESC, id DESC LIMIT 1
      ) s ON true
      WHERE b.client_id = ${clientId} AND b.active = true
        AND s.next_service_date IS NOT NULL AND s.next_service_date <= ${horizon}::date
    `)))) {
    push({
      id: `bike-service:${row.id}`, module: "bike", siteId: num(row.site_id), title: `Service: ${row.name}`,
      dueDate: day(row.due)!, kind: "due", assigneeUserId: null, assigneeName: null,
    });
  }

  // Staff training: each person's latest record of each training sets the
  // expiry, so a renewed certificate stops the old one being reminded.
  for (const row of await source(clientId, "training", async () => rowsOf<{ id: number; staff_name: string; title: string; site_id: number | null; due: string }>(
    await db.execute(sql`
      SELECT id, staff_name, title, site_id, expiry_date::text AS due FROM (
        SELECT DISTINCT ON (COALESCE(staff_roster_id::text, lower(trim(staff_name))), lower(COALESCE(training_type, document_title, '')))
          id, staff_name, COALESCE(training_type, document_title, 'Training') AS title, site_id, expiry_date
        FROM train_track_records
        WHERE client_id = ${clientId}
        ORDER BY COALESCE(staff_roster_id::text, lower(trim(staff_name))), lower(COALESCE(training_type, document_title, '')),
          completed_date DESC, id DESC
      ) latest
      WHERE expiry_date IS NOT NULL AND expiry_date <= ${horizon}::date
    `)))) {
    push({
      id: `training:${row.id}`, module: "train", siteId: num(row.site_id), title: `${row.title} (${row.staff_name})`,
      dueDate: day(row.due)!, kind: "expiry", leadDays: TRAINING_EXPIRY_LEAD_DAYS,
      assigneeUserId: null, assigneeName: null,
    });
  }

  // Contractor insurance, DBS/PVG and certificates.
  const leadDays = await contractorLeadDays(clientId).catch(() => DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS);
  for (const row of await source(clientId, "contractors", async () => rowsOf<{
    id: number; name: string; insurance: string | null; dbs_type: string | null; dbs: string | null;
  }>(await db.execute(sql`
    SELECT id, name, public_liability_expiry::date::text AS insurance, dbs_type, dbs_expiry_date::date::text AS dbs
    FROM contractors WHERE client_id = ${clientId}
  `)))) {
    if (row.insurance && row.insurance <= horizon) {
      push({
        id: `contractor-insurance:${row.id}`, module: CONTRACTORS_MODULE, siteId: null,
        title: `${row.name}: public liability insurance`, dueDate: day(row.insurance)!, kind: "expiry", leadDays,
        assigneeUserId: null, assigneeName: null, linkPath: `/contractors/${row.id}`,
      });
    }
    if (row.dbs && row.dbs_type !== "None" && row.dbs <= horizon) {
      push({
        id: `contractor-dbs:${row.id}`, module: CONTRACTORS_MODULE, siteId: null,
        title: `${row.name}: ${row.dbs_type ?? "DBS/PVG check"}`, dueDate: day(row.dbs)!, kind: "expiry", leadDays,
        assigneeUserId: null, assigneeName: null, linkPath: `/contractors/${row.id}`,
      });
    }
  }
  for (const row of await source(clientId, "contractor certificates", async () => rowsOf<{
    id: number; contractor_id: number; contractor_name: string; certificate_name: string; due: string;
  }>(await db.execute(sql`
    SELECT cc.id, cc.contractor_id, c.name AS contractor_name, cc.certificate_name, cc.expiry_date::date::text AS due
    FROM contractor_certificates cc
    JOIN contractors c ON c.id = cc.contractor_id AND c.client_id = cc.client_id
    WHERE cc.client_id = ${clientId} AND cc.expiry_date IS NOT NULL AND cc.expiry_date::date <= ${horizon}::date
  `)))) {
    push({
      id: `contractor-cert:${row.id}`, module: CONTRACTORS_MODULE, siteId: null,
      title: `${row.contractor_name}: ${row.certificate_name} certificate`, dueDate: day(row.due)!, kind: "expiry", leadDays,
      assigneeUserId: null, assigneeName: null, linkPath: `/contractors/${row.contractor_id}`,
    });
  }

  // Urgent FixTrack issues raised since yesterday's reminders.
  if (entitledTo(services, "fix")) {
    for (const row of await source(clientId, "urgent fixtrack", async () => rowsOf<{
      id: number; title: string; site_id: number | null; location: string | null; raised: string; assignee_user_id: number | null;
    }>(await db.execute(sql`
      SELECT id, title, site_id, location, created_at::date::text AS raised, assignee_user_id
      FROM fix_track_issues
      WHERE client_id = ${clientId} AND priority = 'urgent' AND status IN ('reported', 'in_progress')
        AND created_at >= ${new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()}::timestamptz
    `)))) {
      urgent.push({
        id: `urgent-fix:${row.id}`, module: "fix", trackLabel: moduleLabel("fix"), siteId: num(row.site_id),
        siteName: siteName(num(row.site_id)), title: row.title,
        detail: `Urgent FixTrack issue${row.location ? ` at ${row.location}` : ""}`,
        raisedOn: day(row.raised)!, assigneeUserId: num(row.assignee_user_id), linkPath: `/fix-track/${row.id}`,
      });
    }
  }

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.trackLabel.localeCompare(b.trackLabel) || a.title.localeCompare(b.title));
  return { items, urgent };
}

/** Who is responsible for an item, and whether anyone has been given it. */
export interface Responsibility {
  /** Users to email. Empty for a group task (bell only). */
  userIds: number[];
  /** Users whose bell gets a group task. */
  bellUserIds: number[];
  /** Shown as "who has it": the person's name, the typed name, or the track owner. */
  holder: string | null;
  /** Nobody picked and no track owner set: it fell back to the Owners. */
  unassigned: boolean;
}

export interface ResponsibilityContext extends OwnerContext {
  /** Active Owners (client admins) of the business. */
  ownerIds: number[];
  /** Active Maintenance managers. */
  maintenanceManagerIds: number[];
}

export async function loadResponsibilityContext(clientId: number): Promise<ResponsibilityContext> {
  const ctx = await loadOwnerContext(clientId);
  const managers = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT id FROM users
    WHERE client_id = ${clientId} AND active = true AND is_maintenance_manager = true
      AND role IN ('client_admin', 'client_manager', 'client_staff')
    ORDER BY id
  `)).map((row) => Number(row.id)).filter((id) => ctx.eligible.has(id));
  const ownerIds = [...ctx.eligible.values()].filter((user) => user.role === "client_admin").map((user) => user.id);
  return { ...ctx, ownerIds, maintenanceManagerIds: managers };
}

function canSee(ctx: OwnerContext, userId: number, siteId: number | null): boolean {
  const candidate = ctx.eligible.get(userId);
  if (!candidate) return false;
  return siteId == null || candidateCanSeeSite(candidate, ctx.siteDepartments.get(siteId), siteId);
}

/** The business's Owners, or (with none) its admins and consultants. */
function ownersOf(ctx: ResponsibilityContext): number[] {
  return ctx.ownerIds.length ? ctx.ownerIds : ctx.fallback;
}

export function responsibleFor(ctx: ResponsibilityContext, item: Pick<DueItem, "module" | "siteId" | "assigneeUserId" | "assigneeName" | "groupRole">): Responsibility {
  const name = (userId: number) => ctx.eligible.get(userId)?.name ?? null;
  if (item.assigneeUserId != null && canSee(ctx, item.assigneeUserId, item.siteId)) {
    return { userIds: [item.assigneeUserId], bellUserIds: [], holder: name(item.assigneeUserId), unassigned: false };
  }
  if (item.groupRole) {
    const members = [...ctx.eligible.values()].filter((user) => (item.groupRole === "client_staff"
      ? user.role === "client_staff"
      : user.role === "client_admin" || user.role === "client_manager") && canSee(ctx, user.id, item.siteId));
    return {
      userIds: [], bellUserIds: members.map((user) => user.id),
      holder: item.groupRole === "client_staff" ? "All staff" : "Managers", unassigned: false,
    };
  }
  const typed = item.assigneeName?.trim() || null;
  if (item.module === CONTRACTORS_MODULE) {
    const managers = ctx.maintenanceManagerIds.filter((id) => canSee(ctx, id, null));
    if (managers.length) return { userIds: managers, bellUserIds: [], holder: managers.map(name).filter(Boolean).join(", ") || null, unassigned: false };
    return { userIds: ownersOf(ctx), bellUserIds: [], holder: typed, unassigned: true };
  }
  if (getTrackModule(item.module) && hasExplicitOwner(ctx, item.module, item.siteId)) {
    const owners = resolveOwnersFromContext(ctx, item.module, item.siteId);
    const fellBack = owners.length === ctx.fallback.length && owners.every((id, index) => id === ctx.fallback[index]);
    if (!fellBack) return { userIds: owners, bellUserIds: [], holder: typed ?? owners.map(name).filter(Boolean).join(", "), unassigned: false };
  }
  // A typed name with no account: shown as the holder, reminded through the Owners.
  return { userIds: ownersOf(ctx), bellUserIds: [], holder: typed, unassigned: typed == null };
}

/**
 * Who chases a certificate still to come after a contractor visit: the person
 * assigned to the check, else the Maintenance managers who can see its site,
 * else its Managers, else the Owners.
 */
export function responsibleForCertificate(ctx: ResponsibilityContext, item: { siteId: number | null; assigneeUserId: number | null }): number[] {
  if (item.assigneeUserId != null && canSee(ctx, item.assigneeUserId, item.siteId)) return [item.assigneeUserId];
  const maintenance = ctx.maintenanceManagerIds.filter((id) => canSee(ctx, id, item.siteId));
  if (maintenance.length) return maintenance;
  const managers = [...ctx.eligible.values()]
    .filter((user) => user.role === "client_manager" && canSee(ctx, user.id, item.siteId)).map((user) => user.id);
  return managers.length ? managers : ownersOf(ctx);
}
