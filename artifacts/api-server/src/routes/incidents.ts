import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  incidentsTable, sitesTable, appSettingsTable,
  INCIDENT_STATUSES, EMPLOYMENT_TYPES,
} from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";

const router = Router();

const createSchema = z.object({
  // incidentType/severity are validated against the client's effective option
  // list at request time (custom or default) rather than a fixed enum, so each
  // client can customise these vocabularies. Kept as trimmed strings here.
  incidentType: z.string().min(1).max(60).default("accident"),
  severity: z.string().min(1).max(60).default("minor"),
  status: z.enum(INCIDENT_STATUSES).default("open"),
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  incidentTime: z.string().max(10).nullable().optional(),
  location: z.string().min(1).max(500),
  description: z.string().min(1).max(10000),
  involvedName: z.string().min(1).max(200),
  involvedJobTitle: z.string().max(200).nullable().optional(),
  involvedEmploymentType: z.enum(EMPLOYMENT_TYPES).default("employee"),
  injuriesSustained: z.string().max(5000).nullable().optional(),
  firstAidGiven: z.boolean().default(false),
  firstAiderName: z.string().max(200).nullable().optional(),
  witnesses: z.string().max(2000).nullable().optional(),
  riddorReportable: z.boolean().default(false),
  reportedToHse: z.boolean().default(false),
  hseReference: z.string().max(200).nullable().optional(),
  hseReportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  immediateActions: z.string().max(5000).nullable().optional(),
  correctiveActions: z.string().max(5000).nullable().optional(),
  reportedBy: z.string().min(1).max(200),
  siteId: z.number().int().nullable().optional(),
});

const updateSchema = createSchema.partial();

function allowedSites(clientId: number, deptId: number) {
  return db.select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
    ));
}

// GET /api/incidents
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { status, severity, incidentType, siteId, riddorOnly } = req.query as Record<string, string>;
  const conditions: any[] = [eq(incidentsTable.clientId, clientId)];

  if (status && (INCIDENT_STATUSES as readonly string[]).includes(status))
    conditions.push(eq(incidentsTable.status, status));
  // severity/incidentType filters are free-form (per-client customisable),
  // so accept any non-empty value and let the equality match narrow results.
  if (severity)
    conditions.push(eq(incidentsTable.severity, severity));
  if (incidentType)
    conditions.push(eq(incidentsTable.incidentType, incidentType));
  if (siteId && !isNaN(parseInt(siteId)))
    conditions.push(eq(incidentsTable.siteId, parseInt(siteId)));
  if (riddorOnly === "true")
    conditions.push(eq(incidentsTable.riddorReportable, true));

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(incidentsTable.siteId), inArray(incidentsTable.siteId, allowedSites(clientId, deptId))) as any,
    );
  }

  const rows = await db.select().from(incidentsTable)
    .where(and(...conditions))
    .orderBy(desc(incidentsTable.incidentDate), desc(incidentsTable.id));

  res.json(rows);
});

// GET /api/incidents/summary
router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int                                                           AS total,
      COUNT(*) FILTER (WHERE status = 'open')::int                           AS open_count,
      COUNT(*) FILTER (WHERE status = 'under_investigation')::int            AS investigating_count,
      COUNT(*) FILTER (WHERE riddor_reportable = true)::int                  AS riddor_count,
      COUNT(*) FILTER (WHERE riddor_reportable = true AND reported_to_hse = false)::int AS riddor_outstanding,
      COUNT(*) FILTER (WHERE incident_date >= date_trunc('month', now()))::int AS this_month,
      COUNT(*) FILTER (WHERE severity IN ('serious','fatal'))::int           AS serious_count
    FROM incidents
    WHERE client_id = ${clientId}
  `);

  const row = ((result.rows ?? [])[0] ?? {}) as Record<string, number>;
  res.json({
    total:              row.total              ?? 0,
    openCount:          row.open_count         ?? 0,
    investigatingCount: row.investigating_count ?? 0,
    riddorCount:        row.riddor_count        ?? 0,
    riddorOutstanding:  row.riddor_outstanding  ?? 0,
    thisMonth:          row.this_month          ?? 0,
    seriousCount:       row.serious_count       ?? 0,
  });
});

// POST /api/incidents
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", issues: parsed.error.issues });
  const data = parsed.data;

  const [allowedTypes, allowedSeverities] = await Promise.all([
    getEffectiveOptionList(clientId, "incident_types"),
    getEffectiveOptionList(clientId, "incident_severities"),
  ]);
  if (!allowedTypes.includes(data.incidentType)) return res.status(400).json({ error: "Invalid incident type" });
  if (!allowedSeverities.includes(data.severity)) return res.status(400).json({ error: "Invalid severity" });

  if (data.siteId) {
    const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
      .where(and(eq(sitesTable.id, data.siteId), eq(sitesTable.clientId, clientId))).limit(1);
    if (!site) return res.status(400).json({ error: "Invalid site" });
  }

  const [inserted] = await db.insert(incidentsTable).values({
    clientId,
    ...data,
    createdBy: (req as any).currentUser?.id ?? null,
  }).returning();

  res.status(201).json(inserted);
});

// PUT /api/incidents/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select({
    id: incidentsTable.id,
    incidentType: incidentsTable.incidentType,
    severity: incidentsTable.severity,
  }).from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  // Allow a value that is unchanged from the stored record even if it is no
  // longer in the client's effective list (so editing other fields doesn't
  // force changing a now-removed type); reject only NEW values not in the list.
  if (parsed.data.incidentType !== undefined && parsed.data.incidentType !== existing.incidentType) {
    const allowedTypes = await getEffectiveOptionList(clientId, "incident_types");
    if (!allowedTypes.includes(parsed.data.incidentType)) return res.status(400).json({ error: "Invalid incident type" });
  }
  if (parsed.data.severity !== undefined && parsed.data.severity !== existing.severity) {
    const allowedSeverities = await getEffectiveOptionList(clientId, "incident_severities");
    if (!allowedSeverities.includes(parsed.data.severity)) return res.status(400).json({ error: "Invalid severity" });
  }

  const [updated] = await db.update(incidentsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId)))
    .returning();

  res.json(updated);
});

// DELETE /api/incidents/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select({ id: incidentsTable.id }).from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  await db.delete(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId)));
  res.status(204).end();
});

// ── Template config ───────────────────────────────────────────────────────────
const INCIDENT_CONFIG_KEYS = [
  "incident_locations",          // JSON: string[]
  "incident_departments",        // JSON: string[]
  "incident_default_reporter",
  "incident_show_investigation", // "true"|"false"
] as const;

const INCIDENT_DEFAULT_CONFIG = {
  incident_locations: "",
  incident_departments: "",
  incident_default_reporter: "",
  incident_show_investigation: "true",
};

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...INCIDENT_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (INCIDENT_CONFIG_KEYS.includes(row.key as (typeof INCIDENT_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  res.json(config);
});

router.put("/config", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updates = req.body as Record<string, string>;
  for (const key of INCIDENT_CONFIG_KEYS) {
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
