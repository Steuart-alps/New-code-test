import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { treeInspectionsTable, treesTable, sitesTable, TREE_CHECK_TYPES, TREE_RISK_ZONES, type Tree } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, asc, sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { siteVisibleToDepartment, sitesTableVisibleTo } from "../lib/departmentSites";

const router = Router();

/** Recommended inspection frequencies (days) — based on BS 3998:2010 / NTSG guidance */
export const TREE_FREQUENCY_DAYS: Record<(typeof TREE_CHECK_TYPES)[number], number> = {
  visual_assessment:  365,  // Annual visual tree assessment (minimum)
  detailed_assessment: 365, // Following a VTA where anomalies were found
  post_storm:           30, // After any severe weather event
  remedial_works:      365, // Annual check that recommended works have been actioned
  risk_assessment:     365, // Full tree risk assessment review
};

/**
 * A what3words address as typed or pasted ("///filled.count.soap",
 * "Filled.Count.Soap", "filled count soap"), stored as "filled.count.soap".
 * Anything else is refused, so the link to what3words.com always opens.
 */
export function normaliseWhat3Words(value: string): string | null {
  const words = value.replace(/[\u200b\s]+$/u, "").trim().replace(/^\/+/u, "").replace(/[\u200b]/gu, "")
    .toLowerCase().split(/[.\s。．｡・]+/u).filter(Boolean);
  return words.length === 3 && words.every((w) => /^\p{L}+$/u.test(w)) ? words.join(".") : null;
}

const what3wordsField = z.string().max(120).nullable().optional()
  .transform((value, ctx) => {
    if (value == null || !value.trim()) return value == null ? value : null;
    const words = normaliseWhat3Words(value);
    if (!words) {
      ctx.addIssue({ code: "custom", message: "A what3words address is three words with dots, like ///filled.count.soap" });
      return z.NEVER;
    }
    return words;
  });
const latitudeField = z.number().min(-90).max(90).nullable().optional();
const longitudeField = z.number().min(-180).max(180).nullable().optional();

/** Inspections that restart a tree's routine clock; post-storm walks and works records don't. */
const ROUTINE_TREE_CHECKS = ["visual_assessment", "detailed_assessment", "risk_assessment"];
const TREE_DUE_SOON_DAYS = 30;

const createSchema = z.object({
  checkType: z.enum(TREE_CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "fail"]),
  actionSeverity: z.enum(["monitor", "action_required", "urgent_action"]).nullable().optional(),
  treeId: z.number().int().nullable().optional(),
  treeRef: z.string().max(300).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  what3words: what3wordsField,
  latitude: latitudeField,
  longitude: longitudeField,
  inspector: z.string().max(200).nullable().optional(),
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

const treeSchema = z.object({
  ref: z.string().trim().min(1).max(100),
  species: z.string().max(200).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  what3words: what3wordsField,
  latitude: latitudeField,
  longitude: longitudeField,
  riskZone: z.enum(TREE_RISK_ZONES).optional(),
  inspectionIntervalMonths: z.number().int().min(1).max(60).optional(),
  notes: z.string().max(5000).nullable().optional(),
  removedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
const treeUpdateSchema = treeSchema.partial();

function readInspection<T extends { result: string; actionSeverity?: string | null }>(inspection: T) {
  const legacySeverity = ["monitor", "action_required", "urgent_action"].includes(inspection.result)
    ? inspection.result
    : null;
  return {
    ...inspection,
    // Keep result untouched for consumers of the historical aliases, while
    // making the two concepts explicit for updated clients.
    observationResult: inspection.result === "pass" ? "pass" : "fail",
    actionSeverity: inspection.actionSeverity ?? legacySeverity,
  };
}

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
  if (!(await siteVisibleToDepartment(site, deptId))) return "forbidden";
  return "ok";
}

/**
 * The register tree an inspection is for. Its site and place fill the
 * inspection, so the record and the tree never disagree about where it is.
 */
async function resolveInspectionTree(treeId: number | null | undefined, clientId: number): Promise<Tree | "not_found" | null> {
  if (treeId == null) return null;
  const [tree] = await db.select().from(treesTable)
    .where(and(eq(treesTable.id, treeId), eq(treesTable.clientId, clientId))).limit(1);
  return tree ?? "not_found";
}

function allowedSitesSubquery(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      sitesTableVisibleTo(deptId),
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

  res.json(rows.map(readInspection));
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
    const frequencyDays = TREE_FREQUENCY_DAYS[checkType];
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

// ---- Tree register ----

type TreeStatus = "ok" | "due_soon" | "overdue" | "never";

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** The day `months` after an ISO date (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsIso(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return isoDay(target);
}

/** When a tree is next due, from its last routine inspection and interval. */
export function treeDueStatus(lastInspected: string | null, intervalMonths: number, todayIso: string) {
  if (!lastInspected) return { nextDue: null, status: "never" as TreeStatus };
  const nextDue = addMonthsIso(lastInspected, intervalMonths);
  const days = Math.round((Date.parse(`${nextDue}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
  const status: TreeStatus = days < 0 ? "overdue" : days <= TREE_DUE_SOON_DAYS ? "due_soon" : "ok";
  return { nextDue, status };
}

function londonTodayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

/**
 * Each tree with its last inspection, when it's next due and whether its
 * latest inspection found a problem. Felled trees are left out unless asked for.
 */
export async function listTreesWithStatus(clientId: number, deptId: number | null, opts: { includeRemoved?: boolean; siteId?: number } = {}) {
  const conditions = [eq(treesTable.clientId, clientId)];
  if (!opts.includeRemoved) conditions.push(isNull(treesTable.removedAt));
  if (opts.siteId != null) conditions.push(eq(treesTable.siteId, opts.siteId));
  if (deptId !== null) {
    conditions.push(or(isNull(treesTable.siteId), inArray(treesTable.siteId, allowedSitesSubquery(clientId, deptId))) as any);
  }
  const trees = await db.select().from(treesTable).where(and(...conditions)).orderBy(asc(treesTable.ref), asc(treesTable.id));
  if (trees.length === 0) return [];

  const ids = trees.map((t) => t.id);
  const inspections = await db
    .select({
      treeId: treeInspectionsTable.treeId,
      checkType: treeInspectionsTable.checkType,
      checkDate: treeInspectionsTable.checkDate,
      result: treeInspectionsTable.result,
      actionSeverity: treeInspectionsTable.actionSeverity,
    })
    .from(treeInspectionsTable)
    .where(and(eq(treeInspectionsTable.clientId, clientId), inArray(treeInspectionsTable.treeId, ids)))
    .orderBy(desc(treeInspectionsTable.checkDate), desc(treeInspectionsTable.id));

  const latest = new Map<number, (typeof inspections)[number]>();
  const lastRoutine = new Map<number, string>();
  for (const row of inspections) {
    if (row.treeId == null) continue;
    if (!latest.has(row.treeId)) latest.set(row.treeId, row);
    if (!lastRoutine.has(row.treeId) && ROUTINE_TREE_CHECKS.includes(row.checkType)) lastRoutine.set(row.treeId, row.checkDate);
  }

  const today = londonTodayIso();
  return trees.map((tree) => {
    const last = latest.get(tree.id) ?? null;
    const lastInspected = lastRoutine.get(tree.id) ?? null;
    const reading = last ? readInspection(last) : null;
    return {
      ...tree,
      lastInspected,
      lastCheckDate: last?.checkDate ?? null,
      lastCheckType: last?.checkType ?? null,
      // The latest record found a problem: it stays flagged until a later inspection passes.
      openIssue: reading && reading.observationResult === "fail"
        ? { checkDate: last!.checkDate, severity: reading.actionSeverity ?? null }
        : null,
      ...(tree.removedAt ? { nextDue: null, status: "ok" as TreeStatus } : treeDueStatus(lastInspected, tree.inspectionIntervalMonths, today)),
    };
  });
}

// GET /api/tree-track/trees?siteId=&includeRemoved=true
router.get("/trees", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { siteId, includeRemoved } = req.query as { siteId?: string; includeRemoved?: string };
  const site = siteId && !isNaN(parseInt(siteId)) ? parseInt(siteId) : undefined;
  res.json(await listTreesWithStatus(clientId, getActiveDepartmentId(req), { includeRemoved: includeRemoved === "true", siteId: site }));
});

// POST /api/tree-track/trees
router.post("/trees", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = treeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const data = parsed.data;
  if ((await checkSiteAccess(data.siteId, clientId, getActiveDepartmentId(req))) === "not_found") {
    return res.status(400).json({ error: "Invalid site" });
  }
  const [tree] = await db.insert(treesTable).values({
    clientId,
    ref: data.ref,
    species: data.species?.trim() || null,
    siteId: data.siteId ?? null,
    location: data.location?.trim() || null,
    what3words: data.what3words ?? null,
    latitude: data.latitude ?? null,
    longitude: data.longitude ?? null,
    riskZone: data.riskZone ?? "medium",
    inspectionIntervalMonths: data.inspectionIntervalMonths ?? 12,
    notes: data.notes?.trim() || null,
    removedAt: data.removedAt ?? null,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(tree);
});

// PUT /api/tree-track/trees/:id
router.put("/trees/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = treeUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  if ("siteId" in parsed.data && (await checkSiteAccess(parsed.data.siteId, clientId, getActiveDepartmentId(req))) === "not_found") {
    return res.status(400).json({ error: "Invalid site" });
  }
  const [tree] = await db.update(treesTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(treesTable.id, id), eq(treesTable.clientId, clientId)))
    .returning();
  if (!tree) return res.status(404).json({ error: "Not found" });
  res.json(tree);
});

// DELETE /api/tree-track/trees/:id — only a tree added by mistake; one with
// inspections is marked felled instead, so its records keep their tree.
router.delete("/trees/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [used] = await db.select({ id: treeInspectionsTable.id }).from(treeInspectionsTable)
    .where(and(eq(treeInspectionsTable.treeId, id), eq(treeInspectionsTable.clientId, clientId))).limit(1);
  if (used) return res.status(409).json({ error: "This tree has inspections. Mark it as felled or removed instead." });
  const deleted = await db.delete(treesTable)
    .where(and(eq(treesTable.id, id), eq(treesTable.clientId, clientId)))
    .returning({ id: treesTable.id });
  if (deleted.length === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

// POST /api/tree-track
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;

  const tree = await resolveInspectionTree(data.treeId, clientId);
  if (tree === "not_found") return res.status(400).json({ error: "Invalid tree" });
  if (tree) {
    if (tree.siteId != null) data.siteId = tree.siteId;
    data.treeRef = tree.ref;
    if (!data.location?.trim()) data.location = tree.location;
  }

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
      actionSeverity: data.actionSeverity ?? null,
      treeId: tree ? tree.id : null,
      treeRef: data.treeRef ?? null,
      location: data.location ?? null,
      what3words: data.what3words ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      inspector: data.inspector ?? null,
      followUpDate: data.followUpDate ?? null,
      siteId: data.siteId ?? null,
      notes: data.notes ?? null,
      createdBy: req.currentUser!.id,
    })
    .returning();

  res.status(201).json(readInspection(inserted));
});

// PUT /api/tree-track/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
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

  if (parsed.data.treeId !== undefined) {
    const tree = await resolveInspectionTree(parsed.data.treeId, clientId);
    if (tree === "not_found") return res.status(400).json({ error: "Invalid tree" });
    if (tree) {
      if (tree.siteId != null) parsed.data.siteId = tree.siteId;
      parsed.data.treeRef = tree.ref;
      if (!parsed.data.location?.trim()) parsed.data.location = tree.location;
    }
  }

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
  res.json(readInspection(updated));
});

// DELETE /api/tree-track/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
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
