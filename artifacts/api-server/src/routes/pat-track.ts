import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { patAppliancesTable, patTestsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, denyViewers, getActiveDepartmentId } from "../middleware/requireAuth";

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

function resultRows(result: any): any[] {
  return result.rows ?? result ?? [];
}

async function ownedSite(clientId: number, siteId: number | null | undefined) {
  if (siteId == null) return true;
  const result = await db.execute(sql`SELECT id FROM sites WHERE id = ${siteId} AND client_id = ${clientId} LIMIT 1`);
  return resultRows(result).length > 0;
}

// ── Appliances ────────────────────────────────────────────────────────────────

router.get("/appliances", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const departmentId = getActiveDepartmentId(req);
  const siteId = await checkedSiteQuery(req, clientId, departmentId);
  if (siteId === undefined) return res.status(400).json({ error: "Invalid siteId for this client" });
  if (siteId === "forbidden") return res.status(403).json({ error: "Forbidden" });

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
    LEFT JOIN sites s ON s.id=a.site_id AND s.client_id=a.client_id
    WHERE a.client_id = ${clientId}
    ${departmentId !== null ? sql`AND (a.site_id IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})` : sql``}
    ${siteId ? sql`AND a.site_id=${siteId}` : sql``}
    ORDER BY a.name ASC
  `);

  res.json(rows.rows ?? rows);
});

router.post("/appliances", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = applianceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const access = await siteAccess(clientId, d.siteId, getActiveDepartmentId(req));
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (access === "missing") return res.status(400).json({ error: "Invalid siteId for this client" });
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

router.put("/appliances/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const parsed = applianceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const departmentId = getActiveDepartmentId(req);
  const currentAccess = await applianceAccess(clientId, id, departmentId);
  if (currentAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (currentAccess === "missing") return res.status(404).json({ error: "Not found" });
  const targetAccess = await siteAccess(clientId, d.siteId, departmentId);
  if (targetAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (targetAccess === "missing") return res.status(400).json({ error: "Invalid siteId for this client" });
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

router.delete("/appliances/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const access = await applianceAccess(clientId, id, getActiveDepartmentId(req));
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (access === "missing") return res.status(404).json({ error: "Not found" });
  await db.delete(patAppliancesTable)
    .where(and(eq(patAppliancesTable.id, id), eq(patAppliancesTable.clientId, clientId)));
  res.json({ ok: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

router.get("/tests", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const applianceId = req.query.applianceId ? parseInt(req.query.applianceId as string, 10) : undefined;
  if (req.query.applianceId && isNaN(applianceId!)) return res.status(400).json({ error: "Invalid applianceId" });
  const departmentId = getActiveDepartmentId(req);
  if (applianceId) {
    const access = await applianceAccess(clientId, applianceId, departmentId);
    if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });
    if (access === "missing") return res.status(400).json({ error: "Appliance not found" });
  }

  const rows = await db.execute(sql`
    SELECT
      t.*,
      a.name AS appliance_name,
      a.appliance_type,
      a.asset_tag
    FROM pat_tests t
    JOIN pat_appliances a ON a.id = t.appliance_id
    LEFT JOIN sites s ON s.id=a.site_id AND s.client_id=a.client_id
    WHERE t.client_id = ${clientId}
    ${departmentId !== null ? sql`AND (a.site_id IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})` : sql``}
    ${applianceId ? sql`AND t.appliance_id = ${applianceId}` : sql``}
    ORDER BY t.test_date DESC, t.created_at DESC
    LIMIT 500
  `);

  res.json(rows.rows ?? rows);
});

router.post("/tests", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const applianceAccessResult = await applianceAccess(clientId, d.applianceId, getActiveDepartmentId(req));
  if (applianceAccessResult === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (applianceAccessResult === "missing") return res.status(400).json({ error: "Appliance not found" });
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

router.put("/tests/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const departmentId = getActiveDepartmentId(req);
  const currentAccess = await testAccess(clientId, id, departmentId);
  if (currentAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (currentAccess === "missing") return res.status(404).json({ error: "Not found" });
  const applianceAccessResult = await applianceAccess(clientId, d.applianceId, departmentId);
  if (applianceAccessResult === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (applianceAccessResult === "missing") return res.status(400).json({ error: "Appliance not found" });
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

router.delete("/tests/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const access = await testAccess(clientId, id, getActiveDepartmentId(req));
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (access === "missing") return res.status(404).json({ error: "Not found" });
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
  const departmentId = getActiveDepartmentId(req);

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
    LEFT JOIN sites s ON s.id=a.site_id AND s.client_id=a.client_id
    WHERE a.client_id = ${clientId} AND a.active = true
    ${departmentId !== null ? sql`AND (a.site_id IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})` : sql``}
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

router.get("/config", requireAuth, requireClientAdmin, async (req, res) => {
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

router.put("/config", requireAuth, requireClientAdmin, async (req, res) => {
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
  "reception", "kitchen", "pro-shop", "greenkeeping", "retail-shop",
  "pest-control",
] as const;

type ValidPresetKey = (typeof VALID_PRESET_KEYS)[number];

function presetSettingKey(presetKey: ValidPresetKey) {
  return `pat_preset_${presetKey}` as const;
}

router.get("/preset-templates", requireAuth, requireClientAdmin, async (req, res) => {
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

router.put("/preset-templates/:key", requireAuth, requireClientAdmin, async (req, res) => {
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

router.delete("/preset-templates/:key", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const presetKey = req.params.key as ValidPresetKey;
  if (!VALID_PRESET_KEYS.includes(presetKey)) return res.status(400).json({ error: "Unknown preset key" });

  await db.delete(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, presetSettingKey(presetKey))));
  res.json({ ok: true });
});

// ── Room / certificate PAT register ───────────────────────────────────────────
// This is separate from the original appliance-level register above, so existing
// PATTrack users can continue to use both workflows.
const dateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalText = z.string().max(4000).nullable().optional();
const optionalHttpUrl = z.string().url().max(2000).refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Only HTTP(S) document links are allowed").nullable().optional();
const templateItemSchema = z.object({
  name: z.string().min(1).max(200), applianceType: z.string().max(100).optional(),
  quantity: z.number().int().positive().max(1000).optional(), notes: optionalText,
  sortOrder: z.number().int().min(0).optional(),
});
const templateSchema = z.object({
  siteId: z.number().int().positive().nullable().optional(), name: z.string().min(1).max(200),
  description: optionalText, active: z.boolean().optional(), items: z.array(templateItemSchema).max(500).optional(),
});
const roomSchema = z.object({
  siteId: z.number().int().positive(), name: z.string().min(1).max(200),
  areaType: z.string().min(1).max(100).optional(), templateId: z.number().int().positive().nullable().optional(),
  testIntervalMonths: z.number().int().positive().max(120).optional(), active: z.boolean().optional(), notes: optionalText,
});
const replacementSchema = z.object({
  roomId: z.number().int().positive(), applianceName: z.string().min(1).max(200),
  replacedOn: dateValue, replacementDetails: optionalText, notes: optionalText,
});
const certificateSchema = z.object({
  siteId: z.number().int().positive(), visitDate: dateValue, contractorId: z.number().int().positive().nullable().optional(),
  contractorName: z.string().max(200).nullable().optional(), certificateRef: z.string().min(1).max(200),
  appliancesTestedCount: z.number().int().min(0).optional(), passCount: z.number().int().min(0).optional(),
  failCount: z.number().int().min(0).optional(), nextTestDue: dateValue.nullable().optional(),
  documentId: z.number().int().positive().nullable().optional(), documentLink: optionalHttpUrl,
  notes: optionalText, roomIds: z.array(z.number().int().positive()).max(1000).default([]),
});
const failureSchema = z.object({
  certificateId: z.number().int().positive(), roomId: z.number().int().positive().nullable().optional(),
  locationText: z.string().min(1).max(200).nullable().optional(),
  applianceName: z.string().min(1).max(200), actionTaken: optionalText, resolution: optionalText,
  resolvedDate: dateValue.nullable().optional(),
}).refine((data) => data.roomId != null || !!data.locationText, { message: "locationText is required when no roomId is supplied" });

type AccessResult = "allowed" | "forbidden" | "missing";

async function siteAccess(clientId: number, siteId: number | null | undefined, departmentId: number | null): Promise<AccessResult> {
  if (siteId == null) return "allowed";
  const row = resultRows(await db.execute(sql`
    SELECT department_id FROM sites WHERE id=${siteId} AND client_id=${clientId} LIMIT 1
  `))[0] as { department_id: number | null } | undefined;
  if (!row) return "missing";
  return departmentId !== null && row.department_id !== null && row.department_id !== departmentId ? "forbidden" : "allowed";
}
async function applianceAccess(clientId: number, applianceId: number, departmentId: number | null): Promise<AccessResult> {
  const row = resultRows(await db.execute(sql`SELECT site_id FROM pat_appliances WHERE id=${applianceId} AND client_id=${clientId}`))[0] as { site_id: number | null } | undefined;
  return row ? siteAccess(clientId, row.site_id, departmentId) : "missing";
}
async function testAccess(clientId: number, testId: number, departmentId: number | null): Promise<AccessResult> {
  const row = resultRows(await db.execute(sql`
    SELECT a.site_id FROM pat_tests t JOIN pat_appliances a ON a.id=t.appliance_id AND a.client_id=t.client_id
    WHERE t.id=${testId} AND t.client_id=${clientId}
  `))[0] as { site_id: number | null } | undefined;
  return row ? siteAccess(clientId, row.site_id, departmentId) : "missing";
}

async function checkedSiteQuery(req: any, clientId: number, departmentId: number | null) {
  const raw = (req.query as { siteId?: string }).siteId;
  if (!raw) return null;
  const siteId = Number(raw);
  if (!Number.isInteger(siteId)) return undefined;
  const access = await siteAccess(clientId, siteId, departmentId);
  if (access === "missing") return undefined;
  if (access === "forbidden") return "forbidden" as const;
  return siteId;
}
async function templateAccess(clientId: number, templateId: number | null | undefined, departmentId: number | null, siteId?: number): Promise<AccessResult> {
  if (templateId == null) return "allowed";
  const row = resultRows(await db.execute(sql`SELECT site_id FROM pat_equipment_templates WHERE id=${templateId} AND client_id=${clientId}`))[0] as { site_id: number | null } | undefined;
  if (!row) return "missing";
  const access = await siteAccess(clientId, row.site_id, departmentId);
  if (access !== "allowed") return access;
  return siteId !== undefined && row.site_id !== null && row.site_id !== siteId ? "missing" : "allowed";
}
async function roomOwned(clientId: number, roomId: number, departmentId?: number | null) {
  const rows = resultRows(await db.execute(sql`SELECT id, site_id, name FROM pat_rooms WHERE id = ${roomId} AND client_id = ${clientId}`));
  const room = rows[0] as { id: number; site_id: number; name: string } | undefined;
  if (!room || departmentId === undefined) return room;
  return await siteAccess(clientId, room.site_id, departmentId) === "allowed" ? room : undefined;
}
async function roomAccess(clientId: number, roomId: number, departmentId: number | null): Promise<AccessResult> {
  const room = await roomOwned(clientId, roomId);
  return room ? siteAccess(clientId, room.site_id, departmentId) : "missing";
}
async function certificateAccess(clientId: number, id: number, departmentId: number | null): Promise<AccessResult> {
  const row = resultRows(await db.execute(sql`SELECT site_id FROM pat_certificates WHERE id=${id} AND client_id=${clientId}`))[0] as { site_id: number } | undefined;
  return row ? siteAccess(clientId, row.site_id, departmentId) : "missing";
}
async function replacementAccess(clientId: number, id: number, departmentId: number | null): Promise<AccessResult> {
  const row = resultRows(await db.execute(sql`SELECT r.site_id FROM pat_replacements x JOIN pat_rooms r ON r.id=x.room_id AND r.client_id=x.client_id WHERE x.id=${id} AND x.client_id=${clientId}`))[0] as { site_id: number } | undefined;
  return row ? siteAccess(clientId, row.site_id, departmentId) : "missing";
}
async function failureAccess(clientId: number, id: number, departmentId: number | null): Promise<AccessResult> {
  const row = resultRows(await db.execute(sql`SELECT c.site_id FROM pat_failures f JOIN pat_certificates c ON c.id=f.certificate_id AND c.client_id=f.client_id WHERE f.id=${id} AND f.client_id=${clientId}`))[0] as { site_id: number } | undefined;
  return row ? siteAccess(clientId, row.site_id, departmentId) : "missing";
}

router.get("/equipment-templates", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const departmentId = getActiveDepartmentId(req);
  const siteId = await checkedSiteQuery(req, clientId, departmentId); if (siteId === undefined) return res.status(400).json({ error: "Invalid siteId for this client" }); if (siteId === "forbidden") return res.status(403).json({ error: "Forbidden" });
  const rows = resultRows(await db.execute(sql`
    SELECT t.*, COALESCE(json_agg(i ORDER BY i.sort_order, i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
    FROM pat_equipment_templates t LEFT JOIN pat_equipment_template_items i ON i.template_id=t.id AND i.client_id=t.client_id
    LEFT JOIN sites s ON s.id=t.site_id AND s.client_id=t.client_id
    WHERE t.client_id=${clientId} ${departmentId !== null ? sql`AND (t.site_id IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})` : sql``}
    ${siteId ? sql`AND (t.site_id=${siteId} OR t.site_id IS NULL)` : sql``}
    GROUP BY t.id ORDER BY t.name`));
  res.json(rows);
});
router.post("/equipment-templates", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = templateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Invalid data" }); const d = parsed.data;
  const access = await siteAccess(clientId, d.siteId, getActiveDepartmentId(req));
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (access === "missing") return res.status(400).json({ error: "Invalid siteId for this client" });
  const row = await db.transaction(async tx => {
    const template = resultRows(await tx.execute(sql`INSERT INTO pat_equipment_templates (client_id,site_id,name,description,active) VALUES (${clientId},${d.siteId ?? null},${d.name},${d.description ?? null},${d.active ?? true}) RETURNING *`))[0];
    for (const [index, item] of (d.items ?? []).entries()) await tx.execute(sql`INSERT INTO pat_equipment_template_items (client_id,template_id,name,appliance_type,quantity,notes,sort_order) VALUES (${clientId},${template.id},${item.name},${item.applianceType ?? "Other"},${item.quantity ?? 1},${item.notes ?? null},${item.sortOrder ?? index})`);
    return template;
  }); res.status(201).json(row);
});
router.put("/equipment-templates/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req), id = Number(req.params.id as string); if (!clientId || !Number.isInteger(id)) return res.status(400).json({ error: "Invalid request" });
  const parsed = templateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Invalid data" }); const d = parsed.data;
  const departmentId = getActiveDepartmentId(req);
  const currentAccess = await templateAccess(clientId, id, departmentId);
  if (currentAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (currentAccess === "missing") return res.status(404).json({ error: "Not found" });
  const targetAccess = await siteAccess(clientId, d.siteId, departmentId);
  if (targetAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (targetAccess === "missing") return res.status(400).json({ error: "Invalid siteId for this client" });
  // A global template may be made site-specific only when every room already
  // assigned to it belongs to that site. Going the other direction is safe.
  if (d.siteId != null) {
    const incompatibleRoom = resultRows(await db.execute(sql`
      SELECT r.id FROM pat_rooms r
      WHERE r.template_id=${id} AND r.client_id=${clientId} AND r.site_id<>${d.siteId}
      LIMIT 1
    `))[0];
    if (incompatibleRoom) return res.status(409).json({ error: "Template is assigned to rooms at a different site" });
  }
  const row = await db.transaction(async tx => {
    const template = resultRows(await tx.execute(sql`UPDATE pat_equipment_templates SET site_id=${d.siteId ?? null},name=${d.name},description=${d.description ?? null},active=${d.active ?? true},updated_at=now() WHERE id=${id} AND client_id=${clientId} RETURNING *`))[0];
    if (!template) return null;
    if (d.items) { await tx.execute(sql`DELETE FROM pat_equipment_template_items WHERE template_id=${id} AND client_id=${clientId}`); for (const [index,item] of d.items.entries()) await tx.execute(sql`INSERT INTO pat_equipment_template_items (client_id,template_id,name,appliance_type,quantity,notes,sort_order) VALUES (${clientId},${id},${item.name},${item.applianceType ?? "Other"},${item.quantity ?? 1},${item.notes ?? null},${item.sortOrder ?? index})`); }
    return template;
  }); if (!row) return res.status(404).json({ error: "Not found" }); res.json(row);
});
router.delete("/equipment-templates/:id", requireAuth, denyViewers, async (req,res) => { const clientId=getClientId(req),id=Number(req.params.id as string); if(!clientId||!Number.isInteger(id)) return res.status(400).json({error:"Invalid request"}); const access=await templateAccess(clientId,id,getActiveDepartmentId(req));if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(404).json({error:"Not found"});const assigned=resultRows(await db.execute(sql`SELECT id FROM pat_rooms WHERE template_id=${id} AND client_id=${clientId} LIMIT 1`))[0]; if(assigned)return res.status(409).json({error:"Template is assigned to a room and cannot be deleted"}); await db.execute(sql`DELETE FROM pat_equipment_templates WHERE id=${id} AND client_id=${clientId}`); res.json({ok:true}); });

router.get("/rooms", requireAuth, async (req,res) => { const clientId=getClientId(req); if(!clientId)return res.status(400).json({error:"No client context"});const departmentId=getActiveDepartmentId(req); const siteId=await checkedSiteQuery(req,clientId,departmentId); if(siteId===undefined)return res.status(400).json({error:"Invalid siteId for this client"});if(siteId==="forbidden")return res.status(403).json({error:"Forbidden"}); res.json(resultRows(await db.execute(sql`SELECT r.*,t.name AS template_name,s.name AS site_name FROM pat_rooms r LEFT JOIN pat_equipment_templates t ON t.id=r.template_id AND t.client_id=r.client_id JOIN sites s ON s.id=r.site_id AND s.client_id=r.client_id WHERE r.client_id=${clientId} ${departmentId!==null?sql`AND (s.department_id IS NULL OR s.department_id=${departmentId})`:sql``} ${siteId?sql`AND r.site_id=${siteId}`:sql``} ORDER BY r.name`))); });
router.post("/rooms", requireAuth, denyViewers, async (req,res) => { const clientId=getClientId(req); const p=roomSchema.safeParse(req.body); if(!clientId||!p.success)return res.status(400).json({error:"Invalid data"});const d=p.data,departmentId=getActiveDepartmentId(req);const site=await siteAccess(clientId,d.siteId,departmentId),template=await templateAccess(clientId,d.templateId,departmentId,d.siteId);if(site==="forbidden"||template==="forbidden")return res.status(403).json({error:"Forbidden"});if(site==="missing"||template==="missing")return res.status(400).json({error:"Template must be global or belong to this room's site"});const row=resultRows(await db.execute(sql`INSERT INTO pat_rooms (client_id,site_id,name,area_type,template_id,test_interval_months,active,notes) VALUES (${clientId},${d.siteId},${d.name},${d.areaType??"room"},${d.templateId??null},${d.testIntervalMonths??12},${d.active??true},${d.notes??null}) RETURNING *`))[0];res.status(201).json(row); });
router.put("/rooms/:id", requireAuth, denyViewers, async (req,res) => {const clientId=getClientId(req),id=Number(req.params.id as string),p=roomSchema.safeParse(req.body);if(!clientId||!Number.isInteger(id)||!p.success)return res.status(400).json({error:"Invalid data"});const d=p.data,departmentId=getActiveDepartmentId(req);const existingAccess=await roomAccess(clientId,id,departmentId);if(existingAccess==="forbidden")return res.status(403).json({error:"Forbidden"});if(existingAccess==="missing")return res.status(404).json({error:"Not found"});const site=await siteAccess(clientId,d.siteId,departmentId),template=await templateAccess(clientId,d.templateId,departmentId,d.siteId);if(site==="forbidden"||template==="forbidden")return res.status(403).json({error:"Forbidden"});if(site==="missing"||template==="missing")return res.status(400).json({error:"Template must be global or belong to this room's site"});const current=await roomOwned(clientId,id);if(!current)return res.status(404).json({error:"Not found"});if(current.site_id!==d.siteId){const history=resultRows(await db.execute(sql`SELECT 1 FROM pat_certificate_rooms WHERE room_id=${id} AND client_id=${clientId} UNION ALL SELECT 1 FROM pat_failures WHERE room_id=${id} AND client_id=${clientId} UNION ALL SELECT 1 FROM pat_replacements WHERE room_id=${id} AND client_id=${clientId} LIMIT 1`))[0];if(history)return res.status(409).json({error:"Room site cannot change while PAT compliance history exists"});}const row=resultRows(await db.execute(sql`UPDATE pat_rooms SET site_id=${d.siteId},name=${d.name},area_type=${d.areaType??"room"},template_id=${d.templateId??null},test_interval_months=${d.testIntervalMonths??12},active=${d.active??true},notes=${d.notes??null},updated_at=now() WHERE id=${id} AND client_id=${clientId} RETURNING *`))[0];res.json(row);});
router.delete("/rooms/:id", requireAuth, denyViewers, async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string);if(!clientId||!Number.isInteger(id))return res.status(400).json({error:"Invalid request"});const access=await roomAccess(clientId,id,getActiveDepartmentId(req));if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(404).json({error:"Not found"});const ref=resultRows(await db.execute(sql`SELECT 1 FROM pat_certificate_rooms WHERE room_id=${id} AND client_id=${clientId} UNION ALL SELECT 1 FROM pat_failures WHERE room_id=${id} AND client_id=${clientId} UNION ALL SELECT 1 FROM pat_replacements WHERE room_id=${id} AND client_id=${clientId} LIMIT 1`))[0];if(ref)return res.status(409).json({error:"Room has PAT compliance history and cannot be deleted"});await db.execute(sql`DELETE FROM pat_rooms WHERE id=${id} AND client_id=${clientId}`);res.json({ok:true});});

async function validateCertificateLinks(clientId: number, departmentId: number | null, d: z.infer<typeof certificateSchema>): Promise<AccessResult> {
  const site = await siteAccess(clientId, d.siteId, departmentId);
  if (site !== "allowed") return site;
  if (d.contractorId != null && !resultRows(await db.execute(sql`SELECT id FROM contractors WHERE id=${d.contractorId} AND client_id=${clientId}`)).length) return "missing";
  if (d.documentId != null) {
    const document = resultRows(await db.execute(sql`SELECT site_id FROM doc_track_documents WHERE id=${d.documentId} AND client_id=${clientId}`))[0] as { site_id: number | null } | undefined;
    if (!document) return "missing";
    const documentAccess = await siteAccess(clientId, document.site_id, departmentId);
    if (documentAccess !== "allowed") return documentAccess;
  }
  if (d.roomIds.length) {
    for (const roomId of d.roomIds) {
      const access = await roomAccess(clientId, roomId, departmentId);
      if (access !== "allowed") return access;
    }
    const found = resultRows(await db.execute(sql`SELECT id FROM pat_rooms WHERE client_id=${clientId} AND site_id=${d.siteId} AND id IN (${sql.join(d.roomIds.map(id => sql`${id}`), sql`, `)})`));
    if (found.length !== new Set(d.roomIds).size) return "missing";
  }
  return "allowed";
}
router.get("/certificates", requireAuth, async(req,res)=>{const clientId=getClientId(req);if(!clientId)return res.status(400).json({error:"No client context"});const departmentId=getActiveDepartmentId(req),siteId=await checkedSiteQuery(req,clientId,departmentId);if(siteId===undefined)return res.status(400).json({error:"Invalid siteId for this client"});if(siteId==="forbidden")return res.status(403).json({error:"Forbidden"});res.json(resultRows(await db.execute(sql`SELECT c.*,COALESCE(json_agg(json_build_object('id',r.id,'name',r.name,'area_type',r.area_type)) FILTER (WHERE r.id IS NOT NULL),'[]') AS rooms FROM pat_certificates c JOIN sites s ON s.id=c.site_id AND s.client_id=c.client_id LEFT JOIN pat_certificate_rooms cr ON cr.certificate_id=c.id AND cr.client_id=c.client_id LEFT JOIN pat_rooms r ON r.id=cr.room_id AND r.client_id=c.client_id WHERE c.client_id=${clientId} ${departmentId!==null?sql`AND (s.department_id IS NULL OR s.department_id=${departmentId})`:sql``} ${siteId?sql`AND c.site_id=${siteId}`:sql``} GROUP BY c.id ORDER BY c.visit_date DESC,c.id DESC`)));});
router.post("/certificates", requireAuth, denyViewers, async(req,res)=>{const clientId=getClientId(req),p=certificateSchema.safeParse(req.body);if(!clientId||!p.success)return res.status(400).json({error:"Invalid data"});const d=p.data,access=await validateCertificateLinks(clientId,getActiveDepartmentId(req),d);if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(400).json({error:"Invalid linked site, room, contractor or document"});const row=await db.transaction(async tx=>{const c=resultRows(await tx.execute(sql`INSERT INTO pat_certificates (client_id,site_id,visit_date,contractor_id,contractor_name,certificate_ref,appliances_tested_count,pass_count,fail_count,next_test_due,document_id,document_link,notes) VALUES (${clientId},${d.siteId},${d.visitDate},${d.contractorId??null},${d.contractorName??null},${d.certificateRef},${d.appliancesTestedCount??0},${d.passCount??0},${d.failCount??0},${d.nextTestDue??null},${d.documentId??null},${d.documentLink??null},${d.notes??null}) RETURNING *`))[0];for(const roomId of d.roomIds)await tx.execute(sql`INSERT INTO pat_certificate_rooms (client_id,certificate_id,room_id) VALUES (${clientId},${c.id},${roomId})`);return c;});res.status(201).json(row);});
router.put("/certificates/:id", requireAuth, denyViewers, async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string),p=certificateSchema.safeParse(req.body);if(!clientId||!Number.isInteger(id)||!p.success)return res.status(400).json({error:"Invalid data"});const departmentId=getActiveDepartmentId(req),current=await certificateAccess(clientId,id,departmentId);if(current==="forbidden")return res.status(403).json({error:"Forbidden"});if(current==="missing")return res.status(404).json({error:"Not found"});const d=p.data,access=await validateCertificateLinks(clientId,departmentId,d);if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(400).json({error:"Invalid linked site, room, contractor or document"});const crossSiteFailure=resultRows(await db.execute(sql`SELECT f.id FROM pat_failures f JOIN pat_rooms r ON r.id=f.room_id AND r.client_id=f.client_id WHERE f.certificate_id=${id} AND f.client_id=${clientId} AND r.site_id<>${d.siteId} LIMIT 1`))[0];if(crossSiteFailure)return res.status(409).json({error:"Certificate site cannot change while linked failures reference rooms at another site"});const row=await db.transaction(async tx=>{const c=resultRows(await tx.execute(sql`UPDATE pat_certificates SET site_id=${d.siteId},visit_date=${d.visitDate},contractor_id=${d.contractorId??null},contractor_name=${d.contractorName??null},certificate_ref=${d.certificateRef},appliances_tested_count=${d.appliancesTestedCount??0},pass_count=${d.passCount??0},fail_count=${d.failCount??0},next_test_due=${d.nextTestDue??null},document_id=${d.documentId??null},document_link=${d.documentLink??null},notes=${d.notes??null},updated_at=now() WHERE id=${id} AND client_id=${clientId} RETURNING *`))[0];if(!c)return null;await tx.execute(sql`DELETE FROM pat_certificate_rooms WHERE certificate_id=${id} AND client_id=${clientId}`);for(const roomId of d.roomIds)await tx.execute(sql`INSERT INTO pat_certificate_rooms (client_id,certificate_id,room_id) VALUES (${clientId},${id},${roomId})`);return c;});if(!row)return res.status(404).json({error:"Not found"});res.json(row);});
router.delete("/certificates/:id",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string);if(!clientId||!Number.isInteger(id))return res.status(400).json({error:"Invalid request"});const access=await certificateAccess(clientId,id,getActiveDepartmentId(req));if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(404).json({error:"Not found"});return res.status(405).json({error:"Certificates are retained as compliance evidence and cannot be deleted"});});

router.get("/replacements",requireAuth,async(req,res)=>{const clientId=getClientId(req);if(!clientId)return res.status(400).json({error:"No client context"});const departmentId=getActiveDepartmentId(req),siteId=await checkedSiteQuery(req,clientId,departmentId);if(siteId===undefined)return res.status(400).json({error:"Invalid siteId for this client"});if(siteId==="forbidden")return res.status(403).json({error:"Forbidden"});res.json(resultRows(await db.execute(sql`SELECT x.*,r.name AS room_name FROM pat_replacements x JOIN pat_rooms r ON r.id=x.room_id AND r.client_id=x.client_id JOIN sites s ON s.id=r.site_id AND s.client_id=r.client_id WHERE x.client_id=${clientId} ${departmentId!==null?sql`AND (s.department_id IS NULL OR s.department_id=${departmentId})`:sql``} ${siteId?sql`AND r.site_id=${siteId}`:sql``} ORDER BY x.replaced_on DESC`)));});
router.post("/replacements",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),p=replacementSchema.safeParse(req.body);if(!clientId||!p.success)return res.status(400).json({error:"Invalid data"});const d=p.data,access=await roomAccess(clientId,d.roomId,getActiveDepartmentId(req));if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(400).json({error:"Room not found"});const row=resultRows(await db.execute(sql`INSERT INTO pat_replacements (client_id,room_id,appliance_name,replaced_on,replacement_details,notes) VALUES (${clientId},${d.roomId},${d.applianceName},${d.replacedOn},${d.replacementDetails??null},${d.notes??null}) RETURNING *`))[0];res.status(201).json(row);});
router.put("/replacements/:id",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string),p=replacementSchema.safeParse(req.body);if(!clientId||!Number.isInteger(id)||!p.success)return res.status(400).json({error:"Invalid data"});const departmentId=getActiveDepartmentId(req),current=await replacementAccess(clientId,id,departmentId);if(current==="forbidden")return res.status(403).json({error:"Forbidden"});if(current==="missing")return res.status(404).json({error:"Not found"});const d=p.data,room=await roomAccess(clientId,d.roomId,departmentId);if(room==="forbidden")return res.status(403).json({error:"Forbidden"});if(room==="missing")return res.status(400).json({error:"Room not found"});const row=resultRows(await db.execute(sql`UPDATE pat_replacements SET room_id=${d.roomId},appliance_name=${d.applianceName},replaced_on=${d.replacedOn},replacement_details=${d.replacementDetails??null},notes=${d.notes??null},updated_at=now() WHERE id=${id} AND client_id=${clientId} RETURNING *`))[0];res.json(row);});
router.delete("/replacements/:id",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string);if(!clientId||!Number.isInteger(id))return res.status(400).json({error:"Invalid request"});const access=await replacementAccess(clientId,id,getActiveDepartmentId(req));if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(404).json({error:"Not found"});return res.status(405).json({error:"Replacement logs are retained as compliance evidence and cannot be deleted"});});

async function validFailureLinks(clientId:number,departmentId:number|null,d:z.infer<typeof failureSchema>):Promise<AccessResult>{const cert=resultRows(await db.execute(sql`SELECT site_id FROM pat_certificates WHERE id=${d.certificateId} AND client_id=${clientId}`))[0];if(!cert)return "missing";const certAccess=await siteAccess(clientId,cert.site_id,departmentId);if(certAccess!=="allowed")return certAccess;if(d.roomId!=null){const roomAccessResult=await roomAccess(clientId,d.roomId,departmentId);if(roomAccessResult!=="allowed")return roomAccessResult;const room=await roomOwned(clientId,d.roomId);if(!room||room.site_id!==cert.site_id)return "missing";}return "allowed";}
router.get("/failures",requireAuth,async(req,res)=>{const clientId=getClientId(req);if(!clientId)return res.status(400).json({error:"No client context"});const departmentId=getActiveDepartmentId(req),siteId=await checkedSiteQuery(req,clientId,departmentId);if(siteId===undefined)return res.status(400).json({error:"Invalid siteId for this client"});if(siteId==="forbidden")return res.status(403).json({error:"Forbidden"});res.json(resultRows(await db.execute(sql`SELECT f.*,c.certificate_ref,c.visit_date,r.name AS room_name FROM pat_failures f JOIN pat_certificates c ON c.id=f.certificate_id AND c.client_id=f.client_id JOIN sites s ON s.id=c.site_id AND s.client_id=c.client_id LEFT JOIN pat_rooms r ON r.id=f.room_id AND r.client_id=f.client_id WHERE f.client_id=${clientId} ${departmentId!==null?sql`AND (s.department_id IS NULL OR s.department_id=${departmentId})`:sql``} ${siteId?sql`AND c.site_id=${siteId}`:sql``} ORDER BY f.resolved_date NULLS FIRST,c.visit_date DESC`)));});
router.post("/failures",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),p=failureSchema.safeParse(req.body);if(!clientId||!p.success)return res.status(400).json({error:"Invalid data"});const d=p.data,access=await validFailureLinks(clientId,getActiveDepartmentId(req),d);if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(400).json({error:"Invalid certificate or room"});const room=d.roomId?await roomOwned(clientId,d.roomId):undefined;const location=d.locationText??(room as any)?.name;const row=resultRows(await db.execute(sql`INSERT INTO pat_failures (client_id,certificate_id,room_id,location_text,room_name_snapshot,appliance_name,action_taken,resolution,resolved_date) VALUES (${clientId},${d.certificateId},${d.roomId??null},${location},${(room as any)?.name??location},${d.applianceName},${d.actionTaken??null},${d.resolution??null},${d.resolvedDate??null}) RETURNING *`))[0];res.status(201).json(row);});
router.put("/failures/:id",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string),p=failureSchema.safeParse(req.body);if(!clientId||!Number.isInteger(id)||!p.success)return res.status(400).json({error:"Invalid data"});const departmentId=getActiveDepartmentId(req),current=await failureAccess(clientId,id,departmentId);if(current==="forbidden")return res.status(403).json({error:"Forbidden"});if(current==="missing")return res.status(404).json({error:"Not found"});const d=p.data,access=await validFailureLinks(clientId,departmentId,d);if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(400).json({error:"Invalid certificate or room"});const room=d.roomId?await roomOwned(clientId,d.roomId):undefined;const location=d.locationText??(room as any)?.name;const row=resultRows(await db.execute(sql`UPDATE pat_failures SET certificate_id=${d.certificateId},room_id=${d.roomId??null},location_text=${location},room_name_snapshot=${(room as any)?.name??location},appliance_name=${d.applianceName},action_taken=${d.actionTaken??null},resolution=${d.resolution??null},resolved_date=${d.resolvedDate??null},updated_at=now() WHERE id=${id} AND client_id=${clientId} RETURNING *`))[0];res.json(row);});
router.delete("/failures/:id",requireAuth,denyViewers,async(req,res)=>{const clientId=getClientId(req),id=Number(req.params.id as string);if(!clientId||!Number.isInteger(id))return res.status(400).json({error:"Invalid request"});const access=await failureAccess(clientId,id,getActiveDepartmentId(req));if(access==="forbidden")return res.status(403).json({error:"Forbidden"});if(access==="missing")return res.status(404).json({error:"Not found"});return res.status(405).json({error:"Failures are retained as compliance evidence and cannot be deleted"});});

// A certificate's explicit next due date overrides the calculated date. In its
// absence, the latest certificate covering the room plus its own interval is
// used; rooms with no coverage are reported as untested.
router.get("/overdue-by-room-area",requireAuth,async(req,res)=>{const clientId=getClientId(req);if(!clientId)return res.status(400).json({error:"No client context"});const departmentId=getActiveDepartmentId(req),siteId=await checkedSiteQuery(req,clientId,departmentId);if(siteId===undefined)return res.status(400).json({error:"Invalid siteId for this client"});if(siteId==="forbidden")return res.status(403).json({error:"Forbidden"});const rows=resultRows(await db.execute(sql`
  SELECT r.id,r.name,r.area_type,r.site_id,r.test_interval_months,r.active,
         latest.visit_date AS last_test_date,latest.certificate_ref,
         COALESCE(latest.next_test_due, latest.visit_date + make_interval(months => r.test_interval_months))::date AS due_date,
         CASE WHEN latest.visit_date IS NULL THEN 'untested' ELSE 'overdue' END AS status,
         CASE WHEN latest.visit_date IS NULL THEN NULL ELSE (CURRENT_DATE - COALESCE(latest.next_test_due, latest.visit_date + make_interval(months => r.test_interval_months))::date) END AS days_overdue
  FROM pat_rooms r JOIN sites s ON s.id=r.site_id AND s.client_id=r.client_id
  LEFT JOIN LATERAL (
    SELECT c.visit_date,c.next_test_due,c.certificate_ref FROM pat_certificate_rooms cr
    JOIN pat_certificates c ON c.id=cr.certificate_id AND c.client_id=cr.client_id
    WHERE cr.room_id=r.id AND cr.client_id=r.client_id ORDER BY c.visit_date DESC,c.id DESC LIMIT 1
  ) latest ON true
  WHERE r.client_id=${clientId} AND r.active=true ${departmentId!==null?sql`AND (s.department_id IS NULL OR s.department_id=${departmentId})`:sql``} ${siteId?sql`AND r.site_id=${siteId}`:sql``}
  AND (latest.visit_date IS NULL OR COALESCE(latest.next_test_due,latest.visit_date + make_interval(months => r.test_interval_months))::date < CURRENT_DATE)
  ORDER BY due_date NULLS FIRST,r.name`));res.json(rows);});

export default router;
