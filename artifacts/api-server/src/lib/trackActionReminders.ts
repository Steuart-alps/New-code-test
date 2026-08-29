import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { escapeHtml, getPublicAppUrl, sendEmail } from "./email";
import { getNotificationEmails } from "./getNotificationEmails";
import { logger } from "./logger";
import { sendPushToUsers } from "./pushNotifications";

export interface ReminderAction {
  module: string;
  title: string;
  owner_name: string | null;
  due_date: string | null;
  severity: "monitor" | "action_required" | "urgent";
}

export interface TrackSummaryManager {
  id: number;
  email: string;
}

export interface TrackSummaryRecipient {
  email: string;
  userIds: number[];
  actions: ReminderAction[];
}

export type TrackSummaryRouting = Record<string, number[]>;

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
};

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
): TrackSummaryRecipient[] {
  const groups = new Map<string, { email: string; userIds: Set<number>; actions: Set<ReminderAction> }>();
  const ensureGroup = (email: string) => {
    const key = normalizeEmail(email);
    if (!groups.has(key)) {
      groups.set(key, { email: email.trim(), userIds: new Set(), actions: new Set() });
    }
    return groups.get(key)!;
  };

  for (const email of seniorEmails.filter(Boolean)) {
    const group = ensureGroup(email);
    actions.forEach((action) => group.actions.add(action));
  }
  for (const user of seniorUsers) {
    const group = groups.get(normalizeEmail(user.email));
    if (group) group.userIds.add(user.id);
  }

  const managersById = new Map(configuredManagers.map((manager) => [manager.id, manager]));
  for (const action of actions) {
    for (const managerId of routing[action.module] ?? []) {
      const manager = managersById.get(managerId);
      if (!manager) continue;
      const group = ensureGroup(manager.email);
      group.userIds.add(manager.id);
      group.actions.add(action);
    }
  }

  return [...groups.values()]
    .filter((group) => group.actions.size > 0)
    .map((group) => ({
      email: group.email,
      userIds: [...group.userIds],
      actions: [...group.actions],
    }));
}

function parseTrackSummaryRouting(value: unknown): TrackSummaryRouting {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([module, ids]) => [
        module,
        Array.isArray(ids)
          ? [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
          : [],
      ]),
    );
  } catch {
    return {};
  }
}

/** Resolve the destination for an action module, retaining a safe dashboard fallback. */
export function trackActionModuleUrl(module: string, appUrl = getPublicAppUrl()): string {
  return `${appUrl.replace(/\/+$/, "")}${moduleRoutes[module] ?? "/dashboard"}`;
}

export function buildTrackActionDigest(actions: ReminderAction[], appUrl = getPublicAppUrl()) {
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
    subject: `Action required: ${count} operational action${count === 1 ? "" : "s"} need attention`,
    text: actions.map((a) =>
      `[${moduleLabels[a.module] ?? a.module}] ${a.title} — owner: ${a.owner_name || "Unassigned"} — due: ${formatDate(a.due_date)}\n${trackActionModuleUrl(a.module, appUrl)}`
    ).join("\n"),
    html: `<div style="font-family:Arial,sans-serif;color:#1e293b;max-width:720px">
      <h2>Operational actions need attention</h2>
      <p>${count} unresolved action${count === 1 ? "" : "s"} require review.</p>
      <table style="border-collapse:collapse;width:100%"><thead><tr>
        <th align="left" style="padding:10px">Module</th><th align="left" style="padding:10px">Action</th>
        <th align="left" style="padding:10px">Owner</th><th align="left" style="padding:10px">Due</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`,
  };
}

/**
 * Sends one daily digest per client. A log row is claimed before sending to
 * make overlapping schedulers safe; failed sends release the claim for retry.
 */
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
      const actionsResult = await db.execute(sql`
        SELECT module, title, owner_name, due_date, severity
        FROM track_actions
        WHERE client_id = ${client.id}
          AND status <> 'resolved'
          AND (
            severity IN ('action_required', 'urgent')
            OR (severity = 'monitor' AND (due_date IS NULL OR due_date <= CURRENT_DATE))
          )
        ORDER BY
          CASE severity WHEN 'urgent' THEN 0 WHEN 'action_required' THEN 1 ELSE 2 END,
          due_date ASC NULLS FIRST, created_at ASC
      `);
      const actions = ((actionsResult as any).rows ?? []) as ReminderAction[];
      if (actions.length === 0) continue;

      const { emails: seniorEmails, userIds: seniorUserIds } = await getNotificationEmails(client.id);
      const routingResult = await db.execute(sql`
        SELECT value FROM app_settings
        WHERE client_id = ${client.id} AND key = 'trackSummaryRouting'
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      const routing = parseTrackSummaryRouting(((routingResult as any).rows ?? [])[0]?.value);
      const configuredManagerIds = [...new Set(Object.values(routing).flat())];
      const allUserIds = [...new Set([...seniorUserIds, ...configuredManagerIds])];
      const users = allUserIds.length > 0
        ? await db
          .select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
          .from(usersTable)
          .where(and(
            eq(usersTable.clientId, client.id),
            eq(usersTable.active, true),
            inArray(usersTable.id, allUserIds),
          ))
        : [];
      const seniorUsers = users
        .filter((user) => seniorUserIds.includes(user.id))
        .map(({ id, email }) => ({ id, email }));
      const configuredManagers = users
        .filter((user) =>
          configuredManagerIds.includes(user.id)
          && (user.role === "client_admin" || user.role === "client_staff"))
        .map(({ id, email }) => ({ id, email }));
      const recipients = buildTrackSummaryRecipients(
        actions,
        seniorEmails,
        seniorUsers,
        configuredManagers,
        routing,
      );
      if (recipients.length === 0) continue;

      const claim = await db.execute(sql`
        INSERT INTO track_action_reminder_log (client_id, log_date, sent_at)
        VALUES (${client.id}, CURRENT_DATE, now())
        ON CONFLICT (client_id, log_date) DO NOTHING
        RETURNING id
      `);
      const claimId = ((claim as any).rows ?? [])[0]?.id as number | undefined;
      if (!claimId) continue;

      let sentCount = 0;
      let failedCount = 0;
      for (const recipient of recipients) {
        const digest = buildTrackActionDigest(recipient.actions);
        try {
          await send({
            to: recipient.email,
            subject: digest.subject,
            html: digest.html,
            text: digest.text,
            clientId: client.id,
          });
          sentCount++;
          try {
            await sendPush(recipient.userIds, {
              title: "Operational actions need attention",
              body: `${recipient.actions.length} unresolved action${recipient.actions.length === 1 ? "" : "s"} require review.`,
              data: { route: "/track-actions" },
            });
          } catch (err) {
            logger.warn({ err, clientId: client.id, recipient: recipient.email }, "Track action reminder push failed");
          }
        } catch (err) {
          failedCount++;
          logger.error({ err, clientId: client.id, recipient: recipient.email }, "Track action reminder email failed");
        }
      }
      if (sentCount === 0) {
        await db.execute(sql`DELETE FROM track_action_reminder_log WHERE id = ${claimId}`);
        result.errors++;
        continue;
      }

      result.clientsEmailed++;
      result.emailsSent += sentCount;
      result.errors += failedCount;
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Track action reminder failed");
    }
  }
  return result;
}
