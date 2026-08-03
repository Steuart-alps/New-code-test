import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { fixTrackIssuesTable, sitesTable, contractorsTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";
import { generateActionTokens, sendContractorAssignmentEmail } from "../lib/fixTrackNotifications";

const router = Router();
const storage = new ObjectStorageService();

// ── Helpers ────────────────────────────────────────────────────────────────────

function allowedSites(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
    ));
}

async function verifySite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return true;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!row;
}

async function verifyContractor(contractorId: number | null | undefined, clientId: number) {
  if (contractorId == null) return true;
  const [row] = await db.select({ id: contractorsTable.id }).from(contractorsTable)
    .where(and(eq(contractorsTable.id, contractorId), eq(contractorsTable.clientId, clientId))).limit(1);
  return !!row;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

export const ISSUE_TYPES_LIST = [
  "electrical", "plumbing", "gas", "structural", "equipment",
  "hvac", "it_comms", "safety_hazard", "cleaning", "general",
] as const;

/** Suggested priority per issue type — shown to the reporter and auto-applied. */
export const ISSUE_AUTO_PRIORITY: Record<string, string> = {
  gas:           "urgent",
  safety_hazard: "urgent",
  electrical:    "high",
  structural:    "high",
  hvac:          "medium",
  plumbing:      "medium",
  equipment:     "medium",
  it_comms:      "low",
  cleaning:      "low",
  general:       "low",
};

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const STATUSES   = ["reported", "in_progress", "resolved", "closed"] as const;

const issueCreate = z.object({
  title:         z.string().min(1).max(300),
  issueType:     z.enum(ISSUE_TYPES_LIST).optional(),
  location:      z.string().min(1).max(300),
  description:   z.string().max(5000).nullable().optional(),
  priority:      z.enum(PRIORITIES).optional(),
  status:        z.enum(STATUSES).optional(),
  reportedBy:    z.string().min(1).max(200),
  reportedDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assignedTo:    z.string().max(200).nullable().optional(),
  contractorId:  z.number().int().nullable().optional(),
  targetDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  resolvedDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  solutionNotes: z.string().max(5000).nullable().optional(),
  mediaUrls:     z.array(z.string().max(1000)).optional(),
  siteId:        z.number().int().nullable().optional(),
});

const issueUpdate = issueCreate.partial();

// ── List ──────────────────────────────────────────────────────────────────────

router.get("/issues", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const deptId = getActiveDepartmentId(req);
  const conditions: any[] = [eq(fixTrackIssuesTable.clientId, clientId)];

  if (deptId !== null) {
    conditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, deptId))) as any,
    );
  }

  const { status, priority, issueType, siteId } = req.query as any;
  if (status)    conditions.push(eq(fixTrackIssuesTable.status, status));
  if (priority)  conditions.push(eq(fixTrackIssuesTable.priority, priority));
  if (issueType) conditions.push(eq(fixTrackIssuesTable.issueType, issueType));
  if (siteId)    conditions.push(eq(fixTrackIssuesTable.siteId, Number(siteId)));

  const rows = await db
    .select({ issue: fixTrackIssuesTable, site: sitesTable, contractor: contractorsTable })
    .from(fixTrackIssuesTable)
    .leftJoin(sitesTable,       eq(fixTrackIssuesTable.siteId,        sitesTable.id))
    .leftJoin(contractorsTable, eq(fixTrackIssuesTable.contractorId,   contractorsTable.id))
    .where(and(...conditions))
    .orderBy(desc(fixTrackIssuesTable.createdAt));

  res.json(rows.map(r => ({
    ...r.issue,
    siteName:       r.site?.name        ?? null,
    contractorName: r.contractor?.name  ?? null,
    contractorEmail: r.contractor?.email ?? null,
  })));
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/issues", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = issueCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const data = parsed.data;
  if (!(await verifySite(data.siteId, clientId)))           return res.status(400).json({ error: "Invalid site" });
  if (!(await verifyContractor(data.contractorId, clientId))) return res.status(400).json({ error: "Invalid contractor" });

  const [row] = await db.insert(fixTrackIssuesTable)
    .values({ ...data, clientId, createdBy: (req.session as any).userId ?? null })
    .returning();
  res.status(201).json(row);
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put("/issues/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = issueUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const data = parsed.data as any;
  if ("siteId"       in data && !(await verifySite(data.siteId, clientId)))           return res.status(400).json({ error: "Invalid site" });
  if ("contractorId" in data && !(await verifyContractor(data.contractorId, clientId))) return res.status(400).json({ error: "Invalid contractor" });

  const [row] = await db
    .update(fixTrackIssuesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)))
    .returning();

  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/issues/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select({ id: fixTrackIssuesTable.id }).from(fixTrackIssuesTable)
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  await db.delete(fixTrackIssuesTable)
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)));
  res.status(204).end();
});

// ── Request media upload URL ──────────────────────────────────────────────────

router.post("/issues/:id/request-upload", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select({ id: fixTrackIssuesTable.id }).from(fixTrackIssuesTable)
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  z.object({
    name:        z.string().min(1).max(200),
    contentType: z.string().min(1).max(100),
  }).parse(req.body);

  try {
    const uploadUrl  = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    await storage.trySetObjectEntityAclPolicy(uploadUrl, { owner: String(clientId), visibility: "private" });
    res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL", detail: err?.message });
  }
});

// ── Contractor suggestions ────────────────────────────────────────────────────

router.get("/contractors/suggest", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { issueType } = req.query as { issueType?: string };

  const result = await db.execute(sql`
    SELECT id, name, company, email, trades
    FROM   contractors
    WHERE  client_id = ${clientId}
    ORDER  BY name
  `);

  const all = (result.rows as any[]).map(c => ({
    id:      c.id as number,
    name:    c.name as string,
    company: c.company as string | null,
    email:   c.email as string,
    trades:  Array.isArray(c.trades) ? c.trades as string[] : [],
  }));

  // Gas is one issue type but three distinct trades
  const GAS_SUBTRADES = ["gas_kitchen", "gas_fireplace", "gas_heating", "gas"];
  const matchTrades = issueType === "gas"
    ? GAS_SUBTRADES
    : issueType ? [issueType] : null;

  const matches = matchTrades
    ? all.filter(c => c.trades.some((t: string) => matchTrades.includes(t)))
    : all;

  res.json({ matches, all });
});

// ── Send to contractor ────────────────────────────────────────────────────────

router.post("/issues/:id/send-to-contractor", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const result = await db.execute(sql`
    SELECT
      fi.id, fi.title, fi.issue_type, fi.priority, fi.location, fi.description,
      fi.contractor_id,
      s.name  AS site_name,
      c.name  AS contractor_name,
      c.email AS contractor_email,
      cl.name AS company_name
    FROM  fix_track_issues fi
    LEFT  JOIN sites       s  ON s.id  = fi.site_id
    LEFT  JOIN contractors c  ON c.id  = fi.contractor_id
    LEFT  JOIN clients     cl ON cl.id = fi.client_id
    WHERE fi.id = ${id} AND fi.client_id = ${clientId}
    LIMIT 1
  `);

  const issue = (result.rows as any[])[0];
  if (!issue)                 return res.status(404).json({ error: "Issue not found" });
  if (!issue.contractor_id)   return res.status(400).json({ error: "No contractor assigned to this issue" });
  if (!issue.contractor_email) return res.status(400).json({ error: "Contractor has no email address" });

  // Check for existing active (unused, non-expired) tokens for this issue.
  // Return 409 so the frontend can warn the manager before resending.
  const force = req.query.force === "true";
  if (!force) {
    const existing = await db.execute(sql`
      SELECT id FROM fix_track_action_tokens
      WHERE  issue_id   = ${id}
        AND  client_id  = ${clientId}
        AND  used_at    IS NULL
        AND  expires_at  > now()
      LIMIT 1
    `);
    if ((existing.rows as any[]).length > 0) {
      return res.status(409).json({
        alreadySent: true,
        message: "An email has already been sent for this issue. Send again?",
      });
    }
  }

  // ?force=true: expire all previous tokens before minting fresh ones
  await db.execute(sql`
    UPDATE fix_track_action_tokens
    SET    expires_at = now()
    WHERE  issue_id   = ${id}
      AND  client_id  = ${clientId}
      AND  used_at    IS NULL
  `);

  const proto   = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host    = (req.headers["x-forwarded-host"]  as string) ?? req.get("host") ?? "";
  const baseUrl = `${proto}://${host}`;

  const tokens = await generateActionTokens(id, clientId, issue.contractor_id);

  // Generate 30-day signed download links for site documents (best-effort).
  const siteDocuments: { name: string; url: string }[] = [];
  const siteDocResult = await db.execute(sql`
    SELECT sd.name, sd.object_path
    FROM   fix_track_issues fi
    JOIN   site_documents   sd ON sd.site_id = fi.site_id AND sd.client_id = fi.client_id
    WHERE  fi.id        = ${id}
      AND  fi.client_id = ${clientId}
      AND  fi.site_id   IS NOT NULL
    LIMIT  10
  `);

  for (const doc of (siteDocResult.rows as any[])) {
    try {
      const url = await storage.getSignedDownloadURL(
        doc.object_path as string,
        30 * 24 * 60 * 60,   // 30 days
      );
      siteDocuments.push({ name: doc.name as string, url });
    } catch {
      // Skip any document that fails — don't block the email
    }
  }

  await sendContractorAssignmentEmail({
    contractorName:   issue.contractor_name   ?? "Contractor",
    contractorEmail:  issue.contractor_email,
    issueTitle:       issue.title,
    issueType:        issue.issue_type,
    issuePriority:    issue.priority,
    issueLocation:    issue.location,
    issueDescription: issue.description,
    siteName:         issue.site_name,
    companyName:      issue.company_name      ?? "ComplyTrack",
    bookedToken:      tokens.bookedToken,
    completedToken:   tokens.completedToken,
    baseUrl,
    clientId,
    siteDocuments:    siteDocuments.length ? siteDocuments : undefined,
  });

  res.json({ ok: true, message: "Email sent to contractor" });
});

// ── Summary ───────────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.select().from(fixTrackIssuesTable)
    .where(eq(fixTrackIssuesTable.clientId, clientId));

  const total    = rows.length;
  const open     = rows.filter(r => r.status === "reported" || r.status === "in_progress").length;
  const urgent   = rows.filter(r => r.priority === "urgent" && (r.status === "reported" || r.status === "in_progress")).length;
  const resolved = rows.filter(r => r.status === "resolved" || r.status === "closed").length;

  res.json({ total, open, urgent, resolved });
});

export default router;
