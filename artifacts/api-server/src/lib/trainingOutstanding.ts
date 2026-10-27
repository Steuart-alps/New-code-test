/**
 * Each staff roster member's outstanding training, for the Monday reminder
 * to the staff member (by their roster email) and the TrainTrack section of
 * the Owner and Manager updates (lib/personalReminders.ts):
 *   - expired: their latest record of a training has expired;
 *   - expiring: it expires within the lead time (30 days by default, or
 *     Settings → Reminder Notifications "Staff training expiring");
 *   - to sign: TrainTrack sign-off and in-house training records still
 *     waiting for their signature in My training (only people whose account
 *     is linked to the roster can sign there);
 *   - COSHH assessments they still have to read and sign (COSHHTrack).
 *
 * Records are matched to the roster by their roster link, or by name when
 * exactly one active roster member has that name (as the training matrix
 * does). Inactive roster members are left out. Document and COSHH sign-off
 * records aren't listed as expiring: those documents are asked for again
 * under "documents to read and sign" (lib/docSignOffs.ts).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { addCalendarDays } from "./accountClock";
import { getCoshhSignOffOverview, signOffTitle } from "./coshhSignOffs";
import { logger } from "./logger";

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
const day = (value: unknown) => (value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10));
const normalName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

export interface TrainingExpiry { title: string; expiryDate: string }

export interface StaffTraining {
  staffRosterId: number;
  name: string;
  /** Roster email, lower-cased; null when none is recorded. */
  email: string | null;
  siteId: number | null;
  siteName: string | null;
  /** Whether a user account is linked to this roster entry (they can open My training). */
  hasAccount: boolean;
  expired: TrainingExpiry[];
  expiring: TrainingExpiry[];
  /** Training records waiting for their signature in My training. */
  toSign: string[];
  /** COSHH assessments they still have to read and sign. */
  coshh: string[];
}

export const hasOutstandingTraining = (person: StaffTraining) =>
  person.expired.length + person.expiring.length + person.toSign.length + person.coshh.length > 0;

export async function collectOutstandingTraining(
  clientId: number,
  today: string,
  options: { leadDays: number; trainTrack: boolean; coshhTrack: boolean },
): Promise<StaffTraining[]> {
  if (!options.trainTrack && !options.coshhTrack) return [];
  const roster = rowsOf<{ id: number; name: string; email: string | null; site_id: number | null; site_name: string | null; has_account: boolean }>(
    await db.execute(sql`
      SELECT sr.id, sr.name, NULLIF(lower(trim(sr.email)), '') AS email, sr.site_id, s.name AS site_name,
        EXISTS (SELECT 1 FROM users u WHERE u.client_id = sr.client_id AND u.staff_roster_id = sr.id AND u.active = true) AS has_account
      FROM staff_roster sr
      LEFT JOIN sites s ON s.id = sr.site_id AND s.client_id = sr.client_id
      WHERE sr.client_id = ${clientId} AND sr.active = true
      ORDER BY sr.name, sr.id
    `),
  );
  const people = new Map<number, StaffTraining>(roster.map((row) => [Number(row.id), {
    staffRosterId: Number(row.id), name: row.name, email: row.email,
    siteId: row.site_id == null ? null : Number(row.site_id), siteName: row.site_name ?? null,
    hasAccount: !!row.has_account, expired: [], expiring: [], toSign: [], coshh: [],
  }]));
  const byName = new Map<string, number[]>();
  for (const person of people.values()) {
    const key = normalName(person.name);
    byName.set(key, [...(byName.get(key) ?? []), person.staffRosterId]);
  }
  const rosterIdOf = (linked: number | null, staffName: string) => {
    if (linked != null) return people.has(linked) ? linked : null;
    const matches = byName.get(normalName(staffName)) ?? [];
    return matches.length === 1 ? matches[0]! : null;
  };

  if (options.trainTrack) {
    const records = rowsOf<{
      id: number; staff_roster_id: number | null; staff_name: string; title: string; record_type: string;
      completed_date: unknown; expiry_date: unknown; signed: boolean; document_sign_off: boolean;
    }>(await db.execute(sql`
      SELECT r.id, r.staff_roster_id, r.staff_name, COALESCE(r.training_type, r.document_title, 'Training') AS title, r.record_type,
        r.completed_date, r.expiry_date, r.signature IS NOT NULL AS signed,
        (EXISTS (SELECT 1 FROM doc_acknowledgements a WHERE a.client_id = r.client_id AND a.train_track_record_id = r.id)
          OR EXISTS (SELECT 1 FROM coshh_acknowledgements a WHERE a.client_id = r.client_id AND a.train_track_record_id = r.id)) AS document_sign_off
      FROM train_track_records r
      WHERE r.client_id = ${clientId}
      ORDER BY r.completed_date DESC, r.id DESC
    `));
    const horizon = addCalendarDays(today, Math.max(0, options.leadDays));
    // Newest first, so the first record of each training per person is the current one.
    const seen = new Set<string>();
    for (const record of records) {
      const rosterId = rosterIdOf(record.staff_roster_id == null ? null : Number(record.staff_roster_id), record.staff_name);
      if (rosterId == null) continue;
      const person = people.get(rosterId)!;
      // Signing in My training needs the record's roster link and an account.
      if (!record.signed && record.staff_roster_id != null && person.hasAccount
        && (record.record_type === "signoff" || record.record_type === "internal")) {
        person.toSign.push(record.title);
      }
      if (record.document_sign_off) continue;
      const key = `${rosterId}:${record.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const expiry = day(record.expiry_date);
      if (!expiry || expiry > horizon) continue;
      (expiry < today ? person.expired : person.expiring).push({ title: record.title, expiryDate: expiry });
    }
  }

  if (options.coshhTrack) {
    try {
      for (const assessment of await getCoshhSignOffOverview(clientId, null)) {
        const title = signOffTitle({ task: assessment.task, product_name: assessment.productName, revision: assessment.revision })
          .replace(/^COSHH assessment: /, "");
        for (const member of assessment.outstanding) people.get(member.staffRosterId)?.coshh.push(title);
      }
    } catch (err) {
      logger.warn({ err, clientId }, "Outstanding training: could not read COSHH sign-offs");
    }
  }

  for (const person of people.values()) {
    person.expired.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
    person.expiring.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  }
  return [...people.values()].filter(hasOutstandingTraining);
}
