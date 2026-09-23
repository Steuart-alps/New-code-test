import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { foodSafetyRecordsTable, appSettingsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, sql, inArray, isNull } from "drizzle-orm";
import { requireAuth, getActiveDepartmentId, getClientId, denyViewers, requireClientAdmin } from "../middleware/requireAuth";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";

const router = Router();

// Rows are user-defined shapes, but must be flat objects of primitive values
const rowSchema = z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]));
const rowsSchema = z.array(rowSchema).max(200);
const mobileTemperatureLogSchema = z.object({
  coldFood: rowsSchema,
  expectedColdFood: rowsSchema,
  delivery: rowSchema.optional(),
  hotHolding: rowSchema.optional(),
  hotTemperature: rowSchema.optional(),
  cooling: rowSchema.optional(),
  reheating: rowSchema.optional(),
  correctives: z.string().max(5000).optional(),
  expectedCorrectives: z.string().max(5000).nullable(),
});

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
  performedBy: z.string().max(200).nullable().optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
  submittedAt: z.string().datetime({ offset: true }).nullable().optional(),
});
const updateRecordSchema = recordFieldsSchema.extend({
  mobileTemperatureLog: mobileTemperatureLogSchema.optional(),
});

const createRecordSchema = recordFieldsSchema.extend({
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  submittedAt: z.string().datetime({ offset: true }).optional(),
});

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  "Invalid calendar date",
);

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
  "food_jurisdiction",
  "food_cooking_limit",
  "food_cooling_limit",
  "food_reheating_limit",
  "food_hot_holding_limit",
  // Template keys — stored as JSON strings
  "food_cold_units",            // JSON: [{name, type:"fridge"|"freezer"}]
  "food_default_hot_items",     // JSON: ["item1", "item2"]
  "food_default_holding_items", // JSON: ["item1", "item2"]
  "food_default_sv_items",      // JSON: ["item1", "item2"]
  "food_probe_names",           // JSON: ["Probe 1", "Blue probe"]
  // Section visibility — "true"|"false", default true
  ...SECTION_SHOW_KEYS,
] as const;

const DEFAULT_CONFIG: Record<(typeof CONFIG_KEYS)[number], string> = {
  food_num_fridges: "2",
  food_num_freezers: "2",
  // Keep the historical 82°C default for existing accounts. Administrators
  // can select England/Wales to use the 75°C limit.
  food_jurisdiction: "scotland",
  food_cooking_limit: "Above 75°C (10 seconds)",
  food_cooling_limit: "8°C within 90 minutes",
  food_reheating_limit: "Above 82°C",
  food_hot_holding_limit: "Above 63°C",
  food_cold_units: "",
  food_default_hot_items: "",
  food_default_holding_items: "",
  food_default_sv_items: "",
  food_probe_names: "",
  food_show_deliveries: "true",
  food_show_cold_food: "true",
  food_show_hot_temperature: "true",
  food_show_cooling: "true",
  food_show_reheating: "true",
  food_show_hot_holding: "true",
  food_show_sous_vide: "true",
};

const FOOD_JURISDICTIONS = ["scotland", "england_wales"] as const;
type FoodJurisdiction = (typeof FOOD_JURISDICTIONS)[number];
const REHEATING_LIMIT_BY_JURISDICTION: Record<FoodJurisdiction, string> = {
  scotland: "Above 82°C",
  england_wales: "Above 75°C",
};

function reheatingLimitForJurisdiction(value: string | null | undefined): string {
  return REHEATING_LIMIT_BY_JURISDICTION[
    value as FoodJurisdiction
  ] ?? REHEATING_LIMIT_BY_JURISDICTION.scotland;
}

// ── Per-site override support ─────────────────────────────────────────────────
// Site-level values are stored in app_settings under a prefixed key:
//   site.<siteId>.<configKey>  (e.g. "site.12.food_show_cooling")
// The effective config for a site is: DEFAULT ← client-level ← site-level.
const SITE_PREFIX = "site.";
const siteKeyFor = (siteId: number, key: string) => `${SITE_PREFIX}${siteId}.${key}`;

/** Parse an optional siteId query param. Returns:
 *  - { siteId: null } when absent (client-level operation)
 *  - { siteId: number } when a valid positive integer
 *  - { error } when malformed */
function parseSiteId(raw: unknown): { siteId: number | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { siteId: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: "Invalid siteId" };
  return { siteId: n };
}

/** Confirm the site exists and belongs to the given client. */
async function siteBelongsToClient(siteId: number, clientId: number, departmentId?: number | null): Promise<boolean> {
  const [row] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.id, siteId),
      eq(sitesTable.clientId, clientId),
      ...(departmentId != null ? [or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))] : []),
    ))
    .limit(1);
  return !!row;
}

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

/** Validate + normalise an incoming config patch. Returns cleaned values to set
 *  keyed by CONFIG_KEYS, plus a list of keys the caller explicitly asked to
 *  clear (value === null — only meaningful for site-scoped PUTs, where clearing
 *  removes the site override so the key inherits the client-level value). Only
 *  keys present in the patch are considered. */
function validateConfigPatch(
  updates: Record<string, unknown>
): { values: Partial<Record<(typeof CONFIG_KEYS)[number], string>>; clears: (typeof CONFIG_KEYS)[number][] } | { error: string } {
  const out: Partial<Record<(typeof CONFIG_KEYS)[number], string>> = {};
  const clears: (typeof CONFIG_KEYS)[number][] = [];
  for (const key of CONFIG_KEYS) {
    if (!(key in updates)) continue;
    const raw = updates[key];

    // Explicit null clears the override for this key.
    if (raw === null) {
      clears.push(key);
      continue;
    }

    if (typeof raw !== "string") return { error: `${key} must be a string` };

    if ((SECTION_SHOW_KEYS as readonly string[]).includes(key)) {
      if (raw !== "true" && raw !== "false") return { error: `${key} must be "true" or "false"` };
      out[key] = raw;
    } else if (key === "food_jurisdiction") {
      if (!(FOOD_JURISDICTIONS as readonly string[]).includes(raw)) {
        return { error: `${key} must be "scotland" or "england_wales"` };
      }
      out[key] = raw;
    } else if (key === "food_cold_units") {
      const r = cleanColdUnits(raw);
      if ("error" in r) return { error: r.error };
      out[key] = r.value;
    } else if (
      key === "food_default_hot_items"
      || key === "food_default_holding_items"
      || key === "food_default_sv_items"
      || key === "food_probe_names"
    ) {
      const label = key === "food_default_hot_items" ? "Hot items"
        : key === "food_default_holding_items" ? "Holding items"
        : key === "food_default_sv_items" ? "Sous vide items"
        : "Probe";
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
  return { values: out, clears };
}

// GET /api/food-safety/config[?siteId=N]
// Without siteId: returns the client-level effective config (defaults ← client).
// With siteId: returns the site's effective config (defaults ← client ← site)
// plus _siteOverrides listing which keys the site overrides.
router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });

  const site = parseSiteId((req.query as { siteId?: unknown }).siteId);
  if ("error" in site) return res.status(400).json({ error: site.error });
  if (site.siteId !== null && !(await siteBelongsToClient(site.siteId, clientId, getActiveDepartmentId(req)))) {
    return res.status(400).json({ error: "Invalid siteId" });
  }

  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));

  // client-level values keyed by config key
  const clientStored = new Set<string>();
  const config: Record<string, string> = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    if (CONFIG_KEYS.includes(row.key as (typeof CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
      clientStored.add(row.key);
    }
  }

  // Backward compatibility: cooling/reheating were introduced as their own
  // toggles later. If a client saved a template before they existed, inherit
  // their visibility from the original grouped "hot temperature" toggle.
  if (clientStored.has("food_show_hot_temperature")) {
    if (!clientStored.has("food_show_cooling")) config.food_show_cooling = config.food_show_hot_temperature;
    if (!clientStored.has("food_show_reheating")) config.food_show_reheating = config.food_show_hot_temperature;
  }
  if (clientStored.has("food_jurisdiction") && !clientStored.has("food_reheating_limit")) {
    config.food_reheating_limit = reheatingLimitForJurisdiction(config.food_jurisdiction);
  }

  // Overlay site-level values on top of the client-level config.
  const siteOverrides: string[] = [];
  if (site.siteId !== null) {
    const prefix = `${SITE_PREFIX}${site.siteId}.`;
    let siteJurisdictionOverride = false;
    let siteReheatingOverride = false;
    for (const row of rows) {
      if (!row.key.startsWith(prefix) || row.value == null) continue;
      const baseKey = row.key.slice(prefix.length);
      if (CONFIG_KEYS.includes(baseKey as (typeof CONFIG_KEYS)[number])) {
        config[baseKey] = row.value;
        siteOverrides.push(baseKey);
        if (baseKey === "food_jurisdiction") siteJurisdictionOverride = true;
        if (baseKey === "food_reheating_limit") siteReheatingOverride = true;
      }
    }
    if (siteJurisdictionOverride && !siteReheatingOverride) {
      config.food_reheating_limit = reheatingLimitForJurisdiction(config.food_jurisdiction);
    }
    return res.json({ ...config, _siteOverrides: siteOverrides });
  }

  res.json(config);
});

// PUT /api/food-safety/config[?siteId=N] — admin-only template customisation.
// Without siteId: writes client-level template values (unchanged behaviour).
// With siteId: writes site-scoped override keys (site.<siteId>.<key>).
router.put("/config", requireAuth, requireClientAdmin, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });

  const site = parseSiteId((req.query as { siteId?: unknown }).siteId);
  if ("error" in site) return res.status(400).json({ error: site.error });
  if (site.siteId !== null && !(await siteBelongsToClient(site.siteId, clientId, getActiveDepartmentId(req)))) {
    return res.status(400).json({ error: "Invalid siteId" });
  }

  const validated = validateConfigPatch((req.body ?? {}) as Record<string, unknown>);
  if ("error" in validated) return res.status(400).json({ error: validated.error });

  // Selecting a jurisdiction also selects its standard reheating limit unless
  // the caller explicitly supplied a legacy/custom limit. This keeps existing
  // custom templates intact while making the new selector deterministic.
  const rawUpdates = (req.body ?? {}) as Record<string, unknown>;
  if (
    validated.values.food_jurisdiction
    && !Object.prototype.hasOwnProperty.call(rawUpdates, "food_reheating_limit")
  ) {
    validated.values.food_reheating_limit = reheatingLimitForJurisdiction(
      validated.values.food_jurisdiction,
    );
  }

  const storageKeyOf = (baseKey: string) =>
    site.siteId !== null ? siteKeyFor(site.siteId, baseKey) : baseKey;

  // Upsert the keys that carry a value.
  for (const [baseKey, value] of Object.entries(validated.values) as [
    (typeof CONFIG_KEYS)[number],
    string,
  ][]) {
    const storageKey = storageKeyOf(baseKey);

    const existing = await db
      .select({ clientId: appSettingsTable.clientId })
      .from(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, storageKey)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(appSettingsTable)
        .set({ value, updatedAt: new Date() })
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, storageKey)));
    } else {
      await db.insert(appSettingsTable).values({ clientId, key: storageKey, value });
    }
  }

  // Clear keys sent as null. For a site PUT this removes the site override so the
  // key inherits the client-level value; for a client PUT it removes the stored
  // client value so the key reverts to DEFAULT_CONFIG.
  if (validated.clears.length > 0) {
    const clearKeys = validated.clears.map(storageKeyOf);
    await db
      .delete(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), inArray(appSettingsTable.key, clearKeys)));
  }

  res.json({ ok: true });
});

// DELETE /api/food-safety/config[?siteId=N] — admin-only reset.
// Without siteId: removes every client-level template key; GET then falls back
// to DEFAULT_CONFIG (unchanged behaviour).
// With siteId: removes only that site's override keys; the client-level template
// is left untouched and remains the effective config for the site.
router.delete("/config", requireAuth, requireClientAdmin, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });

  const site = parseSiteId((req.query as { siteId?: unknown }).siteId);
  if ("error" in site) return res.status(400).json({ error: site.error });
  if (site.siteId !== null && !(await siteBelongsToClient(site.siteId, clientId, getActiveDepartmentId(req)))) {
    return res.status(400).json({ error: "Invalid siteId" });
  }

  if (site.siteId !== null) {
    const siteKeys = (CONFIG_KEYS as readonly string[]).map((k) => siteKeyFor(site.siteId as number, k));
    await db
      .delete(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), inArray(appSettingsTable.key, siteKeys)));
  } else {
    await db
      .delete(appSettingsTable)
      .where(
        and(
          eq(appSettingsTable.clientId, clientId),
          inArray(appSettingsTable.key, CONFIG_KEYS as unknown as string[])
        )
      );
  }

  res.json({ ...DEFAULT_CONFIG });
});

/** Resolve the configured jurisdiction for a diary scope. Site-level settings
 * take precedence over the client-level setting, matching GET /config. */
async function resolveReheatingLimit(
  clientId: number,
  siteId: number | null,
  requestedLimit?: string,
): Promise<string> {
  if (requestedLimit !== undefined) return requestedLimit;

  const rows = await db
    .select({ key: appSettingsTable.key, value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));
  const clientJurisdiction = rows.find((row) => row.key === "food_jurisdiction")?.value;
  const siteJurisdiction = siteId === null
    ? undefined
    : rows.find((row) => row.key === siteKeyFor(siteId, "food_jurisdiction"))?.value;
  return reheatingLimitForJurisdiction(siteJurisdiction ?? clientJurisdiction);
}

// Drizzle condition selecting the right diary scope: a specific site when
// siteId is given, otherwise the whole-organisation diary (site_id IS NULL).
const siteScopeCond = (siteId: number | null) =>
  siteId === null ? isNull(foodSafetyRecordsTable.siteId) : eq(foodSafetyRecordsTable.siteId, siteId);

/** Resolve + validate the optional siteId query param against the client's
 *  sites. On error, writes the response and returns undefined. */
async function resolveDiarySiteId(
  req: any,
  res: any,
  clientId: number
): Promise<number | null | undefined> {
  const site = parseSiteId(req.query?.siteId);
  if ("error" in site) {
    res.status(400).json({ error: site.error });
    return undefined;
  }
  if (site.siteId !== null && !(await siteBelongsToClient(site.siteId, clientId, getActiveDepartmentId(req)))) {
    res.status(400).json({ error: "Invalid siteId" });
    return undefined;
  }
  return site.siteId;
}

// GET /api/food-safety/by-date/:date[?siteId=N]
router.get("/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const siteId = await resolveDiarySiteId(req, res, clientId);
  if (siteId === undefined) return;

  const date = req.params.date as string;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date" });

  const [record] = await db
    .select()
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.clientId, clientId), eq(foodSafetyRecordsTable.recordDate, date), siteScopeCond(siteId)))
    .limit(1);

  if (!record) return res.status(404).json({ error: "No record for this date" });
  res.json(record);
});

// GET /api/food-safety?date=YYYY-MM-DD[&siteId=N]
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });

  const siteId = await resolveDiarySiteId(req, res, clientId);
  if (siteId === undefined) return;

  const { date } = req.query as { date?: string };
  if (!date) {
    // Return list of record dates (for history)
    const records = await db
      .select({ id: foodSafetyRecordsTable.id, recordDate: foodSafetyRecordsTable.recordDate, submittedAt: foodSafetyRecordsTable.submittedAt })
      .from(foodSafetyRecordsTable)
      .where(and(eq(foodSafetyRecordsTable.clientId, clientId), siteScopeCond(siteId)))
      .orderBy(foodSafetyRecordsTable.recordDate);
    return void res.json(records);
  }

  const [record] = await db
    .select()
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.clientId, clientId), eq(foodSafetyRecordsTable.recordDate, date), siteScopeCond(siteId)))
    .limit(1);

  if (!record) return void res.json(null);
  res.json(record);
});

// GET /api/food-safety/summary?year=YYYY&month=MM[&siteId=N]
// Return one completeness entry for every calendar day in the requested month.
router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "No client context" });
    return;
  }

  const rawYear = (req.query as { year?: unknown }).year;
  const rawMonth = (req.query as { month?: unknown }).month;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12
  ) {
    res.status(400).json({ error: "year and month are required and must be valid calendar values" });
    return;
  }

  const siteId = await resolveDiarySiteId(req, res, clientId);
  if (siteId === undefined) return;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  const firstDate = `${monthPrefix}-01`;
  const lastDate = `${monthPrefix}-${String(daysInMonth).padStart(2, "0")}`;

  const records = await db
    .select({
      recordDate: foodSafetyRecordsTable.recordDate,
      submittedAt: foodSafetyRecordsTable.submittedAt,
    })
    .from(foodSafetyRecordsTable)
    .where(and(
      eq(foodSafetyRecordsTable.clientId, clientId),
      sql`${foodSafetyRecordsTable.recordDate} >= ${firstDate}`,
      sql`${foodSafetyRecordsTable.recordDate} <= ${lastDate}`,
      siteScopeCond(siteId),
    ));

  const recordsByDate = new Map(records.map((record) => [record.recordDate, record]));
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${monthPrefix}-${String(index + 1).padStart(2, "0")}`;
    const record = recordsByDate.get(date);
    return {
      date,
      hasRecord: !!record,
      submitted: !!record?.submittedAt,
    };
  });

  res.json({ year, month, siteId, days });
});

// GET /api/food-safety/missing-dates?from=YYYY-MM-DD&to=YYYY-MM-DD[&siteId=N]
// Return an explicit, bounded history range rather than making clients infer
// absent dates from an unbounded record list. Drafts are reported separately:
// they exist, but still need to be submitted.
router.get("/missing-dates", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });

  const { from, to } = req.query as { from?: string; to?: string };
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const parseCalendarDate = (value: string | undefined) => {
    if (!value || !dateRe.test(value)) return NaN;
    const millis = Date.parse(`${value}T00:00:00Z`);
    return new Date(millis).toISOString().slice(0, 10) === value ? millis : NaN;
  };
  const fromMillis = parseCalendarDate(from);
  const toMillis = parseCalendarDate(to);
  if (!from || !to || Number.isNaN(fromMillis) || Number.isNaN(toMillis) || from > to) {
    return res.status(400).json({ error: "from and to (YYYY-MM-DD) are required, with from no later than to" });
  }
  const rangeDays = (toMillis - fromMillis) / 86400000;
  if (rangeDays > 366) return res.status(400).json({ error: "Date range cannot exceed 367 days" });

  const siteId = await resolveDiarySiteId(req, res, clientId);
  if (siteId === undefined) return;

  const records = await db
    .select({
      recordDate: foodSafetyRecordsTable.recordDate,
      submittedAt: foodSafetyRecordsTable.submittedAt,
    })
    .from(foodSafetyRecordsTable)
    .where(and(
      eq(foodSafetyRecordsTable.clientId, clientId),
      sql`${foodSafetyRecordsTable.recordDate} >= ${from}`,
      sql`${foodSafetyRecordsTable.recordDate} <= ${to}`,
      siteScopeCond(siteId),
    ));

  const submittedDates = new Set(
    records.filter((record) => record.submittedAt).map((record) => record.recordDate),
  );
  const draftDates = records
    .filter((record) => !record.submittedAt)
    .map((record) => record.recordDate)
    .sort();
  const missingDates: string[] = [];
  for (
    let day = fromMillis;
    day <= toMillis;
    day += 86400000
  ) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (!submittedDates.has(date) && !draftDates.includes(date)) missingDates.push(date);
  }

  res.json({ from, to, siteId, missingDates, draftDates });
});

// POST /api/food-safety[?siteId=N]
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const siteId = await resolveDiarySiteId(req, res, clientId);
  if (siteId === undefined) return;

  const parsed = createRecordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const data = parsed.data;
  const performer = await resolveStaffPerformer(clientId, data.staffRosterId, data.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });
  const reheatingLimit = await resolveReheatingLimit(clientId, siteId, data.reheatingLimit);

  // Check if record already exists for this date within the same diary scope.
  const [existing] = await db
    .select({
      id: foodSafetyRecordsTable.id,
      siteId: foodSafetyRecordsTable.siteId,
      staffRosterId: foodSafetyRecordsTable.staffRosterId,
      performedBy: foodSafetyRecordsTable.performedBy,
    })
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.clientId, clientId), eq(foodSafetyRecordsTable.recordDate, data.recordDate), siteScopeCond(siteId)))
    .limit(1);

  if (existing) return void res.status(409).json({ error: "Record already exists for this date", id: existing.id });

  const [inserted] = await db
    .insert(foodSafetyRecordsTable)
    .values({
      clientId,
      siteId: siteId ?? null,
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
      reheatingLimit,
      hotHoldingLimit: data.hotHoldingLimit ?? "Above 63°C",
      correctives: data.correctives,
      managerSignature: data.managerSignature,
      performedBy: performer.performedBy,
      staffRosterId: performer.staffRosterId,
      submittedAt: data.submittedAt ? new Date(data.submittedAt) : undefined,
      createdBy: (req.session as any).userId ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    const [winner] = await db
      .select({ id: foodSafetyRecordsTable.id })
      .from(foodSafetyRecordsTable)
      .where(and(
        eq(foodSafetyRecordsTable.clientId, clientId),
        eq(foodSafetyRecordsTable.recordDate, data.recordDate),
        siteScopeCond(siteId),
      ))
      .limit(1);
    return res.status(409).json({ error: "Record already exists for this date", id: winner?.id });
  }

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

  const siteId = await resolveDiarySiteId(req, res, clientId);
  if (siteId === undefined) return;

  const appendSchema = z.object({
    recordDate: calendarDateSchema,
    section: z.enum(SECTION_KEYS),
    row: rowSchema,
    entryId: z.string().regex(/^[A-Za-z0-9_-]{12,100}$/).optional(),
    recordedAt: z.string().datetime({ offset: true }).optional(),
  });
  const parsed = appendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const { recordDate, section, row, entryId, recordedAt } = parsed.data;
  if (recordedAt && recordedAt.slice(0, 10) !== recordDate) {
    return res.status(400).json({ error: "recordDate must match the local date in recordedAt" });
  }
  const column = SECTION_COLUMNS[section];
  const storedRow = {
    ...row,
    ...(entryId ? { _entryId: entryId } : {}),
    ...(recordedAt ? { _recordedAt: recordedAt } : {}),
  };
  const rowJson = JSON.stringify(storedRow);
  const userId = (req.session as any).userId ?? null;
  const reheatingLimit = section === "reheating"
    ? await resolveReheatingLimit(clientId, siteId)
    : undefined;

  // Ensure the day's record exists for this diary scope (ignore the race where
  // another writer creates it first), then append in a single UPDATE. The
  // ON CONFLICT target uses the matching partial unique index for the scope.
  if (siteId === null) {
    if (reheatingLimit !== undefined) {
      await db.execute(sql`
        INSERT INTO food_safety_records (client_id, record_date, reheating_limit, created_by)
        VALUES (${clientId}, ${recordDate}, ${reheatingLimit}, ${userId})
        ON CONFLICT (client_id, record_date) WHERE site_id IS NULL DO NOTHING
      `);
    } else {
      await db.execute(sql`
        INSERT INTO food_safety_records (client_id, record_date, created_by)
        VALUES (${clientId}, ${recordDate}, ${userId})
        ON CONFLICT (client_id, record_date) WHERE site_id IS NULL DO NOTHING
      `);
    }
  } else {
    if (reheatingLimit !== undefined) {
      await db.execute(sql`
        INSERT INTO food_safety_records (client_id, site_id, record_date, reheating_limit, created_by)
        VALUES (${clientId}, ${siteId}, ${recordDate}, ${reheatingLimit}, ${userId})
        ON CONFLICT (client_id, site_id, record_date) WHERE site_id IS NOT NULL DO NOTHING
      `);
    } else {
      await db.execute(sql`
        INSERT INTO food_safety_records (client_id, site_id, record_date, created_by)
        VALUES (${clientId}, ${siteId}, ${recordDate}, ${userId})
        ON CONFLICT (client_id, site_id, record_date) WHERE site_id IS NOT NULL DO NOTHING
      `);
    }
  }

  const scopeCond = siteId === null ? sql`site_id IS NULL` : sql`site_id = ${siteId}`;
  const duplicateGuard = entryId
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(${sql.raw(`"${column}"`)}, '[]'::jsonb)) AS existing
        WHERE existing->>'_entryId' = ${entryId}
      )`
    : sql``;
  const result = await db.execute(sql`
    UPDATE food_safety_records
    SET ${sql.raw(`"${column}"`)} = COALESCE(${sql.raw(`"${column}"`)}, '[]'::jsonb) || ${rowJson}::jsonb,
        updated_at = now()
    WHERE client_id = ${clientId} AND record_date = ${recordDate} AND ${scopeCond}
      ${duplicateGuard}
    RETURNING *
  `);
  const updated = (result.rows ?? [])[0];
  if (!updated && entryId) {
    const existingResult = await db.execute(sql`
      SELECT * FROM food_safety_records
      WHERE client_id = ${clientId} AND record_date = ${recordDate} AND ${scopeCond}
      LIMIT 1
    `);
    const existing = existingResult.rows?.[0];
    if (existing) return res.status(200).json({ ...existing, deduplicated: true });
  }
  if (!updated) return res.status(500).json({ error: "Could not append record" });
  res.status(201).json(updated);
});

// PUT /api/food-safety/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db
    .select({
      id: foodSafetyRecordsTable.id,
      siteId: foodSafetyRecordsTable.siteId,
      staffRosterId: foodSafetyRecordsTable.staffRosterId,
      performedBy: foodSafetyRecordsTable.performedBy,
    })
    .from(foodSafetyRecordsTable)
    .where(and(eq(foodSafetyRecordsTable.id, id), eq(foodSafetyRecordsTable.clientId, clientId)))
    .limit(1);

  if (!existing) return res.status(404).json({ error: "Not found" });
  // An ID is not a department bypass: always re-check the owning site's
  // authorization rather than trusting the tenant predicate alone.
  if (existing.siteId !== null && !(await siteBelongsToClient(existing.siteId, clientId, getActiveDepartmentId(req)))) {
    return res.status(403).json({ error: "Site not accessible" });
  }

  const parsedUpdate = updateRecordSchema.safeParse(req.body);
  if (!parsedUpdate.success) return res.status(400).json({ error: "Invalid data" });

  const mobileLog = parsedUpdate.data.mobileTemperatureLog;
  if (mobileLog) {
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(foodSafetyRecordsTable)
        .where(and(eq(foodSafetyRecordsTable.id, id), eq(foodSafetyRecordsTable.clientId, clientId)))
        .limit(1)
        .for("update");
      if (!current) return null;

      const currentCold = (current.coldFood ?? []) as Record<string, unknown>[];
      const expectedByUnit = new Map(
        mobileLog.expectedColdFood.map((row) => [String(row.unit ?? ""), row]),
      );
      const coldConflict = mobileLog.coldFood.some((row) => {
        const unit = String(row.unit ?? "");
        const expected = expectedByUnit.get(unit);
        const currentRow = currentCold.find((candidate) => String(candidate.unit ?? "") === unit);
        return JSON.stringify(currentRow ?? null) !== JSON.stringify(expected ?? null);
      });
      const correctivesConflict =
        mobileLog.correctives !== undefined &&
        (current.correctives ?? null) !== mobileLog.expectedCorrectives;
      if (coldConflict || correctivesConflict) return { conflict: true as const };

      const incomingByUnit = new Map(
        mobileLog.coldFood.map((row) => [String(row.unit ?? ""), row]),
      );
      const mergedCold = currentCold.map((row) => {
        const unit = String(row.unit ?? "");
        const replacement = incomingByUnit.get(unit);
        if (replacement) incomingByUnit.delete(unit);
        return replacement ?? row;
      });
      mergedCold.push(...incomingByUnit.values());

      const append = (
        rows: unknown,
        row: Record<string, string | number | boolean | null> | undefined,
      ) => row ? [...((rows ?? []) as Record<string, unknown>[]), row] : rows;

      const [saved] = await tx
        .update(foodSafetyRecordsTable)
        .set({
          coldFood: mergedCold,
          deliveries: append(current.deliveries, mobileLog.delivery),
          hotHolding: append(current.hotHolding, mobileLog.hotHolding),
          hotTemperature: append(current.hotTemperature, mobileLog.hotTemperature),
          cooling: append(current.cooling, mobileLog.cooling),
          reheating: append(current.reheating, mobileLog.reheating),
          ...(mobileLog.correctives !== undefined ? { correctives: mobileLog.correctives } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(foodSafetyRecordsTable.id, id), eq(foodSafetyRecordsTable.clientId, clientId)))
        .returning();
      return saved;
    });
    if (!updated) return res.status(404).json({ error: "Not found" });
    if ("conflict" in updated) {
      return res.status(409).json({
        error: "Today’s diary changed while you were editing. Reload it and try again.",
      });
    }
    return res.json(updated);
  }

  const updates: any = { updatedAt: new Date() };
  const { submittedAt, mobileTemperatureLog: _mobileTemperatureLog, ...rest } = parsedUpdate.data;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) updates[key] = value;
  }
  if (submittedAt !== undefined) {
    updates.submittedAt = submittedAt ? new Date(submittedAt) : null;
  }
  const performer = await resolveStaffPerformerUpdate(clientId, parsedUpdate.data.staffRosterId, parsedUpdate.data.performedBy,
    existing.staffRosterId, existing.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });
  updates.staffRosterId = performer.staffRosterId;
  updates.performedBy = performer.performedBy;

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
