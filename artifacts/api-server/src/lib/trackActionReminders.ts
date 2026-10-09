import { db } from "@workspace/db";
import { departmentsTable, usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
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
  site_department_id?: number | null;
}

export interface TrackSummaryManager {
  id: number;
  email: string;
  departmentId?: number | null;
  role?: string;
  isDepartmentManager?: boolean;
  isMaintenanceManager?: boolean;
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

  const managersById = new Map(configuredManagers.map((manager) => [manager.id, manager]));
  for (const module of modules) {
    const assignment = routing[module] ?? { managerIds: [], departmentIds: [] };
    const assignedIds = new Set(assignment.managerIds);
    for (const manager of configuredManagers) {
      if (manager.departmentId != null && assignment.departmentIds.includes(manager.departmentId) &&
          (manager.isDepartmentManager || manager.isMaintenanceManager)) {
        assignedIds.add(manager.id);
      }
    }
    for (const managerId of assignedIds) {
      const manager = managersById.get(managerId);
      if (!manager) continue;
      const group = ensureGroup(manager.email);
      group.userIds.add(manager.id);
      group.modules.add(module);
      for (const action of actions) {
        if (action.module !== module) continue;
        // Staff see unassigned sites and their own department's sites, never
        // another department's action. Admins retain their normal global view.
        if (manager.role !== "client_admin" && action.site_department_id != null &&
            action.site_department_id !== manager.departmentId) continue;
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
  const clients = await db.execute(sql`SELECT id FROM clients WHERE active = true`);

  for (const client of ((clients as any).rows ?? []) as Array<{ id: number }>) {
    result.clientsChecked++;
    try {
      const services = await getEntitledServices(client.id);
      const modules = Object.keys(moduleRoutes).filter((module) =>
        moduleServices[module]?.some((key) => isEntitled(services, key)));
      if (modules.length === 0) continue;
      const actionsResult = await db.execute(sql`
        SELECT a.module, a.title, a.owner_name, a.due_date, a.severity,
               s.department_id AS site_department_id
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

      const { emails: seniorEmails, userIds: seniorUserIds } = await getNotificationEmails(client.id);
      const routingResult = await db.execute(sql`
        SELECT value FROM app_settings
        WHERE client_id = ${client.id} AND key = 'trackSummaryRouting'
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      const routing = parseTrackSummaryRouting(((routingResult as any).rows ?? [])[0]?.value);
      const departments = await db.select({ id: departmentsTable.id, name: departmentsTable.name })
        .from(departmentsTable).where(eq(departmentsTable.clientId, client.id));
      const effectiveRouting = effectiveTrackRouting(routing, departments, modules);
      const users = await db
        .select({
          id: usersTable.id, email: usersTable.email, role: usersTable.role,
          departmentId: usersTable.departmentId,
          isDepartmentManager: usersTable.isDepartmentManager,
          isMaintenanceManager: usersTable.isMaintenanceManager,
        })
        .from(usersTable)
        .where(and(eq(usersTable.clientId, client.id), eq(usersTable.active, true)));
      const seniorUsers = users
        .filter((user) => seniorUserIds.includes(user.id))
        .map(({ id, email }) => ({ id, email }));
      const configuredManagers = users
        .filter((user) => user.role === "client_admin" || user.role === "client_staff")
        .map(({ id, email, departmentId, role, isDepartmentManager, isMaintenanceManager }) =>
          ({ id, email, departmentId, role, isDepartmentManager, isMaintenanceManager }));
      const recipients = buildTrackSummaryRecipients(
        actions,
        seniorEmails,
        seniorUsers,
        configuredManagers,
        effectiveRouting,
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
