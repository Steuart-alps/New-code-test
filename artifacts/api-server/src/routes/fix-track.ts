import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { appSettingsTable, fixTrackIssueActivityTable, fixTrackIssuesTable, sitesTable, contractorsTable, usersTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";
import { buildCalendarInvite, escapeHtml, getPublicAppUrl, sendEmail } from "../lib/email";
import { ObjectStorageService, ObjectNotFoundError, ObjectOwnershipError } from "../lib/objectStorage";
import { getObjectAclPolicy } from "../lib/objectAcl";
import { dispatchStoredContractorEmail, generateActionTokens, sendContractorAssignmentEmail, sendContractorQuoteEmail } from "../lib/fixTrackNotifications";
import { DEFAULT_FIX_TRACK_STALE_DAYS, parseFixTrackStaleDays } from "../lib/fixTrackAlertSettings";

const router = Router();
const storage = new ObjectStorageService();
const alertSettingsSchema = z.object({ staleDays: z.number().int().min(1).max(365) });

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

async function latestQuoteForIssue(clientId: number, issueId: number) {
  const result = await db.execute(sql`
    SELECT qs.id, qs.price_pence, qs.notes, qs.status, qs.submitted_at
    FROM fix_track_quote_submissions qs
    JOIN contractor_email_queue q ON q.id = qs.queue_id
    WHERE qs.client_id = ${clientId}
      AND q.entity_type = 'fix_track'
      AND q.entity_id = ${issueId}
    ORDER BY qs.submitted_at DESC, qs.id DESC
    LIMIT 1
  `);
  const quote = (result.rows as any[])[0];
  return quote ? {
    id: quote.id,
    pricePence: quote.price_pence,
    notes: quote.notes,
    status: quote.status,
    submittedAt: quote.submitted_at,
  } : null;
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

/** Auto-assign only when exactly one client contractor covers the issue type. */
async function uniqueContractorForType(clientId: number, issueType: string): Promise<number | null> {
  const matchTrades = tradesForIssueType(issueType);
  const result = await db.execute(sql`
    SELECT id, trades
    FROM   contractors
    WHERE  client_id = ${clientId}
    ORDER  BY name
  `);
  const matches: number[] = [];
  for (const c of (result.rows as any[])) {
    const trades = Array.isArray(c.trades) ? (c.trades as string[]) : [];
    if (trades.some((t) => matchTrades.includes(t))) matches.push(c.id as number);
  }
  return matches.length === 1 ? matches[0] : null;
}

router.get("/alert-settings", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Client context required" });
  const [row] = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, "fixTrackStaleDays")))
    .limit(1);
  const staleDays = parseFixTrackStaleDays(row?.value) ?? DEFAULT_FIX_TRACK_STALE_DAYS;
  res.json({ staleDays });
});

router.put("/alert-settings", requireAuth, requireClientAdmin, async (req, res) => {
  const parsed = alertSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Escalation timing must be between 1 and 365 days" });
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Client context required" });
  await db.insert(appSettingsTable)
    .values({
      clientId,
      key: "fixTrackStaleDays",
      value: String(parsed.data.staleDays),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [appSettingsTable.clientId, appSettingsTable.key],
      set: { value: String(parsed.data.staleDays), updatedAt: new Date() },
    });
  res.json({ staleDays: parsed.data.staleDays });
});

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
    .select({
      issue: fixTrackIssuesTable,
      site: sitesTable,
      contractor: contractorsTable,
      isOverdue: sql<boolean>`${fixTrackIssuesTable.status} IN ('reported', 'in_progress')
        AND ${fixTrackIssuesTable.targetDate} IS NOT NULL
        AND ${fixTrackIssuesTable.targetDate} < CURRENT_DATE`,
    })
    .from(fixTrackIssuesTable)
    .leftJoin(sitesTable, and(eq(fixTrackIssuesTable.siteId, sitesTable.id), eq(sitesTable.clientId, clientId)))
    .leftJoin(contractorsTable, and(eq(fixTrackIssuesTable.contractorId, contractorsTable.id), eq(contractorsTable.clientId, clientId)))
    .where(and(...conditions))
    .orderBy(desc(fixTrackIssuesTable.createdAt));

  res.json(await Promise.all(rows.map(async r => ({
    ...r.issue,
    isOverdue: r.isOverdue,
    siteName:       r.site?.name        ?? null,
    contractorName: r.contractor?.name  ?? null,
    contractorEmail: r.contractor?.email ?? null,
    quote: await latestQuoteForIssue(clientId, r.issue.id),
  }))));
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
    .select({
      issue: fixTrackIssuesTable,
      site: sitesTable,
      contractor: contractorsTable,
      isOverdue: sql<boolean>`${fixTrackIssuesTable.status} IN ('reported', 'in_progress')
        AND ${fixTrackIssuesTable.targetDate} IS NOT NULL
        AND ${fixTrackIssuesTable.targetDate} < CURRENT_DATE`,
    })
    .from(fixTrackIssuesTable)
    .leftJoin(sitesTable, and(eq(fixTrackIssuesTable.siteId, sitesTable.id), eq(sitesTable.clientId, clientId)))
    .leftJoin(contractorsTable, and(eq(fixTrackIssuesTable.contractorId, contractorsTable.id), eq(contractorsTable.clientId, clientId)))
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
    isOverdue: r.isOverdue,
    siteName:        r.site?.name        ?? null,
    contractorName:  r.contractor?.name  ?? null,
    contractorEmail: r.contractor?.email ?? null,
    quote: await latestQuoteForIssue(clientId, r.issue.id),
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

  // Auto-assign only when one contractor matches the issue type (same matching as
  // GET /contractors/suggest). Never auto-sends an email — emails still
  // require manager approval.
  let contractorId = data.contractorId ?? null;
  if (contractorId == null) {
    const autoId = await uniqueContractorForType(clientId, data.issueType ?? "general");
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

    // Re-run auto-matching when the type changes unless the caller explicitly
    // chose a contractor. Multiple or zero matches leave the job unassigned.
    if (
      data.issueType &&
      data.issueType !== current.issueType &&
      !Object.prototype.hasOwnProperty.call(data, "contractorId")
    ) {
      data.contractorId = await uniqueContractorForType(clientId, data.issueType);
    }

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
      ["pending", "approved"].includes(current.emailRequestStatus ?? "") && contractorEmailContentChanged(current, data);
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
      const draftResult = await tx.execute(sql`SELECT i.*,s.name AS site_name,c.name AS contractor_name,
        c.email AS contractor_email,cl.name AS company_name,q.mode,q.quote_token
        FROM fix_track_issues i
        LEFT JOIN sites s ON s.id=i.site_id AND s.client_id=i.client_id
        JOIN contractors c ON c.id=i.contractor_id AND c.client_id=i.client_id
        JOIN clients cl ON cl.id=i.client_id
        JOIN contractor_email_queue q ON q.entity_id=i.id AND q.client_id=i.client_id
          AND q.entity_type='fix_track' AND q.status IN ('pending','approved')
        WHERE i.id=${id} AND i.client_id=${clientId} ORDER BY q.created_at DESC LIMIT 1`);
      const draft = (draftResult.rows as any[])[0];
      if (draft?.contractor_email) {
        const rendered = draft.mode === "quote"
          ? await sendContractorQuoteEmail({
              contractorName: draft.contractor_name, contractorEmail: draft.contractor_email,
              issueTitle: draft.title, issueType: draft.issue_type, issuePriority: draft.priority,
              issueLocation: draft.location, issueDescription: draft.description, siteName: draft.site_name,
              companyName: draft.company_name, clientId, quoteToken: draft.quote_token,
              baseUrl: getPublicAppUrl(), previewOnly: true,
            })
          : await sendContractorAssignmentEmail({
              contractorName: draft.contractor_name, contractorEmail: draft.contractor_email,
              issueTitle: draft.title, issueType: draft.issue_type, issuePriority: draft.priority,
              issueLocation: draft.location, issueDescription: draft.description, siteName: draft.site_name,
              companyName: draft.company_name,
              ...(await generateActionTokens(id, clientId, draft.contractor_id)),
              baseUrl: getPublicAppUrl(), clientId, previewOnly: true,
            });
        const text = rendered.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        await tx.execute(sql`UPDATE contractor_email_queue SET status='pending',
          contractor_id=${draft.contractor_id},to_email=${draft.contractor_email},subject=${rendered.subject},
          body_html=${rendered.html},body_text=${text},
          email_preview_json=${JSON.stringify({ subject: rendered.subject, html: rendered.html, text })}::jsonb,
          approved_by=NULL,approved_at=NULL,updated_at=now()
          WHERE client_id=${clientId} AND entity_type='fix_track' AND entity_id=${id}
            AND status IN ('pending','approved')`);
      }
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

function queueDepartmentScope(req: any) {
  const dept = getActiveDepartmentId(req);
  return dept === null ? sql`` : sql` AND (department_id IS NULL OR department_id=${dept})`;
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

  // Persist the exact draft that will cross the email boundary. Approval is
  // for these stored bytes, not for a later re-render of a changed issue.
  const draftResult = await db.execute(sql`
    SELECT i.title, i.description, i.location, i.priority, i.issue_type,
           s.name AS site_name, c.name AS contractor_name, c.email AS contractor_email,
           cl.name AS company_name
    FROM fix_track_issues i
    LEFT JOIN sites s ON s.id = i.site_id AND s.client_id = i.client_id
    JOIN contractors c ON c.id = i.contractor_id AND c.client_id = i.client_id
    JOIN clients cl ON cl.id = i.client_id
    WHERE i.id = ${id} AND i.client_id = ${clientId}
    LIMIT 1
  `);
  const draft = (draftResult.rows as any[])[0];
  if (!draft?.contractor_email) return res.status(400).json({ error: "Contractor has no email address" });
  const quoteToken = parsed.data.mode === "quote" ? randomUUID() : null;
  const quoteUrl = quoteToken ? `${getPublicAppUrl()}/contractor-quote/${quoteToken}` : null;
  let previewSubject = parsed.data.mode === "quote"
    ? `Quote requested: ${draft.title}${draft.site_name ? ` — ${draft.site_name}` : ""}`
    : `Job assigned: ${draft.title}${draft.site_name ? ` — ${draft.site_name}` : ""}`;
  let previewText = [
    `Dear ${draft.contractor_name},`,
    "",
    parsed.data.mode === "quote"
      ? `${draft.company_name} would like a quote for the following work. This is a quote request only; the job has not been assigned.`
      : `${draft.company_name} has assigned the following work to you.`,
    "",
    draft.title,
    `Site: ${draft.site_name ?? "Not specified"}`,
    `Location: ${draft.location}`,
    `Type: ${draft.issue_type}`,
    `Priority: ${draft.priority}`,
    draft.description ? `Details: ${draft.description}` : "",
    quoteUrl ? `Submit your quote: ${quoteUrl}` : "",
  ].filter(Boolean).join("\n");
  let previewHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1e293b">
    <p>Dear ${escapeHtml(draft.contractor_name)},</p>
    ${parsed.data.mode === "quote" ? "<h2>Quotation Requested</h2>" : ""}
    <p>${parsed.data.mode === "quote"
      ? `<strong>${escapeHtml(draft.company_name)}</strong> would like a quote for the work below. This is a quote request only; the job has not been assigned.`
      : `<strong>${escapeHtml(draft.company_name)}</strong> has assigned the work below to you.`}</p>
    <h2>${escapeHtml(draft.title)}</h2>
    <p><strong>Site:</strong> ${escapeHtml(draft.site_name ?? "Not specified")}<br>
    <strong>Location:</strong> ${escapeHtml(draft.location)}<br>
    <strong>Type:</strong> ${escapeHtml(draft.issue_type)}<br>
    <strong>Priority:</strong> ${escapeHtml(draft.priority)}</p>
    ${draft.description ? `<p>${escapeHtml(draft.description)}</p>` : ""}
    ${quoteUrl ? `<p><a href="${quoteUrl}">Submit Quote</a></p>` : ""}
  </div>`;
  if (parsed.data.mode === "assign") {
    const tokens = await generateActionTokens(id, clientId, existing.contractorId);
    const rendered = await sendContractorAssignmentEmail({
      contractorName: draft.contractor_name, contractorEmail: draft.contractor_email,
      issueTitle: draft.title, issueType: draft.issue_type, issuePriority: draft.priority,
      issueLocation: draft.location, issueDescription: draft.description, siteName: draft.site_name,
      companyName: draft.company_name, bookedToken: tokens.bookedToken, completedToken: tokens.completedToken,
      baseUrl: getPublicAppUrl(), clientId, previewOnly: true,
    });
    previewSubject = rendered.subject;
    previewHtml = rendered.html;
    previewText = rendered.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  } else {
    const rendered = await sendContractorQuoteEmail({
      contractorName: draft.contractor_name, contractorEmail: draft.contractor_email,
      issueTitle: draft.title, issueType: draft.issue_type, issuePriority: draft.priority,
      issueLocation: draft.location, issueDescription: draft.description, siteName: draft.site_name,
      companyName: draft.company_name, clientId, quoteToken: quoteToken ?? undefined,
      baseUrl: getPublicAppUrl(), previewOnly: true,
    });
    previewSubject = rendered.subject;
    previewHtml = rendered.html;
    previewText = rendered.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE contractor_email_queue SET status='cancelled',
      last_error='Replaced by a newer request', updated_at=now()
      WHERE client_id=${clientId} AND entity_type='fix_track' AND entity_id=${id}
        AND status IN ('pending','sending')`);
    await tx.update(fixTrackIssuesTable).set({
      emailRequestMode: parsed.data.mode, emailRequestStatus: "pending",
      emailRequestedBy: (req.session as any).userId ?? null, emailRequestedAt: new Date(),
      emailApprovedBy: null, emailApprovedAt: null, emailSentBy: null, emailSentAt: null, updatedAt: new Date(),
    }).where(and(...requestConditions));
    await tx.insert(fixTrackIssueActivityTable).values({
      clientId, issueId: id, eventType: "email_requested", note: parsed.data.mode,
      createdBy: (req.session as any).userId ?? null,
    });
    await tx.execute(sql`
    INSERT INTO contractor_email_queue
      (client_id, issue_id, entity_type, entity_id, department_id, contractor_id, mode, email_type, to_email,
       subject, body_html, body_text, email_preview_json, quote_token, quote_token_expires_at,
       requested_by, idempotency_key)
    SELECT ${clientId}, i.id, 'fix_track', i.id, s.department_id, i.contractor_id, ${parsed.data.mode},
      ${parsed.data.mode === "quote" ? "quote_request" : "assignment"},
      c.email, ${previewSubject}, ${previewHtml}, ${previewText},
      ${JSON.stringify({ subject: previewSubject, text: previewText, html: previewHtml })}::jsonb,
      ${quoteToken}, ${quoteToken ? sql`now() + interval '30 days'` : null},
      ${(req.session as any).userId ?? null}, ${randomUUID()}
    FROM fix_track_issues i
    LEFT JOIN sites s ON s.id = i.site_id
    JOIN contractors c ON c.id = i.contractor_id
    WHERE i.id = ${id} AND i.client_id = ${clientId}
    ON CONFLICT DO NOTHING
  `);
  });
  res.json({ ok: true, message: "Approval requested" });
});

// Manager queue endpoints. All mutations include tenant and department scope
// in the SQL predicate, making ID guessing harmless.
router.get("/contractor-email-queue", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const dept = getActiveDepartmentId(req);
  const extra = dept === null ? sql`` : sql` AND (q.department_id IS NULL OR q.department_id = ${dept})`;
  const result = await db.execute(sql`SELECT q.*, COALESCE(i.title, ci.title) AS item_title,
    s.name AS site_name, c.name AS contractor_name,
    (SELECT json_build_object('id',qs.id,'pricePence',qs.price_pence,'status',COALESCE(qs.status,'submitted')) FROM fix_track_quote_submissions qs WHERE qs.queue_id=q.id LIMIT 1) AS quote
    FROM contractor_email_queue q
    LEFT JOIN fix_track_issues i ON q.entity_type='fix_track' AND i.id=q.entity_id AND i.client_id=q.client_id
    LEFT JOIN compliance_items ci ON q.entity_type='compliance' AND ci.id=q.entity_id AND ci.client_id=q.client_id
    LEFT JOIN sites s ON s.id=COALESCE(i.site_id,ci.site_id)
    LEFT JOIN contractors c ON c.id=q.contractor_id
    WHERE q.client_id=${clientId} AND q.status='pending'${extra} ORDER BY q.created_at DESC`);
  res.json((result.rows as any[]).map((q) => ({
    id: q.id, entityType: q.entity_type, entityId: q.entity_id ?? q.issue_id,
    contractorId: q.contractor_id, emailType: q.email_type ?? (q.mode === "quote" ? "quote_request" : "assignment"),
    status: q.status, requestedBy: q.requested_by, approvedBy: q.approved_by,
    createdAt: q.created_at, emailPreviewJson: q.email_preview_json,
    siteName: q.site_name ?? null, contractorName: q.contractor_name ?? null,
    jobTitle: q.item_title, quote: q.quote ?? null,
  })));
});

router.get("/contractor-email-queue/count", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const scope = queueDepartmentScope(req);
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM contractor_email_queue
    WHERE client_id=${clientId} AND status='pending'${scope}`);
  res.json({ count: Number((result.rows as any[])[0]?.count ?? 0) });
});

router.put("/contractor-email-queue/:queueId", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const scope = queueDepartmentScope(req);
  const qid = Number(req.params.queueId); const parsed = z.object({ subject: z.string().min(1).max(500), bodyHtml: z.string().min(1), bodyText: z.string().optional() }).safeParse(req.body);
  if (!Number.isInteger(qid) || !parsed.success) return res.status(400).json({ error: "Invalid queue draft" });
  const rows = await db.execute(sql`UPDATE contractor_email_queue SET subject=${parsed.data.subject}, body_html=${parsed.data.bodyHtml}, body_text=${parsed.data.bodyText ?? null}, updated_at=now()
    WHERE id=${qid} AND client_id=${clientId} AND status='pending'${scope} RETURNING *`);
  if (!(rows.rows as any[])[0]) return res.status(404).json({ error: "Queue entry not found" });
  res.json((rows.rows as any[])[0]);
});

router.post("/contractor-email-queue/:queueId/cancel", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const scope = queueDepartmentScope(req);
  const qid = Number(req.params.queueId);
  const cancelled = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`UPDATE contractor_email_queue SET status='cancelled', updated_at=now()
      WHERE id=${qid} AND client_id=${clientId} AND status='pending'${scope} RETURNING *`);
    const row = (rows.rows as any[])[0];
    if (row?.entity_type === "fix_track" && row.entity_id) {
      await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='rejected',updated_at=now()
        WHERE id=${row.entity_id} AND client_id=${clientId} AND email_request_status='pending'`);
    }
    return row;
  });
  if (!cancelled) return res.status(404).json({ error: "Queue entry not found" });
  res.json({ ok: true });
});

// Approval is atomic and idempotent: only one manager can claim a draft.
router.post("/contractor-email-queue/:queueId/approve-and-send", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const scope = queueDepartmentScope(req);
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const qid = Number(req.params.queueId);
  const q = await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`UPDATE contractor_email_queue
      SET status='sending', approved_by=${(req.session as any).userId ?? null}, approved_at=now(), sent_by=${(req.session as any).userId ?? null}, updated_at=now()
      WHERE id=${qid} AND client_id=${clientId} AND status='pending'${scope} RETURNING *`);
    const row = (claimed.rows as any[])[0];
    if (row?.entity_type === "fix_track" && row.entity_id) {
      await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='sending',updated_at=now()
        WHERE id=${row.entity_id} AND client_id=${clientId} AND email_request_status='pending'`);
    }
    return row;
  });
  if (!q) return res.status(409).json({ error: "Queue entry is no longer pending" });
  try {
    await sendEmail({ to: q.to_email, subject: q.subject, html: q.body_html, text: q.body_text ?? undefined,
      cc: Array.isArray(q.cc_json) && q.cc_json.length ? q.cc_json : undefined,
      icsAttachment: q.ics_content ?? undefined, icsFilename: q.ics_filename ?? undefined,
      clientId, idempotencyKey: q.idempotency_key });
    await db.execute(sql`UPDATE contractor_email_queue SET status='sent', sent_at=now(), updated_at=now() WHERE id=${qid} AND status='sending'`);
    if (q.entity_type === "fix_track" && q.entity_id) {
      await db.execute(sql`UPDATE fix_track_issues SET email_request_status='sent',
        email_sent_by=${(req.session as any).userId ?? null}, email_sent_at=now(), updated_at=now()
        WHERE id=${q.entity_id} AND client_id=${clientId}`);
    } else if (q.entity_type === "compliance" && q.entity_id) {
      await db.execute(sql`UPDATE compliance_items SET notification_sent_at=now()
        WHERE id=${q.entity_id} AND client_id=${clientId}`);
    }
    res.json({ ok: true, queueId: qid, mode: q.mode, subject: q.subject, bodyHtml: q.body_html });
  } catch (err) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE contractor_email_queue SET status='pending', last_error=${err instanceof Error ? err.message.slice(0, 2000) : "Email failed"}, updated_at=now() WHERE id=${qid} AND status='sending'`);
      if (q.entity_type === "fix_track" && q.entity_id) await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='pending',updated_at=now() WHERE id=${q.entity_id} AND client_id=${clientId} AND email_request_status='sending'`);
    });
    res.status(502).json({ error: "Contractor email could not be sent" });
  }
});

router.post("/contractor-email-queue/:queueId/edit-and-send", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const scope = queueDepartmentScope(req);
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const qid = Number(req.params.queueId);
  const p = z.object({ subject: z.string().min(1).max(500), bodyText: z.string().min(1).max(50_000) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Invalid email draft" });
  const existingResult = await db.execute(sql`SELECT quote_token,email_type FROM contractor_email_queue
    WHERE id=${qid} AND client_id=${clientId} AND status='pending'${scope} LIMIT 1`);
  const existingDraft = (existingResult.rows as any[])[0];
  if (!existingDraft) return res.status(409).json({ error: "Queue entry is no longer pending" });
  const escapedBody = escapeHtml(p.data.bodyText).replace(/\r?\n/g, "<br>");
  const quoteLink = existingDraft.email_type === "quote_request" && existingDraft.quote_token
    ? `<p><a href="${getPublicAppUrl()}/contractor-quote/${encodeURIComponent(existingDraft.quote_token)}">Submit Quote</a></p>`
    : "";
  const safeHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1e293b"><p>${escapedBody}</p>${quoteLink}</div>`;
  const q = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`UPDATE contractor_email_queue SET subject=${p.data.subject}, body_html=${safeHtml}, body_text=${p.data.bodyText},
      email_preview_json=${JSON.stringify({ subject: p.data.subject, text: p.data.bodyText, html: safeHtml })}::jsonb,
      status='sending', approved_by=${(req.session as any).userId ?? null}, approved_at=now(),
      sent_by=${(req.session as any).userId ?? null}, updated_at=now()
      WHERE id=${qid} AND client_id=${clientId} AND status='pending'${scope} RETURNING *`);
    const row = (rows.rows as any[])[0];
    if (row?.entity_type === "fix_track" && row.entity_id) await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='sending',updated_at=now() WHERE id=${row.entity_id} AND client_id=${clientId} AND email_request_status='pending'`);
    return row;
  });
  if (!q) return res.status(409).json({ error: "Queue entry is no longer pending" });
  try {
    await sendEmail({
      to: q.to_email,
      subject: q.subject,
      html: q.body_html,
      text: q.body_text ?? undefined,
      cc: Array.isArray(q.cc_json) && q.cc_json.length ? q.cc_json : undefined,
      icsAttachment: q.ics_content ?? undefined,
      icsFilename: q.ics_filename ?? undefined,
      clientId,
      idempotencyKey: q.idempotency_key,
    });
    await db.execute(sql`UPDATE contractor_email_queue SET status='sent', sent_at=now(), updated_at=now()
      WHERE id=${qid} AND client_id=${clientId} AND status='sending'`);
    if (q.issue_id) {
      await db.execute(sql`UPDATE fix_track_issues SET email_request_status='sent',
        email_sent_by=${(req.session as any).userId ?? null}, email_sent_at=now(), updated_at=now()
        WHERE id=${q.issue_id} AND client_id=${clientId}`);
    } else if (q.entity_type === "compliance" && q.entity_id) {
      await db.execute(sql`UPDATE compliance_items SET notification_sent_at=now()
        WHERE id=${q.entity_id} AND client_id=${clientId}`);
    }
    res.json({ ok: true, queueId: qid });
  } catch (err) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE contractor_email_queue SET status='pending',
        last_error=${err instanceof Error ? err.message.slice(0, 2000) : "Email failed"}, updated_at=now()
        WHERE id=${qid} AND client_id=${clientId} AND status='sending'`);
      if (q.entity_type === "fix_track" && q.entity_id) await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='pending',updated_at=now() WHERE id=${q.entity_id} AND client_id=${clientId} AND email_request_status='sending'`);
    });
    res.status(502).json({ error: "Contractor email could not be sent" });
  }
});

router.post("/contractor-email-queue/:queueId/decline", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const scope = queueDepartmentScope(req);
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const qid = Number(req.params.queueId);
  const rows = await db.execute(sql`UPDATE contractor_email_queue SET status='cancelled', last_error='Declined by manager', updated_at=now()
    WHERE id=${qid} AND client_id=${clientId} AND mode='quote' AND status IN ('approved','sent')${scope} RETURNING id`);
  if (!(rows.rows as any[])[0]) return res.status(404).json({ error: "Quote not found" });
  res.json({ ok: true });
});

router.post("/quotes/:quoteId/decline", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const id = Number(req.params.quoteId);
  const deptId = getActiveDepartmentId(req);
  const deptScope = deptId === null ? sql`` : sql` AND (i.site_id IS NULL OR s.department_id=${deptId})`;
  const r = await db.execute(sql`UPDATE fix_track_quote_submissions qs SET status='declined'
    FROM contractor_email_queue q
    JOIN fix_track_issues i ON i.id=q.issue_id AND i.client_id=q.client_id
    LEFT JOIN sites s ON s.id=i.site_id AND s.client_id=i.client_id
    WHERE qs.id=${id} AND qs.client_id=${clientId} AND qs.status='submitted'
      AND q.id=qs.queue_id AND q.client_id=${clientId}${deptScope}
    RETURNING qs.id`);
  if (!(r.rows as any[])[0]) return res.status(404).json({ error: "Quote not found" });
  res.json({ ok: true, status: "declined" });
});

router.post("/quotes/:quoteId/accept", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!isManager(req)) return res.status(403).json({ error: "Manager approval required" });
  const id = Number(req.params.quoteId);
  const deptId = getActiveDepartmentId(req);
  const deptScope = deptId === null ? sql`` : sql` AND (i.site_id IS NULL OR s.department_id=${deptId})`;
  const out = await db.transaction(async (tx) => {
    const r = await tx.execute(sql`SELECT qs.*,q.*,i.title,i.description,i.location,i.issue_type,i.priority,
      s.name AS site_name,c.name AS contractor_name
      FROM fix_track_quote_submissions qs
      JOIN contractor_email_queue q ON q.id=qs.queue_id JOIN fix_track_issues i ON i.id=q.issue_id
      LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN contractors c ON c.id=q.contractor_id
      WHERE qs.id=${id} AND qs.client_id=${clientId} AND qs.status='submitted'${deptScope}
      FOR UPDATE OF qs,q,i`);
    const q = (r.rows as any[])[0]; if (!q) return null;
    const subject = `Job Assigned: ${q.title}`;
    const text = [
      `Dear ${q.contractor_name ?? "Contractor"},`,
      `The job "${q.title}" has been assigned to you.`,
      `Site: ${q.site_name ?? "Not specified"}`,
      `Location: ${q.location ?? "Not specified"}`,
      `Type: ${q.issue_type}`,
      `Priority: ${q.priority}`,
      q.description ?? "",
    ].filter(Boolean).join("\n");
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#1e293b">
      <p>Dear ${escapeHtml(q.contractor_name ?? "Contractor")},</p>
      <p>The following job has been assigned to you.</p>
      <h2>${escapeHtml(q.title)}</h2>
      <p><strong>Site:</strong> ${escapeHtml(q.site_name ?? "Not specified")}<br>
      <strong>Location:</strong> ${escapeHtml(q.location ?? "Not specified")}<br>
      <strong>Type:</strong> ${escapeHtml(q.issue_type)}<br>
      <strong>Priority:</strong> ${escapeHtml(q.priority)}</p>
      ${q.description ? `<p>${escapeHtml(q.description)}</p>` : ""}
    </div>`;
    await tx.execute(sql`UPDATE fix_track_quote_submissions SET status='accepted' WHERE id=${id}`);
    await tx.execute(sql`UPDATE fix_track_issues SET contractor_id=${q.contractor_id}, email_request_mode='assign',
      email_request_status='pending', updated_at=now() WHERE id=${q.issue_id} AND client_id=${clientId}`);
    await tx.execute(sql`INSERT INTO contractor_email_queue
      (client_id,issue_id,entity_type,entity_id,department_id,contractor_id,mode,email_type,to_email,subject,body_html,body_text,email_preview_json,requested_by,idempotency_key)
      VALUES (${clientId},${q.issue_id},'fix_track',${q.issue_id},${q.department_id},${q.contractor_id},'assign','assignment',${q.to_email},
      ${subject},${html},${text},
      ${JSON.stringify({ subject, text, html })},${(req.session as any).userId ?? null},${randomUUID()})`);
    return q;
  });
  if (!out) return res.status(404).json({ error: "Quote not found" });
  res.json({ ok: true, status: "accepted", assignmentQueued: true });
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

  const [row] = await db.transaction(async (tx) => {
    const updated = await tx
    .update(fixTrackIssuesTable)
    .set({ emailRequestStatus: "rejected", updatedAt: new Date() })
    .where(and(...rejectConditions))
    .returning();
    if (updated[0]) {
      await tx.execute(sql`UPDATE contractor_email_queue SET status='cancelled',
        last_error='Dismissed by manager', updated_at=now()
        WHERE client_id=${clientId} AND entity_type='fix_track' AND entity_id=${id} AND status='pending'`);
    }
    return updated;
  });
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
  const maybeClientId = getClientId(req);
  if (!maybeClientId) return res.status(400).json({ error: "No client context" });
  const clientId: number = maybeClientId;
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
       q.quote_token,
      s.name  AS site_name,
      c.name  AS contractor_name,
      c.email AS contractor_email,
      cl.name AS company_name
    FROM  fix_track_issues fi
    LEFT  JOIN sites       s  ON s.id  = fi.site_id
    LEFT  JOIN contractors c  ON c.id  = fi.contractor_id
    LEFT  JOIN clients     cl ON cl.id = fi.client_id
     LEFT  JOIN contractor_email_queue q ON q.issue_id = fi.id AND q.client_id = fi.client_id
       AND q.mode = 'quote' AND q.status IN ('pending','approved','sending')
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
  const queueRow = await db.transaction(async (tx) => {
    const queued = await tx.execute(sql`UPDATE contractor_email_queue
      SET status='sending', approved_by=COALESCE(approved_by,${(req.session as any).userId ?? null}),
        approved_at=COALESCE(approved_at,now()), sent_by=${(req.session as any).userId ?? null}, updated_at=now()
      WHERE status='pending' AND id=(SELECT id FROM contractor_email_queue WHERE client_id=${clientId}
        AND entity_type='fix_track' AND entity_id=${id} AND status='pending'
        AND mode=${mode}${queueDepartmentScope(req)} ORDER BY created_at DESC LIMIT 1)
      RETURNING *`);
    const row = (queued.rows as any[])[0];
    if (row) await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='sending',updated_at=now()
      WHERE id=${id} AND client_id=${clientId} AND email_request_status='approved'`);
    return row;
  });
  if (!queueRow) return res.status(409).json({ error: "The reviewed contractor email draft is no longer pending" });
  try {
    await dispatchStoredContractorEmail({
      to: queueRow.to_email, subject: queueRow.subject, html: queueRow.body_html,
      text: queueRow.body_text ?? undefined, clientId, idempotencyKey: queueRow.idempotency_key,
    });
    await db.execute(sql`UPDATE contractor_email_queue SET status='sent',sent_at=now(),updated_at=now()
      WHERE id=${queueRow.id} AND client_id=${clientId} AND status='sending'`);
    await db.execute(sql`UPDATE fix_track_issues SET email_request_status='sent',
      email_sent_by=${(req.session as any).userId ?? null},email_sent_at=now(),updated_at=now()
      WHERE id=${id} AND client_id=${clientId}`);
    return res.json({ ok: true, message: mode === "quote" ? "Quote request sent to contractor" : "Email sent to contractor" });
  } catch (err) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE contractor_email_queue SET status='pending',
        last_error=${err instanceof Error ? err.message.slice(0,2000) : "Email failed"},updated_at=now()
        WHERE id=${queueRow.id} AND client_id=${clientId} AND status='sending'`);
      await tx.execute(sql`UPDATE fix_track_issues SET email_request_status='approved',updated_at=now()
        WHERE id=${id} AND client_id=${clientId} AND email_request_status='sending'`);
    });
    return res.status(502).json({ error: "Contractor email could not be sent" });
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
