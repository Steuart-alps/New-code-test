import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { contractorsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  GetContractorParams,
  UpdateContractorParams,
  DeleteContractorParams,
} from "@workspace/api-zod";
import { z } from "zod";
import { requireAuth, requireClientAdmin, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { randomUUID } from "node:crypto";
import { filterName } from "../lib/contentFilter";
import { digestBearerToken, newBearerToken } from "../lib/bearerTokens";
import { getEffectiveOptionList } from "../lib/formOptions";
import { CONTRACTOR_DBS_TYPES, normalizeContractorDbsType } from "../lib/contractorDbsTypes";

// Local schemas that coerce ISO date strings (the OpenAPI-generated zod schemas
// use `z.date()` which does NOT coerce strings, breaking JSON request bodies).
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
  dbsType:                     z.preprocess(normalizeContractorDbsType, z.enum(CONTRACTOR_DBS_TYPES).nullish()),
  dbsExpiryDate:               z.coerce.date().nullish(),
});

const CertificateBody = z.object({
  certificateName: z.string().min(1).max(200),
  issuer:          z.string().max(200).nullish(),
  completedDate:   z.coerce.date().nullish(),
  expiryDate:      z.coerce.date().nullish(),
  notes:           z.string().max(2000).nullish(),
}).refine(
  body => !body.completedDate || !body.expiryDate || body.expiryDate >= body.completedDate,
  { message: "Expiry date must be on or after completion date", path: ["expiryDate"] },
);

const UpdateContractorBody = CreateContractorBody;

const router: IRouter = Router();

const PortalLinkBody = z.object({
  // Short defaults reduce the impact of a forwarded link; managers may choose
  // a longer period when a contractor needs time to retrieve documents.
  expiresInDays: z.coerce.number().int().min(1).max(90).default(30),
});

async function portalAudit(
  clientId: number,
  contractorId: number,
  actorUserId: number | undefined,
  eventType: string,
  details: Record<string, unknown> = {},
) {
  await db.execute(sql`
    INSERT INTO contractor_portal_audit_log
      (client_id, contractor_id, actor_type, actor_user_id, event_type, details)
    VALUES
      (${clientId}, ${contractorId}, 'manager', ${actorUserId ?? null}, ${eventType}, ${JSON.stringify(details)}::jsonb)
  `);
}

/** Sanitise the trades array from the request body. */
function parseTrades(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 20 || raw.some(t => typeof t !== "string")) return null;
  const trades = raw.map(t => (t as string).trim());
  if (trades.some(t => !t || t.length > 60)) return null;
  if (new Set(trades.map(t => t.toLowerCase())).size !== trades.length) return null;
  return trades;
}

async function validateTrades(clientId: number, raw: unknown, existing: string[] = []) {
  const trades = parseTrades(raw);
  if (!trades) return null;
  const allowed = await getEffectiveOptionList(clientId, "fixtrack_trades");
  return trades.every(trade => existing.includes(trade) || allowed.includes(trade)) ? trades : null;
}

async function contractorInActiveClient(req: Request, contractorId: number) {
  const clientId = getClientId(req);
  if (!clientId) return undefined;
  const [contractor] = await db.select().from(contractorsTable).where(and(
    eq(contractorsTable.id, contractorId),
    eq(contractorsTable.clientId, clientId),
  ));
  return contractor;
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
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const trades = await validateTrades(clientId, req.body?.trades);
  if (!trades) {
    res.status(400).json({ error: "Trades must use active client trade options" });
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
    .values({
      ...body, clientId, trades, updatedAt: new Date(),
      dbsIssueDate: body.dbsType === "None" ? null : body.dbsIssueDate,
      dbsExpiryDate: body.dbsType === "None" ? null : body.dbsExpiryDate,
    })
    .returning();
  res.status(201).json(contractor);
});

router.get("/contractors/:id", requireAuth, async (req, res) => {
  const { id } = GetContractorParams.parse({ id: Number(req.params.id) });

  const contractor = await contractorInActiveClient(req, id);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  res.json(contractor);
});

router.put("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = UpdateContractorParams.parse({ id: Number(req.params.id) });
  const body    = UpdateContractorBody.parse(req.body);
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

  const existing = await db.select().from(contractorsTable)
    .where(and(eq(contractorsTable.id, id), eq(contractorsTable.clientId, clientId)));
  if (!existing[0]) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  // Merge trades only when explicitly supplied in the request body
  const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (body.dbsType === "None") {
    updateData.dbsIssueDate = null;
    updateData.dbsExpiryDate = null;
  }
  if ("trades" in req.body) {
    const trades = await validateTrades(clientId, req.body.trades, existing[0].trades ?? []);
    if (!trades) {
      res.status(400).json({ error: "Trades must use active client trade options" });
      return;
    }
    updateData.trades = trades;
  }

  const [contractor] = await db
    .update(contractorsTable)
    .set(updateData as any)
    .where(and(eq(contractorsTable.id, id), eq(contractorsTable.clientId, clientId)))
    .returning();
  res.json(contractor);
});

router.delete("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = DeleteContractorParams.parse({ id: Number(req.params.id) });

  const existing = await contractorInActiveClient(req, id);
  if (!existing) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  await db.delete(contractorsTable).where(and(
    eq(contractorsTable.id, id),
    eq(contractorsTable.clientId, existing.clientId),
  ));
  res.status(204).send();
});

// ── Manager-issued contractor self-service links ───────────────────────────
// The plaintext bearer token is returned only at issuance time. Reissuing a
// link atomically replaces the prior token; revocation preserves its audit row.
router.post("/contractors/:id/portal-link", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  if (!Number.isInteger(contractorId) || contractorId <= 0) {
    res.status(400).json({ error: "Invalid contractor ID" });
    return;
  }
  const body = PortalLinkBody.parse(req.body ?? {});
  const contractor = await contractorInActiveClient(req, contractorId);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

   const token = newBearerToken();
  const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);
  await db.execute(sql`
    INSERT INTO contractor_portal_tokens
       (client_id, contractor_id, token, token_hash, expires_at, revoked_at, issued_by, created_at)
    VALUES
       (${contractor.clientId}, ${contractor.id}, NULL, ${digestBearerToken(token)}, ${expiresAt}, NULL, ${req.currentUser?.id ?? null}, now())
    ON CONFLICT (contractor_id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
       token = NULL,
       token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL,
      issued_by = EXCLUDED.issued_by,
      created_at = now()
  `);
  await portalAudit(contractor.clientId, contractor.id, req.currentUser?.id, "link_issued", {
    expiresAt: expiresAt.toISOString(),
  });
  const appUrl = (process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  res.status(201).json({
    token,
    expiresAt: expiresAt.toISOString(),
    portalUrl: `${appUrl}/contractor-portal/${token}`,
  });
});

router.delete("/contractors/:id/portal-link", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  if (!Number.isInteger(contractorId) || contractorId <= 0) {
    res.status(400).json({ error: "Invalid contractor ID" });
    return;
  }
  const contractor = await contractorInActiveClient(req, contractorId);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  await db.execute(sql`
    UPDATE contractor_portal_tokens SET revoked_at = now()
    WHERE contractor_id = ${contractor.id} AND client_id = ${contractor.clientId}
      AND revoked_at IS NULL
  `);
  await portalAudit(contractor.clientId, contractor.id, req.currentUser?.id, "link_revoked");
  res.status(204).send();
});

// ── Contractor certificates ────────────────────────────────────────────────

router.get("/contractors/:id/certificates", requireAuth, async (req, res) => {
  const contractorId = Number(req.params.id);
  const existing = await contractorInActiveClient(req, contractorId);
  if (!existing) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  const certs = await db.execute(sql`
    SELECT id, certificate_name, issuer, completed_date, expiry_date, notes, created_at, updated_at
    FROM contractor_certificates
    WHERE contractor_id = ${contractorId} AND client_id = ${existing.clientId}
    ORDER BY expiry_date ASC NULLS LAST, certificate_name ASC
  `);
  res.json(certs.rows ?? []);
});

router.post("/contractors/:id/certificates", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  const existing = await contractorInActiveClient(req, contractorId);
  if (!existing) {
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
  const existing = await contractorInActiveClient(req, contractorId);
  if (!existing) {
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
    WHERE id = ${certId} AND contractor_id = ${contractorId} AND client_id = ${existing.clientId}
  `);
  const [cert] = (await db.execute(sql`
    SELECT * FROM contractor_certificates
    WHERE id = ${certId} AND contractor_id = ${contractorId} AND client_id = ${existing.clientId}
  `)).rows;
  if (!cert) { res.status(404).json({ error: "Certificate not found" }); return; }
  res.json(cert);
});

router.delete("/contractors/:id/certificates/:certId", requireAuth, requireClientAdmin, async (req, res) => {
  const contractorId = Number(req.params.id);
  const certId = Number(req.params.certId);
  const existing = await contractorInActiveClient(req, contractorId);
  if (!existing) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  const deleted = await db.execute(sql`
    DELETE FROM contractor_certificates
    WHERE id = ${certId} AND contractor_id = ${contractorId} AND client_id = ${existing.clientId}
    RETURNING id
  `);
  if (!deleted.rows?.length) {
    res.status(404).json({ error: "Certificate not found" });
    return;
  }
  res.status(204).send();
});

// Resends remain approval drafts, preserving the exact calendar event and
// encrypted credential payload from the most recently dispatched reminder.
router.post("/contractors/:id/reminders/:itemId/resend", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  const contractorId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!clientId || !Number.isSafeInteger(contractorId) || contractorId <= 0 || !Number.isSafeInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid contractor or requirement" });
  }
  const departmentId = getActiveDepartmentId(req);
  const result = await db.transaction(async tx => {
    // Serialize repeated clicks without changing the original delivery record.
    const contractors = await tx.execute(sql`SELECT id, email FROM contractors
      WHERE id=${contractorId} AND client_id=${clientId} FOR UPDATE`);
    if (!contractors.rows.length) return { status: 404, error: "Contractor not found" };
    const items = await tx.execute(sql`SELECT ci.id, COALESCE(ci.department_id, s.department_id) AS department_id FROM compliance_items ci
      LEFT JOIN sites s ON s.id=ci.site_id AND s.client_id=ci.client_id
      WHERE ci.id=${itemId} AND ci.client_id=${clientId} AND ci.contractor_id=${contractorId}
        AND ci.status <> 'completed'
        AND (${departmentId}::integer IS NULL OR ci.department_id IS NULL OR ci.department_id=${departmentId})
        AND (${departmentId}::integer IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})
      FOR UPDATE OF ci`);
    if (!items.rows.length) return { status: 404, error: "Active requirement not found" };
    const pending = await tx.execute(sql`SELECT id FROM contractor_email_queue
      WHERE client_id=${clientId} AND contractor_id=${contractorId} AND entity_type='compliance'
        AND entity_id=${itemId} AND email_type='reminder' AND status IN ('pending','approved','sending') LIMIT 1`);
    if (pending.rows.length) return { status: 409, error: "A reminder is already awaiting approval or being sent" };
    const copied = await tx.execute(sql`INSERT INTO contractor_email_queue
      (client_id, entity_type, entity_id, department_id, contractor_id, mode, email_type,
       to_email, subject, body_html, body_text, cc_json, ics_content, ics_filename,
       email_preview_json, encrypted_token_payload, requested_by, idempotency_key)
      SELECT client_id, entity_type, entity_id, ${items.rows[0].department_id}::integer, contractor_id, mode, email_type,
        to_email, subject, body_html, body_text, cc_json, ics_content, ics_filename,
        email_preview_json, encrypted_token_payload, ${req.currentUser!.id}, ${`reminder-resend-${randomUUID()}`}
      FROM contractor_email_queue
      WHERE client_id=${clientId} AND contractor_id=${contractorId} AND entity_type='compliance'
        AND entity_id=${itemId} AND email_type='reminder' AND status='sent'
        AND id=(SELECT id FROM contractor_email_queue
          WHERE client_id=${clientId} AND contractor_id=${contractorId} AND entity_type='compliance'
            AND entity_id=${itemId} AND email_type='reminder' AND status='sent'
          ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 1)
        AND lower(to_email)=lower(${contractors.rows[0].email}::text)
        AND (${departmentId}::integer IS NULL OR department_id IS NULL OR department_id=${departmentId})
      ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 1 RETURNING id`);
    if (!copied.rows.length) return { status: 404, error: "No previously sent reminder is available to resend" };
    return { status: 202, queueId: copied.rows[0].id };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  return res.status(202).json({ queueId: result.queueId, message: "Latest reminder queued for manager approval, including its calendar attachment where available." });
});

// ── Legacy contractor reminder endpoint ─────────────────────────────────────
//
// Contractor dispatches are deliberately owned by the FixTrack approval
// workflow. Keeping this old direct-send endpoint as a hard refusal prevents a
// card-level shortcut from bypassing the manager approval/audit trail.

router.post("/contractors/:id/send-reminder", requireAuth, requireClientAdmin, async (req, res) => {
  res.status(410).json({
    error: "Direct contractor emails are disabled. Create or select a FixTrack issue and request manager approval.",
  });
});

export default router;
