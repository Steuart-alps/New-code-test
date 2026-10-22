import { db } from "@workspace/db";
import { departmentsTable, userDepartmentsTable, usersTable } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { escapeHtml, getPublicAppUrl, sendEmail } from "./email";
import { getNotificationEmails } from "./getNotificationEmails";
import { logger } from "./logger";
import { sendPushToUsers } from "./pushNotifications";
import { getEntitledServices, isEntitled, type ServiceKey } from "./services";

export interface ReminderAction {
  module: string;
  title: string;
  owner_name: string | null;
  due_date: string | null;
  severity: "monitor" | "action_required" | "urgent";
  site_id?: number | null;
  site_department_id?: number | null;
}

export interface TrackSummaryManager {
  id: number;
  email: string;
  name?: string;
  departmentId?: number | null;
  role?: string;
  isDepartmentManager?: boolean;
  isMaintenanceManager?: boolean;
  /** A Manager's extra departments (beyond departmentId). */
  extraDepartmentIds?: number[];
  /** A Manager who covers every department. */
  allDepartments?: boolean;
  /** Department id -> site, for departments that sit under a site. */
  departmentSiteIds?: Record<number, number>;
}

/** Whether a summary recipient covers a department (Managers may cover several, or all). */
function managerCovers(manager: TrackSummaryManager, departmentId: number): boolean {
  if (manager.role === "client_manager" && manager.allDepartments) return true;
  return manager.departmentId === departmentId
    || (manager.role === "client_manager" && (manager.extraDepartmentIds ?? []).includes(departmentId));
}

/**
 * Whether a summary recipient sees an action's site: one of their departments
 * covers it when the site is shared or that department's, and the department
 * does not sit under another site.
 */
function managerCoversSite(manager: TrackSummaryManager, siteId: number | null, siteDepartmentId: number | null): boolean {
  if (manager.role === "client_manager" && manager.allDepartments) return true;
  const departmentIds = [manager.departmentId ?? null, ...(manager.role === "client_manager" ? manager.extraDepartmentIds ?? [] : [])];
  return departmentIds.some((departmentId) => {
    if (siteDepartmentId != null && departmentId !== siteDepartmentId) return false;
    const departmentSite = departmentId == null ? undefined : manager.departmentSiteIds?.[departmentId];
    return departmentSite == null || departmentSite === siteId;
  });
}

export interface TrackSummaryRecipient {
  email: string;
  userIds: number[];
  actions: ReminderAction[];
  modules: string[];
}

export type TrackSummaryRouting = Record<string, {
  managerIds: number[];
  departmentIds: number[];
}>;

export interface TrackActionReminderResult {
  clientsChecked: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

/** Injectable dependencies keep the daily job focused and straightforward to test. */
export interface TrackActionReminderDependencies {
  send?: typeof sendEmail;
  sendPush?: typeof sendPushToUsers;
  /** Optional internal batch scope; omitted by the production scheduler. */
  clientIds?: readonly number[];
}

function formatDate(value: string | null): string {
  if (!value) return "No due date";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const moduleRoutes: Record<string, string> = {
  daily_am: "/daily-track-am",
  daily_pm: "/daily-track-pm",
  kitchen: "/kitchen",
  fire: "/fire-safety",
  legionella: "/legionella",
  pool: "/aqua-track",
  pat: "/pat-track",
  pest: "/pest-track",
  fix: "/fix-track",
  premises: "/premises-track",
  doc: "/doc-track",
  safe: "/safe-track",
  train: "/train-track",
  hot_tub: "/hot-tub",
  tree: "/tree-track",
  bike: "/bike-track",
  green: "/green-track",
  swim: "/swim-track",
  incident: "/incidents",
  room: "/room-track",
  coshh: "/coshh-track",
  audit: "/report-actions",
};

const moduleLabels: Record<string, string> = {
  daily_am: "DailyTrack AM",
  daily_pm: "DailyTrack PM",
  kitchen: "KitchenTrack",
  fire: "FireTrack",
  legionella: "LegionellaTrack",
  pool: "AquaTrack",
  pat: "PATtrack",
  pest: "PestTrack",
  fix: "FixTrack",
  premises: "PremisesTrack",
  doc: "DocTrack",
  safe: "SafeTrack",
  train: "TrainTrack",
  hot_tub: "TubTrack",
  tree: "TreeTrack",
  bike: "BikeTrack",
  green: "GreenTrack",
  swim: "SwimTrack",
  incident: "IncidentTrack",
  room: "RoomTrack",
  coshh: "COSHHTrack",
  audit: "Report actions",
};

const moduleServices: Record<string, ServiceKey[]> = {
  daily_am: ["dailytrack_am", "kitchentrack", "premisestrack"],
  daily_pm: ["dailytrack_pm", "kitchentrack", "premisestrack"],
  kitchen: ["kitchentrack"], fire: ["firetrack"], legionella: ["legionellatrack"],
  pool: ["aquatrack", "pooltrack"], pat: ["pattrack"], pest: ["pesttrack"],
  fix: ["fixtrack"], premises: ["premisestrack"], doc: ["doctrack", "safetrack"],
  safe: ["safetrack"], train: ["traintrack"], hot_tub: ["hottubtrack"],
  tree: ["treetrack"], bike: ["biketrack"], green: ["greentrack"],
  swim: ["aquatrack", "swimtrack"], incident: ["incidenttrack"], room: ["roomtrack"],
  coshh: ["coshhtrack"], audit: ["core"],
};

// Applied only when an account has not explicitly set recipients for a track.
// A department with no eligible staff simply leaves senior management as fallback.
const defaultDepartments: Record<string, RegExp> = {
  daily_am: /kitchen|cater|premises|facilit|operations/i,
  daily_pm: /kitchen|cater|premises|facilit|operations/i,
  kitchen: /kitchen|cater|food/i,
  fire: /maintenance|facilit|safety/i,
  legionella: /maintenance|facilit|water/i,
  pool: /pool|leisure|maintenance/i,
  pat: /maintenance|facilit/i,
  pest: /housekeeping|maintenance|facilit/i,
  fix: /maintenance|facilit/i,
  premises: /maintenance|facilit|housekeeping/i,
  doc: /operations|admin|safety/i,
  safe: /safety|operations/i,
  train: /training|people|human.resources|operations/i,
  hot_tub: /housekeeping|maintenance|leisure|pool/i,
  tree: /grounds|maintenance|facilit/i,
  bike: /leisure|maintenance|facilit/i,
  green: /grounds|maintenance|facilit/i,
  swim: /leisure|pool/i,
  incident: /safety|operations/i,
  room: /housekeeping|maintenance/i,
  coshh: /safety|housekeeping|cleaning|maintenance|facilit/i,
  audit: /safety|operations|maintenance|facilit/i,
};

export function effectiveTrackRouting(
  routing: TrackSummaryRouting,
  departments: Array<{ id: number; name: string }>,
  modules: string[],
): TrackSummaryRouting {
  return Object.fromEntries(modules.map((module) => [
    module,
    Object.hasOwn(routing, module) ? routing[module] : {
      managerIds: [],
      departmentIds: departments.filter((department) =>
        defaultDepartments[module]?.test(department.name)).map((department) => department.id),
    },
  ]));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** One manager who receives a track, and why. */
export interface TrackModuleAssignee {
  manager: TrackSummaryManager;
  /** Picked by name for this track. */
  named: boolean;
  /** A Manager, or a designated manager, of one of the track's departments. */
  viaDepartment: boolean;
}

/** Whether a recipient receives department matches: Managers, and staff or Owners flagged as a department or maintenance manager. */
function receivesDepartmentMatches(manager: TrackSummaryManager): boolean {
  return manager.role === "client_manager" || !!manager.isDepartmentManager || !!manager.isMaintenanceManager;
}

/**
 * The managers (besides senior management) who receive one track's summary.
 * Named assignments come first, then department managers. Ids that do not
 * resolve to an eligible manager are skipped. The daily job and the settings
 * preview both read recipients from here.
 */
export function resolveTrackModuleManagers(
  assignment: { managerIds: number[]; departmentIds: number[] } | undefined,
  configuredManagers: TrackSummaryManager[],
): TrackModuleAssignee[] {
  const { managerIds, departmentIds } = assignment ?? { managerIds: [], departmentIds: [] };
  const managersById = new Map(configuredManagers.map((manager) => [manager.id, manager]));
  const assignees = new Map<number, TrackModuleAssignee>();
  for (const id of managerIds) {
    const manager = managersById.get(id);
    if (manager) assignees.set(id, { manager, named: true, viaDepartment: false });
  }
  for (const manager of configuredManagers) {
    if (departmentIds.some((departmentId) => managerCovers(manager, departmentId)) && receivesDepartmentMatches(manager)) {
      const existing = assignees.get(manager.id);
      if (existing) existing.viaDepartment = true;
      else assignees.set(manager.id, { manager, named: false, viaDepartment: true });
    }
  }
  return [...assignees.values()];
}

/** Pure recipient grouping used by the job and focused routing tests. */
export function buildTrackSummaryRecipients(
  actions: ReminderAction[],
  seniorEmails: string[],
  seniorUsers: TrackSummaryManager[],
  configuredManagers: TrackSummaryManager[],
  routing: TrackSummaryRouting,
  modules: string[] = [...new Set(actions.map((action) => action.module))],
): TrackSummaryRecipient[] {
  const groups = new Map<string, { email: string; userIds: Set<number>; actions: Set<ReminderAction>; modules: Set<string> }>();
  const ensureGroup = (email: string) => {
    const key = normalizeEmail(email);
    if (!groups.has(key)) {
      groups.set(key, { email: email.trim(), userIds: new Set(), actions: new Set(), modules: new Set() });
    }
    return groups.get(key)!;
  };

  for (const email of seniorEmails.filter(Boolean)) {
    const group = ensureGroup(email);
    modules.forEach((module) => group.modules.add(module));
    actions.forEach((action) => group.actions.add(action));
  }
  for (const user of seniorUsers) {
    const group = groups.get(normalizeEmail(user.email));
    if (group) group.userIds.add(user.id);
  }

  for (const module of modules) {
    for (const { manager } of resolveTrackModuleManagers(routing[module], configuredManagers)) {
      const group = ensureGroup(manager.email);
      group.userIds.add(manager.id);
      group.modules.add(module);
      for (const action of actions) {
        if (action.module !== module) continue;
        // Staff see unassigned sites and their own department's sites, never
        // another department's action, and only their department's own site
        // when it sits under one. Admins retain their normal global view.
        if (manager.role !== "client_admin" && (action.site_department_id != null || action.site_id != null) &&
            !managerCoversSite(manager, action.site_id ?? null, action.site_department_id ?? null)) continue;
        group.actions.add(action);
      }
    }
  }

  return [...groups.values()]
    .filter((group) => group.modules.size > 0)
    .map((group) => ({
      email: group.email,
      userIds: [...group.userIds],
      actions: [...group.actions],
      modules: [...group.modules],
    }));
}

export function parseTrackSummaryRouting(value: unknown): TrackSummaryRouting {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([module]) => Object.hasOwn(moduleRoutes, module))
      .map(([module, entry]) => {
        const value = Array.isArray(entry) ? { managerIds: entry, departmentIds: [] } : entry;
        const ids = (raw: unknown) => Array.isArray(raw)
          ? [...new Set(raw.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))]
          : [];
        return [module, {
          managerIds: ids((value as any)?.managerIds),
          departmentIds: ids((value as any)?.departmentIds),
        }];
      }));
  } catch {
    return {};
  }
}

/** The tracks an account's plan includes, in digest order. */
export function enabledTrackSummaryModules(services: Awaited<ReturnType<typeof getEntitledServices>>): string[] {
  return Object.keys(moduleRoutes).filter((module) =>
    moduleServices[module]?.some((key) => isEntitled(services, key)));
}

/** Everything the routing needs for one client, loaded from that client's rows only. */
export interface TrackSummaryRoutingContext {
  modules: string[];
  seniorEmails: string[];
  seniorSource: "notification_email" | "users";
  seniorUsers: TrackSummaryManager[];
  configuredManagers: TrackSummaryManager[];
  departments: Array<{ id: number; name: string }>;
  /** The saved per-track choices; a track absent here uses automatic matching. */
  routing: TrackSummaryRouting;
  effectiveRouting: TrackSummaryRouting;
}

export async function loadTrackSummaryStoredRouting(clientId: number): Promise<TrackSummaryRouting> {
  const routingResult = await db.execute(sql`
    SELECT value FROM app_settings
    WHERE client_id = ${clientId} AND key = 'trackSummaryRouting'
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  return parseTrackSummaryRouting(((routingResult as any).rows ?? [])[0]?.value);
}

/**
 * Loads the recipients' inputs for one client. `routing` replaces the saved
 * choices, so Settings can preview unsaved edits through the same path the
 * daily job sends with.
 */
export async function loadTrackSummaryRoutingContext(
  clientId: number,
  options: { routing?: TrackSummaryRouting } = {},
): Promise<TrackSummaryRoutingContext> {
  const modules = enabledTrackSummaryModules(await getEntitledServices(clientId));
  const { emails: seniorEmails, userIds: seniorUserIds, source: seniorSource } = await getNotificationEmails(clientId);
  const routing = options.routing ?? await loadTrackSummaryStoredRouting(clientId);
  const departments = await db.select({ id: departmentsTable.id, name: departmentsTable.name, siteId: departmentsTable.siteId })
    .from(departmentsTable).where(eq(departmentsTable.clientId, clientId));
  const departmentSiteIds = Object.fromEntries(departments
    .filter((department) => department.siteId != null)
    .map((department) => [department.id, department.siteId!]));
  const users = await db
    .select({
      id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role,
      departmentId: usersTable.departmentId,
      isDepartmentManager: usersTable.isDepartmentManager,
      isMaintenanceManager: usersTable.isMaintenanceManager,
      allDepartments: usersTable.allDepartments,
    })
    .from(usersTable)
    .where(and(eq(usersTable.clientId, clientId), eq(usersTable.active, true)));
  const extras = users.length
    ? await db.select().from(userDepartmentsTable).where(inArray(userDepartmentsTable.userId, users.map((user) => user.id)))
    : [];
  const seniorUsers = users
    .filter((user) => seniorUserIds.includes(user.id))
    .map(({ id, email, name }) => ({ id, email, name }));
  const configuredManagers = users
    .filter((user) => user.role === "client_admin" || user.role === "client_manager" || user.role === "client_staff")
    .map(({ id, email, name, departmentId, role, isDepartmentManager, isMaintenanceManager, allDepartments }) => ({
      id, email, name, departmentId, role, isDepartmentManager, isMaintenanceManager, allDepartments,
      extraDepartmentIds: extras.filter((extra) => extra.userId === id).map((extra) => extra.departmentId),
      departmentSiteIds,
    }));
  return {
    modules,
    seniorEmails,
    seniorSource,
    seniorUsers,
    configuredManagers,
    departments: departments.map(({ id, name }) => ({ id, name })),
    routing,
    effectiveRouting: effectiveTrackRouting(routing, departments, modules),
  };
}

export interface TrackSummaryPreviewPerson {
  userId: number | null;
  name: string | null;
  email: string;
  /** The person's department, or "All departments" for a Manager who covers every one. */
  departmentName: string | null;
}

export interface TrackSummaryPreviewTrack {
  module: string;
  label: string;
  /** False when the account's plan does not include the track; nothing is sent for it. */
  enabled: boolean;
  /** "automatic": departments matched by name. "custom": the admin's saved or draft choices. */
  mode: "automatic" | "custom";
  /** Matched or chosen departments and their managers (empty = no eligible manager). */
  departments: Array<{ id: number; name: string; managers: TrackSummaryPreviewPerson[] }>;
  /** Managers picked by name who will receive the track. */
  namedManagers: TrackSummaryPreviewPerson[];
  /** Named picks that no longer match an active Owner, Manager or staff account; they are skipped. */
  unavailableNamedCount: number;
  /** True when no department or named manager receives it, so only senior management does. */
  seniorOnly: boolean;
  /** The exact addresses the daily job would email for this track, de-duplicated. */
  recipients: Array<TrackSummaryPreviewPerson & { via: Array<"senior" | "named" | "department"> }>;
}

export interface TrackSummaryPreview {
  senior: { source: "notification_email" | "users"; recipients: TrackSummaryPreviewPerson[] };
  tracks: TrackSummaryPreviewTrack[];
}

/**
 * Describes who receives each track. The recipient list is taken from
 * buildTrackSummaryRecipients and resolveTrackModuleManagers, the functions
 * the daily job sends with, so the preview cannot name someone the job would
 * not email (or miss someone it would).
 */
export function buildTrackSummaryPreview(context: TrackSummaryRoutingContext): TrackSummaryPreview {
  const departmentName = new Map(context.departments.map((department) => [department.id, department.name]));
  const person = (manager: TrackSummaryManager): TrackSummaryPreviewPerson => {
    const names = manager.role === "client_manager" && manager.allDepartments
      ? ["All departments"]
      : [manager.departmentId, ...(manager.role === "client_manager" ? manager.extraDepartmentIds ?? [] : [])]
        .filter((id): id is number => id != null && departmentName.has(id))
        .map((id) => departmentName.get(id)!);
    return {
      userId: manager.id,
      name: manager.name ?? null,
      email: manager.email,
      departmentName: names.length ? [...new Set(names)].join(", ") : null,
    };
  };
  const usersByEmail = new Map<string, TrackSummaryManager>();
  for (const user of [...context.configuredManagers, ...context.seniorUsers]) {
    usersByEmail.set(normalizeEmail(user.email), { ...usersByEmail.get(normalizeEmail(user.email)), ...user });
  }
  const seniorPerson = (email: string): TrackSummaryPreviewPerson => {
    const user = usersByEmail.get(normalizeEmail(email));
    return user ? person(user) : { userId: null, name: null, email: email.trim(), departmentName: null };
  };
  const seniorKeys = new Set(context.seniorEmails.filter(Boolean).map(normalizeEmail));

  const sending = buildTrackSummaryRecipients(
    [], context.seniorEmails, context.seniorUsers, context.configuredManagers,
    context.effectiveRouting, context.modules,
  );

  const tracks = Object.keys(moduleRoutes).map((module): TrackSummaryPreviewTrack => {
    const enabled = context.modules.includes(module);
    const assignment = context.effectiveRouting[module]
      ?? effectiveTrackRouting(context.routing, context.departments, [module])[module];
    const assignees = resolveTrackModuleManagers(assignment, context.configuredManagers);
    const eligibleIds = new Set(context.configuredManagers.map((manager) => manager.id));
    const departments = assignment.departmentIds
      .filter((id) => departmentName.has(id))
      .map((id) => ({
        id,
        name: departmentName.get(id)!,
        managers: assignees
          .filter((assignee) => assignee.viaDepartment && managerCovers(assignee.manager, id))
          .map((assignee) => person(assignee.manager)),
      }));
    const viaByEmail = new Map<string, Set<"senior" | "named" | "department">>();
    const addVia = (email: string, via: "senior" | "named" | "department") => {
      const key = normalizeEmail(email);
      if (!viaByEmail.has(key)) viaByEmail.set(key, new Set());
      viaByEmail.get(key)!.add(via);
    };
    for (const assignee of assignees) {
      if (assignee.named) addVia(assignee.manager.email, "named");
      if (assignee.viaDepartment) addVia(assignee.manager.email, "department");
    }
    seniorKeys.forEach((key) => addVia(key, "senior"));
    const recipients = enabled
      ? sending
        .filter((recipient) => recipient.modules.includes(module))
        .map((recipient) => ({
          ...seniorPerson(recipient.email),
          email: recipient.email,
          via: [...(viaByEmail.get(normalizeEmail(recipient.email)) ?? [])],
        }))
      : [];
    return {
      module,
      label: moduleLabels[module] ?? module,
      enabled,
      mode: Object.hasOwn(context.routing, module) ? "custom" : "automatic",
      departments,
      namedManagers: assignees.filter((assignee) => assignee.named).map((assignee) => person(assignee.manager)),
      unavailableNamedCount: assignment.managerIds.filter((id) => !eligibleIds.has(id)).length,
      seniorOnly: assignees.length === 0,
      recipients,
    };
  });

  return {
    senior: { source: context.seniorSource, recipients: context.seniorEmails.filter(Boolean).map(seniorPerson) },
    tracks,
  };
}

/** Resolve the destination for an action module, retaining a safe dashboard fallback. */
export function trackActionModuleUrl(module: string, appUrl = getPublicAppUrl()): string {
  return `${appUrl.replace(/\/+$/, "")}${moduleRoutes[module] ?? "/dashboard"}`;
}

export function buildTrackActionDigest(
  actions: ReminderAction[], appUrl = getPublicAppUrl(),
  modules: string[] = [...new Set(actions.map((action) => action.module))],
) {
  const summaries = modules.map((module) => {
    const count = actions.filter((action) => action.module === module).length;
    const href = escapeHtml(trackActionModuleUrl(module, appUrl));
    return `<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><a href="${href}">${escapeHtml(moduleLabels[module] ?? module)}</a></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${count === 0 ? "No outstanding actions" : `${count} outstanding action${count === 1 ? "" : "s"}`}</td></tr>`;
  }).join("");
  const rows = actions.map((action) => {
    const href = escapeHtml(trackActionModuleUrl(action.module, appUrl));
    return `
    <tr>
       <td style="padding:10px;border-bottom:1px solid #e2e8f0;"><a href="${href}">${escapeHtml(moduleLabels[action.module] ?? action.module)}</a></td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;"><a href="${href}">${escapeHtml(action.title)}</a></td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(action.owner_name || "Unassigned")}</td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatDate(action.due_date))}</td>
    </tr>`;
  }).join("");
  const count = actions.length;
  return {
    subject: `Daily track summary: ${modules.length} track${modules.length === 1 ? "" : "s"}, ${count} action${count === 1 ? "" : "s"}`,
    text: [`Track summary:`, ...modules.map((module) =>
      `${moduleLabels[module] ?? module}: ${actions.filter((action) => action.module === module).length} outstanding — ${trackActionModuleUrl(module, appUrl)}`),
      "", "Outstanding actions:", ...actions.map((a) =>
      `[${moduleLabels[a.module] ?? a.module}] ${a.title} — owner: ${a.owner_name || "Unassigned"} — due: ${formatDate(a.due_date)}\n${trackActionModuleUrl(a.module, appUrl)}`
    )].join("\n"),
    html: `<div style="font-family:Arial,sans-serif;color:#1e293b;max-width:720px">
      <h2>Daily track summary</h2>
      <p>${modules.length} track${modules.length === 1 ? "" : "s"} · ${count} unresolved action${count === 1 ? "" : "s"}.</p>
      <table style="border-collapse:collapse;width:100%"><thead><tr><th align="left">Track</th><th align="left">Status</th></tr></thead><tbody>${summaries}</tbody></table>
      ${count > 0 ? `<h3>Outstanding actions</h3>` : ""}
      <table style="border-collapse:collapse;width:100%"><thead><tr>
        <th align="left" style="padding:10px">Module</th><th align="left" style="padding:10px">Action</th>
        <th align="left" style="padding:10px">Owner</th><th align="left" style="padding:10px">Due</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`,
  };
}

interface DeliveryClaim {
  id: number;
  token: string;
  logDate: string;
}

/** The conflict clause is the lease: only a failed or expired recipient can be retried. */
export async function claimTrackSummaryDelivery(
  clientId: number, email: string, logDate?: string,
): Promise<DeliveryClaim | null> {
  const token = randomUUID();
  const claim = await db.execute(sql`
    INSERT INTO track_summary_delivery
      (client_id, log_date, email, claim_token, claimed_at)
    VALUES (${clientId}, COALESCE(${logDate ?? null}::date, CURRENT_DATE), ${normalizeEmail(email)}, ${token}, now())
    ON CONFLICT (client_id, log_date, email) DO UPDATE
      SET claim_token = EXCLUDED.claim_token, claimed_at = now()
    WHERE track_summary_delivery.sent_at IS NULL
      AND track_summary_delivery.claimed_at < now() - interval '15 minutes'
    RETURNING id, log_date::text AS log_date
  `);
  const row = claim.rows[0];
  return row ? { id: row.id as number, token, logDate: row.log_date as string } : null;
}

export async function markTrackSummaryDelivered(claim: DeliveryClaim): Promise<void> {
  await db.execute(sql`
    UPDATE track_summary_delivery SET sent_at = now(), claim_token = NULL
    WHERE id = ${claim.id} AND claim_token = ${claim.token}
  `);
}

export async function releaseTrackSummaryDelivery(claim: DeliveryClaim): Promise<void> {
  await db.execute(sql`
    DELETE FROM track_summary_delivery
    WHERE id = ${claim.id} AND claim_token = ${claim.token} AND sent_at IS NULL
  `);
}

/** Send one combined digest per recipient per day, with a reclaimable lease. */
export async function runTrackActionReminderJob(
  deps: TrackActionReminderDependencies = {},
): Promise<TrackActionReminderResult> {
  const send = deps.send ?? sendEmail;
  const sendPush = deps.sendPush ?? sendPushToUsers;
  const result: TrackActionReminderResult = { clientsChecked: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };
  if (deps.clientIds?.length === 0) return result;
  const clients = await db.execute(deps.clientIds === undefined
    ? sql`SELECT id FROM clients WHERE active = true`
    : sql`SELECT id FROM clients WHERE active = true AND id IN (${sql.join(deps.clientIds.map((id) => sql`${id}`), sql`, `)})`);

  for (const client of ((clients as any).rows ?? []) as Array<{ id: number }>) {
    result.clientsChecked++;
    try {
      const context = await loadTrackSummaryRoutingContext(client.id);
      const { modules } = context;
      if (modules.length === 0) continue;
      const actionsResult = await db.execute(sql`
        SELECT a.module, a.title, a.owner_name, a.due_date, a.severity,
               a.site_id, s.department_id AS site_department_id
        FROM track_actions a
        LEFT JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
        WHERE a.client_id = ${client.id}
          AND (a.site_id IS NULL OR s.id IS NOT NULL)
          AND a.status <> 'resolved'
          AND (
            a.severity IN ('action_required', 'urgent')
            OR (a.severity = 'monitor' AND (a.due_date IS NULL OR a.due_date <= CURRENT_DATE))
          )
        ORDER BY
          CASE a.severity WHEN 'urgent' THEN 0 WHEN 'action_required' THEN 1 ELSE 2 END,
          a.due_date ASC NULLS FIRST, a.created_at ASC
      `);
      const actions = (((actionsResult as any).rows ?? []) as ReminderAction[])
        .filter((action) => modules.includes(action.module));

      const recipients = buildTrackSummaryRecipients(
        actions,
        context.seniorEmails,
        context.seniorUsers,
        context.configuredManagers,
        context.effectiveRouting,
        modules,
      );
      if (recipients.length === 0) continue;

      // On the day of an upgrade, honour a completed legacy client-wide send
      // until the next day instead of sending a second digest.
      const legacy = await db.execute(sql`
        SELECT 1 FROM track_action_reminder_log old
        WHERE old.client_id = ${client.id} AND old.log_date = CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM track_summary_delivery d
            WHERE d.client_id = ${client.id} AND d.log_date = CURRENT_DATE
          )
        LIMIT 1
      `);
      if (legacy.rows.length > 0) continue;

      let sentCount = 0;
      let failedCount = 0;
      for (const recipient of recipients) {
        const claim = await claimTrackSummaryDelivery(client.id, recipient.email);
        if (!claim) continue;
        const digest = buildTrackActionDigest(recipient.actions, getPublicAppUrl(), recipient.modules);
        try {
          await send({
            to: recipient.email,
            subject: digest.subject,
            html: digest.html,
            text: digest.text,
            clientId: client.id,
            idempotencyKey: `track-summary-${client.id}-${claim.logDate}-${createHash("sha256").update(normalizeEmail(recipient.email)).digest("hex").slice(0, 24)}`,
          });
        } catch (err) {
          failedCount++;
          logger.error({ err, clientId: client.id, recipient: recipient.email }, "Track summary email delivery failed");
          await releaseTrackSummaryDelivery(claim);
          continue;
        }
        // An accepted email must not be released if only the database update
        // fails. Leave its lease for an idempotent retry after recovery.
        try {
          await markTrackSummaryDelivered(claim);
          sentCount++;
          try {
            await sendPush(recipient.userIds, {
              title: "Daily track summary",
              body: `${recipient.modules.length} track${recipient.modules.length === 1 ? "" : "s"} · ${recipient.actions.length} outstanding action${recipient.actions.length === 1 ? "" : "s"}.`,
              data: { route: "/track-actions" },
            });
          } catch (err) {
            logger.warn({ err, clientId: client.id, recipient: recipient.email }, "Track action reminder push failed");
          }
        } catch (err) {
          failedCount++;
          logger.error({ err, clientId: client.id, recipient: recipient.email }, "Track summary delivered but could not finalize its claim");
        }
      }
      if (sentCount > 0) result.clientsEmailed++;
      result.emailsSent += sentCount;
      result.errors += failedCount;
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Track action reminder failed");
    }
  }
  return result;
}
