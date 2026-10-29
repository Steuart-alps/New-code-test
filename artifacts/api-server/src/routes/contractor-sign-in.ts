/**
 * Contractor sign-in on arrival.
 *
 * Each site has one sign-in link (a QR poster at reception, or emailed to a
 * contractor before a visit). The contractor gives their name and company,
 * reads the site's fire procedure and asbestos register, ticks each, signs,
 * and signs out when they leave. Managers see who is on site now (the fire
 * roll call) and every past visit with what was acknowledged.
 *
 *   /api/site-sign-in/:token        public, the link token is the only credential
 *   /api/contractor-sign-in/...     signed in; Viewers are refused
 */
import { randomBytes, createHash } from "crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { db } from "@workspace/db";
import {
  asbestosRecordsTable,
  asbestosRegisterEntriesTable,
  clientsTable,
  contractorSignInSitesTable,
  contractorSignInsTable,
  contractorsTable,
  sitesTable,
  trackControlProfilesTable,
  usersTable,
} from "@workspace/db/schema";
import { requireAuth, denyViewers, getActiveDepartmentId } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { digestBearerToken, newBearerToken } from "../lib/bearerTokens";
import { siteSignInLinkSubmitRateLimit, siteSignInSubmitRateLimit } from "../lib/loginRateLimit";
import { createUserNotifications } from "../lib/userNotifications";
import { dispatchStoredContractorEmail } from "../lib/fixTrackNotifications";
import { emailButton, escapeHtml, getPublicAppUrl } from "../lib/email";
import { PDF_BOLD_FONT, PDF_REGULAR_FONT } from "../lib/pdfFonts";
import { canUseSite, parseId, requireClient } from "./registers";

/** A visit still open after this many hours is "didn't sign out", not on site. */
export const ON_SITE_HOURS = 16;
const LINK_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const SIGN_OUT_TOKEN = /^[a-f0-9]{64}$/;
const SIGNATURE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

const newLinkToken = () => randomBytes(24).toString("base64url");
/** The name the business uses in Settings, else its account name. */
// Written out in full: an interpolated column renders unqualified here and would
// resolve to app_settings inside the subquery.
const businessNameSql = sql<string>`coalesce(nullif(trim((SELECT a.value FROM app_settings a WHERE a.client_id = "clients"."id" AND a.key = 'companyName')), ''), "clients"."name")`;
const signInUrl = (token: string) => `${getPublicAppUrl()}/site-sign-in/${token}`;

// ── What the contractor reads ────────────────────────────────────────────────

type AsbestosStatus = "register" | "none_expected" | "missing";
interface AsbestosBriefing {
  status: AsbestosStatus;
  surveyType: string | null;
  surveyDate: string | null;
  surveyor: string | null;
  entries: Array<{ location: string; material: string; condition: string; priority: string; action: string; lastInspected: string | null }>;
}
interface Briefing {
  fireProcedure: string | null;
  asbestos: AsbestosBriefing;
  /** Changes whenever what the contractor reads changes. */
  version: string;
}

async function asbestosBriefing(clientId: number, siteId: number): Promise<AsbestosBriefing> {
  const [record] = await db.select().from(asbestosRecordsTable)
    .where(and(
      eq(asbestosRecordsTable.clientId, clientId),
      eq(asbestosRecordsTable.siteId, siteId),
      isNull(asbestosRecordsTable.deletedAt),
    ))
    .orderBy(asc(asbestosRecordsTable.id))
    .limit(1);
  const empty = { surveyType: null, surveyDate: null, surveyor: null, entries: [] };
  if (!record) return { status: "missing", ...empty };
  if (record.noAsbestosExpected) return { status: "none_expected", ...empty };
  // Internal notes on the register stay with the business.
  const entries = await db.select({
    location: asbestosRegisterEntriesTable.location,
    material: asbestosRegisterEntriesTable.material,
    condition: asbestosRegisterEntriesTable.condition,
    priority: asbestosRegisterEntriesTable.priority,
    action: asbestosRegisterEntriesTable.action,
    lastInspected: asbestosRegisterEntriesTable.lastInspected,
  }).from(asbestosRegisterEntriesTable)
    .where(and(
      eq(asbestosRegisterEntriesTable.clientId, clientId),
      eq(asbestosRegisterEntriesTable.recordId, record.id),
      isNull(asbestosRegisterEntriesTable.deletedAt),
    ))
    .orderBy(asc(asbestosRegisterEntriesTable.location), asc(asbestosRegisterEntriesTable.id));
  // A record with neither a survey nor any entries tells a contractor nothing.
  if (!record.surveyDate && entries.length === 0) return { status: "missing", ...empty };
  return { status: "register", surveyType: record.surveyType, surveyDate: record.surveyDate, surveyor: record.surveyor, entries };
}

async function loadBriefing(clientId: number, siteId: number, fireProcedure: string | null): Promise<Briefing> {
  const fire = fireProcedure?.trim() || null;
  const asbestos = await asbestosBriefing(clientId, siteId);
  const version = createHash("sha256").update(JSON.stringify({ fire, asbestos })).digest("hex").slice(0, 16);
  return { fireProcedure: fire, asbestos, version };
}

/** Owners and maintenance managers hear (bell only, once a day per site) when a sign-in showed missing information. */
async function nudgeMissingInformation(clientId: number, siteId: number, siteName: string, missing: string[]) {
  const recipients = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(
      eq(usersTable.clientId, clientId),
      eq(usersTable.active, true),
      or(eq(usersTable.role, "client_admin"), eq(usersTable.isMaintenanceManager, true)),
    ));
  const day = new Date().toISOString().slice(0, 10);
  await createUserNotifications(recipients.map((user) => ({
    clientId,
    userId: user.id,
    module: null,
    siteId,
    kind: "contractor_sign_in_missing",
    title: `A contractor signed in at ${siteName} without the ${missing.join(" or ")}`,
    body: `Add the ${missing.join(" and ")} so the next contractor can read it before starting work.`,
    linkPath: `/contractor-sign-in?siteId=${siteId}`,
    dedupeKey: `contractor-sign-in-missing:${siteId}:${day}`,
  })));
}

// ── Public link ──────────────────────────────────────────────────────────────

export const siteSignInPublicRouter = Router();

async function resolveLink(req: Request) {
  const token = String(req.params.token ?? "");
  if (!LINK_TOKEN.test(token)) return null;
  const [row] = await db.select({
    clientId: contractorSignInSitesTable.clientId,
    siteId: contractorSignInSitesTable.siteId,
    fireProcedure: contractorSignInSitesTable.fireProcedure,
    siteName: sitesTable.name,
    businessName: businessNameSql,
  }).from(contractorSignInSitesTable)
    .innerJoin(sitesTable, and(eq(sitesTable.id, contractorSignInSitesTable.siteId), eq(sitesTable.clientId, contractorSignInSitesTable.clientId)))
    .innerJoin(clientsTable, eq(clientsTable.id, contractorSignInSitesTable.clientId))
    .where(and(
      eq(contractorSignInSitesTable.linkToken, token),
      eq(contractorSignInSitesTable.enabled, true),
      eq(clientsTable.active, true),
    ))
    .limit(1);
  return row ?? null;
}

const LINK_GONE = "This sign-in link is no longer active. Please ask the site for the current one.";

siteSignInPublicRouter.get("/:token", async (req, res) => {
  const link = await resolveLink(req);
  if (!link) return res.status(404).json({ error: LINK_GONE });
  const briefing = await loadBriefing(link.clientId, link.siteId, link.fireProcedure);
  res.json({ businessName: link.businessName, siteName: link.siteName, ...briefing });
});

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((value) => value || null);
const SignInBody = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  company: z.string().trim().min(1, "Enter your company").max(160),
  phone: optionalText(40),
  email: z.string().trim().max(320).email("Enter a valid email address").optional().or(z.literal("")).transform((value) => value || null),
  visitReason: optionalText(300),
  briefingVersion: z.string().max(64),
  fireAcknowledged: z.literal(true, { errorMap: () => ({ message: "Tick to confirm you have read the fire procedure" }) }),
  asbestosAcknowledged: z.literal(true, { errorMap: () => ({ message: "Tick to confirm you have read the asbestos information" }) }),
  declaration: z.literal(true, { errorMap: () => ({ message: "Tick to confirm the declaration" }) }),
  signature: z.string().max(400_000).regex(SIGNATURE, "Sign in the box"),
  // Hidden from people; automated form-fillers tend to complete it.
  website: z.string().max(500).optional(),
});

siteSignInPublicRouter.post("/:token/sign-in", siteSignInSubmitRateLimit, siteSignInLinkSubmitRateLimit, async (req, res) => {
  const link = await resolveLink(req);
  if (!link) return res.status(404).json({ error: LINK_GONE });
  const parsed = SignInBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the form and try again" });
  const body = parsed.data;
  if (body.website?.trim()) {
    // Look the same as a real sign-in so the filler learns nothing.
    return res.status(201).json({ signOutToken: newBearerToken(), signedInAt: new Date(), siteName: link.siteName, name: body.name });
  }
  const briefing = await loadBriefing(link.clientId, link.siteId, link.fireProcedure);
  if (body.briefingVersion !== briefing.version) {
    return res.status(409).json({ error: "The site's safety information has just been updated. Please read it again before signing in." });
  }
  const contractor = body.email ? (await db.select({ id: contractorsTable.id }).from(contractorsTable)
    .where(and(eq(contractorsTable.clientId, link.clientId), sql`lower(${contractorsTable.email}) = lower(${body.email})`))
    .limit(1))[0] : undefined;
  const signOutToken = newBearerToken();
  const [visit] = await db.insert(contractorSignInsTable).values({
    clientId: link.clientId,
    siteId: link.siteId,
    siteName: link.siteName,
    contractorId: contractor?.id ?? null,
    visitorName: body.name,
    company: body.company,
    phone: body.phone,
    email: body.email,
    visitReason: body.visitReason,
    fireProcedureText: briefing.fireProcedure,
    asbestosStatus: briefing.asbestos.status,
    asbestosSnapshot: briefing.asbestos,
    signature: body.signature,
    signOutTokenHash: digestBearerToken(signOutToken),
  }).returning({ signedInAt: contractorSignInsTable.signedInAt });

  const missing = [
    ...(briefing.fireProcedure ? [] : ["fire procedure"]),
    ...(briefing.asbestos.status === "missing" ? ["asbestos register"] : []),
  ];
  if (missing.length) {
    void nudgeMissingInformation(link.clientId, link.siteId, link.siteName, missing)
      .catch((err) => req.log?.warn({ err }, "Contractor sign-in missing-information notice failed"));
  }
  res.status(201).json({ signOutToken, signedInAt: visit.signedInAt, siteName: link.siteName, name: body.name });
});

const SignOutBody = z.object({ signOutToken: z.string().regex(SIGN_OUT_TOKEN) });

async function findOwnVisit(req: Request, res: Response) {
  const link = await resolveLink(req);
  if (!link) { res.status(404).json({ error: LINK_GONE }); return null; }
  const parsed = SignOutBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request" }); return null; }
  const [visit] = await db.select({
    id: contractorSignInsTable.id,
    name: contractorSignInsTable.visitorName,
    company: contractorSignInsTable.company,
    signedInAt: contractorSignInsTable.signedInAt,
    signedOutAt: contractorSignInsTable.signedOutAt,
  }).from(contractorSignInsTable)
    .where(and(
      eq(contractorSignInsTable.signOutTokenHash, digestBearerToken(parsed.data.signOutToken)),
      eq(contractorSignInsTable.clientId, link.clientId),
      eq(contractorSignInsTable.siteId, link.siteId),
    ))
    .limit(1);
  if (!visit) { res.status(404).json({ error: "We couldn't find your sign-in. Please ask the site to sign you out." }); return null; }
  return visit;
}

/** The contractor's own visit, from the sign-out key their phone kept. */
siteSignInPublicRouter.post("/:token/visit", async (req, res) => {
  const visit = await findOwnVisit(req, res);
  if (!visit) return;
  const { id: _id, ...rest } = visit;
  res.json(rest);
});

siteSignInPublicRouter.post("/:token/sign-out", async (req, res) => {
  const visit = await findOwnVisit(req, res);
  if (!visit) return;
  if (visit.signedOutAt) return res.json({ signedOutAt: visit.signedOutAt });
  const [updated] = await db.update(contractorSignInsTable)
    .set({ signedOutAt: new Date() })
    .where(and(eq(contractorSignInsTable.id, visit.id), isNull(contractorSignInsTable.signedOutAt)))
    .returning({ signedOutAt: contractorSignInsTable.signedOutAt });
  res.json({ signedOutAt: updated?.signedOutAt ?? visit.signedOutAt });
});

// ── Managers and staff ───────────────────────────────────────────────────────

const router = Router();
router.use(requireAuth);
// Viewers see only their own training; nothing here is theirs.
router.use((req, res, next) => {
  if (req.currentUser?.role === "client_viewer") return res.status(403).json({ error: "Forbidden" });
  next();
});

/** Owners, consultants, Managers and maintenance managers set up the link and the fire procedure. */
function canManage(req: Request): boolean {
  const user = req.currentUser;
  return !!user && (user.role === "client_admin" || user.role === "consultant" || user.role === "client_manager"
    || user.isMaintenanceManager === true);
}

function requireManager(req: Request, res: Response): boolean {
  if (canManage(req)) return true;
  res.status(403).json({ error: "Only Owners and Managers can change contractor sign-in" });
  return false;
}

async function visibleSites(req: Request, clientId: number) {
  const departmentId = getActiveDepartmentId(req);
  return db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), departmentId === null ? undefined : sitesTableVisibleTo(departmentId)))
    .orderBy(asc(sitesTable.name));
}

/** The site from the URL, when it belongs to this business and the caller can see it. */
async function siteFromParams(req: Request, res: Response, clientId: number) {
  const siteId = parseId(req.params.siteId);
  if (!siteId || !(await canUseSite(req, clientId, siteId))) {
    res.status(404).json({ error: "Site not found" });
    return null;
  }
  const [site] = await db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return site ?? null;
}

const onSiteSql = sql<boolean>`(${contractorSignInsTable.signedOutAt} IS NULL AND ${contractorSignInsTable.signedInAt} > now() - make_interval(hours => ${ON_SITE_HOURS}))`;

async function siteSetups(clientId: number, sites: Array<{ id: number; name: string }>) {
  if (sites.length === 0) return [];
  const siteIds = sites.map((site) => site.id);
  const [settings, profiles, counts] = await Promise.all([
    db.select().from(contractorSignInSitesTable)
      .where(and(eq(contractorSignInSitesTable.clientId, clientId), inArray(contractorSignInSitesTable.siteId, siteIds))),
    db.select({ siteId: trackControlProfilesTable.siteId, profile: trackControlProfilesTable.profile }).from(trackControlProfilesTable)
      .where(and(eq(trackControlProfilesTable.clientId, clientId), eq(trackControlProfilesTable.module, "fire"),
        inArray(trackControlProfilesTable.siteId, siteIds))),
    db.select({ siteId: contractorSignInsTable.siteId, count: sql<number>`count(*)::int` }).from(contractorSignInsTable)
      .where(and(eq(contractorSignInsTable.clientId, clientId), inArray(contractorSignInsTable.siteId, siteIds), onSiteSql))
      .groupBy(contractorSignInsTable.siteId),
  ]);
  return Promise.all(sites.map(async (site) => {
    const setting = settings.find((row) => row.siteId === site.id);
    const profile = profiles.find((row) => row.siteId === site.id)?.profile as { evacuationPeepArrangements?: string | null } | undefined;
    const asbestos = await asbestosBriefing(clientId, site.id);
    return {
      siteId: site.id,
      siteName: site.name,
      enabled: setting?.enabled ?? false,
      link: setting ? signInUrl(setting.linkToken) : null,
      fireProcedure: setting?.fireProcedure ?? null,
      fireTrackEvacuation: profile?.evacuationPeepArrangements?.trim() || null,
      asbestosStatus: asbestos.status,
      asbestosEntryCount: asbestos.entries.length,
      onSiteCount: counts.find((row) => row.siteId === site.id)?.count ?? 0,
    };
  }));
}

router.get("/sites", async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  res.json({ canManage: canManage(req), onSiteHours: ON_SITE_HOURS, sites: await siteSetups(clientId, await visibleSites(req, clientId)) });
});

const SiteBody = z.object({
  enabled: z.boolean().optional(),
  fireProcedure: z.string().trim().max(10_000).nullable().optional(),
}).strict();

router.put("/sites/:siteId", denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId || !requireManager(req, res)) return;
  const site = await siteFromParams(req, res, clientId);
  if (!site) return;
  const parsed = SiteBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const changes = {
    ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
    ...(d.fireProcedure !== undefined ? { fireProcedure: d.fireProcedure || null } : {}),
    updatedBy: req.currentUser!.id,
    updatedAt: new Date(),
  };
  await db.insert(contractorSignInSitesTable)
    .values({ clientId, siteId: site.id, linkToken: newLinkToken(), enabled: d.enabled ?? true, fireProcedure: d.fireProcedure || null, updatedBy: req.currentUser!.id })
    .onConflictDoUpdate({ target: contractorSignInSitesTable.siteId, set: changes });
  res.json((await siteSetups(clientId, [site]))[0]);
});

/** A new link for the site; the old link and its posters stop working. */
router.post("/sites/:siteId/reset-link", denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId || !requireManager(req, res)) return;
  const site = await siteFromParams(req, res, clientId);
  if (!site) return;
  const updated = await db.update(contractorSignInSitesTable)
    .set({ linkToken: newLinkToken(), updatedBy: req.currentUser!.id, updatedAt: new Date() })
    .where(and(eq(contractorSignInSitesTable.clientId, clientId), eq(contractorSignInSitesTable.siteId, site.id)))
    .returning({ id: contractorSignInSitesTable.id });
  if (updated.length === 0) return res.status(404).json({ error: "Turn on contractor sign-in for this site first" });
  res.json((await siteSetups(clientId, [site]))[0]);
});

async function activeLink(clientId: number, siteId: number) {
  const [row] = await db.select({ linkToken: contractorSignInSitesTable.linkToken }).from(contractorSignInSitesTable)
    .where(and(eq(contractorSignInSitesTable.clientId, clientId), eq(contractorSignInSitesTable.siteId, siteId),
      eq(contractorSignInSitesTable.enabled, true)))
    .limit(1);
  return row ? signInUrl(row.linkToken) : null;
}

/** An A4 poster for reception with the site's sign-in QR code. */
router.get("/sites/:siteId/poster", async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = await siteFromParams(req, res, clientId);
  if (!site) return;
  const url = await activeLink(clientId, site.id);
  if (!url) return res.status(404).json({ error: "Turn on contractor sign-in for this site first" });
  const [client] = await db.select({ name: businessNameSql }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  const pdf = await createPosterPdf({ url, siteName: site.name, businessName: client?.name ?? "" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="contractor-sign-in-${site.id}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
});

async function createPosterPdf(opts: { url: string; siteName: string; businessName: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 56, font: PDF_REGULAR_FONT, info: { Title: `Contractor sign-in: ${opts.siteName}`, Author: opts.businessName } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - 112;
  doc.font(PDF_BOLD_FONT).fontSize(14).fillColor("#475569").text(`${opts.businessName} · ${opts.siteName}`.toUpperCase(), { width, align: "center" });
  doc.moveDown(0.6);
  doc.font(PDF_BOLD_FONT).fontSize(34).fillColor("#0f172a").text("Contractors: sign in here", { width, align: "center" });
  doc.moveDown(0.5);
  doc.font(PDF_REGULAR_FONT).fontSize(16).fillColor("#334155")
    .text("Before you start work, scan the code with your phone camera.", { width, align: "center" });

  const size = 260;
  const top = doc.y + 24;
  const left = (doc.page.width - size) / 2;
  const qr = QRCode.create(opts.url, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const cell = size / count;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) doc.rect(left + col * cell, top + row * cell, cell + 0.05, cell + 0.05);
    }
  }
  doc.fillColor("#000000").fill();

  doc.y = top + size + 30;
  doc.x = 56;
  const steps = [
    "Enter your name and company.",
    "Read the site's fire procedure and asbestos register.",
    "Tick to confirm, then sign with your finger.",
    "Sign out on the same phone when you leave, so we know you're safe in a fire.",
  ];
  doc.font(PDF_REGULAR_FONT).fontSize(15).fillColor("#0f172a");
  steps.forEach((step, index) => {
    doc.font(PDF_BOLD_FONT).text(`${index + 1}. `, { continued: true, width }).font(PDF_REGULAR_FONT).text(step, { width });
    doc.moveDown(0.4);
  });
  doc.moveDown(0.8);
  doc.font(PDF_REGULAR_FONT).fontSize(10).fillColor("#64748b").text(`No camera? Open ${opts.url}`, { width, align: "center" });
  doc.end();
  return done;
}

const EmailLinkBody = z.object({ contractorId: z.number().int().positive() }).strict();

/** Email the site's sign-in link to a contractor on the Contractors list before a visit. */
router.post("/sites/:siteId/email-link", denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId || !requireManager(req, res)) return;
  const site = await siteFromParams(req, res, clientId);
  if (!site) return;
  const parsed = EmailLinkBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a contractor" });
  const [contractor] = await db.select({ name: contractorsTable.name, email: contractorsTable.email }).from(contractorsTable)
    .where(and(eq(contractorsTable.id, parsed.data.contractorId), eq(contractorsTable.clientId, clientId))).limit(1);
  if (!contractor) return res.status(400).json({ error: "Choose a contractor from your list" });
  if (!contractor.email?.trim()) return res.status(400).json({ error: "This contractor has no email address" });
  const url = await activeLink(clientId, site.id);
  if (!url) return res.status(404).json({ error: "Turn on contractor sign-in for this site first" });
  const [client] = await db.select({ name: businessNameSql }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  const business = client?.name ?? "";
  try {
    await dispatchStoredContractorEmail({
      clientId,
      to: contractor.email,
      subject: `Signing in at ${site.name}`,
      html: `<p>Hello ${escapeHtml(contractor.name)},</p>
<p>When you arrive at <strong>${escapeHtml(site.name)}</strong>${business ? ` (${escapeHtml(business)})` : ""}, please sign in with the button below before you start work.</p>
<p>You'll read the site's fire procedure and asbestos register, confirm you've read them and sign with your finger. Please sign out on the same phone when you leave.</p>
${emailButton(url, "Sign in on arrival")}
<p style="color:#64748b;font-size:14px">There is also a sign-in QR code at reception.</p>`,
      text: `Hello ${contractor.name},\n\nWhen you arrive at ${site.name}${business ? ` (${business})` : ""}, please sign in before you start work: ${url}\n\nYou'll read the site's fire procedure and asbestos register, confirm you've read them and sign. Please sign out on the same phone when you leave.`,
    });
  } catch (err) {
    req.log?.warn({ err }, "Contractor sign-in link email failed");
    return res.status(502).json({ error: "The email could not be sent. Please try again." });
  }
  res.json({ sentTo: contractor.email });
});

function visitStatus(row: { signedOutAt: Date | null; signedInAt: Date }): "on_site" | "signed_out" | "did_not_sign_out" {
  if (row.signedOutAt) return "signed_out";
  return Date.now() - new Date(row.signedInAt).getTime() < ON_SITE_HOURS * 3_600_000 ? "on_site" : "did_not_sign_out";
}

const visitColumns = {
  id: contractorSignInsTable.id,
  siteId: contractorSignInsTable.siteId,
  siteName: contractorSignInsTable.siteName,
  contractorId: contractorSignInsTable.contractorId,
  name: contractorSignInsTable.visitorName,
  company: contractorSignInsTable.company,
  phone: contractorSignInsTable.phone,
  email: contractorSignInsTable.email,
  visitReason: contractorSignInsTable.visitReason,
  fireAcknowledged: sql<boolean>`(${contractorSignInsTable.fireProcedureText} IS NOT NULL)`,
  asbestosStatus: contractorSignInsTable.asbestosStatus,
  signedInAt: contractorSignInsTable.signedInAt,
  signedOutAt: contractorSignInsTable.signedOutAt,
  signedOutByName: usersTable.name,
};

/** Visits at the caller's sites; ?siteId= narrows to one, ?days= (default 30, at most 366) sets how far back. */
router.get("/visits", async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const sites = await visibleSites(req, clientId);
  let siteIds = sites.map((site) => site.id);
  if (req.query.siteId !== undefined && req.query.siteId !== "") {
    const siteId = parseId(req.query.siteId as string);
    if (!siteId || !siteIds.includes(siteId)) return res.status(404).json({ error: "Site not found" });
    siteIds = [siteId];
  }
  const days = Math.min(366, Math.max(1, Number(req.query.days) || 30));
  if (siteIds.length === 0) return res.json([]);
  const rows = await db.select(visitColumns).from(contractorSignInsTable)
    .leftJoin(usersTable, eq(usersTable.id, contractorSignInsTable.signedOutBy))
    .where(and(
      eq(contractorSignInsTable.clientId, clientId),
      inArray(contractorSignInsTable.siteId, siteIds),
      or(onSiteSql, sql`${contractorSignInsTable.signedInAt} > now() - make_interval(days => ${days})`),
    ))
    .orderBy(sql`${contractorSignInsTable.signedInAt} DESC`)
    .limit(1000);
  res.json(rows.map((row) => ({ ...row, status: visitStatus(row) })));
});

async function visitFromParams(req: Request, res: Response, clientId: number) {
  const id = parseId(req.params.id);
  const sites = await visibleSites(req, clientId);
  const [row] = id && sites.length ? await db.select({
    ...visitColumns,
    fireProcedureText: contractorSignInsTable.fireProcedureText,
    asbestosSnapshot: contractorSignInsTable.asbestosSnapshot,
    signature: contractorSignInsTable.signature,
  }).from(contractorSignInsTable)
    .leftJoin(usersTable, eq(usersTable.id, contractorSignInsTable.signedOutBy))
    .where(and(
      eq(contractorSignInsTable.id, id),
      eq(contractorSignInsTable.clientId, clientId),
      inArray(contractorSignInsTable.siteId, sites.map((site) => site.id)),
    ))
    .limit(1) : [];
  if (!row) res.status(404).json({ error: "Visit not found" });
  return row ?? null;
}

router.get("/visits/:id", async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const visit = await visitFromParams(req, res, clientId);
  if (!visit) return;
  res.json({ ...visit, status: visitStatus(visit) });
});

/** Sign someone out for them, e.g. at the fire roll call or when they left without signing out. */
router.post("/visits/:id/sign-out", denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const visit = await visitFromParams(req, res, clientId);
  if (!visit) return;
  if (!visit.signedOutAt) {
    await db.update(contractorSignInsTable)
      .set({ signedOutAt: new Date(), signedOutBy: req.currentUser!.id })
      .where(and(eq(contractorSignInsTable.id, visit.id), isNull(contractorSignInsTable.signedOutAt)));
  }
  const refreshed = await visitFromParams(req, res, clientId);
  if (!refreshed) return;
  const { signature: _signature, fireProcedureText: _fire, asbestosSnapshot: _asbestos, ...summary } = refreshed;
  res.json({ ...summary, status: visitStatus(refreshed) });
});

export default router;
