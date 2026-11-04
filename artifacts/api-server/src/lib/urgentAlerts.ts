/**
 * Same-day alerts. Everything else waits for the person's 08:00 "due
 * tomorrow" email or the Owner update (lib/personalReminders.ts); these go
 * out within minutes of being raised:
 *   - a track action marked Urgent (a check recorded as unsafe raises one
 *     automatically; anyone can set an action's priority to Urgent): to the
 *     person responsible, the Managers who cover its site and the Owners;
 *   - a compliance check marked Critical: to the person responsible and the
 *     Owners;
 *   - every new FixTrack issue: to the person it is assigned to, else the
 *     Maintenance managers who cover its site, else the Managers who do, else
 *     the Owners. An Urgent issue also goes to those Managers and the Owners.
 * Whoever raised it isn't told about their own item unless it is theirs to do.
 *
 * Runs every 10 minutes over items raised or changed in the last 24 hours.
 * Each (item, address) is claimed before sending (lib/emailDeliveryClaims.ts),
 * so an item is alerted once, a crash retries under the same provider key, and
 * a person with several new items gets them in one email. Recipients also get
 * a bell notification (and phone push).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  canSee,
  loadResponsibilityContext,
  responsibleFor,
  type ResponsibilityContext,
} from "./dueItems";
import {
  claimEmailDelivery,
  emailDeliveryIdempotencyKey,
  markEmailDeliverySent,
  pruneSentEmailDeliveries,
  settleEmailDelivery,
  type EmailDeliveryClaim,
} from "./emailDeliveryClaims";
import { emailButton, escapeHtml, getPublicAppUrl, renderEmailLayout, sendEmail } from "./email";
import { logger } from "./logger";
import { STARTER_CHECK_NOTE } from "./seedStarterContent";
import { sendPushToUsers } from "./pushNotifications";
import { getEntitledServices, isEntitled, type Entitlements } from "./services";
import { getTrackModule } from "./trackModules";
import { isClientBillingLocked } from "./trialLock";
import { createUserNotifications, type NewUserNotification } from "./userNotifications";

export const URGENT_ALERT_JOB = "urgent-alerts";
/** Items raised or changed this long ago or less are considered. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Sent markers are kept this long, then pruned. */
const SENT_MARKER_DAYS = 60;

export interface UrgentAlertJobOptions {
  now?: Date;
  /** Only these businesses (tests); default every active business. */
  clientIds?: number[];
  send?: typeof sendEmail;
  sendPush?: typeof sendPushToUsers;
}

export interface UrgentAlertJobResult {
  clientsChecked: number;
  emailsSent: number;
  itemsAlerted: number;
  errors: number;
}

export interface Candidate {
  kind: "action" | "fix" | "compliance";
  id: number;
  module: string;
  title: string;
  site_id: number | null;
  site_name: string | null;
  urgent: boolean;
  assignee_user_id: number | null;
  owner_name: string | null;
  created_by: number | null;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

function entitledTo(services: Entitlements, module: string): boolean {
  return getTrackModule(module)?.services.some((key) => isEntitled(services, key)) ?? false;
}

function describe(item: Candidate): { label: string; path: string } {
  if (item.kind === "fix") {
    return { label: item.urgent ? "Urgent FixTrack issue" : "New FixTrack issue", path: `/fix-track/${item.id}` };
  }
  if (item.kind === "compliance") return { label: "Critical compliance check", path: "/external" };
  const module = getTrackModule(item.module);
  return { label: `Urgent ${module?.label ?? ""} action`.replace(/\s+/g, " "), path: module?.path ?? "/" };
}

/** Who hears about an item straight away. */
function recipientsFor(ctx: ResponsibilityContext, item: Candidate): number[] {
  const siteId = item.site_id == null ? null : Number(item.site_id);
  const assignee = item.assignee_user_id == null ? null : Number(item.assignee_user_id);
  const managers = [...ctx.eligible.values()]
    .filter((user) => user.role === "client_manager" && canSee(ctx, user.id, siteId))
    .map((user) => user.id);
  const owners = ctx.ownerIds.length ? ctx.ownerIds : ctx.fallback;
  let people: number[];
  if (item.kind === "fix") {
    const maintenance = ctx.maintenanceManagerIds.filter((id) => canSee(ctx, id, siteId));
    const first = assignee != null && canSee(ctx, assignee, siteId) ? [assignee]
      : maintenance.length ? maintenance : managers.length ? managers : owners;
    people = item.urgent ? [...first, ...managers, ...owners] : first;
  } else {
    const responsible = responsibleFor(ctx, {
      module: item.kind === "compliance" ? "compliance" : item.module,
      siteId, assigneeUserId: assignee, assigneeName: item.owner_name,
    }).userIds;
    people = item.kind === "action" ? [...responsible, ...managers, ...owners] : [...responsible, ...owners];
  }
  const raisedBy = item.created_by == null ? null : Number(item.created_by);
  return [...new Set(people)].filter((id) => id !== raisedBy || id === assignee);
}

async function candidates(clientId: number, since: Date): Promise<Candidate[]> {
  const from = since.toISOString();
  return rowsOf<Candidate>(await db.execute(sql`
    SELECT 'action' AS kind, a.id, a.module, a.title, a.site_id, s.name AS site_name, true AS urgent,
           a.assignee_user_id, a.owner_name, a.created_by
    FROM track_actions a LEFT JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
    WHERE a.client_id = ${clientId} AND a.severity = 'urgent' AND a.status <> 'resolved'
      AND GREATEST(a.created_at, a.updated_at) >= ${from}::timestamptz
      -- Actions just created from an uploaded report were in its action plan
      -- email (lib/reportActionEmails.ts); a later change (an assignment, a
      -- new priority) alerts as usual.
      AND NOT (coalesce(a.source_kind, '') LIKE 'inspection_report:%' AND a.updated_at <= a.created_at + interval '1 minute')
    UNION ALL
    SELECT 'fix', f.id, 'fix', f.title, f.site_id, s.name, f.priority = 'urgent',
           f.assignee_user_id, f.assigned_to, f.created_by
    FROM fix_track_issues f LEFT JOIN sites s ON s.id = f.site_id AND s.client_id = f.client_id
    WHERE f.client_id = ${clientId} AND f.status IN ('reported', 'in_progress')
      AND (f.created_at >= ${from}::timestamptz
        OR (f.priority = 'urgent' AND f.updated_at >= ${from}::timestamptz))
    UNION ALL
    SELECT 'compliance', c.id, 'compliance', c.title, c.site_id, s.name, true,
           c.assignee_user_id, c.assigned_to, NULL
    FROM compliance_items c LEFT JOIN sites s ON s.id = c.site_id AND s.client_id = c.client_id
    WHERE c.client_id = ${clientId} AND c.priority = 'critical' AND c.status <> 'completed'
      AND GREATEST(c.created_at, c.updated_at) >= ${from}::timestamptz
      -- A starter check a new business was given (lib/seedStarterContent.ts)
      -- is an example until someone gives it a due date; a brand-new
      -- business is not told its examples need action today.
      AND NOT (c.notes IS NOT DISTINCT FROM ${STARTER_CHECK_NOTE} AND c.due_date IS NULL)
    ORDER BY 1, 2
  `));
}

/** The coloured label beside each item, like the status badges in the check reminder email. */
function badgeFor(item: Candidate): string {
  const [text, background, colour] = item.kind === "compliance" ? ["Critical", "#fee2e2", "#b91c1c"]
    : item.urgent ? ["Urgent", "#fee2e2", "#b91c1c"]
    : ["New", "#dbeafe", "#1d4ed8"];
  return `<span style="background:${background};color:${colour};padding:3px 10px;border-radius:12px;font-size:13px;font-weight:700;">${text}</span>`;
}

export function buildUrgentAlertEmail(businessName: string, items: Candidate[], name: string | null): { subject: string; html: string } {
  const appUrl = getPublicAppUrl();
  const anyUrgent = items.some((item) => item.urgent);
  const subject = items.length === 1
    ? `${describe(items[0]!).label}: ${items[0]!.title} — ComplyTrack`
    : `${items.length} ${anyUrgent ? "items need action today" : "new FixTrack issues"} at ${businessName} — ComplyTrack`;
  const headline = items.length === 1
    ? (anyUrgent ? "1 item needs action today" : "A new FixTrack issue has been reported")
    : anyUrgent ? `${items.length} items need action today` : `${items.length} new FixTrack issues have been reported`;
  const rows = items.map((item) => {
    const { label, path } = describe(item);
    return `<tr>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;">
            <a href="${escapeHtml(`${appUrl}${path}`)}" style="font-weight:700;font-size:16px;color:#0f172a;text-decoration:none;">${escapeHtml(item.title)}</a>
            <div style="font-size:14px;color:#64748b;margin-top:3px;">${escapeHtml(label)}${item.site_name ? ` · ${escapeHtml(item.site_name)}` : ""}</div>
          </td>
          <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;vertical-align:top;">${badgeFor(item)}</td>
        </tr>`;
  }).join("");
  const html = renderEmailLayout({
    subtitle: anyUrgent ? "Needs action today" : "New FixTrack issues",
    bodyHtml: `<p style="margin:0 0 16px;">Hello${name ? ` ${escapeHtml(name.split(" ")[0]!)}` : ""},</p>`
      + `<p style="margin:0 0 6px;font-size:19px;font-weight:700;color:#0f172a;">${headline} at ${escapeHtml(businessName)}.</p>`
      + `<p style="margin:0 0 20px;color:#475569;">Open ComplyTrack to deal with ${items.length === 1 ? "it" : "them"}.</p>`
      + `<table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;margin:0 0 28px;">${rows}</table>`
      + `<div style="text-align:center;">${emailButton(appUrl, "Open ComplyTrack →")}</div>`,
    footerNote: "Urgent items and new FixTrack issues are sent as they are raised",
  });
  return { subject, html };
}

export async function runUrgentAlertsForClient(
  clientId: number,
  now: Date,
  options: Pick<UrgentAlertJobOptions, "send" | "sendPush"> = {},
): Promise<Omit<UrgentAlertJobResult, "clientsChecked">> {
  const result = { emailsSent: 0, itemsAlerted: 0, errors: 0 };
  const services = await getEntitledServices(clientId);
  const found = (await candidates(clientId, new Date(now.getTime() - LOOKBACK_MS)))
    .filter((item) => item.kind === "compliance" || entitledTo(services, item.module));
  if (!found.length) return result;
  if (await isClientBillingLocked(clientId).catch(() => false)) return result;

  const send = options.send ?? sendEmail;
  const [ctx, clientRows] = await Promise.all([
    loadResponsibilityContext(clientId),
    db.execute(sql`SELECT name FROM clients WHERE id = ${clientId}`),
  ]);
  const businessName = rowsOf<{ name: string }>(clientRows)[0]?.name ?? "your business";

  const byUser = new Map<number, Candidate[]>();
  for (const item of found) {
    for (const userId of recipientsFor(ctx, item)) byUser.set(userId, [...(byUser.get(userId) ?? []), item]);
  }
  const alerted = new Set<string>();
  for (const [userId, items] of byUser) {
    const user = ctx.eligible.get(userId);
    const email = user?.email?.trim().toLowerCase();
    if (!user || !email) continue;
    const claims: Array<{ item: Candidate; claim: EmailDeliveryClaim }> = [];
    for (const item of items) {
      const claim = await claimEmailDelivery(URGENT_ALERT_JOB, `${clientId}:${item.kind}:${item.id}:${email}`);
      if (claim) claims.push({ item, claim });
    }
    if (!claims.length) continue;
    const { subject, html } = buildUrgentAlertEmail(businessName, claims.map((entry) => entry.item), user.name);
    try {
      await send({
        to: email, subject, html, clientId,
        idempotencyKey: emailDeliveryIdempotencyKey(claims[0]!.claim, claims.map((entry) => `${entry.item.kind}${entry.item.id}`).join(",")),
      });
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Urgent alert email failed");
      await Promise.all(claims.map((entry) => settleEmailDelivery(entry.claim).catch(() => {})));
      continue;
    }
    await Promise.all(claims.map((entry) => markEmailDeliverySent(entry.claim)));
    result.emailsSent++;
    const bell: NewUserNotification[] = claims.map(({ item }) => {
      const { label, path } = describe(item);
      alerted.add(`${item.kind}:${item.id}`);
      return {
        clientId, userId, module: item.module, siteId: item.site_id == null ? null : Number(item.site_id),
        kind: item.urgent ? "urgent" : "fix_new", title: `${label}: ${item.title}`,
        body: item.site_name ? `At ${item.site_name}.` : null, linkPath: path,
        dedupeKey: `urgent:${item.kind}:${item.id}`,
      };
    });
    try {
      await createUserNotifications(bell, { sendPush: options.sendPush });
    } catch (err) {
      logger.warn({ err, clientId }, "Urgent alert notifications failed");
    }
  }
  result.itemsAlerted = alerted.size;
  return result;
}

export async function runUrgentAlertJob(options: UrgentAlertJobOptions = {}): Promise<UrgentAlertJobResult> {
  const now = options.now ?? new Date();
  const result: UrgentAlertJobResult = { clientsChecked: 0, emailsSent: 0, itemsAlerted: 0, errors: 0 };
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
      const sent = await runUrgentAlertsForClient(Number(client.id), now, options);
      result.emailsSent += sent.emailsSent;
      result.itemsAlerted += sent.itemsAlerted;
      result.errors += sent.errors;
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Urgent alert evaluation failed");
    }
  }
  try {
    await pruneSentEmailDeliveries(URGENT_ALERT_JOB, SENT_MARKER_DAYS);
  } catch (err) {
    logger.warn({ err }, "Could not prune urgent alert markers");
  }
  return result;
}
