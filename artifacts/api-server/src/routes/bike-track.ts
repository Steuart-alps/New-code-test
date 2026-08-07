import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { bikesTable, bikeHireRecordsTable, bikeChecksTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, desc, sql, inArray, or, isNull } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

// ── Schemas ──────────────────────────────────────────────────────────────────

const checkItemSchema = z.enum(["pass", "fail", "na"]).nullable().optional();

const checkItemsSchema = z.object({
  brakesFront:   checkItemSchema,
  brakesRear:    checkItemSchema,
  tyreFront:     checkItemSchema,
  tyreRear:      checkItemSchema,
  chainGears:    checkItemSchema,
  lightsFront:   checkItemSchema,
  lightsRear:    checkItemSchema,
  frame:         checkItemSchema,
  saddleSeatpost: checkItemSchema,
  handlebars:    checkItemSchema,
  pedals:        checkItemSchema,
  helmetProvided: checkItemSchema,
});

const bikeSchema = z.object({
  ref:    z.string().min(1).max(100),
  name:   z.string().max(200).nullable().optional(),
  type:   z.string().max(50).default("hybrid"),
  status: z.string().max(50).default("available"),
  siteId: z.number().int().nullable().optional(),
  notes:  z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

const hireSchema = z.object({
  bikeId:             z.number().int(),
  guestName:          z.string().min(1).max(200),
  guestContact:       z.string().max(200).nullable().optional(),
  hireDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDateExpected: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  depositPence:       z.number().int().min(0).nullable().optional(),
  siteId:             z.number().int().nullable().optional(),
  notes:              z.string().max(2000).nullable().optional(),
  preHireCheck:       checkItemsSchema.extend({
    performedBy:   z.string().max(200).nullable().optional(),
    overallResult: z.enum(["pass", "fail", "action_required"]).optional(),
    checkDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    checkNotes:    z.string().max(2000).nullable().optional(),
  }).optional(),
});

const returnSchema = z.object({
  returnDateActual: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  depositReturned:  z.boolean().optional(),
  notes:            z.string().max(2000).nullable().optional(),
  postReturnCheck:  checkItemsSchema.extend({
    performedBy:   z.string().max(200).nullable().optional(),
    overallResult: z.enum(["pass", "fail", "action_required"]).optional(),
    checkDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    checkNotes:    z.string().max(2000).nullable().optional(),
  }).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function checkItemsToRow(items: Record<string, any>) {
  return {
    brakesFront:    items.brakesFront   ?? null,
    brakesRear:     items.brakesRear    ?? null,
    tyreFront:      items.tyreFront     ?? null,
    tyreRear:       items.tyreRear      ?? null,
    chainGears:     items.chainGears    ?? null,
    lightsFront:    items.lightsFront   ?? null,
    lightsRear:     items.lightsRear    ?? null,
    frame:          items.frame         ?? null,
    saddleSeatpost: items.saddleSeatpost ?? null,
    handlebars:     items.handlebars    ?? null,
    pedals:         items.pedals        ?? null,
    helmetProvided: items.helmetProvided ?? null,
  };
}

// ── Bikes CRUD ────────────────────────────────────────────────────────────────

router.get("/bikes", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const rows = await db
    .select()
    .from(bikesTable)
    .where(eq(bikesTable.clientId, clientId))
    .orderBy(bikesTable.ref);
  res.json(rows);
});

router.post("/bikes", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = bikeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const [row] = await db.insert(bikesTable).values({
    clientId,
    siteId: d.siteId ?? null,
    ref: d.ref,
    name: d.name ?? null,
    type: d.type,
    status: d.status,
    notes: d.notes ?? null,
    active: d.active ?? true,
  }).returning();
  res.status(201).json(row);
});

router.put("/bikes/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = bikeSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const [row] = await db.update(bikesTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(bikesTable.id, id), eq(bikesTable.clientId, clientId)))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/bikes/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  // Block if active hire records exist
  const usageResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM bike_hire_records WHERE bike_id = ${id} AND client_id = ${clientId} AND status = 'active'`);
  const usage = ((usageResult as any).rows ?? [])[0];
  if (parseInt((usage as any)?.cnt ?? "0") > 0)
    return res.status(409).json({ error: "Bike is currently on hire — return it first." });
  await db.delete(bikesTable).where(and(eq(bikesTable.id, id), eq(bikesTable.clientId, clientId)));
  res.status(204).end();
});

// ── Hire Records ──────────────────────────────────────────────────────────────

router.get("/hires", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { status } = req.query as { status?: string };
  const conditions: any[] = [eq(bikeHireRecordsTable.clientId, clientId)];
  if (status) conditions.push(eq(bikeHireRecordsTable.status, status));

  const rows = await db.execute(sql`
    SELECT h.*,
           b.ref AS bike_ref, b.name AS bike_name, b.type AS bike_type,
           pre.id AS pre_check_id, pre.overall_result AS pre_result,
           post.id AS post_check_id, post.overall_result AS post_result
    FROM bike_hire_records h
    JOIN bikes b ON b.id = h.bike_id
    LEFT JOIN bike_checks pre  ON pre.hire_record_id  = h.id AND pre.check_type  = 'pre_hire'
    LEFT JOIN bike_checks post ON post.hire_record_id = h.id AND post.check_type = 'post_return'
    WHERE h.client_id = ${clientId}
    ${status ? sql`AND h.status = ${status}` : sql``}
    ORDER BY h.hire_date DESC, h.id DESC
  `);
  res.json(rows.rows ?? rows);
});

router.post("/hires", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = hireSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
  const d = parsed.data;

  // Verify bike belongs to client and is available
  const [bike] = await db.select().from(bikesTable)
    .where(and(eq(bikesTable.id, d.bikeId), eq(bikesTable.clientId, clientId)))
    .limit(1);
  if (!bike) return res.status(400).json({ error: "Bike not found" });
  if (bike.status === "hired") return res.status(409).json({ error: "Bike is already on hire" });
  if (bike.status === "maintenance") return res.status(409).json({ error: "Bike is currently in maintenance" });
  if (bike.status === "retired") return res.status(409).json({ error: "Bike is retired" });

  const userId = (req.session as any).userId ?? null;

  // Create hire record
  const [hire] = await db.insert(bikeHireRecordsTable).values({
    clientId,
    siteId: d.siteId ?? null,
    bikeId: d.bikeId,
    guestName: d.guestName,
    guestContact: d.guestContact ?? null,
    hireDate: d.hireDate,
    returnDateExpected: d.returnDateExpected ?? null,
    depositPence: d.depositPence ?? null,
    depositReturned: false,
    status: "active",
    notes: d.notes ?? null,
    createdBy: userId,
  }).returning();

  // Mark bike as hired
  await db.update(bikesTable).set({ status: "hired", updatedAt: new Date() })
    .where(eq(bikesTable.id, d.bikeId));

  // Save pre-hire check if provided
  let preCheck = null;
  if (d.preHireCheck) {
    const c = d.preHireCheck;
    const overallResult = c.overallResult ?? "pass";
    const [check] = await db.insert(bikeChecksTable).values({
      clientId,
      hireRecordId: hire.id,
      bikeId: d.bikeId,
      checkType: "pre_hire",
      checkDate: c.checkDate ?? d.hireDate,
      performedBy: c.performedBy ?? null,
      overallResult,
      ...checkItemsToRow(c),
      notes: c.checkNotes ?? null,
      createdBy: userId,
    }).returning();
    preCheck = check;
  }

  res.status(201).json({ hire, preCheck });
});

router.put("/hires/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const updateSchema = hireSchema.omit({ bikeId: true, preHireCheck: true }).partial();
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const [row] = await db.update(bikeHireRecordsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(bikeHireRecordsTable.id, id), eq(bikeHireRecordsTable.clientId, clientId)))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// POST /bike-track/hires/:id/return — mark returned + optional post-return check
router.post("/hires/:id/return", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = returnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;

  const [hire] = await db.select().from(bikeHireRecordsTable)
    .where(and(eq(bikeHireRecordsTable.id, id), eq(bikeHireRecordsTable.clientId, clientId)))
    .limit(1);
  if (!hire) return res.status(404).json({ error: "Not found" });
  if (hire.status === "returned") return res.status(409).json({ error: "Hire already returned" });

  const today = todayIso();
  const userId = (req.session as any).userId ?? null;

  // Save post-return check
  let postCheck = null;
  let newBikeStatus = "available";
  if (d.postReturnCheck) {
    const c = d.postReturnCheck;
    const overallResult = c.overallResult ?? "pass";
    if (overallResult === "fail" || overallResult === "action_required") newBikeStatus = "maintenance";
    const [check] = await db.insert(bikeChecksTable).values({
      clientId,
      hireRecordId: hire.id,
      bikeId: hire.bikeId,
      checkType: "post_return",
      checkDate: c.checkDate ?? today,
      performedBy: c.performedBy ?? null,
      overallResult,
      ...checkItemsToRow(c),
      notes: c.checkNotes ?? null,
      createdBy: userId,
    }).returning();
    postCheck = check;
  }

  // Update hire record
  const [updatedHire] = await db.update(bikeHireRecordsTable)
    .set({
      status: "returned",
      returnDateActual: d.returnDateActual ?? today,
      depositReturned: d.depositReturned ?? hire.depositReturned,
      notes: d.notes !== undefined ? d.notes : hire.notes,
      updatedAt: new Date(),
    })
    .where(eq(bikeHireRecordsTable.id, id))
    .returning();

  // Update bike status
  await db.update(bikesTable).set({ status: newBikeStatus, updatedAt: new Date() })
    .where(eq(bikesTable.id, hire.bikeId));

  res.json({ hire: updatedHire, postCheck, bikeStatus: newBikeStatus });
});

router.delete("/hires/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [hire] = await db.select().from(bikeHireRecordsTable)
    .where(and(eq(bikeHireRecordsTable.id, id), eq(bikeHireRecordsTable.clientId, clientId)))
    .limit(1);
  if (!hire) return res.status(404).json({ error: "Not found" });

  // Free the bike if cancelling an active hire
  if (hire.status === "active") {
    await db.update(bikesTable).set({ status: "available", updatedAt: new Date() })
      .where(eq(bikesTable.id, hire.bikeId));
  }
  await db.update(bikeHireRecordsTable).set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(bikeHireRecordsTable.id, id));
  res.status(204).end();
});

// ── Checks ────────────────────────────────────────────────────────────────────

router.get("/checks", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { bikeId, checkType } = req.query as { bikeId?: string; checkType?: string };
  const conditions: any[] = [eq(bikeChecksTable.clientId, clientId)];
  if (bikeId && !isNaN(parseInt(bikeId))) conditions.push(eq(bikeChecksTable.bikeId, parseInt(bikeId)));
  if (checkType) conditions.push(eq(bikeChecksTable.checkType, checkType));

  const rows = await db.execute(sql`
    SELECT c.*, b.ref AS bike_ref, b.name AS bike_name
    FROM bike_checks c
    JOIN bikes b ON b.id = c.bike_id
    WHERE c.client_id = ${clientId}
    ${bikeId ? sql`AND c.bike_id = ${parseInt(bikeId)}` : sql``}
    ${checkType ? sql`AND c.check_type = ${checkType}` : sql``}
    ORDER BY c.check_date DESC, c.id DESC
    LIMIT 200
  `);
  res.json(rows.rows ?? rows);
});

// ── Services ──────────────────────────────────────────────────────────────────

const serviceSchema = z.object({
  bikeId:            z.number().int(),
  serviceDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  serviceType:       z.enum(["annual", "interim", "adhoc"]).default("annual"),
  servicedBy:        z.string().max(200).nullable().optional(),
  nextServiceDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  costPence:         z.number().int().min(0).nullable().optional(),
  notes:             z.string().max(2000).nullable().optional(),
});

router.get("/services", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { bikeId } = req.query as { bikeId?: string };

  const rows = await db.execute(sql`
    SELECT s.*, b.ref AS bike_ref, b.name AS bike_name, b.type AS bike_type
    FROM bike_services s
    JOIN bikes b ON b.id = s.bike_id
    WHERE s.client_id = ${clientId}
    ${bikeId && !isNaN(parseInt(bikeId)) ? sql`AND s.bike_id = ${parseInt(bikeId)}` : sql``}
    ORDER BY s.service_date DESC, s.id DESC
    LIMIT 500
  `);
  res.json(rows.rows ?? rows);
});

// Per-bike latest service (for Fleet tab status)
router.get("/services/latest", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (bike_id)
      bike_id, service_date, service_type, serviced_by, next_service_date
    FROM bike_services
    WHERE client_id = ${clientId}
    ORDER BY bike_id, service_date DESC, id DESC
  `);
  res.json(rows.rows ?? rows);
});

router.post("/services", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
  const d = parsed.data;

  // Verify bike belongs to this client
  const bikeCheckResult = await db.execute(sql`SELECT id FROM bikes WHERE id = ${d.bikeId} AND client_id = ${clientId} LIMIT 1`);
  const bike = ((bikeCheckResult as any).rows ?? [])[0];
  if (!bike) return res.status(400).json({ error: "Bike not found" });

  const userId = (req.session as any).userId ?? null;

  const insertResult = await db.execute(sql`
    INSERT INTO bike_services
      (client_id, bike_id, service_date, service_type, serviced_by, next_service_date, cost_pence, notes, created_by)
    VALUES
      (${clientId}, ${d.bikeId}, ${d.serviceDate}, ${d.serviceType}, ${d.servicedBy ?? null},
       ${d.nextServiceDate ?? null}, ${d.costPence ?? null}, ${d.notes ?? null}, ${userId})
    RETURNING *
  `);
  const row = ((insertResult as any).rows ?? [])[0];
  res.status(201).json(row);
});

router.put("/services/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = serviceSchema.omit({ bikeId: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;

  const sets: string[] = [];
  if (d.serviceDate       !== undefined) sets.push(`service_date = '${d.serviceDate}'`);
  if (d.serviceType       !== undefined) sets.push(`service_type = '${d.serviceType}'`);
  if (d.servicedBy        !== undefined) sets.push(`serviced_by = ${d.servicedBy ? `'${d.servicedBy.replace(/'/g, "''")}'` : "NULL"}`);
  if (d.nextServiceDate   !== undefined) sets.push(`next_service_date = ${d.nextServiceDate ? `'${d.nextServiceDate}'` : "NULL"}`);
  if (d.costPence         !== undefined) sets.push(`cost_pence = ${d.costPence ?? "NULL"}`);
  if (d.notes             !== undefined) sets.push(`notes = ${d.notes ? `'${d.notes.replace(/'/g, "''")}'` : "NULL"}`);
  sets.push(`updated_at = now()`);

  if (sets.length === 1) return res.status(400).json({ error: "Nothing to update" });

  const updateResult = await db.execute(sql`
    UPDATE bike_services SET ${sql.raw(sets.join(", "))}
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);
  const row = ((updateResult as any).rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/services/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  await db.execute(sql`DELETE FROM bike_services WHERE id = ${id} AND client_id = ${clientId}`);
  res.status(204).end();
});

// ── Summary ───────────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const today = todayIso();

  const countsResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'available')   AS available,
      COUNT(*) FILTER (WHERE status = 'hired')        AS hired,
      COUNT(*) FILTER (WHERE status = 'maintenance')  AS maintenance,
      COUNT(*) FILTER (WHERE status = 'retired')      AS retired,
      COUNT(*)                                         AS total
    FROM bikes
    WHERE client_id = ${clientId} AND active = true
  `);
  const counts = ((countsResult as any).rows ?? [])[0];

  const hireCountsResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')  AS active_hires,
      COUNT(*) FILTER (WHERE status = 'active' AND return_date_expected < ${today}) AS overdue
    FROM bike_hire_records
    WHERE client_id = ${clientId}
  `);
  const hireCounts = ((hireCountsResult as any).rows ?? [])[0];

  // Bikes with a next_service_date that has passed
  const serviceCountsResult = await db.execute(sql`
    SELECT COUNT(DISTINCT b.id) AS overdue_service
    FROM bikes b
    LEFT JOIN LATERAL (
      SELECT next_service_date
      FROM bike_services
      WHERE bike_id = b.id AND client_id = ${clientId}
      ORDER BY service_date DESC LIMIT 1
    ) s ON true
    WHERE b.client_id = ${clientId}
      AND b.active = true
      AND s.next_service_date IS NOT NULL
      AND s.next_service_date < ${today}
  `);
  const serviceCounts = ((serviceCountsResult as any).rows ?? [])[0];

  res.json({ bikes: (counts as any), hires: (hireCounts as any), services: (serviceCounts as any) });
});

// ── Template config ───────────────────────────────────────────────────────────
const BIKE_CONFIG_KEYS = [
  "bike_default_deposit_pence", // string (e.g. "2000" = £20)
  "bike_hire_duration_hours",   // string (e.g. "4")
  "bike_require_helmet",        // "true"|"false"
] as const;

const BIKE_DEFAULT_CONFIG = {
  bike_default_deposit_pence: "",
  bike_hire_duration_hours: "",
  bike_require_helmet: "true",
};

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...BIKE_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (BIKE_CONFIG_KEYS.includes(row.key as (typeof BIKE_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  res.json(config);
});

router.put("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updates = req.body as Record<string, string>;
  for (const key of BIKE_CONFIG_KEYS) {
    if (key in updates) {
      const existing = await db.select({ id: appSettingsTable.clientId }).from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key))).limit(1);
      if (existing.length > 0) {
        await db.update(appSettingsTable).set({ value: updates[key], updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db.insert(appSettingsTable).values({ clientId, key, value: updates[key] });
      }
    }
  }
  res.json({ ok: true });
});

export default router;
