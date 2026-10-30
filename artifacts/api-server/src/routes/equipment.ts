import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { EQUIPMENT_LABEL_KINDS, EQUIPMENT_TYPES } from "@workspace/db/schema";
import {
  requireAuth, requireRole, denyViewers, getClientId, getActiveDepartmentId, canAccessClient,
} from "../middleware/requireAuth";
import { getEntitledServices, isEntitled } from "../lib/services";
import { siteVisibleToDepartment } from "../lib/departmentSites";
import { appendAuditEvent } from "../lib/audit";
import { getPublicAppUrl } from "../lib/email";
import {
  EQUIPMENT_TYPE_LABELS, KIND_INFO, activeLabels, buildScanSummary, ensureLabels, findActiveLabel, findLabelTarget,
  isLabelKind, listLabelTargets, normaliseLabelCode, replaceLabel, targetTrack, type LabelTarget,
} from "../lib/equipmentLabels";
import { createEquipmentLabelPdf } from "../lib/equipmentLabelPdf";

/**
 * The equipment list (plant no track keeps a record of) and QR labels for
 * every labelled item and for each track's checks at each site. Owners, consultants and Managers keep the list and
 * print labels; anyone signed in (Viewers excepted) can open a scanned label
 * for an item they are allowed to see.
 */
const router = Router();
const requireManager = requireRole("consultant", "client_admin", "client_manager");

type Row = Record<string, any>;
const rowsOf = (result: unknown) => ((result as { rows?: Row[] }).rows ?? []) as Row[];

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform(v => (v ? v : null));
const itemBody = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(EQUIPMENT_TYPES),
  siteId: z.number().int().positive().nullable().optional(),
  location: text(300),
  make: text(200),
  model: text(200),
  serialNo: text(200),
  notes: text(5000),
  active: z.boolean().optional(),
  /** Compliance Checks for this item (gas safety, LOLER, service). */
  complianceItemIds: z.array(z.number().int().positive()).max(50).optional(),
});

/** A site id from a body or query: the caller's own site, visible to their department. */
async function siteAllowed(req: Request, clientId: number, siteId: number | null | undefined): Promise<"ok" | "invalid" | "forbidden"> {
  if (siteId == null) return "ok";
  const [site] = rowsOf(await db.execute(sql`SELECT id, department_id FROM sites WHERE id = ${siteId} AND client_id = ${clientId}`));
  if (!site) return "invalid";
  const visible = await siteVisibleToDepartment({ id: Number(site.id), departmentId: site.department_id ?? null }, getActiveDepartmentId(req));
  return visible ? "ok" : "forbidden";
}

function siteQuery(raw: unknown): number | "none" | null | undefined {
  if (raw === undefined || raw === "") return null;
  if (raw === "none") return "none";
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function linkedChecks(clientId: number, equipmentIds: number[]): Promise<Map<number, Array<{ id: number; title: string }>>> {
  const map = new Map<number, Array<{ id: number; title: string }>>();
  if (!equipmentIds.length) return map;
  const rows = rowsOf(await db.execute(sql`
    SELECT id, title, equipment_id FROM compliance_items
    WHERE client_id = ${clientId} AND equipment_id IN (${sql.join(equipmentIds.map(id => sql`${id}`), sql`, `)})
    ORDER BY title, id`));
  for (const row of rows) {
    const list = map.get(Number(row.equipment_id)) ?? [];
    list.push({ id: Number(row.id), title: row.title });
    map.set(Number(row.equipment_id), list);
  }
  return map;
}

/** Point the given Compliance Checks at this item, and only those. */
async function setLinkedChecks(req: Request, clientId: number, equipmentId: number, ids: number[]): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (unique.length) {
    const found = rowsOf(await db.execute(sql`
      SELECT id, site_id FROM compliance_items
      WHERE client_id = ${clientId} AND id IN (${sql.join(unique.map(id => sql`${id}`), sql`, `)})`));
    if (found.length !== unique.length) return "One of the Compliance Checks was not found";
    for (const item of found) {
      if ((await siteAllowed(req, clientId, item.site_id)) !== "ok") return "One of the Compliance Checks is at a site you cannot see";
    }
  }
  await db.execute(sql`
    UPDATE compliance_items SET equipment_id = NULL
    WHERE client_id = ${clientId} AND equipment_id = ${equipmentId}
      ${unique.length ? sql`AND id NOT IN (${sql.join(unique.map(id => sql`${id}`), sql`, `)})` : sql``}`);
  if (unique.length) {
    await db.execute(sql`
      UPDATE compliance_items SET equipment_id = ${equipmentId}
      WHERE client_id = ${clientId} AND id IN (${sql.join(unique.map(id => sql`${id}`), sql`, `)})`);
  }
  return null;
}

async function itemResponse(clientId: number, departmentId: number | null, id: number) {
  const services = await getEntitledServices(clientId);
  const [target] = await listLabelTargets(clientId, departmentId, services, { siteId: null, ref: String(id), includeArchived: true }, ["equipment"]);
  if (!target) return null;
  const [row] = rowsOf(await db.execute(sql`SELECT * FROM equipment_items WHERE id = ${id} AND client_id = ${clientId}`));
  const links = await linkedChecks(clientId, [id]);
  const labels = await activeLabels(clientId);
  return serialiseItem(row, target.siteName, links.get(id) ?? [], labels.get(`equipment:${id}`)?.code ?? null);
}

function serialiseItem(row: Row, siteName: string | null, complianceItems: Array<{ id: number; title: string }>, labelCode: string | null) {
  return {
    id: Number(row.id), siteId: row.site_id ?? null, siteName, name: row.name, type: row.type,
    typeLabel: EQUIPMENT_TYPE_LABELS[row.type as keyof typeof EQUIPMENT_TYPE_LABELS] ?? "Other equipment",
    location: row.location, make: row.make, model: row.model, serialNo: row.serial_no, notes: row.notes,
    active: row.active, complianceItems, labelCode,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ── Equipment list ───────────────────────────────────────────────────────────

router.get("/equipment", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = siteQuery(req.query.siteId);
  if (siteId === undefined) return res.status(400).json({ error: "Invalid site" });
  if (typeof siteId === "number") {
    const access = await siteAllowed(req, clientId, siteId);
    if (access !== "ok") return res.status(access === "invalid" ? 400 : 403).json({ error: "Site not accessible" });
  }
  const departmentId = getActiveDepartmentId(req);
  const services = await getEntitledServices(clientId);
  const targets = await listLabelTargets(clientId, departmentId, services,
    { siteId, includeArchived: req.query.includeArchived === "true" }, ["equipment"]);
  const ids = targets.map(t => Number(t.ref));
  const rows = ids.length ? rowsOf(await db.execute(sql`
    SELECT * FROM equipment_items WHERE client_id = ${clientId} AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`)) : [];
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const links = await linkedChecks(clientId, ids);
  const labels = await activeLabels(clientId);
  res.json(targets.map(t => serialiseItem(byId.get(Number(t.ref))!, t.siteName, links.get(Number(t.ref)) ?? [],
    labels.get(`equipment:${t.ref}`)?.code ?? null)));
});

router.post("/equipment", requireAuth, denyViewers, requireManager, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = itemBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the item a name and a type" });
  const data = parsed.data;
  const access = await siteAllowed(req, clientId, data.siteId);
  if (access !== "ok") return res.status(access === "invalid" ? 400 : 403).json({ error: "Invalid site" });
  const [row] = rowsOf(await db.execute(sql`
    INSERT INTO equipment_items (client_id, site_id, name, type, location, make, model, serial_no, notes, active, created_by)
    VALUES (${clientId}, ${data.siteId ?? null}, ${data.name}, ${data.type}, ${data.location}, ${data.make}, ${data.model},
      ${data.serialNo}, ${data.notes}, ${data.active ?? true}, ${req.currentUser!.id})
    RETURNING *`));
  if (data.complianceItemIds) {
    const error = await setLinkedChecks(req, clientId, Number(row.id), data.complianceItemIds);
    if (error) {
      await db.execute(sql`DELETE FROM equipment_items WHERE id = ${row.id} AND client_id = ${clientId}`);
      return res.status(400).json({ error });
    }
  }
  await appendAuditEvent(req, { clientId, entityType: "equipment_item", entityId: Number(row.id), action: "created", after: row });
  res.status(201).json(await itemResponse(clientId, getActiveDepartmentId(req), Number(row.id)));
});

router.put("/equipment/:id", requireAuth, denyViewers, requireManager, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId || !Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid request" });
  const departmentId = getActiveDepartmentId(req);
  const target = await findLabelTarget(clientId, departmentId, "equipment", String(id));
  if (!target) return res.status(404).json({ error: "Not found" });
  const parsed = itemBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  if (data.siteId !== undefined) {
    const access = await siteAllowed(req, clientId, data.siteId);
    if (access !== "ok") return res.status(access === "invalid" ? 400 : 403).json({ error: "Invalid site" });
  }
  const [before] = rowsOf(await db.execute(sql`SELECT * FROM equipment_items WHERE id = ${id} AND client_id = ${clientId}`));
  const keep = <T,>(value: T | undefined, current: T) => (value === undefined ? current : value);
  const [after] = rowsOf(await db.execute(sql`
    UPDATE equipment_items SET
      name = ${keep(data.name, before.name)}, type = ${keep(data.type, before.type)},
      site_id = ${keep(data.siteId, before.site_id)}, location = ${keep(data.location, before.location)},
      make = ${keep(data.make, before.make)}, model = ${keep(data.model, before.model)},
      serial_no = ${keep(data.serialNo, before.serial_no)}, notes = ${keep(data.notes, before.notes)},
      active = ${keep(data.active, before.active)}, updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *`));
  if (data.complianceItemIds) {
    const error = await setLinkedChecks(req, clientId, id, data.complianceItemIds);
    if (error) return res.status(400).json({ error });
  }
  await appendAuditEvent(req, { clientId, entityType: "equipment_item", entityId: id, action: "updated", before, after });
  res.json(await itemResponse(clientId, departmentId, id));
});

/** FireTrack's extinguisher list, copied onto a site's equipment list. */
router.post("/equipment/import-extinguishers", requireAuth, denyViewers, requireManager, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = req.body?.siteId == null ? null : Number(req.body.siteId);
  if (siteId !== null && (!Number.isSafeInteger(siteId) || siteId < 1)) return res.status(400).json({ error: "Invalid site" });
  const access = await siteAllowed(req, clientId, siteId);
  if (access !== "ok") return res.status(access === "invalid" ? 400 : 403).json({ error: "Invalid site" });
  const [setting] = rowsOf(await db.execute(sql`
    SELECT value FROM app_settings WHERE client_id = ${clientId} AND key = 'fire_extinguisher_points' LIMIT 1`));
  let names: string[] = [];
  try {
    const parsed = JSON.parse(setting?.value || "[]");
    if (Array.isArray(parsed)) names = parsed.filter((n): n is string => typeof n === "string").map(n => n.trim()).filter(Boolean).slice(0, 200);
  } catch { /* nothing to import */ }
  const existing = rowsOf(await db.execute(sql`
    SELECT lower(name) AS name FROM equipment_items
    WHERE client_id = ${clientId} AND type = 'fire_extinguisher'
      AND ${siteId === null ? sql`site_id IS NULL` : sql`site_id = ${siteId}`}`)).map(r => r.name as string);
  const seen = new Set(existing);
  let added = 0;
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const [row] = rowsOf(await db.execute(sql`
      INSERT INTO equipment_items (client_id, site_id, name, type, created_by)
      VALUES (${clientId}, ${siteId}, ${name.slice(0, 200)}, 'fire_extinguisher', ${req.currentUser!.id}) RETURNING *`));
    await appendAuditEvent(req, { clientId, entityType: "equipment_item", entityId: Number(row.id), action: "created", after: row, metadata: { source: "fire_extinguisher_points" } });
    added++;
  }
  res.json({ added, alreadyListed: names.length - added });
});

// ── Labels ───────────────────────────────────────────────────────────────────

const labelRef = z.object({ kind: z.enum(EQUIPMENT_LABEL_KINDS), ref: z.string().min(1).max(100) });

function labelUrl(code: string) {
  return `${getPublicAppUrl().replace(/\/$/, "")}/q/${code}`;
}

function targetRow(target: LabelTarget, code: string | null) {
  return {
    kind: target.kind, ref: target.ref, track: targetTrack(target), name: target.name, detail: target.detail,
    siteId: target.siteId, siteName: target.siteName, code, url: code ? labelUrl(code) : null,
  };
}

/** Everything at a site that can carry a label, with its code once it has one. */
router.get("/equipment-labels", requireAuth, denyViewers, requireManager, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = siteQuery(req.query.siteId);
  if (siteId === undefined) return res.status(400).json({ error: "Invalid site" });
  if (typeof siteId === "number") {
    const access = await siteAllowed(req, clientId, siteId);
    if (access !== "ok") return res.status(access === "invalid" ? 400 : 403).json({ error: "Site not accessible" });
  }
  const services = await getEntitledServices(clientId);
  const targets = await listLabelTargets(clientId, getActiveDepartmentId(req), services, { siteId });
  const labels = await activeLabels(clientId);
  res.json(targets.map(t => targetRow(t, labels.get(`${t.kind}:${t.ref}`)?.code ?? null)));
});

/** A PDF sheet of labels; items without a code get one now. */
router.post("/equipment-labels/sheet", requireAuth, denyViewers, requireManager, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = z.object({
    items: z.array(labelRef).min(1).max(500),
    size: z.enum(["standard", "large"]).default("standard"),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose at least one item to print" });
  const departmentId = getActiveDepartmentId(req);
  const targets: LabelTarget[] = [];
  for (const item of parsed.data.items) {
    const target = await findLabelTarget(clientId, departmentId, item.kind, item.ref);
    if (!target) return res.status(404).json({ error: "One of the items was not found" });
    targets.push(target);
  }
  const labels = await ensureLabels(clientId, req.currentUser!.id, targets);
  const [client] = rowsOf(await db.execute(sql`SELECT name FROM clients WHERE id = ${clientId}`));
  const pdf = await createEquipmentLabelPdf(targets.map(t => {
    const code = labels.get(`${t.kind}:${t.ref}`)!.code;
    return { code, url: labelUrl(code), name: t.name, track: targetTrack(t), siteName: t.siteName };
  }), parsed.data.size, client?.name ?? "ComplyTrack");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="equipment-labels.pdf"`);
  res.setHeader("Content-Length", pdf.length);
  res.send(pdf);
});

/** A lost or damaged label: its old code stops working and the item gets a new one. */
router.post("/equipment-labels/replace", requireAuth, denyViewers, requireManager, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = labelRef.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid item" });
  const target = await findLabelTarget(clientId, getActiveDepartmentId(req), parsed.data.kind, parsed.data.ref);
  if (!target) return res.status(404).json({ error: "Not found" });
  const label = await replaceLabel(clientId, req.currentUser!.id, target.kind, target.ref);
  await appendAuditEvent(req, {
    clientId, entityType: "equipment_label", entityId: label.id, action: "replaced",
    metadata: { kind: target.kind, ref: target.ref, name: target.name },
  });
  res.json(targetRow(target, label.code));
});

function notAvailable(res: Response) {
  // One answer for a made-up code, a replaced label, another business's label
  // or an item the caller cannot see, so a scan never reveals anything.
  return res.status(404).json({ error: "This label isn't available to you", code: "LABEL_NOT_AVAILABLE" });
}

/** What a scanned label shows. */
router.get("/equipment-labels/scan/:code", requireAuth, denyViewers, async (req, res) => {
  const code = normaliseLabelCode(req.params.code);
  if (!code) return notAvailable(res);
  const label = await findActiveLabel(code);
  if (!label || !isLabelKind(label.kind) || !canAccessClient(req, label.clientId)) return notAvailable(res);
  const services = await getEntitledServices(label.clientId);
  const service = KIND_INFO[label.kind].service;
  if (service && !isEntitled(services, service)) return notAvailable(res);
  const target = await findLabelTarget(label.clientId, getActiveDepartmentId(req), label.kind, label.targetRef);
  if (!target) return notAvailable(res);
  const role = req.currentUser!.role;
  res.json(await buildScanSummary(code, label.clientId, target, {
    canRecord: true,
    canAdmin: role === "consultant" || role === "client_admin",
    services,
  }));
});

export default router;
