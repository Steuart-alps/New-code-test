import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { patAppliancesTable, patTestsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

// ── Schemas ──────────────────────────────────────────────────────────────────

const applianceSchema = z.object({
  name:          z.string().min(1).max(200),
  applianceType: z.string().max(100).default("Other"),
  location:      z.string().max(200).nullable().optional(),
  assetTag:      z.string().max(100).nullable().optional(),
  description:   z.string().max(1000).nullable().optional(),
  siteId:        z.number().int().nullable().optional(),
  active:        z.boolean().optional(),
});

const testSchema = z.object({
  applianceId:         z.number().int(),
  testDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result:              z.enum(["pass", "fail"]),
  nextTestDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  testedBy:            z.string().max(200).nullable().optional(),
  visualInspection:    z.enum(["pass", "fail", "na"]).nullable().optional(),
  earthContinuityOhms: z.string().max(50).nullable().optional(),
  insulationMohms:     z.string().max(50).nullable().optional(),
  operatingCurrent:    z.string().max(50).nullable().optional(),
  notes:               z.string().max(2000).nullable().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Appliances ────────────────────────────────────────────────────────────────

router.get("/appliances", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  // Return appliances with their latest test info joined
  const rows = await db.execute(sql`
    SELECT
      a.id, a.client_id, a.site_id, a.name, a.appliance_type, a.location,
      a.asset_tag, a.description, a.active, a.created_at, a.updated_at,
      t.test_date       AS last_test_date,
      t.result          AS last_result,
      t.next_test_date  AS next_test_date,
      t.tested_by       AS last_tested_by
    FROM pat_appliances a
    LEFT JOIN LATERAL (
      SELECT test_date, result, next_test_date, tested_by
      FROM pat_tests
      WHERE appliance_id = a.id AND client_id = a.client_id
      ORDER BY test_date DESC LIMIT 1
    ) t ON true
    WHERE a.client_id = ${clientId}
    ORDER BY a.name ASC
  `);

  res.json(rows.rows ?? rows);
});

router.post("/appliances", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = applianceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const [row] = await db.insert(patAppliancesTable).values({
    clientId,
    siteId:        d.siteId ?? null,
    name:          d.name,
    applianceType: d.applianceType,
    location:      d.location ?? null,
    assetTag:      d.assetTag ?? null,
    description:   d.description ?? null,
    active:        d.active ?? true,
  }).returning();
  res.status(201).json(row);
});

router.put("/appliances/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const parsed = applianceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const [row] = await db.update(patAppliancesTable)
    .set({
      siteId:        d.siteId ?? null,
      name:          d.name,
      applianceType: d.applianceType,
      location:      d.location ?? null,
      assetTag:      d.assetTag ?? null,
      description:   d.description ?? null,
      active:        d.active ?? true,
      updatedAt:     new Date(),
    })
    .where(and(eq(patAppliancesTable.id, id), eq(patAppliancesTable.clientId, clientId)))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/appliances/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  await db.delete(patAppliancesTable)
    .where(and(eq(patAppliancesTable.id, id), eq(patAppliancesTable.clientId, clientId)));
  res.json({ ok: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

router.get("/tests", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const applianceId = req.query.applianceId ? parseInt(req.query.applianceId as string, 10) : undefined;

  const rows = await db.execute(sql`
    SELECT
      t.*,
      a.name AS appliance_name,
      a.appliance_type,
      a.asset_tag
    FROM pat_tests t
    JOIN pat_appliances a ON a.id = t.appliance_id
    WHERE t.client_id = ${clientId}
    ${applianceId ? sql`AND t.appliance_id = ${applianceId}` : sql``}
    ORDER BY t.test_date DESC, t.created_at DESC
    LIMIT 500
  `);

  res.json(rows.rows ?? rows);
});

router.post("/tests", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const [row] = await db.insert(patTestsTable).values({
    clientId,
    applianceId:         d.applianceId,
    testDate:            d.testDate,
    result:              d.result,
    nextTestDate:        d.nextTestDate ?? null,
    testedBy:            d.testedBy ?? null,
    visualInspection:    d.visualInspection ?? null,
    earthContinuityOhms: d.earthContinuityOhms ?? null,
    insulationMohms:     d.insulationMohms ?? null,
    operatingCurrent:    d.operatingCurrent ?? null,
    notes:               d.notes ?? null,
  }).returning();
  res.status(201).json(row);
});

router.put("/tests/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const [row] = await db.update(patTestsTable)
    .set({
      applianceId:         d.applianceId,
      testDate:            d.testDate,
      result:              d.result,
      nextTestDate:        d.nextTestDate ?? null,
      testedBy:            d.testedBy ?? null,
      visualInspection:    d.visualInspection ?? null,
      earthContinuityOhms: d.earthContinuityOhms ?? null,
      insulationMohms:     d.insulationMohms ?? null,
      operatingCurrent:    d.operatingCurrent ?? null,
      notes:               d.notes ?? null,
      updatedAt:           new Date(),
    })
    .where(and(eq(patTestsTable.id, id), eq(patTestsTable.clientId, clientId)))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/tests/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  await db.delete(patTestsTable)
    .where(and(eq(patTestsTable.id, id), eq(patTestsTable.clientId, clientId)));
  res.json({ ok: true });
});

// ── Status summary ────────────────────────────────────────────────────────────

router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const today = todayIso();
  const in30 = new Date(); in30.setDate(in30.getDate() + 30);
  const in30Iso = in30.toISOString().split("T")[0];

  const result = await db.execute(sql`
    SELECT
      COUNT(*)                                                                      AS total_appliances,
      COUNT(*) FILTER (WHERE last.next_test_date IS NULL)                          AS untested,
      COUNT(*) FILTER (WHERE last.next_test_date IS NOT NULL AND last.next_test_date < ${today}::date)   AS overdue,
      COUNT(*) FILTER (WHERE last.next_test_date >= ${today}::date AND last.next_test_date <= ${in30Iso}::date) AS due_soon,
      COUNT(*) FILTER (WHERE last.next_test_date > ${in30Iso}::date)               AS ok
    FROM pat_appliances a
    LEFT JOIN LATERAL (
      SELECT next_test_date, result
      FROM pat_tests
      WHERE appliance_id = a.id AND client_id = a.client_id
      ORDER BY test_date DESC LIMIT 1
    ) last ON true
    WHERE a.client_id = ${clientId} AND a.active = true
  `);

  const row = (result.rows ?? result)[0] as any;
  res.json({
    totalAppliances: Number(row?.total_appliances ?? 0),
    untested:        Number(row?.untested ?? 0),
    overdue:         Number(row?.overdue ?? 0),
    dueSoon:         Number(row?.due_soon ?? 0),
    ok:              Number(row?.ok ?? 0),
  });
});

// ── Template config ───────────────────────────────────────────────────────────

const PAT_CONFIG_KEYS = [
  "pat_default_tester",    // string
  "pat_retest_months",     // string (e.g. "12")
  "pat_locations",         // JSON string[]
  "pat_show_earth_bond",   // "true"|"false"
  "pat_show_insulation",   // "true"|"false"
] as const;

const PAT_DEFAULT_CONFIG = {
  pat_default_tester:  "",
  pat_retest_months:   "12",
  pat_locations:       "[]",
  pat_show_earth_bond: "true",
  pat_show_insulation: "true",
};

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...PAT_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (PAT_CONFIG_KEYS.includes(row.key as (typeof PAT_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  res.json(config);
});

router.put("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updates = req.body as Record<string, string>;
  for (const key of PAT_CONFIG_KEYS) {
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

// ── Preset templates (per-client customisable room presets) ───────────────────

const VALID_PRESET_KEYS = [
  "hotel-suite", "hotel-classic", "office", "bar-restaurant",
  "reception", "kitchen", "pro-shop", "greenkeeping",
] as const;

type ValidPresetKey = (typeof VALID_PRESET_KEYS)[number];

function presetSettingKey(presetKey: ValidPresetKey) {
  return `pat_preset_${presetKey}` as const;
}

router.get("/preset-templates", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const settingRows = await db.select().from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));

  const templates: Record<string, unknown[]> = {};
  for (const row of settingRows) {
    for (const key of VALID_PRESET_KEYS) {
      if (row.key === presetSettingKey(key) && row.value) {
        try { templates[key] = JSON.parse(row.value); } catch { /* ignore */ }
      }
    }
  }
  res.json(templates);
});

router.put("/preset-templates/:key", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const presetKey = req.params.key as ValidPresetKey;
  if (!VALID_PRESET_KEYS.includes(presetKey)) return res.status(400).json({ error: "Unknown preset key" });

  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });

  const settingKey = presetSettingKey(presetKey);
  const value = JSON.stringify(items);
  const existing = await db.select({ clientId: appSettingsTable.clientId }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey))).limit(1);

  if (existing.length > 0) {
    await db.update(appSettingsTable).set({ value, updatedAt: new Date() })
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey)));
  } else {
    await db.insert(appSettingsTable).values({ clientId, key: settingKey, value });
  }
  res.json({ ok: true });
});

router.delete("/preset-templates/:key", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const presetKey = req.params.key as ValidPresetKey;
  if (!VALID_PRESET_KEYS.includes(presetKey)) return res.status(400).json({ error: "Unknown preset key" });

  await db.delete(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, presetSettingKey(presetKey))));
  res.json({ ok: true });
});

export default router;
