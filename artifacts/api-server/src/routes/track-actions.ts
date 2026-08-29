import { Router } from "express";
import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth } from "../middleware/requireAuth";

const router = Router();

// This deliberately belongs to the operational modules, rather than the
// Compliance Hub data model. Keep it independent of compliance_hub_* tables.
const trackActionsTable = pgTable("track_actions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  siteId: integer("site_id"),
  module: text("module").notNull(),
  sourceKind: text("source_kind"),
  sourceRecordId: integer("source_record_id"),
  title: text("title").notNull(),
  severity: text("severity").notNull(),
  ownerName: text("owner_name"),
  dueDate: date("due_date"),
  remedialAction: text("remedial_action"),
  evidenceReference: text("evidence_reference"),
  resolutionNotes: text("resolution_notes"),
  status: text("status").notNull(),
  createdBy: integer("created_by").notNull(),
  resolvedBy: integer("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

const MODULES = [
  "daily_am", "daily_pm", "kitchen", "fire", "legionella", "pool", "pat",
  "pest", "fix", "premises", "doc", "safe", "train", "hot_tub", "tree",
  "bike", "green", "swim", "incident",
] as const;

const optionalText = z.string().trim().max(10_000).nullable().optional();
const actionFields = {
  siteId: z.number().int().positive().nullable().optional(),
  sourceRecordId: z.number().int().positive().nullable().optional(),
  ownerName: optionalText,
  dueDate: z.string().date().nullable().optional(),
  remedialAction: optionalText,
  evidenceReference: optionalText,
  resolutionNotes: optionalText,
};

const createSchema = z.object({
  module: z.enum(MODULES),
  title: z.string().trim().min(1).max(500),
  severity: z.enum(["monitor", "action_required", "urgent"]).default("action_required"),
  status: z.enum(["open", "in_progress", "resolved"]).default("open"),
  ...actionFields,
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  severity: z.enum(["monitor", "action_required", "urgent"]).optional(),
  status: z.enum(["open", "in_progress", "resolved"]).optional(),
  ...actionFields,
}).strict();

async function canAccessSite(
  siteId: number | null | undefined,
  clientId: number,
  departmentId: number | null,
): Promise<boolean> {
  if (siteId == null) return true;
  const conditions = [eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)];
  if (departmentId != null) {
    conditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))!);
  }
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(and(...conditions));
  return !!site;
}

async function accessibleSiteIds(clientId: number, departmentId: number | null): Promise<number[] | null> {
  if (departmentId == null) return null;
  const sites = await db.select({ id: sitesTable.id }).from(sitesTable).where(and(
    eq(sitesTable.clientId, clientId),
    or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId)),
  ));
  return sites.map((site) => site.id);
}

router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const query = z.object({
    module: z.enum(MODULES),
    siteId: z.coerce.number().int().positive().optional(),
  }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.flatten() });

  const siteIds = await accessibleSiteIds(clientId, getActiveDepartmentId(req));
  const conditions = [
    eq(trackActionsTable.clientId, clientId),
    eq(trackActionsTable.module, query.data.module),
  ];
  if (siteIds) conditions.push(or(isNull(trackActionsTable.siteId), inArray(trackActionsTable.siteId, siteIds))!);
  if (query.data.siteId) {
    // Global actions are relevant in every site's action view.
    conditions.push(or(
      isNull(trackActionsTable.siteId),
      eq(trackActionsTable.siteId, query.data.siteId),
    )!);
  }

  const actions = await db.select().from(trackActionsTable)
    .where(and(...conditions))
    .orderBy(desc(trackActionsTable.createdAt));
  res.json(actions);
});

router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.status === "resolved") {
    return res.status(400).json({ error: "Actions must be resolved via PATCH" });
  }
  if (!await canAccessSite(parsed.data.siteId, clientId, getActiveDepartmentId(req))) {
    return res.status(403).json({ error: "Forbidden site" });
  }

  const [action] = await db.insert(trackActionsTable).values({
    ...parsed.data,
    siteId: parsed.data.siteId ?? null,
    sourceRecordId: parsed.data.sourceRecordId ?? null,
    ownerName: parsed.data.ownerName ?? null,
    dueDate: parsed.data.dueDate ?? null,
    remedialAction: parsed.data.remedialAction ?? null,
    evidenceReference: parsed.data.evidenceReference ?? null,
    resolutionNotes: parsed.data.resolutionNotes ?? null,
    clientId,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(action);
});

router.patch("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (Object.keys(parsed.data).length === 0) return res.status(400).json({ error: "No changes supplied" });

  const [current] = await db.select().from(trackActionsTable).where(and(
    eq(trackActionsTable.id, id),
    eq(trackActionsTable.clientId, clientId),
  ));
  if (!current) return res.status(404).json({ error: "Action not found" });
  const departmentId = getActiveDepartmentId(req);
  if (!await canAccessSite(current.siteId, clientId, departmentId)) {
    return res.status(403).json({ error: "Forbidden site" });
  }
  if (current.status === "resolved") {
    return res.status(409).json({ error: "Resolved actions cannot be edited or reopened" });
  }
  if ("siteId" in parsed.data && !await canAccessSite(parsed.data.siteId, clientId, departmentId)) {
    return res.status(403).json({ error: "Forbidden site" });
  }

  const nextStatus = parsed.data.status ?? current.status;
  if (nextStatus === "resolved") {
    const nonblank = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;
    if (!nonblank(parsed.data.remedialAction ?? current.remedialAction)
      || !nonblank(parsed.data.evidenceReference ?? current.evidenceReference)
      || !nonblank(parsed.data.resolutionNotes ?? current.resolutionNotes)) {
      return res.status(400).json({
        error: "remedialAction, evidenceReference and resolutionNotes are required to resolve an action",
      });
    }
  }

  const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (nextStatus === "resolved") {
    updates.resolvedBy = req.currentUser!.id;
    updates.resolvedAt = new Date();
  }
  const [action] = await db.update(trackActionsTable).set(updates as any)
    // The pre-read is needed for site access and resolution validation, but
    // this predicate is the authoritative immutability guard under races.
    .where(and(
      eq(trackActionsTable.id, id),
      eq(trackActionsTable.clientId, clientId),
      ne(trackActionsTable.status, "resolved"),
    ))
    .returning();
  if (!action) return res.status(409).json({ error: "Resolved actions cannot be edited or reopened" });
  res.json(action);
});

export default router;