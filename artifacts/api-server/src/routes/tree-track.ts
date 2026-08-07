import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { treeInspectionsTable, sitesTable, TREE_CHECK_TYPES } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";

const router = Router();

/** Recommended inspection frequencies (days) — based on BS 3998:2010 / NTSG guidance */
const FREQUENCY_DAYS: Record<(typeof TREE_CHECK_TYPES)[number], number> = {
  visual_assessment:  365,  // Annual visual tree assessment (minimum)
  detailed_assessment: 365, // Following a VTA where anomalies were found
  post_storm:           30, // After any severe weather event
  remedial_works:      365, // Annual check that recommended works have been actioned
  risk_assessment:     365, // Full tree risk assessment review
};

const createSchema = z.object({
  checkType: z.enum(TREE_CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "monitor", "action_required", "urgent_action"]),
  treeRef: z.string().max(300).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  inspector: z.string().max(200).nullable().optional(),
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

async function fetchClientSite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return null;
  const [site] = await db
    .select({ id: sitesTable.id, departmentId: sitesTable.departmentId })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  return site ?? null;
}

async function checkSiteAccess(
  siteId: number | null | undefined,
  clientId: number,
  deptId: number | null,
): Promise<null | "not_found" | "forbidden" | "ok"> {
  if (siteId == null) return null;
  const site = await fetchClientSite(siteId, clientId);
  if (!site) return "not_found";
  if (deptId !== null && site.departmentId !== null && site.departmentId !== deptId) return "forbidden";
  return "ok";
}

function allowedSitesSubquery(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
    ));
}

// GET /api/tree-track?checkType=&siteId=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const conditions = [eq(treeInspectionsTable.clientId, clientId)];
  const { checkType, siteId } = req.query as { checkType?: string; siteId?: string };
  if (checkType && (TREE_CHECK_TYPES as readonly string[]).includes(checkType)) {
    conditions.push(eq(treeInspectionsTable.checkType, checkType));
  }
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(treeInspectionsTable.siteId, parseInt(siteId)));
  }

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(treeInspectionsTable.siteId), inArray(treeInspectionsTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const rows = await db
    .select()
    .from(treeInspectionsTable)
    .where(and(...conditions))
    .orderBy(desc(treeInspectionsTable.checkDate), desc(treeInspectionsTable.id));

  res.json(rows);
});

// GET /api/tree-track/status?siteId=
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { siteId } = req.query as { siteId?: string };
  const conditions = [eq(treeInspectionsTable.clientId, clientId)];
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(treeInspectionsTable.siteId, parseInt(siteId)));
  }

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(treeInspectionsTable.siteId), inArray(treeInspectionsTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const lastDates = await db
    .select({
      checkType: treeInspectionsTable.checkType,
      lastDate: sql<string>`max(${treeInspectionsTable.checkDate})`,
    })
    .from(treeInspectionsTable)
    .where(and(...conditions))
    .groupBy(treeInspectionsTable.checkType);

  const lastByType = new Map(lastDates.map((r) => [r.checkType, r.lastDate]));
  const MS_DAY = 24 * 60 * 60 * 1000;
  const toUtcDays = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_DAY);
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayDays = toUtcDays(todayIso);

  const statuses = TREE_CHECK_TYPES.map((checkType) => {
    const frequencyDays = FREQUENCY_DAYS[checkType];
    const lastDate = lastByType.get(checkType) ?? null;
    if (!lastDate) {
      return { checkType, frequencyDays, lastDate: null, dueDate: null, status: "never" as const };
    }
    const dueDays = toUtcDays(lastDate) + frequencyDays;
    const dueDate = new Date(dueDays * MS_DAY).toISOString().slice(0, 10);
    const daysUntilDue = dueDays - todayDays;
    const dueSoonWindow = Math.max(14, Math.ceil(frequencyDays * 0.1));
    const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= dueSoonWindow ? "due_soon" : "ok";
    return { checkType, frequencyDays, lastDate, dueDate, status };
  });

  res.json(statuses);
});

// POST /api/tree-track
router.post("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;

  const deptId = getActiveDepartmentId(req);
  const siteAccess = await checkSiteAccess(data.siteId, clientId, deptId);
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

  const [inserted] = await db
    .insert(treeInspectionsTable)
    .values({
      clientId,
      checkType: data.checkType,
      checkDate: data.checkDate,
      result: data.result,
      treeRef: data.treeRef ?? null,
      location: data.location ?? null,
      inspector: data.inspector ?? null,
      followUpDate: data.followUpDate ?? null,
      siteId: data.siteId ?? null,
      notes: data.notes ?? null,
      createdBy: (req.session as any).userId ?? null,
    })
    .returning();

  res.status(201).json(inserted);
});

// PUT /api/tree-track/:id
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const [existing] = await db
    .select()
    .from(treeInspectionsTable)
    .where(and(eq(treeInspectionsTable.id, id), eq(treeInspectionsTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  const existingAccess = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (existingAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });

  if ("siteId" in parsed.data) {
    const newAccess = await checkSiteAccess(parsed.data.siteId, clientId, deptId);
    if (newAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (newAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }

  const [updated] = await db
    .update(treeInspectionsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(treeInspectionsTable.id, id), eq(treeInspectionsTable.clientId, clientId)))
    .returning();

  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(updated);
});

// DELETE /api/tree-track/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db
    .select()
    .from(treeInspectionsTable)
    .where(and(eq(treeInspectionsTable.id, id), eq(treeInspectionsTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  const access = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });

  await db
    .delete(treeInspectionsTable)
    .where(and(eq(treeInspectionsTable.id, id), eq(treeInspectionsTable.clientId, clientId)));

  res.status(204).end();
});

export default router;
