/**
 * Contractors logging their tests through a link (PATrack first).
 *
 * A manager sets up a visit for one site and emails the contractor a link.
 * On the day the contractor signs in at the site through that link (fire
 * procedure, asbestos register, signature: routes/contractor-sign-in.ts), and
 * only then can log a pass or fail for each appliance. Every result is saved
 * straight onto PATrack as a test "by <name> (<company>) via contractor link",
 * so a fail raises its action the same day. To finish, the contractor uploads
 * their own certificate (now or later) and signs off, which records the
 * certificate on PATrack with each failed appliance.
 *
 *   /api/contractor-tests/:token             public, the link token is the only credential
 *   /api/pat-track/contractor-visits/...     signed in; set up, follow and end visits
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { PAT_APPLIANCE_TYPES } from "@workspace/db/schema";
import { denyViewers, getActiveDepartmentId, getClientId } from "../middleware/requireAuth";
import { siteVisibleSql } from "../lib/departmentSites";
import { digestBearerToken, newBearerToken } from "../lib/bearerTokens";
import { siteSignInLinkSubmitRateLimit, siteSignInSubmitRateLimit } from "../lib/loginRateLimit";
import { createUserNotifications } from "../lib/userNotifications";
import { dispatchStoredContractorEmail } from "../lib/fixTrackNotifications";
import { emailButton, escapeHtml, getPublicAppUrl } from "../lib/email";
import { addCalendarDays, getAccountToday } from "../lib/accountClock";
import { checkCertificateFile, EXTENSIONS, MAX_INBOX_FILE_BYTES } from "../lib/certificateInbox";
import { ObjectContentError, ObjectStorageService } from "../lib/objectStorage";
import { StorageFullError } from "../lib/storageFull";
import { ensureUploadCapacity } from "../lib/storageLimit";
import { ON_SITE_HOURS, SIGNATURE, contractorNoticeRecipients, loadBriefing, recordSignIn } from "./contractor-sign-in";

/** The link keeps working this many days after the last visit day. */
export const LINK_DAYS_AFTER_VISIT = 2;
/** After sign-off the link still takes the certificate for this long. */
export const CERTIFICATE_DAYS_AFTER_SIGN_OFF = 30;
/** A visit can be at most this many days long. */
const MAX_VISIT_DAYS = 31;
const LINK_TOKEN = /^[a-f0-9]{64}$/;
const SIGN_IN_TOKEN = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SIGN_IN_HEADER = "x-contractor-sign-in";

const storage = new ObjectStorageService();
const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
export const contractorTestsUrl = (token: string) => `${getPublicAppUrl()}/contractor-tests/${token}`;
const storageUrl = (objectPath: string) => `${getPublicAppUrl()}/api/storage${objectPath}`;

/** The end of the day LINK_DAYS_AFTER_VISIT days after the visit ends (UTC, so never early in the UK). */
function linkExpiry(endsOn: string): Date {
  return new Date(`${addCalendarDays(endsOn, LINK_DAYS_AFTER_VISIT)}T23:59:59Z`);
}

const dayText = (iso: string | null | undefined) => iso
  ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
  : "";
const visitDays = (startsOn: string, endsOn: string) => startsOn === endsOn ? dayText(startsOn) : `${dayText(startsOn)} to ${dayText(endsOn)}`;
const testerText = (name: string, company: string) => `${name} (${company}) via contractor link`;

/** The business's PATrack settings the contractor's form follows. */
async function patSettings(clientId: number) {
  const rows = rowsOf<{ key: string; value: string | null }>(await db.execute(sql`
    SELECT key, value FROM app_settings
    WHERE client_id = ${clientId} AND key IN ('pat_retest_months', 'pat_show_earth_bond', 'pat_show_insulation')
  `));
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  const months = Number(value("pat_retest_months"));
  return {
    retestMonths: Number.isInteger(months) && months > 0 && months <= 120 ? months : 12,
    showEarthBond: value("pat_show_earth_bond") !== "false",
    showInsulation: value("pat_show_insulation") !== "false",
  };
}

function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// ── Public link ──────────────────────────────────────────────────────────────

interface LinkedVisit {
  id: number;
  client_id: number;
  site_id: number;
  site_name: string;
  business_name: string;
  module: string;
  contractor_id: number | null;
  contractor_name: string;
  starts_on: string;
  ends_on: string;
  status: "open" | "signed_off" | "ended";
  expired: boolean;
  certificate_window_open: boolean;
  fire_procedure: string | null;
  signed_off_at: Date | null;
  signed_off_name: string | null;
  signed_off_company: string | null;
  certificate_ref: string | null;
  next_test_due: string | null;
  certificate_object_path: string | null;
  certificate_file_name: string | null;
  pat_certificate_id: number | null;
  created_by: number | null;
}

const LINK_GONE = "This testing link is no longer active. Please ask the site for a new one.";

async function findVisit(token: string): Promise<LinkedVisit | null> {
  if (!LINK_TOKEN.test(token)) return null;
  const [visit] = rowsOf<LinkedVisit>(await db.execute(sql`
    SELECT v.id, v.client_id, v.site_id, s.name AS site_name,
      coalesce(nullif(trim((SELECT a.value FROM app_settings a WHERE a.client_id = c.id AND a.key = 'companyName')), ''), c.name) AS business_name,
      v.module, v.contractor_id, v.contractor_name, v.starts_on::text AS starts_on, v.ends_on::text AS ends_on, v.status,
      (v.expires_at <= now()) AS expired,
      (v.signed_off_at > now() - make_interval(days => ${CERTIFICATE_DAYS_AFTER_SIGN_OFF})) AS certificate_window_open,
      si.fire_procedure, v.signed_off_at, v.signed_off_name, v.signed_off_company, v.certificate_ref,
      v.next_test_due::text AS next_test_due, v.certificate_object_path, v.certificate_file_name, v.pat_certificate_id, v.created_by
    FROM contractor_test_visits v
    JOIN sites s ON s.id = v.site_id AND s.client_id = v.client_id
    JOIN clients c ON c.id = v.client_id AND c.active = true
    LEFT JOIN contractor_sign_in_sites si ON si.site_id = v.site_id AND si.client_id = v.client_id
    WHERE v.link_token_hash = ${digestBearerToken(token)}
    LIMIT 1
  `));
  return visit ?? null;
}

/** The visit behind the link, while the link may still be used for this kind of request. */
async function linkedVisit(req: Request, res: Response, use: "read" | "test" | "certificate"): Promise<LinkedVisit | null> {
  const visit = await findVisit(String(req.params.token ?? ""));
  const usable = visit && (
    visit.status === "open" ? !visit.expired
      : visit.status === "signed_off" ? (use !== "test" && visit.certificate_window_open)
        : false);
  if (!visit || !usable) {
    res.status(404).json({ error: LINK_GONE });
    return null;
  }
  return visit;
}

interface Tester { id: number; name: string; company: string }

/** The contractor signed in on this phone for this visit, still on site; else 401. */
async function signedInTester(req: Request, res: Response, visit: LinkedVisit): Promise<Tester | null> {
  const token = String(req.get(SIGN_IN_HEADER) ?? "");
  const [row] = SIGN_IN_TOKEN.test(token) ? rowsOf<Tester>(await db.execute(sql`
    SELECT id, visitor_name AS name, company FROM contractor_sign_ins
    WHERE sign_out_token_hash = ${digestBearerToken(token)}
      AND client_id = ${visit.client_id} AND contractor_test_visit_id = ${visit.id}
      AND signed_out_at IS NULL AND signed_in_at > now() - make_interval(hours => ${ON_SITE_HOURS})
    LIMIT 1
  `)) : [];
  if (!row) {
    res.status(401).json({ error: "Please sign in at the site before logging tests.", code: "SIGN_IN_REQUIRED" });
    return null;
  }
  return row;
}

export const contractorTestsPublicRouter = Router();

contractorTestsPublicRouter.get("/:token", async (req, res) => {
  const visit = await linkedVisit(req, res, "read");
  if (!visit) return;
  const [briefing, settings] = await Promise.all([
    loadBriefing(visit.client_id, visit.site_id, visit.fire_procedure),
    patSettings(visit.client_id),
  ]);
  res.json({
    module: visit.module,
    businessName: visit.business_name,
    siteName: visit.site_name,
    contractorName: visit.contractor_name,
    startsOn: visit.starts_on,
    endsOn: visit.ends_on,
    status: visit.status,
    hasCertificate: !!visit.certificate_object_path,
    certificateFileName: visit.certificate_file_name,
    signedOff: visit.status === "signed_off" ? {
      at: visit.signed_off_at,
      name: visit.signed_off_name,
      company: visit.signed_off_company,
      certificateRef: visit.certificate_ref,
      nextTestDue: visit.next_test_due,
    } : null,
    maxCertificateBytes: MAX_INBOX_FILE_BYTES,
    applianceTypes: PAT_APPLIANCE_TYPES,
    ...settings,
    fireProcedure: briefing.fireProcedure,
    asbestos: briefing.asbestos,
    version: briefing.version,
  });
});

contractorTestsPublicRouter.post("/:token/sign-in", siteSignInSubmitRateLimit, siteSignInLinkSubmitRateLimit, async (req, res) => {
  const visit = await linkedVisit(req, res, "test");
  if (!visit) return;
  const outcome = await recordSignIn(req, {
    clientId: visit.client_id, siteId: visit.site_id, siteName: visit.site_name, fireProcedure: visit.fire_procedure,
  }, { visitReason: "PAT testing", ...(req.body ?? {}) }, { contractorTestVisitId: visit.id, contractorId: visit.contractor_id });
  res.status(outcome.status).json(outcome.body);
});

const SignInKeyBody = z.object({ signOutToken: z.string().regex(SIGN_IN_TOKEN) });

async function ownSignIn(req: Request, res: Response, visit: LinkedVisit) {
  const parsed = SignInKeyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request" }); return null; }
  const [row] = rowsOf<{ id: number; name: string; company: string; signed_in_at: Date; signed_out_at: Date | null; on_site: boolean }>(await db.execute(sql`
    SELECT id, visitor_name AS name, company, signed_in_at, signed_out_at,
      (signed_out_at IS NULL AND signed_in_at > now() - make_interval(hours => ${ON_SITE_HOURS})) AS on_site
    FROM contractor_sign_ins
    WHERE sign_out_token_hash = ${digestBearerToken(parsed.data.signOutToken)}
      AND client_id = ${visit.client_id} AND contractor_test_visit_id = ${visit.id}
    LIMIT 1
  `));
  if (!row) { res.status(404).json({ error: "We couldn't find your sign-in. Please sign in again." }); return null; }
  return row;
}

/** The contractor's sign-in on this phone, from the key it kept. */
contractorTestsPublicRouter.post("/:token/session", async (req, res) => {
  const visit = await linkedVisit(req, res, "read");
  if (!visit) return;
  const row = await ownSignIn(req, res, visit);
  if (!row) return;
  res.json({ name: row.name, company: row.company, signedInAt: row.signed_in_at, signedOutAt: row.signed_out_at, onSite: row.on_site });
});

contractorTestsPublicRouter.post("/:token/sign-out", async (req, res) => {
  const visit = await linkedVisit(req, res, "read");
  if (!visit) return;
  const row = await ownSignIn(req, res, visit);
  if (!row) return;
  const [updated] = rowsOf<{ signed_out_at: Date }>(await db.execute(sql`
    UPDATE contractor_sign_ins SET signed_out_at = now()
    WHERE id = ${row.id} AND signed_out_at IS NULL
    RETURNING signed_out_at
  `));
  res.json({ signedOutAt: updated?.signed_out_at ?? row.signed_out_at });
});

interface ItemRow {
  id: number; name: string; appliance_type: string; location: string | null; asset_tag: string | null;
  last_test_date: string | null; last_result: string | null;
  result: string | null; visual_inspection: string | null; earth_continuity_ohms: string | null;
  insulation_mohms: string | null; operating_current: string | null; notes: string | null;
  tested_by: string | null; tested_at: Date | null;
}

function itemJson(row: ItemRow) {
  return {
    id: row.id,
    name: row.name,
    applianceType: row.appliance_type,
    location: row.location,
    assetTag: row.asset_tag,
    lastTestDate: row.last_test_date,
    lastResult: row.last_result,
    result: row.result,
    visualInspection: row.visual_inspection,
    earthContinuityOhms: row.earth_continuity_ohms,
    insulationMohms: row.insulation_mohms,
    operatingCurrent: row.operating_current,
    notes: row.notes,
    testedBy: row.tested_by,
    testedAt: row.tested_at,
  };
}

/** The site's appliances, each with its last test before this visit and this visit's result. */
async function visitItems(visit: Pick<LinkedVisit, "id" | "client_id" | "site_id">, applianceId?: number) {
  return rowsOf<ItemRow>(await db.execute(sql`
    SELECT a.id, a.name, a.appliance_type, a.location, a.asset_tag,
      last.test_date::text AS last_test_date, last.result AS last_result,
      v.result, v.visual_inspection, v.earth_continuity_ohms, v.insulation_mohms, v.operating_current, v.notes,
      v.tested_by, v.updated_at AS tested_at
    FROM pat_appliances a
    LEFT JOIN LATERAL (
      SELECT test_date, result FROM pat_tests t
      WHERE t.appliance_id = a.id AND t.client_id = a.client_id AND t.contractor_test_visit_id IS DISTINCT FROM ${visit.id}
      ORDER BY t.test_date DESC, t.id DESC LIMIT 1
    ) last ON true
    LEFT JOIN pat_tests v ON v.appliance_id = a.id AND v.client_id = a.client_id AND v.contractor_test_visit_id = ${visit.id}
    WHERE a.client_id = ${visit.client_id} AND a.site_id = ${visit.site_id} AND (a.active OR v.id IS NOT NULL)
      ${applianceId ? sql`AND a.id = ${applianceId}` : sql``}
    ORDER BY lower(coalesce(nullif(trim(a.location), ''), '~')), lower(a.name), a.id
  `));
}

contractorTestsPublicRouter.get("/:token/items", async (req, res) => {
  const visit = await linkedVisit(req, res, "test");
  if (!visit) return;
  if (!(await signedInTester(req, res, visit))) return;
  const [items, locations] = await Promise.all([
    visitItems(visit),
    db.execute(sql`
      SELECT name FROM (
        SELECT trim(name) AS name FROM pat_rooms WHERE client_id = ${visit.client_id} AND site_id = ${visit.site_id} AND active
        UNION
        SELECT trim(location) FROM pat_appliances WHERE client_id = ${visit.client_id} AND site_id = ${visit.site_id} AND active
      ) places WHERE coalesce(name, '') <> '' ORDER BY lower(name)
    `),
  ]);
  res.json({ items: items.map(itemJson), locations: rowsOf<{ name: string }>(locations).map((row) => row.name) });
});

const reading = z.string().trim().max(50).nullable().optional().transform((value) => value || null);
const ResultBody = z.object({
  result: z.enum(["pass", "fail"]),
  visualInspection: z.enum(["pass", "fail", "na"]).nullable().optional(),
  earthContinuityOhms: reading,
  insulationMohms: reading,
  operatingCurrent: reading,
  notes: z.string().trim().max(1000).nullable().optional().transform((value) => value || null),
}).strict();

/** Owners, maintenance managers and whoever set the visit up hear, once a day per visit, that something failed. */
async function noticeFailure(visit: LinkedVisit, day: string) {
  const recipients = new Set(await contractorNoticeRecipients(visit.client_id));
  if (visit.created_by) recipients.add(visit.created_by);
  await createUserNotifications([...recipients].map((userId) => ({
    clientId: visit.client_id,
    userId,
    module: "pat",
    siteId: visit.site_id,
    kind: "contractor_test_failed",
    title: `An appliance failed PAT testing at ${visit.site_name}`,
    body: `${visit.contractor_name} is logging the tests. Take failed appliances out of use; each one is an action on PATtrack.`,
    linkPath: `/pat-track?tab=contractor-visits&visit=${visit.id}`,
    dedupeKey: `contractor-test-failed:${visit.id}:${day}`,
  })));
}

contractorTestsPublicRouter.put("/:token/items/:applianceId/result", async (req, res) => {
  const visit = await linkedVisit(req, res, "test");
  if (!visit) return;
  const tester = await signedInTester(req, res, visit);
  if (!tester) return;
  const applianceId = Number(req.params.applianceId);
  if (!Number.isSafeInteger(applianceId) || applianceId <= 0) return res.status(404).json({ error: "Appliance not found" });
  const parsed = ResultBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the result and try again" });
  const d = parsed.data;
  const [today, settings] = await Promise.all([getAccountToday(visit.client_id), patSettings(visit.client_id)]);
  const testedBy = testerText(tester.name, tester.company);
  const nextTestDate = d.result === "pass" ? addMonths(today, settings.retestMonths) : null;

  const outcome = await db.transaction(async (tx) => {
    const [appliance] = rowsOf<{ id: number; name: string; location: string | null; active: boolean }>(await tx.execute(sql`
      SELECT id, name, location, active FROM pat_appliances
      WHERE id = ${applianceId} AND client_id = ${visit.client_id} AND site_id = ${visit.site_id}
      FOR UPDATE
    `));
    if (!appliance) return null;
    const [previous] = rowsOf<{ id: number; result: string }>(await tx.execute(sql`
      SELECT id, result FROM pat_tests
      WHERE contractor_test_visit_id = ${visit.id} AND appliance_id = ${applianceId} AND client_id = ${visit.client_id}
      FOR UPDATE
    `));
    if (!previous && !appliance.active) return { retired: true as const };
    const values = sql`${d.result}, ${today}, ${nextTestDate}, ${testedBy}, ${d.visualInspection ?? null},
      ${d.earthContinuityOhms}, ${d.insulationMohms}, ${d.operatingCurrent}, ${d.notes}`;
    const [test] = previous
      ? rowsOf<{ id: number }>(await tx.execute(sql`
          UPDATE pat_tests SET (result, test_date, next_test_date, tested_by, visual_inspection,
            earth_continuity_ohms, insulation_mohms, operating_current, notes) = (${values}), updated_at = now()
          WHERE id = ${previous.id} RETURNING id
        `))
      : rowsOf<{ id: number }>(await tx.execute(sql`
          INSERT INTO pat_tests (client_id, appliance_id, contractor_test_visit_id, result, test_date, next_test_date,
            tested_by, visual_inspection, earth_continuity_ohms, insulation_mohms, operating_current, notes)
          VALUES (${visit.client_id}, ${applianceId}, ${visit.id}, ${values})
          RETURNING id
        `));
    // The database raised the action when the fail was saved (sync_track_action_on_result).
    // Say what failed; if the contractor then changes it to a pass, the action
    // stays for someone at the business to check and close.
    if (d.result === "fail" || previous?.result === "fail") {
      const where = appliance.location?.trim() ? ` (${appliance.location.trim()})` : "";
      const instruction = d.result === "fail" ? [
        `Failed its PAT test on ${dayText(today)}, logged by ${testedBy}.`,
        "Take it out of use until it has been repaired and passes a retest, or replace it.",
        d.notes ? `Contractor's note: ${d.notes}` : null,
      ].filter(Boolean).join("\n") : [
        `Logged as a fail, then changed to a pass on ${dayText(today)} by ${testedBy}.`,
        "Check with the contractor and close this action if the appliance is safe to use.",
      ].join("\n");
      await tx.execute(sql`
        UPDATE track_actions SET title = ${`PAT fail: ${appliance.name}${where}`}, instruction = ${instruction}, updated_at = now()
        WHERE client_id = ${visit.client_id} AND module = 'pat' AND source_kind = 'pat_tests' AND source_record_id = ${test!.id}
      `);
    }
    return { retired: false as const };
  });
  if (!outcome) return res.status(404).json({ error: "Appliance not found" });
  if (outcome.retired) return res.status(409).json({ error: "This appliance has been retired. Add it again if it is still in use." });
  if (d.result === "fail") {
    void noticeFailure(visit, today).catch((err) => req.log?.warn({ err }, "PAT contractor fail notice failed"));
  }
  const [item] = await visitItems(visit, applianceId);
  res.json(itemJson(item!));
});

const optionalLine = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value || null);
const NewItemBody = z.object({
  name: z.string().trim().min(1, "Enter what the appliance is").max(200),
  applianceType: z.enum(PAT_APPLIANCE_TYPES).default("Other"),
  location: optionalLine(200),
  assetTag: optionalLine(100),
}).strict();

/** An appliance the site's register doesn't have yet. */
contractorTestsPublicRouter.post("/:token/items", async (req, res) => {
  const visit = await linkedVisit(req, res, "test");
  if (!visit) return;
  const tester = await signedInTester(req, res, visit);
  if (!tester) return;
  const parsed = NewItemBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the appliance and try again" });
  const d = parsed.data;
  const [row] = rowsOf<{ id: number }>(await db.execute(sql`
    INSERT INTO pat_appliances (client_id, site_id, name, appliance_type, location, asset_tag, description)
    VALUES (${visit.client_id}, ${visit.site_id}, ${d.name}, ${d.applianceType}, ${d.location}, ${d.assetTag},
      ${`Added by ${testerText(tester.name, tester.company)}`})
    RETURNING id
  `));
  const [item] = await visitItems(visit, row!.id);
  res.status(201).json(itemJson(item!));
});

const CertificateBody = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(200),
  data: z.string().min(1).max(Math.ceil(MAX_INBOX_FILE_BYTES / 3) * 4 + 4),
}).strict();

/** The contractor's own certificate: before sign-off, or afterwards from the office. Replaces an earlier file. */
contractorTestsPublicRouter.post("/:token/certificate", async (req, res) => {
  const visit = await linkedVisit(req, res, "certificate");
  if (!visit) return;
  const parsed = CertificateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a PDF or a photo of the certificate (10 MB at most)." });
  let objectPath: string;
  let fileName = parsed.data.fileName;
  try {
    const checked = await checkCertificateFile(Buffer.from(parsed.data.data, "base64"), fileName, parsed.data.mimeType);
    await ensureUploadCapacity(visit.client_id);
    objectPath = await storage.storeTenantFile(visit.client_id, checked.bytes, checked.contentType, EXTENSIONS[checked.contentType] ?? ".bin");
    if (checked.contentType === "image/jpeg" && !/\.jpe?g$/i.test(fileName)) fileName = `${fileName.replace(/\.[^.]*$/, "")}.jpg`;
  } catch (err) {
    if (err instanceof ObjectContentError) {
      return res.status(400).json({ error: "That file could not be opened as a PDF, a photo or a Word document. Save the certificate as a PDF and try again." });
    }
    if (err instanceof StorageFullError) {
      return res.status(507).json({ error: `${visit.business_name} cannot take files just now. Please email the certificate to the site instead.` });
    }
    req.log?.error({ err }, "Contractor test certificate upload failed");
    return res.status(503).json({ error: "The certificate could not be saved just now. Please try again in a few minutes." });
  }
  const [updated] = rowsOf<{ previous: string | null; pat_certificate_id: number | null }>(await db.execute(sql`
    UPDATE contractor_test_visits v SET certificate_object_path = ${objectPath}, certificate_file_name = ${fileName.slice(0, 255)}
    FROM (SELECT id, certificate_object_path AS previous FROM contractor_test_visits WHERE id = ${visit.id} FOR UPDATE) old
    WHERE v.id = old.id
    RETURNING old.previous, v.pat_certificate_id
  `));
  if (updated?.pat_certificate_id) {
    await db.execute(sql`
      UPDATE pat_certificates SET document_link = ${storageUrl(objectPath)}, updated_at = now()
      WHERE id = ${updated.pat_certificate_id} AND client_id = ${visit.client_id}
    `);
  }
  if (updated?.previous && updated.previous !== objectPath) {
    await storage.deleteTenantObject(updated.previous, visit.client_id)
      .catch((err) => req.log?.warn({ err }, "Could not delete a replaced contractor certificate"));
  }
  res.status(201).json({ hasCertificate: true, certificateFileName: fileName });
});

const SignOffBody = z.object({
  certificateRef: z.string().trim().min(1, "Enter your certificate number").max(120),
  nextTestDue: z.string().regex(DAY).nullable().optional(),
  name: z.string().trim().min(1, "Enter your name").max(120),
  company: z.string().trim().min(1, "Enter your company").max(160),
  notes: z.string().trim().max(2000).nullable().optional().transform((value) => value || null),
  declaration: z.literal(true, { error: "Tick to confirm the results are accurate" }),
  signature: z.string().max(400_000).regex(SIGNATURE, "Sign in the box"),
}).strict();

/**
 * Finish the visit: the certificate goes on PATrack with every failed
 * appliance, the visit is signed off and the link closes for testing.
 */
contractorTestsPublicRouter.post("/:token/sign-off", async (req, res) => {
  const visit = await linkedVisit(req, res, "test");
  if (!visit) return;
  const tester = await signedInTester(req, res, visit);
  if (!tester) return;
  const parsed = SignOffBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the form and try again" });
  const d = parsed.data;
  const today = await getAccountToday(visit.client_id);

  const outcome = await db.transaction(async (tx) => {
    const [locked] = rowsOf<{ status: string; certificate_object_path: string | null }>(await tx.execute(sql`
      SELECT status, certificate_object_path FROM contractor_test_visits WHERE id = ${visit.id} FOR UPDATE
    `));
    if (locked?.status !== "open") return { status: 409, body: { error: "These tests have already been signed off." } };
    const tests = rowsOf<{ id: number; result: string; test_date: string; next_test_date: string | null; appliance_name: string; location: string | null; notes: string | null }>(await tx.execute(sql`
      SELECT id, result, test_date::text AS test_date, next_test_date::text AS next_test_date,
        coalesce(appliance_name_snapshot, 'Appliance') AS appliance_name, nullif(trim(location_snapshot), '') AS location, notes
      FROM pat_tests WHERE contractor_test_visit_id = ${visit.id} AND client_id = ${visit.client_id}
      ORDER BY id
    `));
    if (tests.length === 0) return { status: 400, body: { error: "Log at least one test before you sign off." } };
    const failed = tests.filter((test) => test.result === "fail");
    const firstDay = tests.reduce((min, test) => test.test_date < min ? test.test_date : min, tests[0]!.test_date);
    const lastDay = tests.reduce((max, test) => test.test_date > max ? test.test_date : max, tests[0]!.test_date);
    const nextDue = d.nextTestDue ?? tests.map((test) => test.next_test_date).filter((date): date is string => !!date).sort()[0] ?? null;
    // Rooms on the register whose names match where appliances were tested.
    const rooms = rowsOf<{ id: number; key: string }>(await tx.execute(sql`
      SELECT DISTINCT ON (lower(trim(name))) id, lower(trim(name)) AS key FROM pat_rooms
      WHERE client_id = ${visit.client_id} AND site_id = ${visit.site_id}
      ORDER BY lower(trim(name)), active DESC, id
    `));
    const roomFor = (location: string | null) => location ? rooms.find((room) => room.key === location.toLowerCase())?.id ?? null : null;
    const coveredRooms = [...new Set(tests.map((test) => roomFor(test.location)).filter((id): id is number => id !== null))];
    const summary = [
      `Logged in ComplyTrack by ${testerText(d.name, d.company)}, ${visitDays(firstDay, lastDay)}.`,
      d.notes ? `Contractor's notes: ${d.notes}` : null,
    ].filter(Boolean).join("\n");
    const [certificate] = rowsOf<{ id: number }>(await tx.execute(sql`
      INSERT INTO pat_certificates (client_id, site_id, visit_date, contractor_id, contractor_name, certificate_ref,
        appliances_tested_count, pass_count, fail_count, next_test_due, document_link, notes)
      VALUES (${visit.client_id}, ${visit.site_id}, ${lastDay}, ${visit.contractor_id}, ${d.company}, ${d.certificateRef},
        ${tests.length}, ${tests.length - failed.length}, ${failed.length}, ${nextDue},
        ${locked.certificate_object_path ? storageUrl(locked.certificate_object_path) : null}, ${summary})
      RETURNING id
    `));
    for (const roomId of coveredRooms) {
      await tx.execute(sql`INSERT INTO pat_certificate_rooms (client_id, certificate_id, room_id) VALUES (${visit.client_id}, ${certificate!.id}, ${roomId})`);
    }
    for (const test of failed) {
      await tx.execute(sql`
        INSERT INTO pat_failures (client_id, certificate_id, room_id, location_text, appliance_name, action_taken)
        VALUES (${visit.client_id}, ${certificate!.id}, ${roomFor(test.location)}, ${test.location}, ${test.appliance_name},
          ${test.notes ? `Contractor's note: ${test.notes}` : null})
      `);
    }
    await tx.execute(sql`
      UPDATE contractor_test_visits SET status = 'signed_off', signed_off_at = now(), signed_off_name = ${d.name},
        signed_off_company = ${d.company}, signed_off_signature = ${d.signature}, certificate_ref = ${d.certificateRef},
        next_test_due = ${nextDue}, sign_off_notes = ${d.notes}, pat_certificate_id = ${certificate!.id}
      WHERE id = ${visit.id}
    `);
    return { status: 200, body: { tested: tests.length, passed: tests.length - failed.length, failed: failed.length, nextTestDue: nextDue, hasCertificate: !!locked.certificate_object_path } };
  });

  if (outcome.status === 200) {
    const { tested, failed } = outcome.body as { tested: number; failed: number };
    const recipients = new Set(await contractorNoticeRecipients(visit.client_id));
    if (visit.created_by) recipients.add(visit.created_by);
    void createUserNotifications([...recipients].map((userId) => ({
      clientId: visit.client_id,
      userId,
      module: "pat",
      siteId: visit.site_id,
      kind: "contractor_test_signed_off",
      title: `PAT testing at ${visit.site_name} is signed off`,
      body: `${d.company} tested ${tested} appliance${tested === 1 ? "" : "s"}${failed ? `; ${failed} failed` : ", all passed"}.`,
      linkPath: `/pat-track?tab=contractor-visits&visit=${visit.id}`,
      dedupeKey: `contractor-test-signed-off:${visit.id}`,
    }))).catch((err) => req.log?.warn({ err }, "PAT contractor sign-off notice failed"));
  }
  res.status(outcome.status).json(outcome.body);
});

// ── Managers and staff (mounted under /pat-track, behind its sign-in and service check) ──

export const patContractorVisitsRouter = Router();
patContractorVisitsRouter.use((req, res, next) => {
  if (req.currentUser?.role === "client_viewer") return res.status(403).json({ error: "Forbidden" });
  next();
});

/** Owners, consultants, Managers and maintenance managers set visits up and end them. */
function canManage(req: Request): boolean {
  const user = req.currentUser;
  return !!user && (user.role === "client_admin" || user.role === "consultant" || user.role === "client_manager"
    || user.isMaintenanceManager === true);
}

function requireManager(req: Request, res: Response): boolean {
  if (canManage(req)) return true;
  res.status(403).json({ error: "Only Owners and Managers can set up contractor visits" });
  return false;
}

function siteScope(req: Request) {
  const departmentId = getActiveDepartmentId(req);
  return departmentId === null ? sql`` : sql`AND ${siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId)}`;
}

interface VisitRow {
  id: number; site_id: number; site_name: string; contractor_id: number | null; contractor_name: string;
  contractor_email: string | null; starts_on: string; ends_on: string; expires_at: Date; status: string; expired: boolean;
  created_at: Date; created_by_name: string | null; tested: number; passed: number; failed: number; on_site: number;
  signed_off_at: Date | null; signed_off_name: string | null; signed_off_company: string | null; certificate_ref: string | null;
  next_test_due: string | null; sign_off_notes: string | null; certificate_object_path: string | null;
  certificate_file_name: string | null; pat_certificate_id: number | null; ended_at: Date | null;
}

const visitSelect = sql`
  SELECT v.id, v.site_id, s.name AS site_name, v.contractor_id, v.contractor_name, v.contractor_email,
    v.starts_on::text AS starts_on, v.ends_on::text AS ends_on, v.expires_at, v.status, (v.expires_at <= now()) AS expired,
    v.created_at, u.name AS created_by_name,
    (SELECT count(*)::int FROM pat_tests t WHERE t.contractor_test_visit_id = v.id AND t.client_id = v.client_id) AS tested,
    (SELECT count(*)::int FROM pat_tests t WHERE t.contractor_test_visit_id = v.id AND t.client_id = v.client_id AND t.result = 'pass') AS passed,
    (SELECT count(*)::int FROM pat_tests t WHERE t.contractor_test_visit_id = v.id AND t.client_id = v.client_id AND t.result = 'fail') AS failed,
    (SELECT count(*)::int FROM contractor_sign_ins si WHERE si.contractor_test_visit_id = v.id AND si.client_id = v.client_id
      AND si.signed_out_at IS NULL AND si.signed_in_at > now() - make_interval(hours => ${ON_SITE_HOURS})) AS on_site,
    v.signed_off_at, v.signed_off_name, v.signed_off_company, v.certificate_ref, v.next_test_due::text AS next_test_due,
    v.sign_off_notes, v.certificate_object_path, v.certificate_file_name, v.pat_certificate_id, v.ended_at
  FROM contractor_test_visits v
  JOIN sites s ON s.id = v.site_id AND s.client_id = v.client_id
  LEFT JOIN users u ON u.id = v.created_by
`;

function visitJson(row: VisitRow) {
  const state = row.status === "open" && row.expired ? "expired" : row.status;
  return {
    id: row.id,
    siteId: row.site_id,
    siteName: row.site_name,
    contractorId: row.contractor_id,
    contractorName: row.contractor_name,
    contractorEmail: row.contractor_email,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    linkExpiresAt: row.expires_at,
    status: state as "open" | "expired" | "signed_off" | "ended",
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    tested: row.tested,
    passed: row.passed,
    failed: row.failed,
    onSiteNow: row.on_site,
    signedOffAt: row.signed_off_at,
    signedOffName: row.signed_off_name,
    signedOffCompany: row.signed_off_company,
    certificateRef: row.certificate_ref,
    nextTestDue: row.next_test_due,
    signOffNotes: row.sign_off_notes,
    certificateUrl: row.certificate_object_path ? `/api/storage${row.certificate_object_path}` : null,
    certificateFileName: row.certificate_file_name,
    patCertificateId: row.pat_certificate_id,
    endedAt: row.ended_at,
  };
}

async function loadVisit(req: Request, clientId: number, id: number) {
  const [row] = rowsOf<VisitRow>(await db.execute(sql`${visitSelect}
    WHERE v.client_id = ${clientId} AND v.id = ${id} ${siteScope(req)}
  `));
  return row ?? null;
}

async function visitFromParams(req: Request, res: Response) {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  const row = clientId && Number.isSafeInteger(id) && id > 0 ? await loadVisit(req, clientId, id) : null;
  if (!row) res.status(404).json({ error: "Visit not found" });
  return row && clientId ? { clientId, row } : null;
}

/** Visits at the caller's sites, newest first; ?siteId= narrows to one site. */
patContractorVisitsRouter.get("/", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = req.query.siteId ? Number(req.query.siteId) : null;
  if (siteId !== null && (!Number.isSafeInteger(siteId) || siteId <= 0)) return res.status(400).json({ error: "Invalid siteId" });
  const rows = rowsOf<VisitRow>(await db.execute(sql`${visitSelect}
    WHERE v.client_id = ${clientId} ${siteScope(req)} ${siteId ? sql`AND v.site_id = ${siteId}` : sql``}
    ORDER BY v.created_at DESC, v.id DESC
    LIMIT 200
  `));
  res.json({ canManage: canManage(req), visits: rows.map(visitJson) });
});

/** One visit with every result, who signed in, and the sign-off signature. */
patContractorVisitsRouter.get("/:id", async (req, res) => {
  const found = await visitFromParams(req, res);
  if (!found) return;
  const { clientId, row } = found;
  const [results, signIns, signature] = await Promise.all([
    db.execute(sql`
      SELECT t.id, t.appliance_id, coalesce(t.appliance_name_snapshot, a.name) AS appliance_name,
        t.appliance_type_snapshot AS appliance_type, t.location_snapshot AS location, t.asset_tag_snapshot AS asset_tag,
        t.result, t.visual_inspection, t.earth_continuity_ohms, t.insulation_mohms, t.operating_current, t.notes,
        t.tested_by, t.test_date::text AS test_date, t.updated_at
      FROM pat_tests t LEFT JOIN pat_appliances a ON a.id = t.appliance_id AND a.client_id = t.client_id
      WHERE t.contractor_test_visit_id = ${row.id} AND t.client_id = ${clientId}
      ORDER BY (t.result = 'fail') DESC, lower(coalesce(t.location_snapshot, '')), lower(coalesce(t.appliance_name_snapshot, '')), t.id
    `),
    db.execute(sql`
      SELECT id, visitor_name AS name, company, signed_in_at, signed_out_at,
        (fire_procedure_text IS NOT NULL) AS fire_procedure_shown, asbestos_status
      FROM contractor_sign_ins WHERE contractor_test_visit_id = ${row.id} AND client_id = ${clientId}
      ORDER BY signed_in_at
    `),
    db.execute(sql`SELECT signed_off_signature FROM contractor_test_visits WHERE id = ${row.id} AND client_id = ${clientId}`),
  ]);
  res.json({
    ...visitJson(row),
    signOffSignature: rowsOf<{ signed_off_signature: string | null }>(signature)[0]?.signed_off_signature ?? null,
    results: rowsOf<Record<string, unknown>>(results).map((r) => ({
      id: r.id, applianceId: r.appliance_id, applianceName: r.appliance_name, applianceType: r.appliance_type,
      location: r.location, assetTag: r.asset_tag, result: r.result, visualInspection: r.visual_inspection,
      earthContinuityOhms: r.earth_continuity_ohms, insulationMohms: r.insulation_mohms, operatingCurrent: r.operating_current,
      notes: r.notes, testedBy: r.tested_by, testDate: r.test_date, updatedAt: r.updated_at,
    })),
    signIns: rowsOf<Record<string, unknown>>(signIns).map((s) => ({
      id: s.id, name: s.name, company: s.company, signedInAt: s.signed_in_at, signedOutAt: s.signed_out_at,
      fireProcedureShown: s.fire_procedure_shown, asbestosStatus: s.asbestos_status,
    })),
  });
});

const optionalEmail = z.string().trim().max(320).email("Enter a valid email address").nullable().optional()
  .or(z.literal("")).transform((value) => value || null);
const NewVisitBody = z.object({
  siteId: z.number().int().positive(),
  contractorId: z.number().int().positive().nullable().optional(),
  contractorName: z.string().trim().max(160).nullable().optional(),
  contractorEmail: optionalEmail,
  startsOn: z.string().regex(DAY, "Choose the first day of the visit"),
  endsOn: z.string().regex(DAY, "Choose the last day of the visit"),
  sendEmail: z.boolean().default(true),
}).strict();

async function emailLink(opts: {
  clientId: number; to: string; contractorName: string; siteName: string; startsOn: string; endsOn: string; url: string; expiresAt: Date;
}) {
  const [business] = rowsOf<{ name: string }>(await db.execute(sql`
    SELECT coalesce(nullif(trim((SELECT a.value FROM app_settings a WHERE a.client_id = c.id AND a.key = 'companyName')), ''), c.name) AS name
    FROM clients c WHERE c.id = ${opts.clientId}
  `));
  const businessName = business?.name ?? "";
  const days = visitDays(opts.startsOn, opts.endsOn);
  const until = opts.expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" });
  await dispatchStoredContractorEmail({
    clientId: opts.clientId,
    to: opts.to,
    subject: `PAT testing at ${opts.siteName}: log your results here`,
    html: `<p>Hello ${escapeHtml(opts.contractorName)},</p>
<p>${businessName ? `${escapeHtml(businessName)} would` : "We would"} like you to log your PAT test results for <strong>${escapeHtml(opts.siteName)}</strong> on ComplyTrack, ${escapeHtml(days)}.</p>
<p>When you arrive, open the button below on your phone. You'll sign in at the site first (fire procedure and asbestos register), then tap Pass or Fail for each appliance as you test it. When you've finished, upload your own certificate and sign off.</p>
${emailButton(opts.url, "Sign in and log tests")}
<p style="color:#64748b;font-size:14px">The link works until ${escapeHtml(until)}. Please don't forward it.</p>`,
    text: `Hello ${opts.contractorName},\n\n${businessName || "We"} would like you to log your PAT test results for ${opts.siteName} on ComplyTrack, ${days}.\n\nWhen you arrive, open this link on your phone: ${opts.url}\n\nYou'll sign in at the site first (fire procedure and asbestos register), then tap Pass or Fail for each appliance as you test it. When you've finished, upload your own certificate and sign off.\n\nThe link works until ${until}. Please don't forward it.`,
  });
}

/** Set up a visit: returns the link once (only its digest is kept) and emails it to the contractor. */
patContractorVisitsRouter.post("/", denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!requireManager(req, res)) return;
  const parsed = NewVisitBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the visit and try again" });
  const d = parsed.data;
  const [site] = rowsOf<{ id: number; name: string }>(await db.execute(sql`
    SELECT s.id, s.name FROM sites s WHERE s.id = ${d.siteId} AND s.client_id = ${clientId} ${siteScope(req)}
  `));
  if (!site) return res.status(404).json({ error: "Site not found" });
  let contractorName = d.contractorName ?? null;
  let contractorEmail = d.contractorEmail;
  if (d.contractorId) {
    const [contractor] = rowsOf<{ name: string; company: string | null; email: string | null }>(await db.execute(sql`
      SELECT name, company, email FROM contractors WHERE id = ${d.contractorId} AND client_id = ${clientId}
    `));
    if (!contractor) return res.status(400).json({ error: "Choose a contractor from your list" });
    contractorName = contractor.company?.trim() || contractor.name;
    contractorEmail = contractorEmail ?? (contractor.email?.trim() || null);
  }
  if (!contractorName) return res.status(400).json({ error: "Choose a contractor or enter their company name" });
  const today = await getAccountToday(clientId);
  if (d.endsOn < d.startsOn) return res.status(400).json({ error: "The last day can't be before the first day" });
  if (d.endsOn < today) return res.status(400).json({ error: "The visit has to end today or later" });
  if (d.endsOn > addCalendarDays(d.startsOn, MAX_VISIT_DAYS - 1)) return res.status(400).json({ error: `A visit can be ${MAX_VISIT_DAYS} days at most` });
  if (d.sendEmail && !contractorEmail) return res.status(400).json({ error: "Add the contractor's email address, or copy the link instead" });

  const token = newBearerToken();
  const expiresAt = linkExpiry(d.endsOn);
  const [created] = rowsOf<{ id: number }>(await db.execute(sql`
    INSERT INTO contractor_test_visits (client_id, site_id, module, contractor_id, contractor_name, contractor_email,
      starts_on, ends_on, expires_at, link_token_hash, created_by)
    VALUES (${clientId}, ${site.id}, 'pat', ${d.contractorId ?? null}, ${contractorName}, ${contractorEmail},
      ${d.startsOn}, ${d.endsOn}, ${expiresAt}, ${digestBearerToken(token)}, ${req.currentUser!.id})
    RETURNING id
  `));
  const link = contractorTestsUrl(token);
  let emailedTo: string | null = null;
  let emailError: string | null = null;
  if (d.sendEmail && contractorEmail) {
    try {
      await emailLink({ clientId, to: contractorEmail, contractorName, siteName: site.name, startsOn: d.startsOn, endsOn: d.endsOn, url: link, expiresAt });
      emailedTo = contractorEmail;
    } catch (err) {
      req.log?.warn({ err }, "PAT contractor visit link email failed");
      emailError = "The visit is set up, but the email could not be sent. Copy the link and send it yourself.";
    }
  }
  const row = await loadVisit(req, clientId, created!.id);
  res.status(201).json({ visit: visitJson(row!), link, emailedTo, emailError });
});

const NewLinkBody = z.object({ sendEmail: z.boolean().default(true) }).strict();

/** A new link for an open visit; the old one stops working. */
patContractorVisitsRouter.post("/:id/new-link", denyViewers, async (req, res) => {
  if (!requireManager(req, res)) return;
  const found = await visitFromParams(req, res);
  if (!found) return;
  const { clientId, row } = found;
  if (row.status !== "open") return res.status(409).json({ error: "This visit is finished. Set up a new visit instead." });
  const parsed = NewLinkBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  const token = newBearerToken();
  const expiresAt = linkExpiry(row.ends_on);
  await db.execute(sql`
    UPDATE contractor_test_visits SET link_token_hash = ${digestBearerToken(token)}, expires_at = ${expiresAt}
    WHERE id = ${row.id} AND client_id = ${clientId} AND status = 'open'
  `);
  const link = contractorTestsUrl(token);
  let emailedTo: string | null = null;
  let emailError: string | null = null;
  if (parsed.data.sendEmail && row.contractor_email) {
    try {
      await emailLink({ clientId, to: row.contractor_email, contractorName: row.contractor_name, siteName: row.site_name,
        startsOn: row.starts_on, endsOn: row.ends_on, url: link, expiresAt });
      emailedTo = row.contractor_email;
    } catch (err) {
      req.log?.warn({ err }, "PAT contractor visit link email failed");
      emailError = "The new link is ready, but the email could not be sent. Copy the link and send it yourself.";
    }
  }
  res.json({ visit: visitJson((await loadVisit(req, clientId, row.id))!), link, emailedTo, emailError });
});

/** Close the link early. Results already logged stay on PATrack. */
patContractorVisitsRouter.post("/:id/end", denyViewers, async (req, res) => {
  if (!requireManager(req, res)) return;
  const found = await visitFromParams(req, res);
  if (!found) return;
  const { clientId, row } = found;
  if (row.status === "signed_off") return res.status(409).json({ error: "This visit is already signed off." });
  await db.execute(sql`
    UPDATE contractor_test_visits SET status = 'ended', ended_at = now(), ended_by = ${req.currentUser!.id}
    WHERE id = ${row.id} AND client_id = ${clientId} AND status = 'open'
  `);
  res.json(visitJson((await loadVisit(req, clientId, row.id))!));
});
