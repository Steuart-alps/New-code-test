import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { fixTrackIssuesTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";
import { randomUUID } from "crypto";

const router = Router();
const storage = new ObjectStorageService();

// ── helpers ───────────────────────────────────────────────────────────────────

function allowedSites(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId))));
}

async function verifySite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return true;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!row;
}

// ── Issue schemas ─────────────────────────────────────────────────────────────

const ISSUE_TYPES = ["electrical", "plumbing", "structural", "equipment", "hvac", "it_comms", "safety_hazard", "cleaning", "general"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const STATUSES = ["reported", "in_progress", "resolved", "closed"] as const;

const issueCreate = z.object({
  title: z.string().min(1).max(300),
  issueType: z.enum(ISSUE_TYPES).optional(),
  location: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  reportedBy: z.string().min(1).max(200),
  reportedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assignedTo: z.string().max(200).nullable().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  resolvedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  solutionNotes: z.string().max(5000).nullable().optional(),
  mediaUrls: z.array(z.string().max(1000)).optional(),
  siteId: z.number().int().nullable().optional(),
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
  if (status) conditions.push(eq(fixTrackIssuesTable.status, status));
  if (priority) conditions.push(eq(fixTrackIssuesTable.priority, priority));
  if (issueType) conditions.push(eq(fixTrackIssuesTable.issueType, issueType));
  if (siteId) conditions.push(eq(fixTrackIssuesTable.siteId, Number(siteId)));

  const rows = await db
    .select({ issue: fixTrackIssuesTable, site: sitesTable })
    .from(fixTrackIssuesTable)
    .leftJoin(sitesTable, eq(fixTrackIssuesTable.siteId, sitesTable.id))
    .where(and(...conditions))
    .orderBy(desc(fixTrackIssuesTable.createdAt));

  res.json(rows.map(r => ({ ...r.issue, siteName: r.site?.name ?? null })));
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/issues", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = issueCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const data = parsed.data;
  if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });

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
  if ("siteId" in data && !(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });

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

// ── Request media upload URL ───────────────────────────────────────────────────
// Returns a presigned PUT URL so the client can upload a photo/video directly
// to object storage without proxying through the API server.

router.post("/issues/:id/request-upload", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select({ id: fixTrackIssuesTable.id }).from(fixTrackIssuesTable)
    .where(and(eq(fixTrackIssuesTable.id, id), eq(fixTrackIssuesTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { name, contentType } = z.object({
    name: z.string().min(1).max(200),
    contentType: z.string().min(1).max(100),
  }).parse(req.body);

  const ext = name.split(".").pop() ?? "";
  const objectPath = `fix-track/${clientId}/${id}/${randomUUID()}.${ext}`;

  try {
    const result = await storage.getObjectEntityUploadURL(objectPath, name, contentType);
    res.json({ uploadUrl: result.uploadURL, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL", detail: err?.message });
  }
});

// ── Summary (for dashboard card) ──────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db
    .select()
    .from(fixTrackIssuesTable)
    .where(eq(fixTrackIssuesTable.clientId, clientId));

  const total = rows.length;
  const open = rows.filter(r => r.status === "reported" || r.status === "in_progress").length;
  const urgent = rows.filter(r => r.priority === "urgent" && (r.status === "reported" || r.status === "in_progress")).length;
  const resolved = rows.filter(r => r.status === "resolved" || r.status === "closed").length;

  res.json({ total, open, urgent, resolved });
});

export default router;
