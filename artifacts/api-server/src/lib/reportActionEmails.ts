/**
 * The same-day email that goes out when actions are created from an uploaded
 * audit or inspection report (routes/inspection-reports.ts): a short summary
 * and the action plan, with an "Assign to" button on each action. One email
 * per person per confirmation, to the business's Owners and Managers who can
 * see the actions' sites and to the consultants linked to the business (ALPS),
 * but not to the person who just confirmed them.
 *
 * The buttons are plain links into ComplyTrack (sign-in required) that open
 * the report at that action with its "Assigned to" picker ready; nothing is
 * assigned from the email itself.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { escapeHtml, getPublicAppUrl, renderEmailLayout, sendSystemEmail } from "./email";
import { candidateCanSeeSite, loadEligibleOwners } from "./trackOwners";
import { TRACK_MODULES } from "./trackModules";
import { logger } from "./logger";

type Severity = "urgent" | "action_required" | "monitor";

export interface PlanAction {
  id: number;
  title: string;
  severity: Severity;
  siteId: number | null;
  module: string;
  dueDate: string | null;
  ownerName: string | null;
}

export interface PlanEmailInput {
  recipientName: string;
  businessName: string;
  reportId: number;
  reportTitle: string;
  reportTypeLabel: string;
  reportDate: string | null;
  summary: string | null;
  confirmedBy: string;
  actions: Array<PlanAction & { siteName: string | null; trackLabel: string }>;
  appUrl: string;
}

const SEVERITY: Record<Severity, { label: string; order: number; colour: string; background: string }> = {
  urgent: { label: "Urgent", order: 0, colour: "#991b1b", background: "#fef2f2" },
  action_required: { label: "Action required", order: 1, colour: "#92400e", background: "#fffbeb" },
  monitor: { label: "Recommendation", order: 2, colour: "#334155", background: "#f1f5f9" },
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Most pressing first: by priority, then the earliest due date. */
function sortForPlan<T extends PlanAction>(actions: T[]): T[] {
  return [...actions].sort((a, b) =>
    SEVERITY[a.severity].order - SEVERITY[b.severity].order
    || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999")
    || a.id - b.id);
}

export function buildReportActionPlanEmail(input: PlanEmailInput): { subject: string; html: string; text: string } {
  const actions = sortForPlan(input.actions);
  const reportLink = `${input.appUrl}/report-actions?report=${input.reportId}`;
  const actionLink = (id: number) => `${reportLink}&action=${id}`;
  const counts = (Object.keys(SEVERITY) as Severity[])
    .map((severity) => ({ severity, count: actions.filter((action) => action.severity === severity).length }))
    .filter((entry) => entry.count > 0);
  const countLine = counts.map(({ severity, count }) => `${count} ${SEVERITY[severity].label.toLowerCase()}`).join(" · ");
  const unassigned = actions.filter((action) => !action.ownerName?.trim()).length;
  const reportDate = formatDate(input.reportDate);
  const reportName = `${input.reportTypeLabel}: ${input.reportTitle}${reportDate ? ` (${reportDate})` : ""}`;
  const subject = `Action plan: ${input.reportTitle} (${plural(actions.length, "action", "actions")}${unassigned ? `, ${unassigned} to assign` : ""})`;

  const rows = actions.map((action) => {
    const tone = SEVERITY[action.severity];
    const details = [action.trackLabel, action.siteName ?? "Whole business", formatDate(action.dueDate) && `Due ${formatDate(action.dueDate)}`]
      .filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
    const owner = action.ownerName?.trim();
    const assign = owner
      ? `<div style="font-size:13px;color:#334155;">Assigned to <strong>${escapeHtml(owner)}</strong></div>
         <a href="${escapeHtml(actionLink(action.id))}" style="font-size:12px;color:#2563eb;">Change</a>`
      : `<a href="${escapeHtml(actionLink(action.id))}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;">Assign to…</a>`;
    return `<tr>
      <td style="padding:12px 0;border-top:1px solid #e2e8f0;vertical-align:top;">
        <span style="display:inline-block;font-size:11px;font-weight:600;color:${tone.colour};background:${tone.background};border-radius:6px;padding:2px 8px;">${tone.label}</span>
        <div style="font-weight:600;color:#0f172a;margin-top:4px;">${escapeHtml(action.title)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${details}</div>
      </td>
      <td style="padding:12px 0 12px 12px;border-top:1px solid #e2e8f0;vertical-align:top;text-align:right;width:150px;">${assign}</td>
    </tr>`;
  }).join("");

  const bodyHtml = `
    <p style="margin:0 0 12px;">Hi ${escapeHtml(input.recipientName)},</p>
    <p style="margin:0 0 16px;">${escapeHtml(input.confirmedBy)} has added ${plural(actions.length, "action", "actions")} for ${escapeHtml(input.businessName)} from the <strong>${escapeHtml(reportName)}</strong>.${unassigned ? ` ${unassigned === actions.length ? (unassigned === 1 ? "It isn't" : "None of them is") : `${unassigned} ${unassigned === 1 ? "isn't" : "aren't"}`} assigned to anyone yet: press <strong>Assign to…</strong> to choose who does ${unassigned === 1 ? "it" : "each one"}.` : ""}</p>
    ${input.summary ? `<div style="background:#f8fafc;border-radius:10px;padding:14px 16px;margin:0 0 16px;font-size:14px;"><div style="font-weight:600;margin-bottom:4px;">Summary of the report</div>${escapeHtml(input.summary)}</div>` : ""}
    <div style="font-size:13px;color:#64748b;margin:0 0 4px;">${escapeHtml(countLine)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
    <div style="margin:24px 0 0;"><a href="${escapeHtml(reportLink)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:700;">Open the action plan</a></div>
    <p style="margin:16px 0 0;font-size:12px;color:#64748b;">You'll be asked to sign in. The report itself stays in ComplyTrack; it isn't attached to this email.</p>`;
  const html = renderEmailLayout({
    bodyHtml,
    subtitle: "Action plan from a report",
    footerNote: `Sent to the Owners, Managers and consultants of ${escapeHtml(input.businessName)}`,
  });

  const text = [
    `Hi ${input.recipientName},`,
    "",
    `${input.confirmedBy} has added ${plural(actions.length, "action", "actions")} for ${input.businessName} from the ${reportName}.`,
    ...(input.summary ? ["", `Summary of the report: ${input.summary}`] : []),
    "",
    countLine,
    ...actions.flatMap((action) => [
      "",
      `[${SEVERITY[action.severity].label}] ${action.title}`,
      [action.trackLabel, action.siteName ?? "Whole business", formatDate(action.dueDate) && `Due ${formatDate(action.dueDate)}`].filter(Boolean).join(" · "),
      action.ownerName?.trim() ? `Assigned to ${action.ownerName.trim()}: ${actionLink(action.id)}` : `Assign to someone: ${actionLink(action.id)}`,
    ]),
    "",
    `Open the action plan: ${reportLink}`,
  ].join("\n");
  return { subject, html, text };
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

/**
 * Email the action plan to the business's Owners, Managers and linked
 * consultants (not the person who confirmed it). Each person gets only the
 * actions at sites they can see.
 * Returns the names of the people emailed; a failed send is logged, never thrown.
 */
export async function sendReportActionPlanEmails(opts: {
  clientId: number;
  reportId: number;
  reportTitle: string;
  reportTypeLabel: string;
  reportDate: string | null;
  summary: string | null;
  confirmedByUserId: number;
  confirmedBy: string;
  actions: PlanAction[];
  sendEmail?: typeof sendSystemEmail;
}): Promise<string[]> {
  const send = opts.sendEmail ?? sendSystemEmail;
  try {
    const [business] = rowsOf<{ name: string }>(await db.execute(sql`SELECT name FROM clients WHERE id = ${opts.clientId}`));
    const sites = rowsOf<{ id: number; name: string; department_id: number | null }>(await db.execute(sql`
      SELECT id, name, department_id FROM sites WHERE client_id = ${opts.clientId}
    `));
    const siteById = new Map(sites.map((site) => [Number(site.id), site]));
    const trackLabels = new Map(TRACK_MODULES.map((module) => [module.key, module.label]));
    const people = (await loadEligibleOwners(opts.clientId)).filter((person) =>
      ["client_admin", "client_manager", "consultant"].includes(person.role) && person.id !== opts.confirmedByUserId && person.email?.trim());
    const appUrl = getPublicAppUrl();
    const emailed: string[] = [];
    for (const person of people) {
      const visible = opts.actions.filter((action) => {
        if (action.siteId == null) return true;
        const site = siteById.get(action.siteId);
        return !!site && candidateCanSeeSite(person, site.department_id == null ? null : Number(site.department_id), action.siteId);
      });
      if (!visible.length) continue;
      const { subject, html, text } = buildReportActionPlanEmail({
        recipientName: person.name,
        businessName: business?.name ?? "your business",
        reportId: opts.reportId,
        reportTitle: opts.reportTitle,
        reportTypeLabel: opts.reportTypeLabel,
        reportDate: opts.reportDate,
        summary: opts.summary,
        confirmedBy: opts.confirmedBy,
        actions: visible.map((action) => ({
          ...action,
          siteName: action.siteId == null ? null : siteById.get(action.siteId)?.name ?? null,
          trackLabel: trackLabels.get(action.module) ?? "Report actions",
        })),
        appUrl,
      });
      try {
        await send({
          to: person.email,
          subject,
          html,
          text,
          idempotencyKey: `report-action-plan:${opts.reportId}:${Math.min(...visible.map((action) => action.id))}:${person.id}`,
        });
        emailed.push(person.name);
      } catch (err) {
        logger.error({ err, clientId: opts.clientId, reportId: opts.reportId, userId: person.id }, "Report action plan email failed");
      }
    }
    return emailed;
  } catch (err) {
    logger.error({ err, clientId: opts.clientId, reportId: opts.reportId }, "Report action plan emails failed");
    return [];
  }
}
