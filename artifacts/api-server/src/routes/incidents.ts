import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  incidentsTable, incidentRiddorEventsTable, sitesTable, appSettingsTable, usersTable,
  INCIDENT_STATUSES, EMPLOYMENT_TYPES,
} from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";
import { appendAuditEvent } from "../lib/audit";

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
  riddorRationale: z.string().max(5000).nullable().optional(),
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

async function canAccessSite(clientId: number, siteId: number | null | undefined, deptId: number | null) {
  if (siteId == null) return true;
  const [site] = await db.select({ departmentId: sitesTable.departmentId }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  if (!site) return false;
  return deptId === null || site.departmentId === null || site.departmentId === deptId;
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

  const deptId = getActiveDepartmentId(req);
  const deptClause = deptId !== null ? sql`
    AND (site_id IS NULL OR site_id IN (
      SELECT id FROM sites WHERE client_id = ${clientId}
      AND (department_id IS NULL OR department_id = ${deptId})
    ))` : sql``;
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
    WHERE client_id = ${clientId} ${deptClause}
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

  if (!await canAccessSite(clientId, data.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Invalid or inaccessible site" });

  const { riddorRationale, ...incidentData } = data;
  const inserted = await db.transaction(async (tx) => {
    const [incident] = await tx.insert(incidentsTable).values({
      clientId, ...incidentData, createdBy: (req as any).currentUser?.id ?? null,
    }).returning();
    await tx.insert(incidentRiddorEventsTable).values({
      clientId, incidentId: incident.id, eventType: "decision", actorId: (req as any).currentUser?.id ?? null,
      riddorReportable: incident.riddorReportable, reportedToHse: incident.reportedToHse,
      rationale: riddorRationale ?? null, hseReference: incident.hseReference, hseReportDate: incident.hseReportDate,
    });
    return incident;
  });
  await appendAuditEvent(req, { clientId, entityType: "incident", entityId: inserted.id, action: "created", after: inserted });

  res.status(201).json(inserted);
});

// PUT /api/incidents/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, existing.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Forbidden" });

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

  if ("siteId" in parsed.data && !await canAccessSite(clientId, parsed.data.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Invalid or inaccessible site" });
  const { riddorRationale, ...updateData } = parsed.data;
  const riddorChanged = ["riddorReportable", "reportedToHse", "hseReference", "hseReportDate"]
    .some(k => k in updateData && (updateData as any)[k] !== (existing as any)[k]);
  const updated = await db.transaction(async (tx) => {
    const [incident] = await tx.update(incidentsTable)
      .set({ ...updateData, updatedAt: new Date() })
      .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).returning();
    if (riddorChanged || riddorRationale) {
      await tx.insert(incidentRiddorEventsTable).values({
        clientId, incidentId: id, eventType: incident.reportedToHse ? "submission" : "decision",
        actorId: (req as any).currentUser?.id ?? null, riddorReportable: incident.riddorReportable,
        reportedToHse: incident.reportedToHse, rationale: riddorRationale ?? null,
        hseReference: incident.hseReference, hseReportDate: incident.hseReportDate,
      });
    }
    return incident;
  });
  await appendAuditEvent(req, { clientId, entityType: "incident", entityId: id, action: "updated", before: existing, after: updated });
  res.json(updated);
});

// DELETE /api/incidents/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, existing.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Forbidden" });

  // Incidents have a statutory decision/submission trail. Do not allow an API
  // delete to silently destroy that trail; retain the record for export/audit.
  return res.status(409).json({ error: "Incident records with compliance history cannot be deleted" });
});

// Decision/submission events are intentionally insert-only. Current incident
// fields remain available for existing consumers, while this endpoint retains
// the legally useful sequence of assessments and HSE references.
router.get("/:id/riddor-history", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id)) return res.status(400).json({ error: "Invalid request" });
  const [incident] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!incident) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, incident.siteId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Forbidden" });
  res.json(await db.select({
    id: incidentRiddorEventsTable.id,
    eventType: incidentRiddorEventsTable.eventType,
    riddorReportable: incidentRiddorEventsTable.riddorReportable,
    reportedToHse: incidentRiddorEventsTable.reportedToHse,
    rationale: incidentRiddorEventsTable.rationale,
    hseReference: incidentRiddorEventsTable.hseReference,
    hseReportDate: incidentRiddorEventsTable.hseReportDate,
    createdAt: incidentRiddorEventsTable.createdAt,
    actorName: usersTable.name,
    actorEmail: usersTable.email,
  }).from(incidentRiddorEventsTable)
    .leftJoin(usersTable, eq(incidentRiddorEventsTable.actorId, usersTable.id))
    .where(and(eq(incidentRiddorEventsTable.clientId, clientId), eq(incidentRiddorEventsTable.incidentId, id)))
    .orderBy(desc(incidentRiddorEventsTable.createdAt), desc(incidentRiddorEventsTable.id)));
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
