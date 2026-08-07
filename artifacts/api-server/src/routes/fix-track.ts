import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { fixTrackIssuesTable, sitesTable, contractorsTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";
import { ObjectStorageService } from "../lib/objectStorage";
import { generateActionTokens, sendContractorAssignmentEmail, sendContractorQuoteEmail } from "../lib/fixTrackNotifications";

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

// Gas is one issue type but three distinct trades.
const GAS_SUBTRADES = ["gas_kitchen", "gas_fireplace", "gas_heating", "gas"];

/** Trades that match a given issue type — same matching as GET /contractors/suggest. */
function tradesForIssueType(issueType: string): string[] {
  return issueType === "gas" ? GAS_SUBTRADES : [issueType];
}

/**
 * Pick the client's best-matching contractor for an issue type by trade.
 * Returns the first (name-ordered) contractor whose trades cover the type,
 * or null when none match. Used to auto-assign on issue creation.
 */
async function pickContractorForType(clientId: number, issueType: string): Promise<number | null> {
  const matchTrades = tradesForIssueType(issueType);
  const result = await db.execute(sql`
    SELECT id, trades
    FROM   contractors
    WHERE  client_id = ${clientId}
    ORDER  BY name
  `);
  for (const c of (result.rows as any[])) {
    const trades = Array.isArray(c.trades) ? (c.trades as string[]) : [];
    if (trades.some((t) => matchTrades.includes(t))) return c.id as number;
  }
  return null;
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
  // Validated against the client's effective issue-type list at request time.
  issueType:     z.string().min(1).max(60).optional(),
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

// ── Get one ───────────────────────────────────────────────────────────────────

router.get("/issues/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const conditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, deptId))) as any,
    );
  }

  const [r] = await db
    .select({ issue: fixTrackIssuesTable, site: sitesTable, contractor: contractorsTable })
    .from(fixTrackIssuesTable)
    .leftJoin(sitesTable,       eq(fixTrackIssuesTable.siteId,      sitesTable.id))
    .leftJoin(contractorsTable, eq(fixTrackIssuesTable.contractorId, contractorsTable.id))
    .where(and(...conditions))
    .limit(1);
  if (!r) return res.status(404).json({ error: "Not found" });

  res.json({
    ...r.issue,
    siteName:        r.site?.name        ?? null,
    contractorName:  r.contractor?.name  ?? null,
    contractorEmail: r.contractor?.email ?? null,
  });
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/issues", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = issueCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const data = parsed.data;
  if (data.issueType !== undefined) {
    const allowedTypes = await getEffectiveOptionList(clientId, "fixtrack_issue_types");
    if (!allowedTypes.includes(data.issueType)) return res.status(400).json({ error: "Invalid issue type" });
  }
  if (!(await verifySite(data.siteId, clientId)))           return res.status(400).json({ error: "Invalid site" });
  if (!(await verifyContractor(data.contractorId, clientId))) return res.status(400).json({ error: "Invalid contractor" });

  // Auto-assign: if no contractor supplied, pick the client's best-matching
  // active contractor by trade for the issue type (same matching as
  // GET /contractors/suggest). Never auto-sends an email — emails still
  // require manager approval.
  let contractorId = data.contractorId ?? null;
  if (contractorId == null) {
    const autoId = await pickContractorForType(clientId, data.issueType ?? "general");
    if (autoId != null) contractorId = autoId;
  }

  const [row] = await db.insert(fixTrackIssuesTable)
    .values({ ...data, contractorId, clientId, createdBy: (req.session as any).userId ?? null })
    .returning();
  res.status(201).json(row);
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put("/issues/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = issueUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const data = parsed.data as any;
  if ("issueType" in data && data.issueType != null) {
    // Allow a value unchanged from the stored record even if it is no longer in
    // the client's effective list; reject only NEW values not in the list.
    const [current] = await db.select({ issueType: fixTrackIssuesTable.issueType }).from(fixTrackIssuesTable)
      .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId))).limit(1);
    if (data.issueType !== current?.issueType) {
      const allowedTypes = await getEffectiveOptionList(clientId, "fixtrack_issue_types");
      if (!allowedTypes.includes(data.issueType)) return res.status(400).json({ error: "Invalid issue type" });
    }
  }
  if ("siteId"       in data && !(await verifySite(data.siteId, clientId)))           return res.status(400).json({ error: "Invalid site" });
  if ("contractorId" in data && !(await verifyContractor(data.contractorId, clientId))) return res.status(400).json({ error: "Invalid contractor" });

  const updateConditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const updateDeptId = getActiveDepartmentId(req);
  if (updateDeptId !== null) {
    updateConditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, updateDeptId))) as any,
    );
  }

  const [row] = await db
    .update(fixTrackIssuesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(...updateConditions))
    .returning();

  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Append a note (atomic — safe under concurrent writers) ───────────────────

router.post("/issues/:id/notes", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const noteSchema = z.object({ note: z.string().min(1).max(2000) });
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const deptId = getActiveDepartmentId(req);
  const deptClause = deptId !== null
    ? sql` AND (site_id IS NULL OR site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${deptId})))`
    : sql``;

  const stamp = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const entry = `[${stamp}] ${parsed.data.note.trim()}`;

  // Append server-side in one statement so concurrent notes never clobber
  // each other.
  const result = await db.execute(sql`
    UPDATE fix_track_issues
    SET solution_notes = CASE
          WHEN solution_notes IS NULL OR solution_notes = '' THEN ${entry}
          ELSE solution_notes || E'\n\n' || ${entry}
        END,
        updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}${deptClause}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/issues/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select({ id: fixTrackIssuesTable.id }).from(fixTrackIssuesTable)
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  await db.delete(fixTrackIssuesTable)
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)));
  res.status(204).end();
});

// ── Request media upload URL ──────────────────────────────────────────────────

router.post("/issues/:id/request-upload", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
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
  const matchTrades = issueType ? tradesForIssueType(issueType) : null;

  const matches = matchTrades
    ? all.filter(c => c.trades.some((t: string) => matchTrades.includes(t)))
    : all;

  res.json({ matches, all });
});

// ── Contractor email approval workflow ───────────────────────────────────────
//
// Contractor emails require manager approval: staff request a send
// (mode "assign" or "quote"); a manager (client_admin/consultant or a
// maintenance manager) approves — which actually sends — or dismisses it.

function isManager(req: any): boolean {
  const u = req.currentUser;
  return !!u && (u.role === "client_admin" || u.role === "consultant" || u.isMaintenanceManager === true);
}

// Staff: request that a contractor email be sent (needs manager approval)
router.post("/issues/:id/request-send", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = z.object({ mode: z.enum(["assign", "quote"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const requestConditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const requestDeptId = getActiveDepartmentId(req);
  if (requestDeptId !== null) {
    requestConditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, requestDeptId))) as any,
    );
  }

  const [row] = await db
    .update(fixTrackIssuesTable)
    .set({
      emailRequestMode: parsed.data.mode,
      emailRequestedBy: (req.session as any).userId ?? null,
      emailRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(...requestConditions))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  if (!row.contractorId) return res.status(400).json({ error: "No contractor assigned to this issue" });
  res.json({ ok: true, message: "Approval requested" });
});

// Manager: dismiss a pending request without sending
router.post("/issues/:id/reject-send", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const rejectConditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const rejectDeptId = getActiveDepartmentId(req);
  if (rejectDeptId !== null) {
    rejectConditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, rejectDeptId))) as any,
    );
  }

  const [row] = await db
    .update(fixTrackIssuesTable)
    .set({ emailRequestMode: null, emailRequestedBy: null, emailRequestedAt: null, updatedAt: new Date() })
    .where(and(...rejectConditions))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ── Send to contractor (managers only) ────────────────────────────────────────

router.post("/issues/:id/send-to-contractor", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) {
    return res.status(403).json({ error: "Manager approval required — use 'Request approval' instead" });
  }

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const modeParsed = z.object({ mode: z.enum(["assign", "quote"]).optional() }).safeParse(req.body ?? {});
  if (!modeParsed.success) return res.status(400).json({ error: "Invalid data" });

  const sendDeptId = getActiveDepartmentId(req);
  const sendDeptClause = sendDeptId !== null
    ? sql` AND (fi.site_id IS NULL OR fi.site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${sendDeptId})))`
    : sql``;

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
    WHERE fi.id = ${id} AND fi.client_id = ${clientId}${sendDeptClause}
    LIMIT 1
  `);

  const issue = (result.rows as any[])[0];
  if (!issue)                 return res.status(404).json({ error: "Issue not found" });
  if (!issue.contractor_id)   return res.status(400).json({ error: "No contractor assigned to this issue" });
  if (!issue.contractor_email) return res.status(400).json({ error: "Contractor has no email address" });

  // Mode: explicit in body, else whatever the pending request asked for, else assign
  const pendingModeResult = await db.execute(sql`
    SELECT email_request_mode FROM fix_track_issues WHERE id = ${id} AND client_id = ${clientId}
  `);
  const pendingMode = ((pendingModeResult.rows as any[])[0]?.email_request_mode ?? null) as string | null;
  const mode: "assign" | "quote" = modeParsed.data.mode ?? (pendingMode === "quote" ? "quote" : "assign");

  const clearPendingRequest = () => db.execute(sql`
    UPDATE fix_track_issues
    SET email_request_mode = NULL, email_requested_by = NULL, email_requested_at = NULL, updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);

  if (mode === "quote") {
    // Quote requests carry no action tokens — just send the email.
    const quoteDocs: { name: string; url: string }[] = [];
    const quoteDocResult = await db.execute(sql`
      SELECT sd.name, sd.object_path
      FROM   fix_track_issues fi
      JOIN   site_documents   sd ON sd.site_id = fi.site_id AND sd.client_id = fi.client_id
      WHERE  fi.id = ${id} AND fi.client_id = ${clientId} AND fi.site_id IS NOT NULL
      LIMIT  10
    `);
    for (const doc of (quoteDocResult.rows as any[])) {
      try {
        const url = await storage.getSignedDownloadURL(doc.object_path as string, 30 * 24 * 60 * 60);
        quoteDocs.push({ name: doc.name as string, url });
      } catch { /* skip */ }
    }

    await sendContractorQuoteEmail({
      contractorName:   issue.contractor_name   ?? "Contractor",
      contractorEmail:  issue.contractor_email,
      issueTitle:       issue.title,
      issueType:        issue.issue_type,
      issuePriority:    issue.priority,
      issueLocation:    issue.location,
      issueDescription: issue.description,
      siteName:         issue.site_name,
      companyName:      issue.company_name ?? "ComplyTrack",
      clientId,
      siteDocuments:    quoteDocs.length ? quoteDocs : undefined,
    });
    await clearPendingRequest();
    return res.json({ ok: true, message: "Quote request sent to contractor" });
  }

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

  await clearPendingRequest();
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
