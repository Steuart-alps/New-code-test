import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { foodSafetyRecordsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, getClientId, denyViewers, requireClientAdmin } from "../middleware/requireAuth";

const router = Router();

// Rows are user-defined shapes, but must be flat objects of primitive values
const rowSchema = z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]));
const rowsSchema = z.array(rowSchema).max(200);

const recordFieldsSchema = z.object({
  deliveries: rowsSchema.optional(),
  coldFood: rowsSchema.optional(),
  hotTemperature: rowsSchema.optional(),
  cooling: rowsSchema.optional(),
  reheating: rowsSchema.optional(),
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

// Section visibility keys — one per diary section. Each stores "true"|"false"
// and defaults to enabled. cold_food defaults on for compliance reasons.
const SECTION_SHOW_KEYS = [
  "food_show_deliveries",       // deliveries
  "food_show_cold_food",        // coldFood
  "food_show_hot_temperature",  // hotTemperature (cooking)
  "food_show_cooling",          // cooling
  "food_show_reheating",        // reheating
  "food_show_hot_holding",      // hotHolding
  "food_show_sous_vide",        // sousVide
] as const;

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
  ...SECTION_SHOW_KEYS,
] as const;

const DEFAULT_CONFIG: Record<(typeof CONFIG_KEYS)[number], string> = {
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
  food_show_cold_food: "true",
  food_show_hot_temperature: "true",
  food_show_cooling: "true",
  food_show_reheating: "true",
  food_show_hot_holding: "true",
  food_show_sous_vide: "true",
};

// ── Validation for the customisable template ──────────────────────────────────
const MAX_ROW_NAME = 40;
const MAX_ROWS = 30;
const MAX_LIMIT_TEXT = 200;

const coldUnitSchema = z.object({
  name: z.string(),
  type: z.enum(["fridge", "freezer"]),
});

/** Trim + dedupe (case-insensitive) + length/count cap a list of names.
 *  Returns the cleaned list, or an error string. */
function cleanNameList(raw: string, label: string): { value: string } | { error: string } {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : []; } catch { return { error: `${label} is not valid JSON` }; }
  if (!Array.isArray(parsed)) return { error: `${label} must be an array` };
  if (parsed.length > MAX_ROWS) return { error: `${label} allows at most ${MAX_ROWS} rows` };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return { error: `${label} rows must be text` };
    const name = item.trim();
    if (!name) continue; // drop blanks
    if (name.length > MAX_ROW_NAME) return { error: `${label} names must be ${MAX_ROW_NAME} characters or fewer` };
    const k = name.toLowerCase();
    if (seen.has(k)) return { error: `${label} names must be unique` };
    seen.add(k);
    out.push(name);
  }
  return { value: JSON.stringify(out) };
}

function cleanColdUnits(raw: string): { value: string } | { error: string } {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : []; } catch { return { error: "Cold units is not valid JSON" }; }
  if (!Array.isArray(parsed)) return { error: "Cold units must be an array" };
  if (parsed.length > MAX_ROWS) return { error: `Cold units allows at most ${MAX_ROWS} rows` };
  const seen = new Set<string>();
  const out: { name: string; type: "fridge" | "freezer" }[] = [];
  for (const item of parsed) {
    const p = coldUnitSchema.safeParse(item);
    if (!p.success) return { error: "Each cold unit needs a name and type (fridge|freezer)" };
    const name = p.data.name.trim();
    if (!name) continue; // drop blanks
    if (name.length > MAX_ROW_NAME) return { error: `Cold unit names must be ${MAX_ROW_NAME} characters or fewer` };
    const k = name.toLowerCase();
    if (seen.has(k)) return { error: "Cold unit names must be unique" };
    seen.add(k);
    out.push({ name, type: p.data.type });
  }
  return { value: JSON.stringify(out) };
}

/** Validate + normalise an incoming config patch. Returns cleaned values keyed
 *  by CONFIG_KEYS, or an error message. Only keys present in the patch are
 *  returned. */
function validateConfigPatch(
  updates: Record<string, unknown>
): { values: Partial<Record<(typeof CONFIG_KEYS)[number], string>> } | { error: string } {
  const out: Partial<Record<(typeof CONFIG_KEYS)[number], string>> = {};
  for (const key of CONFIG_KEYS) {
    if (!(key in updates)) continue;
    const raw = updates[key];
    if (typeof raw !== "string") return { error: `${key} must be a string` };

    if ((SECTION_SHOW_KEYS as readonly string[]).includes(key)) {
      if (raw !== "true" && raw !== "false") return { error: `${key} must be "true" or "false"` };
      out[key] = raw;
    } else if (key === "food_cold_units") {
      const r = cleanColdUnits(raw);
      if ("error" in r) return { error: r.error };
      out[key] = r.value;
    } else if (key === "food_default_hot_items" || key === "food_default_holding_items" || key === "food_default_sv_items") {
      const label = key === "food_default_hot_items" ? "Hot items"
        : key === "food_default_holding_items" ? "Holding items" : "Sous vide items";
      const r = cleanNameList(raw, label);
      if ("error" in r) return { error: r.error };
      out[key] = r.value;
    } else {
      // limits + fridge/freezer counts — plain trimmed text
      const val = raw.trim();
      if (val.length > MAX_LIMIT_TEXT) return { error: `${key} is too long` };
      out[key] = val;
    }
  }
  return { values: out };
}

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

  const stored = new Set<string>();
  const config: Record<string, string> = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    if (CONFIG_KEYS.includes(row.key as (typeof CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
      stored.add(row.key);
    }
  }

  // Backward compatibility: cooling/reheating were introduced as their own
  // toggles later. If a client saved a template before they existed, inherit
  // their visibility from the original grouped "hot temperature" toggle.
  if (stored.has("food_show_hot_temperature")) {
    if (!stored.has("food_show_cooling")) config.food_show_cooling = config.food_show_hot_temperature;
    if (!stored.has("food_show_reheating")) config.food_show_reheating = config.food_show_hot_temperature;
  }

  res.json(config);
});

// PUT /api/food-safety/config — admin-only template customisation
router.put("/config", requireAuth, requireClientAdmin, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const validated = validateConfigPatch((req.body ?? {}) as Record<string, unknown>);
  if ("error" in validated) return res.status(400).json({ error: validated.error });

  for (const [key, value] of Object.entries(validated.values) as [
    (typeof CONFIG_KEYS)[number],
    string,
  ][]) {
    const existing = await db
      .select({ clientId: appSettingsTable.clientId })
      .from(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(appSettingsTable)
        .set({ value, updatedAt: new Date() })
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
    } else {
      await db.insert(appSettingsTable).values({ clientId, key, value });
    }
  }

  res.json({ ok: true });
});

// DELETE /api/food-safety/config — reset the template to defaults (admin-only).
// Removes every stored template key; GET then falls back to DEFAULT_CONFIG.
router.delete("/config", requireAuth, requireClientAdmin, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  await db
    .delete(appSettingsTable)
    .where(
      and(
        eq(appSettingsTable.clientId, clientId),
        inArray(appSettingsTable.key, CONFIG_KEYS as unknown as string[])
      )
    );

  res.json({ ...DEFAULT_CONFIG });
});

// GET /api/food-safety/by-date/:date
router.get("/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const date = req.params.date as string;
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
router.post("/", requireAuth, denyViewers, async (req, res) => {
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
      cooling: data.cooling ?? [],
      reheating: data.reheating ?? [],
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

// POST /api/food-safety/append — atomically append one row to a section of
// the given date's diary, creating the record if needed. Safe under
// concurrent writers (mobile + web) unlike GET-then-PUT of whole arrays.
const SECTION_KEYS = ["deliveries", "coldFood", "hotTemperature", "cooling", "reheating", "hotHolding", "sousVide"] as const;
const SECTION_COLUMNS: Record<(typeof SECTION_KEYS)[number], string> = {
  deliveries: "deliveries",
  coldFood: "cold_food",
  hotTemperature: "hot_temperature",
  cooling: "cooling",
  reheating: "reheating",
  hotHolding: "hot_holding",
  sousVide: "sous_vide",
};

router.post("/append", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const appendSchema = z.object({
    recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    section: z.enum(SECTION_KEYS),
    row: rowSchema,
  });
  const parsed = appendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const { recordDate, section, row } = parsed.data;
  const column = SECTION_COLUMNS[section];
  const rowJson = JSON.stringify(row);

  // Ensure the day's record exists (ignore the race where another writer
  // creates it first), then append in a single UPDATE.
  await db.execute(sql`
    INSERT INTO food_safety_records (client_id, record_date, created_by)
    VALUES (${clientId}, ${recordDate}, ${(req.session as any).userId ?? null})
    ON CONFLICT (client_id, record_date) DO NOTHING
  `);

  const result = await db.execute(sql`
    UPDATE food_safety_records
    SET ${sql.raw(`"${column}"`)} = COALESCE(${sql.raw(`"${column}"`)}, '[]'::jsonb) || ${rowJson}::jsonb,
        updated_at = now()
    WHERE client_id = ${clientId} AND record_date = ${recordDate}
    RETURNING *
  `);
  const updated = (result.rows ?? [])[0];
  if (!updated) return res.status(500).json({ error: "Could not append record" });
  res.status(201).json(updated);
});

// PUT /api/food-safety/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
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
