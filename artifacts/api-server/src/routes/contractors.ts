import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { contractorsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  GetContractorParams,
  UpdateContractorParams,
  DeleteContractorParams,
} from "@workspace/api-zod";
import { z } from "zod";
import { requireAuth, requireClientAdmin, getClientId, canAccessClient } from "../middleware/requireAuth";
import { filterName } from "../lib/contentFilter";
import { sendSystemEmail } from "../lib/email";
import { getPublicAppUrl } from "../lib/email";

// Local schemas that coerce ISO date strings (the OpenAPI-generated zod schemas
// use `z.date()` which does NOT coerce strings, breaking JSON request bodies).
const DBS_TYPES = ["DBS Check (Basic)", "DBS Check (Standard)", "DBS Check (Enhanced)", "PVG Scheme (Scotland)"] as const;

const CreateContractorBody = z.object({
  name:                        z.string().min(1),
  company:                     z.string().nullish(),
  email:                       z.string().email(),
  phone:                       z.string().nullish(),
  address:                     z.string().nullish(),
  notes:                       z.string().nullish(),
  gasSafeNumber:               z.string().max(30).nullish(),
  gasSafeRegistration:         z.string().nullish(),
  publicLiabilityExpiry:       z.coerce.date().nullish(),
  dbsCheckDate:                z.coerce.date().nullish(),
  dbsIssueDate:                z.coerce.date().nullish(),
  dbsType:                     z.enum(DBS_TYPES).nullish(),
  dbsExpiryDate:               z.coerce.date().nullish(),
});

const CertificateBody = z.object({
  certificateName: z.string().min(1).max(200),
  issuer:          z.string().max(200).nullish(),
  completedDate:   z.coerce.date().nullish(),
  expiryDate:      z.coerce.date().nullish(),
  notes:           z.string().max(2000).nullish(),
});

const UpdateContractorBody = CreateContractorBody;

const router: IRouter = Router();

/** Sanitise the trades array from the request body. */
function parseTrades(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((t): t is string => typeof t === "string")
    .slice(0, 20);
}

router.get("/contractors", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const contractors = await db
    .select()
    .from(contractorsTable)
    .where(eq(contractorsTable.clientId, clientId))
    .orderBy(contractorsTable.name);
  res.json(contractors);
});

router.post("/contractors", requireAuth, requireClientAdmin, async (req, res) => {
  const body     = CreateContractorBody.parse(req.body);
  const trades   = parseTrades(req.body?.trades);
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const nameCheck = filterName(body.name);
  if (!nameCheck.ok) {
    res.status(400).json({ error: nameCheck.message });
    return;
  }
  if (body.company) {
    const companyCheck = filterName(body.company);
    if (!companyCheck.ok) {
      res.status(400).json({ error: companyCheck.message });
      return;
    }
  }
  if (body.gasSafeNumber) {
    const gasCheck = filterName(body.gasSafeNumber);
    if (!gasCheck.ok) {
      res.status(400).json({ error: gasCheck.message });
      return;
    }
  }
  const [contractor] = await db
    .insert(contractorsTable)
    .values({ ...body, clientId, trades, updatedAt: new Date() })
    .returning();
  res.status(201).json(contractor);
});

router.get("/contractors/:id", requireAuth, async (req, res) => {
  const { id } = GetContractorParams.parse({ id: Number(req.params.id) });

  const [contractor] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  if (!canAccessClient(req, contractor.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(contractor);
});

router.put("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = UpdateContractorParams.parse({ id: Number(req.params.id) });
  const body    = UpdateContractorBody.parse(req.body);

  const nameCheck = filterName(body.name);
  if (!nameCheck.ok) {
    res.status(400).json({ error: nameCheck.message });
    return;
  }
  if (body.company) {
    const companyCheck = filterName(body.company);
    if (!companyCheck.ok) {
      res.status(400).json({ error: companyCheck.message });
      return;
    }
  }
  if (body.gasSafeNumber) {
    const gasCheck = filterName(body.gasSafeNumber);
    if (!gasCheck.ok) {
      res.status(400).json({ error: gasCheck.message });
      return;
    }
  }

  const existing = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!existing[0] || !canAccessClient(req, existing[0].clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  // Merge trades only when explicitly supplied in the request body
  const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if ("trades" in req.body) updateData.trades = parseTrades(req.body.trades);

  const [contractor] = await db
    .update(contractorsTable)
    .set(updateData as any)
    .where(and(eq(contractorsTable.id, id), eq(contractorsTable.clientId, existing[0].clientId)))
    .returning();
  res.json(contractor);
});

router.delete("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = DeleteContractorParams.parse({ id: Number(req.params.id) });

  const existing = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!existing[0] || !canAccessClient(req, existing[0].clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  await db.delete(contractorsTable).where(eq(contractorsTable.id, id));
  res.status(204).send();
});

// ── Contractor certificates ────────────────────────────────────────────────

router.get("/contractors/:id/certificates", requireAuth, async (req, res) => {
  const contractorId = Number(req.params.id);
  const [existing] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!existing || !canAccessClient(req, existing.clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  const certs = await db.execute(sql`
    SELECT id, certificate_name, issuer, completed_date, expiry_date, notes, created_at, updated_at
    FROM contractor_certificates
    WHERE contractor_id = ${contractorId}
    ORDER BY expiry_date ASC NULLS LAST, certificate_name ASC
  `);
  res.json(certs.rows ?? []);
});

router.post("/contractors/:id/certificates", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  const [existing] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!existing || !canAccessClient(req, existing.clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  const body = CertificateBody.parse(req.body);
  const [cert] = (await db.execute(sql`
    INSERT INTO contractor_certificates
      (client_id, contractor_id, certificate_name, issuer, completed_date, expiry_date, notes)
    VALUES
      (${existing.clientId}, ${contractorId}, ${body.certificateName}, ${body.issuer ?? null},
       ${body.completedDate ?? null}, ${body.expiryDate ?? null}, ${body.notes ?? null})
    RETURNING *
  `)).rows;
  res.status(201).json(cert);
});

router.put("/contractors/:id/certificates/:certId", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  const certId = Number(req.params.certId);
  const [existing] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!existing || !canAccessClient(req, existing.clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  const body = CertificateBody.parse(req.body);
  await db.execute(sql`
    UPDATE contractor_certificates SET
      certificate_name = ${body.certificateName},
      issuer           = ${body.issuer ?? null},
      completed_date   = ${body.completedDate ?? null},
      expiry_date      = ${body.expiryDate ?? null},
      notes            = ${body.notes ?? null},
      updated_at       = now()
    WHERE id = ${certId} AND contractor_id = ${contractorId}
  `);
  const [cert] = (await db.execute(sql`
    SELECT * FROM contractor_certificates WHERE id = ${certId}
  `)).rows;
  if (!cert) { res.status(404).json({ error: "Certificate not found" }); return; }
  res.json(cert);
});

router.delete("/contractors/:id/certificates/:certId", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  const certId = Number(req.params.certId);
  const [existing] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!existing || !canAccessClient(req, existing.clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  await db.execute(sql`
    DELETE FROM contractor_certificates WHERE id = ${certId} AND contractor_id = ${contractorId}
  `);
  res.status(204).send();
});

// ── Resend contractor job reminder email (Task #101) ───────────────────────

router.post("/contractors/:id/send-reminder", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  if (!Number.isFinite(contractorId)) {
    res.status(400).json({ error: "Invalid contractor id" });
    return;
  }
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const [contractor] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!contractor || !canAccessClient(req, contractor.clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  if (!contractor.email) {
    res.status(400).json({ error: `${contractor.name} does not have an email address on file.` });
    return;
  }

  // Fetch client company name from app settings
  const settingsRows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    if (row.value != null) settings[row.key] = row.value;
  }
  const companyName = settings["companyName"] ?? "ComplyTrack";
  const appUrl = getPublicAppUrl();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">🛡️ ComplyTrack</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Contractor compliance reminder</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 16px;">Dear ${contractor.name},</p>
      <p style="font-size:15px;color:#334155;margin:0 0 16px;">
        This is a reminder from <strong>${companyName}</strong> to ensure your compliance records are up to date.
      </p>
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        Please check that the following are current and send updated documents to your account manager if required:
      </p>
      <ul style="margin:0 0 20px;padding-left:20px;color:#334155;font-size:14px;">
        <li style="margin:6px 0;">Public liability insurance certificate</li>
        <li style="margin:6px 0;">Gas Safe registration (if applicable)</li>
        <li style="margin:6px 0;">DBS / PVG check (if applicable)</li>
        <li style="margin:6px 0;">Any other relevant compliance certificates</li>
      </ul>
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
          Open ComplyTrack →
        </a>
      </div>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">
      ComplyTrack by ALPS Consulting · Sent on behalf of ${companyName}.
    </div>
  </div>
</body>
</html>`;

  await sendSystemEmail({
    to: contractor.email,
    subject: `Compliance reminder — please update your details`,
    html,
  });

  res.json({ success: true, message: `Reminder sent to ${contractor.email}` });
});

export default router;
