import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { foodSafetyRecordsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

// Rows are user-defined shapes, but must be flat objects of primitive values
const rowSchema = z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]));
const rowsSchema = z.array(rowSchema).max(200);

const recordFieldsSchema = z.object({
  deliveries: rowsSchema.optional(),
  coldFood: rowsSchema.optional(),
  hotTemperature: rowsSchema.optional(),
  hotHolding: rowsSchema.optional(),
  sousVide: rowsSchema.optional(),
  cookingLimit: z.string().max(200).optional(),
  coolingLimit: z.string().max(200).optional(),
  reheatingLimit: z.string().max(200).optional(),
  hotHoldingLimit: z.string().max(200).optional(),
  correctives: z.string().max(5000).optional(),
  managerSignature: z.string().max(200).optional(),
  submittedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const createRecordSchema = recordFieldsSchema.extend({
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  submittedAt: z.string().datetime({ offset: true }).optional(),
});

const CONFIG_KEYS = [
  "food_num_fridges",
  "food_num_freezers",
  "food_cooking_limit",
  "food_cooling_limit",
  "food_reheating_limit",
  "food_hot_holding_limit",
  // Template keys — stored as JSON strings
  "food_cold_units",            // JSON: [{name, type:"fridge"|"freezer"}]
  "food_default_hot_items",     // JSON: ["item1", "item2"]
  "food_default_holding_items", // JSON: ["item1", "item2"]
  "food_default_sv_items",      // JSON: ["item1", "item2"]
  // Section visibility — "true"|"false", default true
  "food_show_deliveries",
  "food_show_hot_temperature",
  "food_show_hot_holding",
  "food_show_sous_vide",
] as const;

const DEFAULT_CONFIG = {
  food_num_fridges: "2",
  food_num_freezers: "2",
  food_cooking_limit: "Above 75°C (10 seconds)",
  food_cooling_limit: "8°C within 90 minutes",
  food_reheating_limit: "Above 82°C",
  food_hot_holding_limit: "Above 63°C",
  food_cold_units: "",
  food_default_hot_items: "",
  food_default_holding_items: "",
  food_default_sv_items: "",
  food_show_deliveries: "true",
  food_show_hot_temperature: "true",
  food_show_hot_holding: "true",
  food_show_sous_vide: "true",
};

// GET /api/food-safety/config
router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(
      and(
        eq(appSettingsTable.clientId, clientId),
        // We fetch all and filter in JS to keep it simple
      )
    );

  const config: Record<string, string> = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    if (CONFIG_KEYS.includes(row.key as (typeof CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }

  res.json(config);
});

// PUT /api/food-safety/config
router.put("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const updates = req.body as Record<string, string>;

  for (const key of CONFIG_KEYS) {
    if (key in updates) {
      const existing = await db
        .select()
        .from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(appSettingsTable)
          .set({ value: updates[key], updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db.insert(appSettingsTable).values({ clientId, key, value: updates[key] });
      }
    }
  }

  res.json({ ok: true });
});

// GET /api/food-safety/by-date/:date
router.get("/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date" });

  const [record] = await db
    .select()
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.clientId, clientId), eq(foodSafetyRecordsTable.recordDate, date)))
    .limit(1);

  if (!record) return res.status(404).json({ error: "No record for this date" });
  res.json(record);
});

// GET /api/food-safety?date=YYYY-MM-DD
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { date } = req.query as { date?: string };
  if (!date) {
    // Return list of record dates (for history)
    const records = await db
      .select({ id: foodSafetyRecordsTable.id, recordDate: foodSafetyRecordsTable.recordDate, submittedAt: foodSafetyRecordsTable.submittedAt })
      .from(foodSafetyRecordsTable)
      .where(eq(foodSafetyRecordsTable.clientId, clientId))
      .orderBy(foodSafetyRecordsTable.recordDate);
    return res.json(records);
  }

  const [record] = await db
    .select()
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.clientId, clientId), eq(foodSafetyRecordsTable.recordDate, date)))
    .limit(1);

  if (!record) return res.json(null);
  res.json(record);
});

// POST /api/food-safety
router.post("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createRecordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const data = parsed.data;

  // Check if record already exists for this date
  const [existing] = await db
    .select({ id: foodSafetyRecordsTable.id })
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.clientId, clientId), eq(foodSafetyRecordsTable.recordDate, data.recordDate)))
    .limit(1);

  if (existing) return res.status(409).json({ error: "Record already exists for this date", id: existing.id });

  const [inserted] = await db
    .insert(foodSafetyRecordsTable)
    .values({
      clientId,
      recordDate: data.recordDate,
      deliveries: data.deliveries ?? [],
      coldFood: data.coldFood ?? [],
      hotTemperature: data.hotTemperature ?? [],
      hotHolding: data.hotHolding ?? [],
      sousVide: data.sousVide ?? [],
      cookingLimit: data.cookingLimit ?? "Above 75°C (10 seconds)",
      coolingLimit: data.coolingLimit ?? "8°C within 90 minutes",
      reheatingLimit: data.reheatingLimit ?? "Above 82°C",
      hotHoldingLimit: data.hotHoldingLimit ?? "Above 63°C",
      correctives: data.correctives,
      managerSignature: data.managerSignature,
      submittedAt: data.submittedAt ? new Date(data.submittedAt) : undefined,
      createdBy: (req.session as any).userId ?? null,
    })
    .returning();

  res.status(201).json(inserted);
});

// PUT /api/food-safety/:id
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db
    .select({ id: foodSafetyRecordsTable.id })
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.id, id), eq(foodSafetyRecordsTable.clientId, clientId)))
    .limit(1);

  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsedUpdate = recordFieldsSchema.safeParse(req.body);
  if (!parsedUpdate.success) return res.status(400).json({ error: "Invalid data" });

  const updates: any = { updatedAt: new Date() };
  const { submittedAt, ...rest } = parsedUpdate.data;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) updates[key] = value;
  }
  if (submittedAt !== undefined) {
    updates.submittedAt = submittedAt ? new Date(submittedAt) : null;
  }

  const [updated] = await db
    .update(foodSafetyRecordsTable)
    .set(updates)
    .where(and(eq(foodSafetyRecordsTable.id, id), eq(foodSafetyRecordsTable.clientId, clientId)))
    .returning();

  res.json(updated);
});

// ── Status — due/overdue per check type ───────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const MS_DAY = 86400000;
  const todayDays = Math.floor(Date.now() / MS_DAY);
  const toUtcDays = (iso: string) => Math.floor(new Date(iso).getTime() / MS_DAY);

  function computeStatus(lastDate: string | null, frequencyDays: number) {
    if (!lastDate) return { lastDate: null, dueDate: null, status: "never" as const };
    const dueDays = toUtcDays(lastDate) + frequencyDays;
    const dueDate = new Date(dueDays * MS_DAY).toISOString().slice(0, 10);
    const daysUntilDue = dueDays - todayDays;
    const dueSoonWindow = Math.max(1, Math.ceil(frequencyDays * 0.2));
    const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= dueSoonWindow ? "due_soon" : "ok";
    return { lastDate, dueDate, status };
  }

  const [diary, weekly, probe, cleanDaily, cleanWeekly, cleanMonthly, taskCountsRes] = await Promise.all([
    db.execute(sql`SELECT MAX(record_date)::text AS last_date FROM food_safety_records WHERE client_id = ${clientId}`),
    db.execute(sql`SELECT MAX(week_commencing)::text AS last_date FROM kitchen_weekly_records WHERE client_id = ${clientId}`),
    db.execute(sql`SELECT MAX(check_date)::text AS last_date FROM kitchen_probe_checks WHERE client_id = ${clientId}`),
    db.execute(sql`SELECT MAX(log_date)::text AS last_date FROM kitchen_cleaning_logs WHERE client_id = ${clientId} AND frequency = 'daily'`),
    db.execute(sql`SELECT MAX(log_date)::text AS last_date FROM kitchen_cleaning_logs WHERE client_id = ${clientId} AND frequency = 'weekly'`),
    db.execute(sql`SELECT MAX(log_date)::text AS last_date FROM kitchen_cleaning_logs WHERE client_id = ${clientId} AND frequency = 'monthly'`),
    db.execute(sql`
      SELECT frequency, COUNT(*)::int AS task_count
      FROM kitchen_cleaning_tasks
      WHERE client_id = ${clientId} AND active = true
      GROUP BY frequency
    `),
  ]);

  const taskCounts = Object.fromEntries(
    (taskCountsRes.rows as any[]).map((r: any) => [r.frequency, Number(r.task_count)])
  );

  const statuses: any[] = [
    { checkType: "daily_diary",   frequencyDays: 1,  ...computeStatus((diary.rows[0] as any)?.last_date  ?? null, 1) },
    { checkType: "weekly_review", frequencyDays: 7,  ...computeStatus((weekly.rows[0] as any)?.last_date ?? null, 7) },
    { checkType: "probe_check",   frequencyDays: 30, ...computeStatus((probe.rows[0] as any)?.last_date  ?? null, 30) },
  ];

  if ((taskCounts["daily"]   ?? 0) > 0) statuses.push({ checkType: "cleaning_daily",   frequencyDays: 1,  ...computeStatus((cleanDaily.rows[0] as any)?.last_date   ?? null, 1) });
  if ((taskCounts["weekly"]  ?? 0) > 0) statuses.push({ checkType: "cleaning_weekly",  frequencyDays: 7,  ...computeStatus((cleanWeekly.rows[0] as any)?.last_date  ?? null, 7) });
  if ((taskCounts["monthly"] ?? 0) > 0) statuses.push({ checkType: "cleaning_monthly", frequencyDays: 30, ...computeStatus((cleanMonthly.rows[0] as any)?.last_date ?? null, 30) });

  res.json(statuses);
});

export default router;
