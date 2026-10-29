import { randomBytes } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * Drawn signatures on recorded checks. Every check, inspection and test that
 * the web app saves must be signed by the person logged in, with a finger or
 * mouse, so a record is never just a typed or picked name.
 *
 * The flow works for every track without changing each route:
 *  1. A save listed in SIGNED_RECORD_ROUTES arrives without a signature: the
 *     gate (middleware/recordSignatureGate.ts) answers 428 SIGNATURE_REQUIRED.
 *  2. The web app shows its "Sign to save" box. The drawing is posted to
 *     POST /record-signatures, which stores it under a one-use token tied to
 *     the user and business.
 *  3. The app sends the same save again with the token in X-Record-Signature.
 *     The gate claims the token, and when the save succeeds it links the
 *     signature to the record the route created or submitted.
 *
 * Phone-app (bearer) requests are not asked yet; the phone app is after launch.
 */

export const SIGNATURE_HEADER = "x-record-signature";
export const SIGNATURE_REQUIRED_CODE = "SIGNATURE_REQUIRED";

/** Strokes are points in this box: [x, y, x, y, ...] per stroke, whole numbers. */
export const SIGNATURE_BOX = { width: 600, height: 200 } as const;
const MAX_STROKES = 80;
const MAX_POINTS = 4000;
/** Shorter than this (in box units) is a tap or a dot, not a signature. */
const MIN_INK_LENGTH = 40;
/** A staged signature must be used within this long. */
export const SIGNATURE_TOKEN_MINUTES = 30;

export type Strokes = number[][];

/** The strokes if `value` is a usable signature drawing, else null. */
export function parseStrokes(value: unknown): Strokes | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STROKES) return null;
  let points = 0;
  let ink = 0;
  const strokes: Strokes = [];
  for (const stroke of value) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length % 2 !== 0) return null;
    points += stroke.length / 2;
    if (points > MAX_POINTS) return null;
    const clean: number[] = [];
    for (let i = 0; i < stroke.length; i += 2) {
      const x = stroke[i];
      const y = stroke[i + 1];
      if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
      if (x < 0 || x > SIGNATURE_BOX.width || y < 0 || y > SIGNATURE_BOX.height) return null;
      if (i > 0) ink += Math.hypot(x - clean[clean.length - 2], y - clean[clean.length - 1]);
      clean.push(x, y);
    }
    strokes.push(clean);
  }
  return ink >= MIN_INK_LENGTH ? strokes : null;
}

/** SVG path data for strokes (for exports); built only from validated numbers. */
export function strokesToSvgPath(strokes: Strokes): string {
  return strokes.map(stroke => {
    const parts = [`M${stroke[0]} ${stroke[1]}`];
    for (let i = 2; i < stroke.length; i += 2) parts.push(`L${stroke[i]} ${stroke[i + 1]}`);
    if (stroke.length === 2) parts.push(`L${stroke[0] + 1} ${stroke[1]}`);
    return parts.join("");
  }).join("");
}

export function newSignatureToken(): string {
  return randomBytes(24).toString("base64url");
}

type SignedRoute = {
  method: "POST" | "PUT" | "PATCH";
  /** Canonical path under /api (see canonicalTrackPath). Group 1 is the record id for "path" routes. */
  path: RegExp;
  recordType: string;
  /**
   * The record's table and its site, as SQL over the alias `record`. Both are
   * fixed identifiers here and never come from a request.
   */
  table: string;
  site: string;
  /**
   * always: every save. submitting: only when the body sets submittedAt (a
   * draft being submitted; for an existing record, only if it was not already
   * submitted). completing: only when the body sets status "completed".
   */
  when: "always" | "submitting" | "completing";
  /** Where the saved record's id is: the route path, or the JSON response. */
  id: "path" | ((body: any) => unknown);
};

const RECORD_SITE = "record.site_id";
const MACHINE_SITE = "(SELECT m.site_id FROM green_machines m WHERE m.id = record.machine_id AND m.client_id = record.client_id)";
const fromBody = (body: any) => body?.id;

/**
 * Every web save that records a check. Set-up (machines, rooms, outlets,
 * products), observations and incidents are not checks and are not signed.
 * Actions and FixTrack jobs already have their own signature when closed;
 * training and document read-and-sign already have a signature box.
 */
export const SIGNED_RECORD_ROUTES: readonly SignedRoute[] = [
  { method: "POST", path: /^\/fire-safety$/, recordType: "fire_safety_check", table: "fire_safety_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/legionella$/, recordType: "legionella_check", table: "legionella_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/hot-tub$/, recordType: "hot_tub_check", table: "hot_tub_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/pool-track$/, recordType: "pool_check", table: "pool_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/tree-track$/, recordType: "tree_inspection", table: "tree_inspections", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/premises-track$/, recordType: "premises_inspection", table: "premises_inspections", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/room-track\/checks$/, recordType: "room_check", table: "room_track_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/coshh-track\/checks$/, recordType: "coshh_check", table: "coshh_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/pat-track\/tests$/, recordType: "pat_test", table: "pat_tests", site: "record.site_id_snapshot", when: "always", id: fromBody },
  { method: "POST", path: /^\/pest-track\/visits$/, recordType: "pest_visit", table: "pest_visits", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/bike-track\/services$/, recordType: "bike_service", table: "bike_services", site: "(SELECT b.site_id FROM bikes b WHERE b.id = record.bike_id AND b.client_id = record.client_id)", when: "always", id: fromBody },
  { method: "POST", path: /^\/bike-track\/hires$/, recordType: "bike_hire", table: "bike_hire_records", site: RECORD_SITE, when: "always", id: (body: any) => body?.hire?.id },
  { method: "POST", path: /^\/bike-track\/hires\/(\d+)\/return$/, recordType: "bike_return", table: "bike_hire_records", site: RECORD_SITE, when: "always", id: "path" },
  { method: "POST", path: /^\/green-track\/pre-use-checks$/, recordType: "green_pre_use_check", table: "green_pre_use_checks", site: MACHINE_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/green-track\/service-records$/, recordType: "green_service_record", table: "green_service_records", site: MACHINE_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/green-track\/puwer-inspections$/, recordType: "green_puwer_inspection", table: "green_puwer_inspections", site: MACHINE_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/green-track\/applications$/, recordType: "green_application", table: "green_applications", site: MACHINE_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/green-track\/shed-checks$/, recordType: "daily_checklist", table: "daily_checklists", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/green-track\/shed-checks\/(\d+)$/, recordType: "daily_checklist", table: "daily_checklists", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/swim-track\/sessions$/, recordType: "swim_session", table: "swim_sessions", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/swim-track\/surveillance$/, recordType: "swim_surveillance_check", table: "swim_surveillance_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/swim-track\/first-aid$/, recordType: "swim_first_aid_check", table: "swim_first_aid_checks", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/kitchen-weekly\/weekly$/, recordType: "kitchen_weekly_review", table: "kitchen_weekly_records", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/kitchen-weekly\/weekly\/(\d+)$/, recordType: "kitchen_weekly_review", table: "kitchen_weekly_records", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/kitchen-weekly\/probe$/, recordType: "kitchen_probe_check", table: "kitchen_probe_checks", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/kitchen-weekly\/probe\/(\d+)$/, recordType: "kitchen_probe_check", table: "kitchen_probe_checks", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/kitchen-cleaning\/logs$/, recordType: "kitchen_cleaning_log", table: "kitchen_cleaning_logs", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "POST", path: /^\/daily-track-am$/, recordType: "daily_checklist", table: "daily_checklists", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/daily-track-am\/(\d+)$/, recordType: "daily_checklist", table: "daily_checklists", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/daily-track-pm$/, recordType: "daily_checklist", table: "daily_checklists", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/daily-track-pm\/(\d+)$/, recordType: "daily_checklist", table: "daily_checklists", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/daily-track-pm\/signoffs$/, recordType: "daily_manager_signoff", table: "daily_manager_signoffs", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/daily-track-pm\/signoffs\/(\d+)$/, recordType: "daily_manager_signoff", table: "daily_manager_signoffs", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/food-safety$/, recordType: "food_safety_record", table: "food_safety_records", site: RECORD_SITE, when: "submitting", id: fromBody },
  { method: "PUT", path: /^\/food-safety\/(\d+)$/, recordType: "food_safety_record", table: "food_safety_records", site: RECORD_SITE, when: "submitting", id: "path" },
  { method: "POST", path: /^\/daily-checklists\/\d+\/[^/]+\/(?:am|pm)$/, recordType: "daily_checklist_submission", table: "daily_checklist_submissions", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "POST", path: /^\/daily-checklists\/\d+\/[^/]+\/pm\/sign-off$/, recordType: "daily_checklist_submission", table: "daily_checklist_submissions", site: RECORD_SITE, when: "always", id: fromBody },
  { method: "PATCH", path: /^\/compliance-items\/(\d+)\/status$/, recordType: "compliance_item_completion", table: "compliance_items", site: RECORD_SITE, when: "completing", id: "path" },
];

/** Record types the app can ask about (for history and exports). */
export const SIGNED_RECORD_TYPES: ReadonlySet<string> = new Set(SIGNED_RECORD_ROUTES.map(route => route.recordType));

export type SignedRouteMatch = { route: SignedRoute; pathId: number | null };

export function matchSignedRoute(method: string, canonicalPath: string): SignedRouteMatch | null {
  for (const route of SIGNED_RECORD_ROUTES) {
    if (route.method !== method) continue;
    const match = route.path.exec(canonicalPath);
    if (!match) continue;
    const pathId = match[1] ? Number(match[1]) : null;
    if (route.id === "path" && (pathId === null || !Number.isSafeInteger(pathId))) return null;
    return { route, pathId };
  }
  return null;
}

/**
 * Whether this save must be signed. A "submitting" save of an existing record
 * that was already submitted is not asked again (its route refuses or keeps it).
 */
export async function saveNeedsSignature(match: SignedRouteMatch, body: unknown, clientId: number): Promise<boolean> {
  const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const { route, pathId } = match;
  if (route.when === "always") return true;
  if (route.when === "completing") return fields.status === "completed";
  if (!fields.submittedAt) return false;
  if (pathId === null) return true;
  const result = await db.execute(sql`
    SELECT record.submitted_at FROM ${sql.raw(`"${route.table}"`)} AS record
    WHERE record.id = ${pathId} AND record.client_id = ${clientId}
  `);
  const row = (result.rows ?? [])[0] as { submitted_at: unknown } | undefined;
  return row !== undefined && row.submitted_at == null;
}

/**
 * Claims a staged signature for one save. A claim left by a save that never
 * answered is taken over after two minutes. Returns the signature row id.
 */
export async function claimSignature(token: string, clientId: number, userId: number): Promise<number | null> {
  const result = await db.execute(sql`
    UPDATE record_signatures SET claimed_at = now()
    WHERE token = ${token} AND client_id = ${clientId} AND user_id = ${userId}
      AND record_id IS NULL
      AND created_at > now() - make_interval(mins => ${SIGNATURE_TOKEN_MINUTES})
      AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
    RETURNING id
  `);
  const row = (result.rows ?? [])[0] as { id: number } | undefined;
  return row?.id ?? null;
}

/** Lets the same signature be used again after a save that failed. */
export async function releaseSignature(signatureId: number): Promise<void> {
  await db.execute(sql`UPDATE record_signatures SET claimed_at = NULL WHERE id = ${signatureId} AND record_id IS NULL`);
}

/** Links a claimed signature to the record its save created or submitted. */
export async function linkSignature(signatureId: number, route: SignedRoute, recordId: number, clientId: number): Promise<boolean> {
  const table = sql.raw(`"${route.table}"`);
  const site: SQL = sql.raw(route.site);
  const result = await db.execute(sql`
    UPDATE record_signatures SET
      record_type = ${route.recordType},
      record_id = ${recordId},
      signed_at = now(),
      site_id = (SELECT ${site} FROM ${table} AS record WHERE record.id = ${recordId} AND record.client_id = ${clientId})
    WHERE id = ${signatureId} AND client_id = ${clientId} AND record_id IS NULL
      AND EXISTS (SELECT 1 FROM ${table} AS record WHERE record.id = ${recordId} AND record.client_id = ${clientId})
    RETURNING id
  `);
  return (result.rows ?? []).length > 0;
}

/** Signatures drawn but never used by a save are removed after a day. */
export async function pruneUnusedSignatures(clientId: number): Promise<void> {
  await db.execute(sql`
    DELETE FROM record_signatures
    WHERE client_id = ${clientId} AND record_id IS NULL AND created_at < now() - interval '1 day'
  `);
}
