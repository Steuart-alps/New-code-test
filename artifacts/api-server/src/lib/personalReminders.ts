/**
 * Reminder emails to the person who has to do the work, and an update for the
 * Owner, instead of a daily digest of everything to the Owner.
 *
 * Runs hourly; each business is handled once a day at 08:00 on its own clock
 * (Settings timezone), with a three-hour window so a restart or deploy at
 * 08:00 doesn't skip the day.
 *
 * "Due tomorrow" email: at most one per person per day, only on days when
 * something of theirs needs it. It lists, across every track
 * (lib/dueItems.ts, which also decides who is responsible), with the timing
 * per type set in Settings → Reminder Notifications
 * (@workspace/api-zod/reminder-timings):
 *   - what is due tomorrow (by default), or on Fridays what is due the next
 *     Monday to Sunday for types set to "Weekly";
 *   - anything gone overdue: the day after it was due, then once a week (by
 *     default);
 *   - expiries: the early reminder (by default 30 days for training, the
 *     contractor lead time for contractor documents) and 1 day before;
 *   - "Certificates outstanding": a contractor visit with no certificate
 *     two weeks on (lib/certificateFollowUp.ts), then every two weeks while
 *     it is still missing;
 *   - documents they still have to sign (by their staff roster email), added
 *     when an email is going anyway, and on Mondays.
 * Tasks assigned to a group ("Staff" or "Managers") go on that group's bell
 * only.
 * Anything marked urgent, and every new FixTrack issue, is emailed the same
 * day as it is raised instead (lib/urgentAlerts.ts).
 *
 * Owner update: Mondays (or every day, with Settings "Owner update" set to
 * Daily) to the business's Owners, or to its Notification email when one is
 * set. Managers get one covering the sites their departments can see. It
 * lists the last week's completed work by track and by person, what is
 * overdue and who has it, what is due this week, anything nobody has been
 * given, expiries in the next 60 days, certificates outstanding two weeks or more
 * after a contractor visit, documents still to sign and contractor reminders waiting
 * in Contractor Approvals. On those days an
 * Owner's own due-tomorrow list is folded in, so they get one email.
 *
 * Each email is claimed per business, day and address before it is sent
 * (lib/emailDeliveryClaims.ts), so a second run or instance never repeats it
 * and a crash mid-send retries under the same provider key.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { addCalendarDays, getAccountTimezone, localDateIn } from "./accountClock";
import { LOOK_BACK_DAYS, certificateChaseOn, getVisitsAwaitingCertificate, type VisitAwaitingCertificate } from "./certificateFollowUp";
import { getOutstandingAckSummary } from "./docAckReminders";
import {
  DEFAULT_OVERDUE_EVERY,
  NEXT_WEEK,
  REMINDER_TIMINGS_SETTING,
  defaultReminderTiming,
  validateReminderTimings,
  type ReminderTiming,
} from "@workspace/api-zod/reminder-timings";
import {
  CONTRACTORS_MODULE,
  collectDueItems,
  loadResponsibilityContext,
  responsibleFor,
  responsibleForCertificate,
  type DueItem,
  type Responsibility,
  type UrgentItem,
} from "./dueItems";
import {
  claimEmailDelivery,
  emailDeliveryIdempotencyKey,
  markEmailDeliverySent,
  pruneSentEmailDeliveries,
  settleEmailDelivery,
} from "./emailDeliveryClaims";
import { emailButton, escapeHtml, getPublicAppUrl, renderEmailLayout, sendEmail } from "./email";
import { logger } from "./logger";
import { sendPushToUsers } from "./pushNotifications";
import { getOutstandingSafeTrackAcknowledgements, getOutstandingSafeTrackStaffReminders } from "./safeTrackAckReminders";
import { getEntitledServices, isEntitled } from "./services";
import { localHourIn } from "./trackReminders";
import { candidateCanSeeSite } from "./trackOwners";
import { isClientBillingLocked } from "./trialLock";
import { createUserNotifications, type NewUserNotification } from "./userNotifications";

export const PERSONAL_REMINDER_HOUR = 8;
export const PERSONAL_REMINDER_WINDOW_HOURS = 3;
export const PERSONAL_REMINDER_JOB = "personal-reminders";
export const OWNER_UPDATE_FREQUENCY_SETTING = "ownerUpdateFrequency";
export const OWNER_UPDATE_FREQUENCIES = ["weekly", "daily"] as const;
export type OwnerUpdateFrequency = (typeof OWNER_UPDATE_FREQUENCIES)[number];
/** Sent markers are kept this long, then pruned. */
const SENT_MARKER_DAYS = 60;
/** Rows shown per section before "and N more". */
const MAX_ROWS = 25;

/** Audited tables whose new rows count as work done, by track. */
const WORK_TABLES: Record<string, string> = {
  fire_safety_checks: "FireTrack",
  legionella_checks: "LegionellaTrack",
  food_safety_records: "KitchenTrack",
  kitchen_cleaning_logs: "KitchenTrack",
  kitchen_probe_checks: "KitchenTrack",
  kitchen_weekly_records: "KitchenTrack",
  pool_checks: "AquaTrack",
  swim_sessions: "AquaTrack",
  swim_surveillance_checks: "AquaTrack",
  swim_first_aid_checks: "AquaTrack",
  hot_tub_checks: "TubTrack",
  pat_tests: "PATtrack",
  pest_visits: "PestTrack",
  premises_inspections: "PremisesTrack",
  room_track_checks: "RoomTrack",
  tree_inspections: "TreeTrack",
  green_pre_use_checks: "GreenTrack",
  green_service_records: "GreenTrack",
  green_puwer_inspections: "GreenTrack",
  green_hour_readings: "GreenTrack",
  green_applications: "GreenTrack",
  bike_checks: "BikeTrack",
  bike_services: "BikeTrack",
  daily_checklist_submissions: "DailyTrack",
  coshh_checks: "COSHHTrack",
  train_track_records: "TrainTrack",
  task_completions: "Tasks",
};

export function parseOwnerUpdateFrequency(value: unknown): OwnerUpdateFrequency {
  return value === "daily" ? "daily" : "weekly";
}

export interface PersonalReminderJobOptions {
  /** Clock override (tests). */
  now?: Date;
  /** Only these businesses (tests); default every active business. */
  clientIds?: number[];
  send?: typeof sendEmail;
  sendPush?: typeof sendPushToUsers;
}

export interface PersonalReminderJobResult {
  clientsChecked: number;
  personalEmails: number;
  ownerUpdates: number;
  bellNotifications: number;
  errors: number;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
const MS_DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY);

function inWindow(hour: number): boolean {
  return hour >= PERSONAL_REMINDER_HOUR && hour < PERSONAL_REMINDER_HOUR + PERSONAL_REMINDER_WINDOW_HOURS;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** "today", "tomorrow" or the date. */
function dueWhen(today: string, date: string): string {
  if (date === today) return "today";
  if (date === addCalendarDays(today, 1)) return "tomorrow";
  return formatDay(date);
}

/**
 * Whether an item is in today's personal email under its type's timing, and
 * in which section. Types with no stored timing use the defaults; an expiry's
 * default early reminder is its own lead time (training 30 days, the
 * contractor lead time).
 */
export function reminderSection(
  item: Pick<DueItem, "kind" | "dueDate" | "leadDays">,
  timing: ReminderTiming | undefined,
  today: string,
): "upcoming" | "nextWeek" | "overdue" | "expiring" | null {
  const { daysBefore, overdueEvery } = timing
    ?? (item.kind === "expiry" && item.leadDays != null
      ? { daysBefore: item.leadDays, overdueEvery: DEFAULT_OVERDUE_EVERY }
      : defaultReminderTiming({ expiry: item.kind === "expiry" }));
  if (daysBefore == null) return null; // switched off for this type
  if (daysBefore === NEXT_WEEK) {
    if (item.kind === "due" && isFriday(today)) {
      const ahead = daysBetween(today, item.dueDate);
      if (ahead >= 3 && ahead <= 9) return "nextWeek"; // the following Monday to Sunday
    }
  }
  if (item.kind === "expiry") {
    const left = daysBetween(today, item.dueDate);
    return left === daysBefore || left === 1 ? "expiring" : null;
  }
  const late = daysBetween(item.dueDate, today);
  if (typeof daysBefore === "number" && late === -daysBefore) return "upcoming";
  if (late === 1 || (late > 1 && overdueEvery > 0 && (late - 1) % overdueEvery === 0)) return "overdue";
  return null;
}

const isMonday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 1;
const isFriday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5;

// ── Content ──────────────────────────────────────────────────────────────────

interface SignOff { title: string; docType: string; siteName: string | null }

interface PersonalSections {
  /** Due soon, at each type's "days before" timing (tomorrow by default). */
  upcoming: DueItem[];
  /** Fridays: due next Monday to Sunday, for types set to the weekly email. */
  nextWeek: DueItem[];
  overdue: DueItem[];
  expiring: DueItem[];
  urgent: UrgentItem[];
  certificates: VisitAwaitingCertificate[];
  signOffs: SignOff[];
}

const emptySections = (): PersonalSections => ({ upcoming: [], nextWeek: [], overdue: [], expiring: [], urgent: [], certificates: [], signOffs: [] });

/** Whether anything in the sections needs an email on its own (sign-offs ride along). */
const hasReminders = (sections: PersonalSections) =>
  sections.upcoming.length + sections.nextWeek.length + sections.overdue.length + sections.expiring.length + sections.urgent.length
    + sections.certificates.length > 0;

interface ActivityRow { track: string; person: string; count: number }

interface OwnerUpdate {
  period: "week" | "day";
  urgent: UrgentItem[];
  overdue: Array<{ item: DueItem; holder: string | null }>;
  dueSoon: Array<{ item: DueItem; holder: string | null }>;
  unassigned: DueItem[];
  expiring: DueItem[];
  certificates: VisitAwaitingCertificate[];
  unsigned: Array<{ title: string; docType: string; outstanding: number }>;
  contractorDrafts: number;
  /** Omitted for Managers (it covers the whole business). */
  activity: ActivityRow[] | null;
}

function where(item: { siteName: string | null }): string {
  return item.siteName ? ` · ${escapeHtml(item.siteName)}` : "";
}

function link(path: string, label: string): string {
  return `<a href="${escapeHtml(`${getPublicAppUrl()}${path}`)}" style="color:#4f46e5;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function list(rows: string[]): string {
  const shown = rows.slice(0, MAX_ROWS).map((row) =>
    `<li style="margin:0 0 6px;">${row}</li>`).join("");
  const more = rows.length > MAX_ROWS ? `<li style="margin:0 0 6px;color:#64748b;">and ${rows.length - MAX_ROWS} more</li>` : "";
  return `<ul style="margin:0 0 20px;padding-left:20px;">${shown}${more}</ul>`;
}

function heading(text: string, colour = "#0f172a"): string {
  return `<h3 style="margin:24px 0 8px;font-size:16px;color:${colour};">${escapeHtml(text)}</h3>`;
}

function itemRow(item: DueItem, extra = ""): string {
  return `<strong>${link(item.linkPath, item.title)}</strong> <span style="color:#64748b;">· ${escapeHtml(item.trackLabel)}${where(item)}${extra}</span>`;
}

function urgentRow(item: UrgentItem): string {
  return `<strong>${link(item.linkPath, item.title)}</strong> <span style="color:#64748b;">· ${escapeHtml(item.detail)}${where(item)} · ${escapeHtml(formatDay(item.raisedOn))}</span>`;
}

function certificateRow(visit: VisitAwaitingCertificate): string {
  const who = [visit.contractorName, visit.contractorCompany].filter(Boolean).join(", ");
  return `<strong>${link(`/items/${visit.itemId}`, visit.title)}</strong> <span style="color:#64748b;">· visited ${escapeHtml(formatDay(visit.visitDay))} by ${escapeHtml(who)}${where(visit)}</span>`;
}

function personalHtml(sections: PersonalSections, today: string): string {
  const parts: string[] = [];
  if (sections.urgent.length) {
    parts.push(heading("Needs action now", "#b91c1c"), list(sections.urgent.map(urgentRow)));
  }
  if (sections.upcoming.length) {
    const tomorrow = addCalendarDays(today, 1);
    if (sections.upcoming.every((item) => item.dueDate === tomorrow)) {
      parts.push(heading(`Due tomorrow (${formatDay(tomorrow)})`), list(sections.upcoming.map((item) => itemRow(item))));
    } else {
      const sorted = [...sections.upcoming].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      parts.push(heading("Coming up"), list(sorted.map((item) => itemRow(item, ` · due ${escapeHtml(dueWhen(today, item.dueDate))}`))));
    }
  }
  if (sections.nextWeek.length) {
    const sorted = [...sections.nextWeek].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    parts.push(
      heading(`Due next week (${formatDay(addCalendarDays(today, 3))} to ${formatDay(addCalendarDays(today, 9))})`),
      list(sorted.map((item) => itemRow(item, ` · ${escapeHtml(formatDay(item.dueDate))}`))),
    );
  }
  if (sections.overdue.length) {
    parts.push(heading("Overdue", "#b45309"), list(sections.overdue.map((item) =>
      itemRow(item, ` · was due ${escapeHtml(formatDay(item.dueDate))}`))));
  }
  if (sections.expiring.length) {
    parts.push(heading("Expiring"), list(sections.expiring.map((item) =>
      itemRow(item, ` · expires ${escapeHtml(formatDay(item.dueDate))}`))));
  }
  if (sections.certificates.length) {
    parts.push(
      heading("Certificates outstanding"),
      `<p style="margin:0 0 8px;color:#64748b;">The contractor has been and no certificate has been uploaded. Certificates are often held until the invoice is paid. The contractor is emailed today asking for it, with you copied in. When the certificate arrives, upload it on the check.</p>`,
      list(sections.certificates.map(certificateRow)),
    );
  }
  if (sections.signOffs.length) {
    parts.push(heading(`${plural(sections.signOffs.length, "document")} to read and sign`), list(sections.signOffs.map((doc) =>
      `${escapeHtml(doc.title)} <span style="color:#64748b;">· ${escapeHtml(doc.docType)}${doc.siteName ? ` · ${escapeHtml(doc.siteName)}` : ""}</span>`)));
  }
  return parts.join("");
}

function ownerUpdateHtml(update: OwnerUpdate, today: string): string {
  const parts: string[] = [];
  const holder = (name: string | null) => ` · <em>${name ? escapeHtml(name) : "no one assigned"}</em>`;
  if (update.urgent.length) {
    parts.push(heading("Needs action now", "#b91c1c"), list(update.urgent.map(urgentRow)));
  }
  if (update.activity) {
    const byTrack = new Map<string, number>();
    const byPerson = new Map<string, number>();
    for (const row of update.activity) {
      byTrack.set(row.track, (byTrack.get(row.track) ?? 0) + row.count);
      byPerson.set(row.person, (byPerson.get(row.person) ?? 0) + row.count);
    }
    const sorted = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    parts.push(heading(update.period === "week" ? "Done in the last 7 days" : "Done yesterday"));
    if (!byTrack.size) {
      parts.push(`<p style="margin:0 0 20px;color:#64748b;">Nothing was recorded.</p>`);
    } else {
      parts.push(
        `<p style="margin:0 0 4px;font-weight:600;">By track</p>`,
        list(sorted(byTrack).map(([track, count]) => `${escapeHtml(track)}: ${count}`)),
        `<p style="margin:0 0 4px;font-weight:600;">By person</p>`,
        list(sorted(byPerson).map(([person, count]) => `${escapeHtml(person)}: ${count}`)),
      );
    }
  }
  if (update.overdue.length) {
    parts.push(heading(`Overdue (${update.overdue.length})`, "#b45309"), list(update.overdue.map(({ item, holder: name }) =>
      itemRow(item, ` · was due ${escapeHtml(formatDay(item.dueDate))}${holder(name)}`))));
  }
  if (update.dueSoon.length) {
    parts.push(heading(update.period === "week" ? "Due this week" : "Due today and tomorrow"), list(update.dueSoon.map(({ item, holder: name }) =>
      itemRow(item, ` · ${escapeHtml(formatDay(item.dueDate))}${holder(name)}`))));
  }
  if (update.unassigned.length) {
    parts.push(
      heading("No one assigned"),
      `<p style="margin:0 0 8px;color:#64748b;">Reminders for these come to you. Pick a person on the record, or set a track owner in Settings, to hand them over.</p>`,
      list(update.unassigned.map((item) => itemRow(item, ` · ${escapeHtml(formatDay(item.dueDate))}`))),
    );
  }
  if (update.expiring.length) {
    parts.push(heading("Expiring in the next 60 days"), list(update.expiring.map((item) =>
      itemRow(item, item.dueDate < today
        ? ` · <strong style="color:#b91c1c;">expired ${escapeHtml(formatDay(item.dueDate))}</strong>`
        : ` · ${escapeHtml(formatDay(item.dueDate))}`))));
  }
  if (update.certificates.length) {
    // Past the chase window the contractor is no longer reminded: say so.
    parts.push(heading("Certificates outstanding"), list(update.certificates.map((visit) => certificateRow(visit)
      + (daysBetween(visit.visitDay, today) >= LOOK_BACK_DAYS
        ? ` <strong style="color:#b91c1c;">· reminders to the contractor have stopped after ${LOOK_BACK_DAYS} days; please chase them directly</strong>`
        : ""))));
  }
  if (update.unsigned.length) {
    parts.push(heading("Documents still to be signed"), list(update.unsigned.map((doc) =>
      `${escapeHtml(doc.title)} <span style="color:#64748b;">· ${escapeHtml(doc.docType)} · ${plural(doc.outstanding, "person", "people")} still to sign</span>`)));
  }
  if (update.contractorDrafts > 0) {
    parts.push(
      heading("Contractor reminders waiting for approval"),
      `<p style="margin:0 0 20px;">${plural(update.contractorDrafts, "reminder")} to contractors ${update.contractorDrafts === 1 ? "is" : "are"} waiting in ${link("/contractor-approvals", "Contractor Approvals")}.</p>`,
    );
  }
  return parts.join("");
}

function ownerUpdateHasContent(update: OwnerUpdate): boolean {
  return update.urgent.length + update.overdue.length + update.dueSoon.length + update.unassigned.length
    + update.expiring.length + update.certificates.length + update.unsigned.length + update.contractorDrafts > 0
    || (update.activity?.length ?? 0) > 0;
}

// ── Data ─────────────────────────────────────────────────────────────────────

/** DocTrack documents each staff member (with a roster email) still has to sign. */
async function docTrackSignOffs(clientId: number): Promise<Array<{ email: string; title: string }>> {
  return rowsOf<{ email: string; title: string }>(await db.execute(sql`
    SELECT lower(trim(staff.email)) AS email, d.title
    FROM doc_track_documents d
    JOIN staff_roster staff
      ON staff.client_id = d.client_id AND staff.active = true
     AND (d.department IS NULL OR staff.department = d.department)
     AND (d.site_id IS NULL OR staff.site_id = d.site_id)
    WHERE d.client_id = ${clientId} AND d.requires_acknowledgement = true
      AND NULLIF(trim(staff.email), '') IS NOT NULL
      -- Signed, and not since expired (annual documents) or removed from TrainTrack.
      AND NOT EXISTS (
        SELECT 1 FROM doc_acknowledgements ack
        LEFT JOIN train_track_records tr ON tr.id = ack.train_track_record_id AND tr.client_id = ack.client_id
        WHERE ack.client_id = d.client_id AND ack.document_id = d.id AND ack.staff_roster_id = staff.id
          AND (ack.train_track_record_id IS NULL OR tr.id IS NOT NULL)
          AND (tr.expiry_date IS NULL OR tr.expiry_date >= CURRENT_DATE)
      )
    ORDER BY d.title
  `));
}

async function activitySince(clientId: number, from: Date, to: Date): Promise<ActivityRow[]> {
  const tables = Object.keys(WORK_TABLES);
  const rows = rowsOf<{ table_name: string; person: string | null; count: number }>(await db.execute(sql`
    SELECT a.table_name, u.name AS person, count(*)::int AS count
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.changed_by
    WHERE a.client_id = ${clientId}
      AND a.changed_at >= ${from.toISOString()}::timestamptz AND a.changed_at < ${to.toISOString()}::timestamptz
      AND (
        (a.action = 'create' AND a.table_name IN (${sql.join(tables.map((table) => sql`${table}`), sql`, `)}))
        OR (a.action = 'update' AND a.table_name = 'track_actions' AND a.diff->'status'->>'after' = 'resolved')
        OR (a.action = 'update' AND a.table_name = 'fix_track_issues' AND a.diff->'status'->>'after' IN ('resolved', 'closed'))
        OR (a.action = 'update' AND a.table_name = 'compliance_items' AND a.diff->'completed_at'->>'after' IS NOT NULL)
      )
    GROUP BY a.table_name, u.name
  `));
  const label = (table: string) => WORK_TABLES[table]
    ?? (table === "track_actions" ? "Actions" : table === "fix_track_issues" ? "FixTrack" : "Compliance checks");
  return rows.map((row) => ({ track: label(row.table_name), person: row.person ?? "Staff without an account", count: Number(row.count) }));
}

// ── Job ──────────────────────────────────────────────────────────────────────

interface Recipient {
  email: string;
  name: string | null;
  userId: number | null;
  sections: PersonalSections;
  update: OwnerUpdate | null;
}

async function sendClaimed(
  clientId: number, today: string, recipient: Recipient, subject: string, html: string, send: typeof sendEmail,
): Promise<boolean> {
  const claim = await claimEmailDelivery(PERSONAL_REMINDER_JOB, `${clientId}:${today}:${recipient.email}`);
  if (!claim) return false; // already sent today, or another worker is sending it
  try {
    await send({ to: recipient.email, subject, html, clientId, idempotencyKey: emailDeliveryIdempotencyKey(claim) });
  } catch (err) {
    await settleEmailDelivery(claim).catch(() => {});
    throw err;
  }
  await markEmailDeliverySent(claim);
  return true;
}

/** Evaluate and send one business's reminders at `now`. */
export async function runPersonalRemindersForClient(
  clientId: number,
  now: Date,
  options: Pick<PersonalReminderJobOptions, "send" | "sendPush"> = {},
): Promise<Omit<PersonalReminderJobResult, "clientsChecked">> {
  const result = { personalEmails: 0, ownerUpdates: 0, bellNotifications: 0, errors: 0 };
  const timeZone = await getAccountTimezone(clientId);
  if (!inWindow(localHourIn(timeZone, now))) return result;
  // A business locked out by an ended trial can't open the reminders anyway.
  if (await isClientBillingLocked(clientId).catch(() => false)) return result;

  const send = options.send ?? sendEmail;
  const today = localDateIn(timeZone, now);
  const [{ items, urgent }, certificates, ctx, services, settingRows, clientRows] = await Promise.all([
    collectDueItems(clientId, today, now),
    // Every one outstanding, however old: chases stop after 90 days, the updates keep listing them.
    getVisitsAwaitingCertificate(clientId, { today, lookBackDays: null }).catch((err) => {
      logger.warn({ err, clientId }, "Personal reminders: could not read outstanding certificates");
      return [] as VisitAwaitingCertificate[];
    }),
    loadResponsibilityContext(clientId),
    getEntitledServices(clientId),
    db.execute(sql`
      SELECT key, value FROM app_settings
      WHERE client_id = ${clientId} AND key IN (${OWNER_UPDATE_FREQUENCY_SETTING}, ${REMINDER_TIMINGS_SETTING}, 'notificationEmail')
    `),
    db.execute(sql`SELECT name FROM clients WHERE id = ${clientId}`),
  ]);
  const settings = new Map(rowsOf<{ key: string; value: string | null }>(settingRows).map((row) => [row.key, row.value]));
  const businessName = rowsOf<{ name: string }>(clientRows)[0]?.name ?? "your business";
  const frequency = parseOwnerUpdateFrequency(settings.get(OWNER_UPDATE_FREQUENCY_SETTING));
  const updateDay = frequency === "daily" || isMonday(today);
  const storedTimings = validateReminderTimings(settings.get(REMINDER_TIMINGS_SETTING) ?? {});
  const timings: Record<string, ReminderTiming> = storedTimings.ok ? storedTimings.value : {};

  const recipients = new Map<string, Recipient>();
  const recipientFor = (email: string, user?: { id: number; name: string } | null) => {
    const key = email.trim().toLowerCase();
    let recipient = recipients.get(key);
    if (!recipient) {
      recipient = { email: key, name: user?.name ?? null, userId: user?.id ?? null, sections: emptySections(), update: null };
      recipients.set(key, recipient);
    }
    if (user && recipient.userId == null) { recipient.userId = user.id; recipient.name = user.name; }
    return recipient;
  };
  const userRecipient = (userId: number) => {
    const user = ctx.eligible.get(userId);
    return user?.email ? recipientFor(user.email, user) : null;
  };

  // Personal reminders, and the bell for group tasks coming up.
  const responsibility = new Map<string, Responsibility>();
  const bell: NewUserNotification[] = [];
  for (const item of items) {
    const who = responsibleFor(ctx, item);
    responsibility.set(item.id, who);
    const section = reminderSection(item, timings[item.module], today);
    if (item.groupRole) {
      if (section !== "upcoming" && section !== "nextWeek") continue;
      for (const userId of who.bellUserIds) {
        bell.push({
          clientId, userId, module: null, siteId: item.siteId, kind: "task_due",
          title: `Task due ${dueWhen(today, item.dueDate)}: ${item.title}`,
          body: item.siteName ? `At ${item.siteName}.` : null,
          linkPath: item.linkPath, dedupeKey: `task_due:${item.id}`,
        });
      }
      continue;
    }
    if (!section) continue;
    for (const userId of who.userIds) userRecipient(userId)?.sections[section].push(item);
  }
  // A missing certificate: on each chase day (two weeks after the visit, then every two weeks).
  for (const visit of certificates) {
    if (certificateChaseOn(visit.visitDay, today) == null) continue;
    for (const userId of responsibleForCertificate(ctx, visit)) userRecipient(userId)?.sections.certificates.push(visit);
  }

  // Documents to sign, by staff roster email.
  const signs = isEntitled(services, "safetrack") || isEntitled(services, "doctrack");
  if (signs) {
    try {
      for (const staff of await getOutstandingSafeTrackStaffReminders(clientId)) {
        recipientFor(staff.email).sections.signOffs.push(...staff.documents);
      }
      for (const row of await docTrackSignOffs(clientId)) {
        recipientFor(row.email).sections.signOffs.push({ title: row.title, docType: "DocTrack document", siteName: null });
      }
    } catch (err) {
      logger.warn({ err, clientId }, "Personal reminders: could not read documents to sign");
    }
  }

  // Owner and Manager updates.
  if (updateDay) {
    const period = frequency === "daily" ? "day" : "week";
    const horizon = addCalendarDays(today, period === "week" ? 6 : 1);
    const [activity, unsigned, drafts] = await Promise.all([
      activitySince(clientId, new Date(now.getTime() - (period === "week" ? 7 : 1) * MS_DAY), now).catch((err) => {
        logger.warn({ err, clientId }, "Personal reminders: could not read last week's activity");
        return [] as ActivityRow[];
      }),
      signs ? Promise.all([
        getOutstandingSafeTrackAcknowledgements(clientId),
        getOutstandingAckSummary(clientId),
      ]).then(([safe, doc]) => [
        ...safe.map((row) => ({ title: row.title, docType: row.docType, outstanding: row.outstandingCount })),
        ...doc.map((row) => ({ title: row.title, docType: "DocTrack document", outstanding: row.outstanding.length })),
      ].filter((row) => row.outstanding > 0)).catch((err) => {
        logger.warn({ err, clientId }, "Personal reminders: could not read unsigned documents");
        return [];
      }) : Promise.resolve([]),
      db.execute(sql`SELECT count(*)::int AS count FROM contractor_email_queue WHERE client_id = ${clientId} AND status = 'pending'`)
        .then((rows) => Number(rowsOf<{ count: number }>(rows)[0]?.count ?? 0)).catch(() => 0),
    ]);
    const build = (visible: (siteId: number | null) => boolean, full: boolean): OwnerUpdate => {
      const mine = items.filter((item) => visible(item.siteId));
      const held = (item: DueItem) => ({ item, holder: responsibility.get(item.id)?.holder ?? null });
      return {
        period,
        urgent: urgent.filter((item) => visible(item.siteId)),
        overdue: mine.filter((item) => item.kind === "due" && item.dueDate < today).map(held),
        dueSoon: mine.filter((item) => item.kind === "due" && item.dueDate >= today && item.dueDate <= horizon).map(held),
        unassigned: mine.filter((item) => item.kind === "due" && item.dueDate <= addCalendarDays(today, 13)
          && responsibility.get(item.id)?.unassigned),
        expiring: mine.filter((item) => item.kind === "expiry"),
        certificates: certificates.filter((visit) => visible(visit.siteId)),
        unsigned: full ? unsigned : [],
        contractorDrafts: full ? drafts : 0,
        activity: full ? activity : null,
      };
    };
    const everything = () => true;
    const notificationEmail = settings.get("notificationEmail")?.trim();
    if (notificationEmail) {
      recipientFor(notificationEmail).update = build(everything, true);
    } else {
      for (const id of ctx.ownerIds) {
        const recipient = userRecipient(id);
        if (recipient) recipient.update = build(everything, true);
      }
    }
    for (const user of ctx.eligible.values()) {
      if (user.role !== "client_manager" || !user.email) continue;
      const recipient = recipientFor(user.email, user);
      if (recipient.update) continue;
      const sees = (siteId: number | null) => siteId == null || candidateCanSeeSite(user, ctx.siteDepartments.get(siteId), siteId);
      const update = build(sees, user.allDepartments === true);
      // Contractor documents go to whoever looks after contractors.
      if (!ctx.maintenanceManagerIds.includes(user.id)) update.expiring = update.expiring.filter((item) => item.module !== CONTRACTORS_MODULE);
      recipient.update = update;
    }
  }

  if (bell.length) {
    try {
      result.bellNotifications += await createUserNotifications(bell, { sendPush: options.sendPush });
    } catch (err) {
      result.errors++;
      logger.warn({ err, clientId }, "Personal reminders: could not create task notifications");
    }
  }

  const appUrl = getPublicAppUrl();
  for (const recipient of recipients.values()) {
    const update = recipient.update && ownerUpdateHasContent(recipient.update) ? recipient.update : null;
    const personal = hasReminders(recipient.sections)
      || (recipient.sections.signOffs.length > 0 && (isMonday(today) || update != null));
    if (!update && !personal) continue;
    const greeting = `<p style="margin:0 0 16px;">Hello${recipient.name ? ` ${escapeHtml(recipient.name.split(" ")[0]!)}` : ""},</p>`;
    let subject: string;
    let body: string;
    if (update) {
      const label = update.period === "week" ? "Weekly update" : "Daily update";
      subject = `${label} for ${businessName} — ComplyTrack`;
      body = greeting
        + `<p style="margin:0 0 8px;">Here is ${update.period === "week" ? "this week's" : "today's"} update for ${escapeHtml(businessName)}.</p>`
        + (personal ? `${heading("Yours to do", "#4f46e5")}${personalHtml(recipient.sections, today)}` : "")
        + ownerUpdateHtml(update, today);
    } else {
      const upcoming = recipient.sections.upcoming;
      const allTomorrow = upcoming.every((item) => item.dueDate === addCalendarDays(today, 1));
      const certificateCount = recipient.sections.certificates.length;
      const onlyCertificates = certificateCount > 0 && !recipient.sections.nextWeek.length
        && !recipient.sections.overdue.length && !recipient.sections.expiring.length;
      subject = recipient.sections.urgent.length
        ? `Needs action now at ${businessName} — ComplyTrack`
        : upcoming.length
          ? `${allTomorrow ? "Due tomorrow" : "Coming up"}: ${plural(upcoming.length, "item")} at ${businessName} — ComplyTrack`
          : recipient.sections.nextWeek.length
            ? `Due next week: ${plural(recipient.sections.nextWeek.length, "item")} at ${businessName} — ComplyTrack`
          : onlyCertificates
            ? `${certificateCount === 1 ? "A certificate" : "Certificates"} outstanding at ${businessName} — ComplyTrack`
          : `Your reminders for ${businessName} — ComplyTrack`;
      body = greeting
        + `<p style="margin:0 0 8px;">This is what needs doing at ${escapeHtml(businessName)}.</p>`
        + personalHtml(recipient.sections, today);
    }
    const html = renderEmailLayout({
      subtitle: escapeHtml(update ? `${businessName} · ${formatDay(today)}` : formatDay(today)),
      bodyHtml: `${body}<div style="margin-top:24px;">${emailButton(appUrl, "Open ComplyTrack")}</div>`,
      footerNote: update
        ? "Settings → Reminder Notifications sets whether this comes weekly or daily"
        : "You get this because these are assigned to you",
    });
    try {
      if (await sendClaimed(clientId, today, recipient, subject, html, send)) {
        if (update) result.ownerUpdates++;
        else result.personalEmails++;
      }
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Personal reminder email failed");
    }
  }
  return result;
}

export async function runPersonalReminderJob(options: PersonalReminderJobOptions = {}): Promise<PersonalReminderJobResult> {
  const now = options.now ?? new Date();
  const result: PersonalReminderJobResult = { clientsChecked: 0, personalEmails: 0, ownerUpdates: 0, bellNotifications: 0, errors: 0 };
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
      const sent = await runPersonalRemindersForClient(Number(client.id), now, options);
      result.personalEmails += sent.personalEmails;
      result.ownerUpdates += sent.ownerUpdates;
      result.bellNotifications += sent.bellNotifications;
      result.errors += sent.errors;
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Personal reminder evaluation failed");
    }
  }
  try {
    await pruneSentEmailDeliveries(PERSONAL_REMINDER_JOB, SENT_MARKER_DAYS);
  } catch (err) {
    logger.warn({ err }, "Could not prune personal reminder markers");
  }
  return result;
}
