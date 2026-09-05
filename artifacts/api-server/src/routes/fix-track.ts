import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { fixTrackIssueActivityTable, fixTrackIssuesTable, sitesTable, contractorsTable, usersTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";
import { buildCalendarInvite } from "../lib/email";
import { ObjectStorageService, ObjectNotFoundError, ObjectOwnershipError } from "../lib/objectStorage";
import { getObjectAclPolicy } from "../lib/objectAcl";
import { generateActionTokens, sendContractorAssignmentEmail, sendContractorQuoteEmail } from "../lib/fixTrackNotifications";

const router = Router();
const storage = new ObjectStorageService();

async function finalizeIssueMedia(paths: string[] | undefined, clientId: number): Promise<string | null> {
  try {
    for (const objectPath of paths ?? []) await storage.finalizeTenantUpload(objectPath, clientId);
    return null;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return "Uploaded media object not found";
    if (err instanceof ObjectOwnershipError) return err.message;
    return "Could not secure uploaded media";
  }
}

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

async function canAccessSite(siteId: number | null | undefined, clientId: number, deptId: number | null) {
  if (siteId == null) return true;
  const [site] = await db.select({ departmentId: sitesTable.departmentId }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!site && (deptId === null || site.departmentId === null || site.departmentId === deptId);
}

async function verifyContractor(contractorId: number | null | undefined, clientId: number) {
  if (contractorId == null) return true;
  const [row] = await db.select({ id: contractorsTable.id }).from(contractorsTable)
    .where(and(eq(contractorsTable.id, contractorId), eq(contractorsTable.clientId, clientId))).limit(1);
  return !!row;
}

function dateOnly(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Fields rendered into a contractor email. Any change invalidates approval. */
function contractorEmailContentChanged(current: any, data: Record<string, any>): boolean {
  const fields = ["contractorId", "title", "description", "location", "issueType", "priority", "siteId"] as const;
  if (fields.some((field) => field in data && (data[field] ?? null) !== (current[field] ?? null))) return true;
  return "targetDate" in data && dateOnly(data.targetDate) !== dateOnly(current.targetDate);
}

/** Never sign a cross-tenant or unstamped private document URL into contractor mail. */
async function authorisedSiteDocumentUrl(objectPath: string, clientId: number): Promise<string | null> {
  try {
    const file = await storage.getObjectEntityFile(objectPath);
    const acl = await getObjectAclPolicy(file);
    if (acl?.visibility !== "private" || acl.owner !== String(clientId)) return null;
    return await storage.getSignedDownloadURL(objectPath, 30 * 24 * 60 * 60);
  } catch {
    return null;
  }
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
  // Mobile's open-work view requests more than one status. Treat repeated
  // query values as an OR rather than comparing the column to an array.
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    conditions.push(inArray(fixTrackIssuesTable.status, statuses));
  }
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

  const activity = await db
    .select({
      id: fixTrackIssueActivityTable.id,
      eventType: fixTrackIssueActivityTable.eventType,
      status: fixTrackIssueActivityTable.status,
      note: fixTrackIssueActivityTable.note,
      createdAt: fixTrackIssueActivityTable.createdAt,
      createdBy: usersTable.name,
    })
    .from(fixTrackIssueActivityTable)
    .leftJoin(usersTable, eq(fixTrackIssueActivityTable.createdBy, usersTable.id))
    .where(and(
      eq(fixTrackIssueActivityTable.issueId, id),
      eq(fixTrackIssueActivityTable.clientId, clientId),
    ))
    // An issue can be created or advanced more than once within the same
    // timestamp precision. Use the append-only id as a stable tie-breaker so
    // every client receives the status history in the order it occurred.
    .orderBy(fixTrackIssueActivityTable.createdAt, fixTrackIssueActivityTable.id);

  res.json({
    ...r.issue,
    siteName:        r.site?.name        ?? null,
    contractorName:  r.contractor?.name  ?? null,
    contractorEmail: r.contractor?.email ?? null,
    statusEvents: activity.filter(a => a.eventType === "status").map(a => ({
      status: a.status,
      createdAt: a.createdAt,
    })),
    notes: activity.filter(a => a.eventType === "note").map(a => ({
      id: a.id,
      note: a.note,
      createdBy: a.createdBy ?? "Former user",
      createdAt: a.createdAt,
    })),
  });
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/issues", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = issueCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const data = parsed.data;
  if (data.status && data.status !== "reported") {
    return res.status(400).json({ error: "New issues must start with reported status" });
  }
  delete data.resolvedDate;
  if (data.issueType !== undefined) {
    const allowedTypes = await getEffectiveOptionList(clientId, "fixtrack_issue_types");
    if (!allowedTypes.includes(data.issueType)) return res.status(400).json({ error: "Invalid issue type" });
  }
  if (!(await canAccessSite(data.siteId, clientId, getActiveDepartmentId(req)))) return res.status(403).json({ error: "Site not accessible" });
  if (!(await verifyContractor(data.contractorId, clientId))) return res.status(400).json({ error: "Invalid contractor" });
  const mediaError = await finalizeIssueMedia(data.mediaUrls, clientId);
  if (mediaError) return res.status(403).json({ error: mediaError });

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
  await db.insert(fixTrackIssueActivityTable).values({
    clientId,
    issueId: row.id,
    eventType: "status",
    status: row.status,
    createdBy: (req.session as any).userId ?? null,
  });
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
  delete data.resolvedDate;
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
  if ("siteId" in data && !(await canAccessSite(data.siteId, clientId, getActiveDepartmentId(req)))) return res.status(403).json({ error: "Site not accessible" });
  if ("contractorId" in data && !(await verifyContractor(data.contractorId, clientId))) return res.status(400).json({ error: "Invalid contractor" });
  const mediaError = await finalizeIssueMedia(data.mediaUrls, clientId);
  if (mediaError) return res.status(403).json({ error: mediaError });

  const updateConditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const updateDeptId = getActiveDepartmentId(req);
  if (updateDeptId !== null) {
    updateConditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, updateDeptId))) as any,
    );
  }

  const transitionResult = await db.transaction(async (tx) => {
    const [current] = await tx.select()
      .from(fixTrackIssuesTable)
      .where(and(...updateConditions))
      .limit(1);
    if (!current) return { kind: "not_found" as const };
    if (current.emailRequestStatus === "sending") return { kind: "email_sending" as const };

    const nextStatus: Record<string, string | undefined> = {
      reported: "in_progress",
      in_progress: "resolved",
      resolved: "closed",
      closed: undefined,
    };
    const isStatusChange = data.status && data.status !== current.status;
    if (isStatusChange && data.status !== nextStatus[current.status]) {
      return { kind: "invalid_transition" as const, currentStatus: current.status };
    }

    const approvalInvalidated =
      current.emailRequestStatus === "approved" && contractorEmailContentChanged(current, data);
    const updateData: Record<string, any> = { ...data, updatedAt: new Date() };
    if (data.status === "resolved" && isStatusChange) {
      updateData.resolvedDate = new Date().toISOString().slice(0, 10);
    }
    if (approvalInvalidated) {
      updateData.emailRequestStatus = "pending";
      updateData.emailApprovedBy = null;
      updateData.emailApprovedAt = null;
      updateData.emailSentBy = null;
      updateData.emailSentAt = null;
    }
    // Make approval invalidation race safely against dispatch: the update can
    // only win while the row is still approved; a claimed `sending` row is
    // never mutated underneath the provider call.
    const atomicConditions = [
      ...updateConditions,
      ...(isStatusChange ? [eq(fixTrackIssuesTable.status, current.status)] : []),
      current.emailRequestStatus == null
        ? isNull(fixTrackIssuesTable.emailRequestStatus)
        : eq(fixTrackIssuesTable.emailRequestStatus, current.emailRequestStatus),
    ];
    const updated = await tx.update(fixTrackIssuesTable)
      .set(updateData)
      .where(and(...atomicConditions))
      .returning();

    if (!updated[0]) return { kind: "conflict" as const };
    if (isStatusChange) {
      await tx.insert(fixTrackIssueActivityTable).values({
        clientId,
        issueId: id,
        eventType: "status",
        status: data.status,
        createdBy: (req.session as any).userId ?? null,
      });
    }
    if (approvalInvalidated) {
      await tx.insert(fixTrackIssueActivityTable).values({
        clientId,
        issueId: id,
        eventType: "email_invalidated",
        note: "Contractor email content changed; manager reapproval required",
        createdBy: (req.session as any).userId ?? null,
      });
    }
    return { kind: "updated" as const, row: updated[0] };
  });

  if (transitionResult.kind === "not_found") return res.status(404).json({ error: "Not found" });
  if (transitionResult.kind === "invalid_transition") {
    return res.status(409).json({
      error: `Issue must move to the next status from ${transitionResult.currentStatus}`,
      currentStatus: transitionResult.currentStatus,
    });
  }
  if (transitionResult.kind === "conflict") {
    return res.status(409).json({ error: "Issue status changed; refresh and try again" });
  }
  if (transitionResult.kind === "email_sending") {
    return res.status(409).json({ error: "This issue cannot be changed while its approved contractor email is sending" });
  }
  res.json(transitionResult.row);
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
  const row = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE fix_track_issues
      SET solution_notes = CASE
            WHEN solution_notes IS NULL OR solution_notes = '' THEN ${entry}
            ELSE solution_notes || E'\n\n' || ${entry}
          END,
          updated_at = now()
      WHERE id = ${id} AND client_id = ${clientId}${deptClause}
      RETURNING *
    `);
    const updated = (result.rows ?? [])[0];
    if (!updated) return null;
    await tx.insert(fixTrackIssueActivityTable).values({
      clientId,
      issueId: id,
      eventType: "note",
      note: parsed.data.note.trim(),
      createdBy: (req.session as any).userId ?? null,
    });
    return updated;
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/issues/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const conditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) conditions.push(or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, deptId))) as any);
  const [existing] = await db.select({ id: fixTrackIssuesTable.id }).from(fixTrackIssuesTable)
    .where(and(...conditions)).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  await db.delete(fixTrackIssuesTable)
    .where(and(...conditions));
  res.status(204).end();
});

// ── Request media upload URL ──────────────────────────────────────────────────

router.post("/issues/:id/request-upload", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const uploadConditions: any[] = [eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId)];
  const uploadDeptId = getActiveDepartmentId(req);
  if (uploadDeptId !== null) uploadConditions.push(or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, uploadDeptId))) as any);
  const [existing] = await db.select({ id: fixTrackIssuesTable.id }).from(fixTrackIssuesTable)
    .where(and(...uploadConditions)).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  z.object({
    name:        z.string().min(1).max(200),
    contentType: z.string().min(1).max(100),
  }).parse(req.body);

  try {
    const uploadUrl  = await storage.getObjectEntityUploadURL(clientId);
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
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
// maintenance manager) approves or dismisses it. A separate, manager-only
// dispatch then crosses the outbound email boundary.

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

  const [existing] = await db.select({
    contractorId: fixTrackIssuesTable.contractorId,
    emailRequestStatus: fixTrackIssuesTable.emailRequestStatus,
  }).from(fixTrackIssuesTable).where(and(...requestConditions)).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!existing.contractorId) return res.status(400).json({ error: "No contractor assigned to this issue" });
  if (existing.emailRequestStatus === "sent" || existing.emailRequestStatus === "sending") {
    return res.status(409).json({ error: "A contractor email has already been sent for this issue" });
  }

  await db.update(fixTrackIssuesTable).set({
    emailRequestMode: parsed.data.mode,
    emailRequestStatus: "pending",
    emailRequestedBy: (req.session as any).userId ?? null,
    emailRequestedAt: new Date(),
    emailApprovedBy: null,
    emailApprovedAt: null,
    emailSentBy: null,
    emailSentAt: null,
    updatedAt: new Date(),
  }).where(and(...requestConditions));
  await db.insert(fixTrackIssueActivityTable).values({
    clientId,
    issueId: id,
    eventType: "email_requested",
    note: parsed.data.mode,
    createdBy: (req.session as any).userId ?? null,
  });
  res.json({ ok: true, message: "Approval requested" });
});

// Manager: approve a specific requested mode. Approval and dispatch are
// intentionally separate so the outbound boundary can require this state.
router.post("/issues/:id/approve-send", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const deptId = getActiveDepartmentId(req);
  const deptClause = deptId !== null
    ? sql` AND (site_id IS NULL OR site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${deptId})))`
    : sql``;
  const result = await db.execute(sql`
    UPDATE fix_track_issues
    SET email_request_status = 'approved',
        email_approved_by = ${(req.session as any).userId ?? null},
        email_approved_at = now(),
        updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
      AND email_request_status = 'pending'
      AND email_request_mode IN ('assign', 'quote')${deptClause}
    RETURNING email_request_mode
  `);
  const row = (result.rows as any[])[0];
  if (!row) return res.status(409).json({ error: "There is no pending contractor email request to approve" });
  await db.insert(fixTrackIssueActivityTable).values({
    clientId,
    issueId: id,
    eventType: "email_approved",
    note: row.email_request_mode,
    createdBy: (req.session as any).userId ?? null,
  });
  res.json({ ok: true, mode: row.email_request_mode });
});

// Manager: dismiss a pending request without sending
router.post("/issues/:id/reject-send", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const rejectConditions: any[] = [
    eq(fixTrackIssuesTable.id, id),
    eq(fixTrackIssuesTable.clientId, clientId),
    eq(fixTrackIssuesTable.emailRequestStatus, "pending"),
  ];
  const rejectDeptId = getActiveDepartmentId(req);
  if (rejectDeptId !== null) {
    rejectConditions.push(
      or(isNull(fixTrackIssuesTable.siteId), inArray(fixTrackIssuesTable.siteId, allowedSites(clientId, rejectDeptId))) as any,
    );
  }

  const [row] = await db
    .update(fixTrackIssuesTable)
    .set({ emailRequestStatus: "rejected", updatedAt: new Date() })
    .where(and(...rejectConditions))
    .returning();
  if (!row) return res.status(409).json({ error: "There is no pending contractor email request to dismiss" });
  await db.insert(fixTrackIssueActivityTable).values({
    clientId,
    issueId: id,
    eventType: "email_rejected",
    note: row.emailRequestMode ?? null,
    createdBy: (req.session as any).userId ?? null,
  });
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

  const sendDeptId = getActiveDepartmentId(req);
  const sendDeptClause = sendDeptId !== null
    ? sql` AND (fi.site_id IS NULL OR fi.site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${sendDeptId})))`
    : sql``;
  const sendUpdateDeptClause = sendDeptId !== null
    ? sql` AND (site_id IS NULL OR site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${sendDeptId})))`
    : sql``;

  const result = await db.execute(sql`
    SELECT
      fi.id, fi.title, fi.issue_type, fi.priority, fi.location, fi.description,
       fi.target_date, fi.contractor_id, fi.email_request_mode, fi.email_request_status,
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

  if (issue.email_request_status !== "approved" || !["assign", "quote"].includes(issue.email_request_mode)) {
    return res.status(403).json({ error: "An approved contractor email request is required before sending" });
  }
  const mode = issue.email_request_mode as "assign" | "quote";

  // Claim only an approved request before reaching either email sender. In
  // particular, never allow a second request that merely observes `sending` to
  // reach the provider: this is the final approval and concurrency gate.
  const claim = await db.execute(sql`
    UPDATE fix_track_issues
    SET email_request_status = 'sending', updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
      AND email_request_status = 'approved' AND email_request_mode = ${mode}${sendUpdateDeptClause}
    RETURNING id
  `);
  if (!(claim.rows as any[])[0]) {
    return res.status(409).json({ error: "This contractor email request is already being processed or has changed" });
  }
  const markSent = () => db.execute(sql`
    UPDATE fix_track_issues
    SET email_request_status = 'sent',
        email_sent_by = ${(req.session as any).userId ?? null},
        email_sent_at = now(),
        updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId} AND email_request_status = 'sending'
  `);
  const restoreApproval = () => db.execute(sql`
    UPDATE fix_track_issues
    SET email_request_status = 'approved', updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId} AND email_request_status = 'sending'
  `);

  // Insert before calling the provider. The unique client/issue/mode tuple
  // gives every dispatch a stable identity, including retries after a crash.
  let dispatch: any;
  let providerAccepted = false;
  try {
  const insertedDispatch = await db.execute(sql`
    INSERT INTO fix_track_email_dispatches (client_id, issue_id, mode, idempotency_key, status)
    VALUES (${clientId}, ${id}, ${mode}, ${randomUUID()}, 'sending')
    ON CONFLICT (client_id, issue_id, mode) DO NOTHING
    RETURNING id, idempotency_key, status
  `);
  dispatch = (insertedDispatch.rows as any[])[0];
  if (!dispatch) {
    const existingDispatch = await db.execute(sql`
      SELECT id, idempotency_key, status
      FROM fix_track_email_dispatches
      WHERE client_id = ${clientId} AND issue_id = ${id} AND mode = ${mode}
      LIMIT 1
    `);
    dispatch = (existingDispatch.rows as any[])[0];
  }
  if (!dispatch) throw new Error("Could not create contractor email dispatch");

  // The provider already accepted this exact dispatch; only repair the issue
  // state. Never submit another provider request in this case.
  if (dispatch.status === "accepted") {
    await markSent();
    return res.json({ ok: true, message: mode === "quote" ? "Quote request already sent to contractor" : "Email already sent to contractor" });
  }
  if (dispatch.status === "failed") {
    await db.execute(sql`
      UPDATE fix_track_email_dispatches
      SET status = 'sending', last_error = NULL, updated_at = now()
      WHERE id = ${dispatch.id} AND client_id = ${clientId} AND status = 'failed'
    `);
  }

  const markProviderAccepted = () => db.execute(sql`
    UPDATE fix_track_email_dispatches
    SET status = 'accepted', accepted_at = now(), last_error = NULL, updated_at = now()
    WHERE id = ${dispatch.id} AND client_id = ${clientId}
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
        const url = await authorisedSiteDocumentUrl(doc.object_path as string, clientId);
        if (url) quoteDocs.push({ name: doc.name as string, url });
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
      idempotencyKey:   dispatch.idempotency_key,
    });
    providerAccepted = true;
    await markProviderAccepted();
    await markSent();
      await db.insert(fixTrackIssueActivityTable).values({
        clientId, issueId: id, eventType: "email_sent", note: mode,
        createdBy: (req.session as any).userId ?? null,
      });
      return res.json({ ok: true, message: "Quote request sent to contractor" });
    }

    // The state claim above prevents resends. Expire any legacy action links
    // before minting the one approved assignment's links.
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

  // CC the approving manager so they get a copy (and the calendar invite).
  const rawManagerEmail = req.currentUser?.email?.trim() || undefined;
  const managerEmail =
    rawManagerEmail && rawManagerEmail.toLowerCase() !== String(issue.contractor_email).toLowerCase()
      ? rawManagerEmail
      : undefined;

  // Build a calendar invite for the job visit (best-effort). Use the issue's
  // target date if set, otherwise fall back to 2 weeks from today so the
  // contractor always receives a calendar placeholder they can reschedule.
  let icsAttachment: string | undefined;
  let icsFilename: string | undefined;
  try {
    // Resolve the visit date: target_date if set, else 2 weeks from now.
    let visitDate: Date;
    if (issue.target_date) {
      // pg returns date columns as Date objects (at UTC midnight); use UTC
      // components so the calendar day never shifts with server timezone.
      const raw = issue.target_date;
      const parsed = raw instanceof Date
        ? new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate(), 9, 0, 0))
        : new Date(`${raw}T09:00:00Z`);
      visitDate = !isNaN(parsed.getTime()) ? parsed : (() => {
        const d = new Date(); d.setUTCDate(d.getUTCDate() + 14); d.setUTCHours(9, 0, 0, 0); return d;
      })();
    } else {
      // No target date — default to 2 weeks from today at 09:00 UTC.
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 14);
      d.setUTCHours(9, 0, 0, 0);
      visitDate = d;
    }

    const fromRow = await db.execute(sql`
      SELECT value FROM app_settings
      WHERE client_id = ${clientId} AND key = 'smtpFrom' LIMIT 1
    `);
    const fromEmail =
      ((fromRow.rows as any[])[0]?.value as string | undefined) ??
      process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

    // Build the calendar invite using the existing rich builder.
    icsAttachment = buildCalendarInvite({
      itemTitle: `ComplyTrack Job Visit — ${issue.title}`,
      dueDate: visitDate,
      contractorName: issue.contractor_name ?? "Contractor",
      contractorEmail: issue.contractor_email,
      companyName: issue.company_name ?? "ComplyTrack",
      fromEmail,
      notes: issue.description ?? null,
      extraAttendees: managerEmail ? [{ name: req.currentUser?.name ?? undefined, email: managerEmail }] : undefined,
    });
    icsFilename = `${(issue.title as string).replace(/[^a-z0-9]/gi, "-").toLowerCase()}.ics`;
  } catch {
    // Never block the email on invite generation
  }

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
      const url = await authorisedSiteDocumentUrl(doc.object_path as string, clientId);
      if (url) siteDocuments.push({ name: doc.name as string, url });
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
    icsAttachment,
    icsFilename,
    cc:               managerEmail,
    idempotencyKey:   dispatch.idempotency_key,
  });

  providerAccepted = true;
  await markProviderAccepted();
  await markSent();
  await db.insert(fixTrackIssueActivityTable).values({
    clientId, issueId: id, eventType: "email_sent", note: mode,
    createdBy: (req.session as any).userId ?? null,
  });
  res.json({ ok: true, message: "Email sent to contractor" });
  } catch (err) {
    // Only an explicit provider failure is retryable. If provider acceptance
    // succeeded but persisting it failed, retain `sending`: retrying with the
    // same durable provider idempotency key is safe and cannot duplicate mail.
    if (!providerAccepted) {
      if (dispatch) {
      await db.execute(sql`
        UPDATE fix_track_email_dispatches
        SET status = 'failed', last_error = ${err instanceof Error ? err.message.slice(0, 2000) : "Provider submission failed"}, updated_at = now()
        WHERE id = ${dispatch.id} AND client_id = ${clientId} AND status = 'sending'
      `).catch(() => {});
      }
      await restoreApproval();
    }
    throw err;
  }
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
