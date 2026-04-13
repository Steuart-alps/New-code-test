import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sitesTable, fireAlarmTestsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

// GET /api/sites
router.get("/sites", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const sites = await db
    .select()
    .from(sitesTable)
    .where(eq(sitesTable.clientId, clientId))
    .orderBy(sitesTable.name);

  res.json(sites);
});

// POST /api/sites
const CreateSiteBody = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
});

router.post("/sites", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = CreateSiteBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request", details: body.error.issues });

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId, name: body.data.name, address: body.data.address ?? null })
    .returning();

  res.status(201).json(site);
});

// GET /api/sites/:id
router.get("/sites/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [site] = await db
    .select()
    .from(sitesTable)
    .where(and(eq(sitesTable.id, id), eq(sitesTable.clientId, clientId)))
    .limit(1);

  if (!site) return res.status(404).json({ error: "Site not found" });

  res.json(site);
});

// PUT /api/sites/:id
const UpdateSiteBody = z.object({
  name: z.string().min(1).optional(),
  address: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

router.put("/sites/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = UpdateSiteBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request", details: body.error.issues });

  const [site] = await db
    .update(sitesTable)
    .set({ ...body.data, updatedAt: new Date() })
    .where(and(eq(sitesTable.id, id), eq(sitesTable.clientId, clientId)))
    .returning();

  if (!site) return res.status(404).json({ error: "Site not found" });

  res.json(site);
});

// DELETE /api/sites/:id
router.delete("/sites/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [deleted] = await db
    .delete(sitesTable)
    .where(and(eq(sitesTable.id, id), eq(sitesTable.clientId, clientId)))
    .returning();

  if (!deleted) return res.status(404).json({ error: "Site not found" });

  res.json({ ok: true });
});

// GET /api/sites/:siteId/fire-alarm-tests
router.get("/sites/:siteId/fire-alarm-tests", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const siteId = parseInt(req.params.siteId);
  if (isNaN(siteId)) return res.status(400).json({ error: "Invalid site id" });

  const [site] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const tests = await db
    .select()
    .from(fireAlarmTestsTable)
    .where(and(eq(fireAlarmTestsTable.siteId, siteId), eq(fireAlarmTestsTable.clientId, clientId)))
    .orderBy(desc(fireAlarmTestsTable.weekOf));

  res.json(tests);
});

// POST /api/sites/:siteId/fire-alarm-tests
const CreateTestBody = z.object({
  weekOf: z.string().min(1),
  testedBy: z.string().min(1),
  result: z.enum(["pass", "fail"]),
  alarmActivated: z.boolean().default(true),
  allCallPointsTested: z.boolean().default(true),
  faultFound: z.string().nullable().optional(),
  actionTaken: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

router.post("/sites/:siteId/fire-alarm-tests", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const siteId = parseInt(req.params.siteId);
  if (isNaN(siteId)) return res.status(400).json({ error: "Invalid site id" });

  const [site] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const body = CreateTestBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request", details: body.error.issues });

  const [test] = await db
    .insert(fireAlarmTestsTable)
    .values({
      clientId,
      siteId,
      weekOf: body.data.weekOf,
      testedBy: body.data.testedBy,
      result: body.data.result,
      alarmActivated: body.data.alarmActivated,
      allCallPointsTested: body.data.allCallPointsTested,
      faultFound: body.data.faultFound ?? null,
      actionTaken: body.data.actionTaken ?? null,
      notes: body.data.notes ?? null,
      createdBy: req.currentUser?.id ?? null,
    })
    .returning();

  res.status(201).json(test);
});

// PUT /api/sites/:siteId/fire-alarm-tests/:testId
const UpdateTestBody = z.object({
  weekOf: z.string().optional(),
  testedBy: z.string().min(1).optional(),
  result: z.enum(["pass", "fail"]).optional(),
  alarmActivated: z.boolean().optional(),
  allCallPointsTested: z.boolean().optional(),
  faultFound: z.string().nullable().optional(),
  actionTaken: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

router.put("/sites/:siteId/fire-alarm-tests/:testId", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const siteId = parseInt(req.params.siteId);
  const testId = parseInt(req.params.testId);
  if (isNaN(siteId) || isNaN(testId)) return res.status(400).json({ error: "Invalid id" });

  const body = UpdateTestBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request", details: body.error.issues });

  const [test] = await db
    .update(fireAlarmTestsTable)
    .set({ ...body.data, updatedAt: new Date() })
    .where(
      and(
        eq(fireAlarmTestsTable.id, testId),
        eq(fireAlarmTestsTable.siteId, siteId),
        eq(fireAlarmTestsTable.clientId, clientId),
      ),
    )
    .returning();

  if (!test) return res.status(404).json({ error: "Test not found" });

  res.json(test);
});

// DELETE /api/sites/:siteId/fire-alarm-tests/:testId
router.delete("/sites/:siteId/fire-alarm-tests/:testId", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const siteId = parseInt(req.params.siteId);
  const testId = parseInt(req.params.testId);
  if (isNaN(siteId) || isNaN(testId)) return res.status(400).json({ error: "Invalid id" });

  const [deleted] = await db
    .delete(fireAlarmTestsTable)
    .where(
      and(
        eq(fireAlarmTestsTable.id, testId),
        eq(fireAlarmTestsTable.siteId, siteId),
        eq(fireAlarmTestsTable.clientId, clientId),
      ),
    )
    .returning();

  if (!deleted) return res.status(404).json({ error: "Test not found" });

  res.json({ ok: true });
});

export default router;
