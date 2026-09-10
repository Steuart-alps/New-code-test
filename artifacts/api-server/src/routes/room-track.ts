import { Router } from "express";
import { db } from "@workspace/db";
import { roomTrackChecksTable, roomTrackRoomsTable, sitesTable } from "@workspace/db/schema";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getActiveDepartmentId, getClientId, requireAuth, requireClientAdmin, denyViewers } from "../middleware/requireAuth";
import { resolveStaffPerformer as resolveStaffRoster, resolveStaffPerformerUpdate } from "../lib/staffPerformer";

const router = Router();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const RoomBody = z.object({
  roomNumber: z.string().trim().min(1).max(100),
  name: z.string().trim().max(200).optional().nullable(),
  floor: z.string().trim().max(100).optional().nullable(),
  siteId: z.number().int().positive().optional().nullable(),
  active: z.boolean().optional(),
  notes: z.string().max(5000).optional().nullable(),
});
const CheckCreateBody = z.object({
  roomId: z.number().int().positive(),
  siteId: z.number().int().positive().optional().nullable(),
  checkDate: dateString,
  clean: z.boolean().optional().default(false),
  tidy: z.boolean().optional().default(false),
  toStandard: z.boolean().optional().default(false),
  notes: z.string().max(5000).optional().nullable(),
  checkedBy: z.string().trim().max(200).optional().nullable(),
  checkedByRosterId: z.number().int().positive().optional().nullable(),
});
const CheckUpdateBody = CheckCreateBody.partial().omit({ roomId: true, checkDate: true }).extend({
  roomId: z.number().int().positive().optional(),
  checkDate: dateString.optional(),
});

function postgresErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate?.code ?? candidate?.cause?.code;
}

async function allowedSites(clientId: number, departmentId: number | null): Promise<number[] | null> {
  if (departmentId === null) return null;
  const found = await db.select({ id: sitesTable.id }).from(sitesTable).where(and(
    eq(sitesTable.clientId, clientId),
    or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId)),
  ));
  return found.map((site) => site.id);
}

function scopedSite(column: typeof roomTrackRoomsTable.siteId | typeof roomTrackChecksTable.siteId, siteIds: number[] | null) {
  return siteIds === null ? undefined : (siteIds.length ? or(isNull(column), inArray(column, siteIds)) : isNull(column));
}

async function validSite(siteId: number | null | undefined, clientId: number, siteIds: number[] | null): Promise<boolean> {
  if (siteId == null) return true;
  if (siteIds !== null && !siteIds.includes(siteId)) return false;
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!site;
}

async function getScopedRoom(id: number, clientId: number, siteIds: number[] | null) {
  const scope = scopedSite(roomTrackRoomsTable.siteId, siteIds);
  const conditions = [eq(roomTrackRoomsTable.id, id), eq(roomTrackRoomsTable.clientId, clientId)];
  if (scope) conditions.push(scope);
  const [room] = await db.select().from(roomTrackRoomsTable).where(and(...conditions)).limit(1);
  return room;
}

// Rooms are a manager-maintained registry.
router.get("/rooms", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  const requestedSite = req.query.siteId ? Number(req.query.siteId) : null;
  if (req.query.siteId && (!Number.isInteger(requestedSite) || !(await validSite(requestedSite, clientId, siteIds)))) {
    return res.status(403).json({ error: "Site is not available in the current department" });
  }
  const conditions = [eq(roomTrackRoomsTable.clientId, clientId)];
  if (requestedSite) conditions.push(eq(roomTrackRoomsTable.siteId, requestedSite));
  else {
    const scope = scopedSite(roomTrackRoomsTable.siteId, siteIds);
    if (scope) conditions.push(scope);
  }
  if (req.query.active !== undefined) conditions.push(eq(roomTrackRoomsTable.active, req.query.active === "true"));
  res.json(await db.select().from(roomTrackRoomsTable).where(and(...conditions)).orderBy(roomTrackRoomsTable.floor, roomTrackRoomsTable.roomNumber));
});

router.get("/rooms/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const room = await getScopedRoom(id, clientId, await allowedSites(clientId, getActiveDepartmentId(req)));
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json(room);
});

router.post("/rooms", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const body = RoomBody.safeParse(req.body); if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  if (!(await validSite(body.data.siteId, clientId, siteIds))) return res.status(403).json({ error: "Invalid siteId for this client or department" });
  const [room] = await db.insert(roomTrackRoomsTable).values({ ...body.data, clientId, siteId: body.data.siteId ?? null, name: body.data.name ?? null, floor: body.data.floor ?? null, notes: body.data.notes ?? null, active: body.data.active ?? true, createdBy: req.currentUser!.id, updatedBy: req.currentUser!.id }).returning();
  res.status(201).json(room);
});

router.put("/rooms/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const body = RoomBody.safeParse(req.body); if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  if (!await getScopedRoom(id, clientId, siteIds)) return res.status(404).json({ error: "Room not found" });
  if (!(await validSite(body.data.siteId, clientId, siteIds))) return res.status(403).json({ error: "Invalid siteId for this client or department" });
  const [room] = await db.update(roomTrackRoomsTable).set({ ...body.data, siteId: body.data.siteId ?? null, name: body.data.name ?? null, floor: body.data.floor ?? null, notes: body.data.notes ?? null, updatedBy: req.currentUser!.id, updatedAt: new Date() }).where(and(eq(roomTrackRoomsTable.id, id), eq(roomTrackRoomsTable.clientId, clientId))).returning();
  res.json(room);
});

router.delete("/rooms/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const room = await getScopedRoom(id, clientId, await allowedSites(clientId, getActiveDepartmentId(req)));
  if (!room) return res.status(404).json({ error: "Room not found" });
  // Checks are an audit history. Archive the registry entry rather than
  // deleting it (and consequently activating the database cascade).
  const [archived] = await db.update(roomTrackRoomsTable)
    .set({ active: false, updatedBy: req.currentUser!.id, updatedAt: new Date() })
    .where(and(eq(roomTrackRoomsTable.id, id), eq(roomTrackRoomsTable.clientId, clientId)))
    .returning();
  res.json(archived);
});

router.get("/checks", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  const conditions = [eq(roomTrackChecksTable.clientId, clientId)];
  const scope = scopedSite(roomTrackChecksTable.siteId, siteIds); if (scope) conditions.push(scope);
  const { date, from, to, roomId } = req.query as Record<string, string>;
  if (date) conditions.push(eq(roomTrackChecksTable.checkDate, date));
  if (from) conditions.push(gte(roomTrackChecksTable.checkDate, from));
  if (to) conditions.push(lte(roomTrackChecksTable.checkDate, to));
  if (roomId && Number.isInteger(Number(roomId))) conditions.push(eq(roomTrackChecksTable.roomId, Number(roomId)));
  res.json(await db.select().from(roomTrackChecksTable).where(and(...conditions)).orderBy(desc(roomTrackChecksTable.checkDate), desc(roomTrackChecksTable.id)));
});

router.get("/checks/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  const scope = scopedSite(roomTrackChecksTable.siteId, siteIds);
  const conditions = [eq(roomTrackChecksTable.id, id), eq(roomTrackChecksTable.clientId, clientId)]; if (scope) conditions.push(scope);
  const [check] = await db.select().from(roomTrackChecksTable).where(and(...conditions)).limit(1);
  if (!check) return res.status(404).json({ error: "Check not found" }); res.json(check);
});

router.post("/checks", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const body = CheckCreateBody.safeParse(req.body); if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  const room = await getScopedRoom(body.data.roomId, clientId, siteIds);
  if (!room || !room.active) return res.status(404).json({ error: "Active room not found" });
  const checkSiteId = body.data.siteId ?? room.siteId;
  if (room.siteId != null && checkSiteId !== room.siteId) return res.status(400).json({ error: "Check siteId must match the room site" });
  if (!(await validSite(checkSiteId, clientId, siteIds))) return res.status(403).json({ error: "Invalid siteId for this client or department" });
  const performer = await resolveStaffRoster(clientId, body.data.checkedByRosterId, body.data.checkedBy);
  if (body.data.checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  try {
    const [check] = await db.insert(roomTrackChecksTable).values({ ...body.data, clientId, siteId: checkSiteId, notes: body.data.notes ?? null, checkedBy: performer?.performedBy ?? null, checkedByRosterId: performer?.staffRosterId ?? null, createdBy: req.currentUser!.id, updatedBy: req.currentUser!.id } as any).returning();
    res.status(201).json(check);
  } catch (error: any) {
    if (postgresErrorCode(error) === "23505") return res.status(409).json({ error: "A check already exists for this room and date" });
    throw error;
  }
});

router.put("/checks/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id); if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const body = CheckUpdateBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  const scope = scopedSite(roomTrackChecksTable.siteId, siteIds); const existingConditions = [eq(roomTrackChecksTable.id, id), eq(roomTrackChecksTable.clientId, clientId)]; if (scope) existingConditions.push(scope);
  const [existing] = await db.select().from(roomTrackChecksTable).where(and(...existingConditions)).limit(1); if (!existing) return res.status(404).json({ error: "Check not found" });
  const roomId = body.data.roomId ?? existing.roomId;
  const room = await getScopedRoom(roomId, clientId, siteIds); if (!room) return res.status(404).json({ error: "Room not found" });
  const checkSiteId = body.data.siteId === undefined ? existing.siteId : body.data.siteId ?? room.siteId; if (room.siteId != null && checkSiteId !== room.siteId) return res.status(400).json({ error: "Check siteId must match the room site" });
  if (!(await validSite(checkSiteId, clientId, siteIds))) return res.status(403).json({ error: "Invalid siteId for this client or department" });
  const performer = await resolveStaffPerformerUpdate(clientId, body.data.checkedByRosterId, body.data.checkedBy, (existing as any).checkedByRosterId, existing.checkedBy);
  if (body.data.checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  try {
    const [check] = await db.update(roomTrackChecksTable).set({ ...body.data, checkedBy: performer?.performedBy, checkedByRosterId: performer?.staffRosterId, roomId, checkDate: body.data.checkDate ?? existing.checkDate, siteId: checkSiteId, updatedBy: req.currentUser!.id, updatedAt: new Date() } as any).where(and(eq(roomTrackChecksTable.id, id), eq(roomTrackChecksTable.clientId, clientId))).returning();
    res.json(check);
  } catch (error: any) {
    if (postgresErrorCode(error) === "23505") return res.status(409).json({ error: "A check already exists for this room and date" });
    throw error;
  }
});

router.get("/daily/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const date = typeof req.query.date === "string" && dateString.safeParse(req.query.date).success ? req.query.date : new Date().toISOString().slice(0, 10);
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req));
  const rawSiteId = req.query.siteId;
  const requestedSiteId = typeof rawSiteId === "string" ? Number(rawSiteId) : null;
  if (rawSiteId !== undefined && (!Number.isInteger(requestedSiteId) || !(await validSite(requestedSiteId, clientId, siteIds)))) {
    return res.status(403).json({ error: "Site is not available in the current department" });
  }
  const roomScope = scopedSite(roomTrackRoomsTable.siteId, siteIds);
  const roomConditions = [eq(roomTrackRoomsTable.clientId, clientId), eq(roomTrackRoomsTable.active, true)]; if (roomScope) roomConditions.push(roomScope);
  if (requestedSiteId != null) roomConditions.push(eq(roomTrackRoomsTable.siteId, requestedSiteId));
  const rooms = await db.select({ id: roomTrackRoomsTable.id }).from(roomTrackRoomsTable).where(and(...roomConditions));
  if (!rooms.length) return res.json({ date, checked: 0, total: 0, unchecked: 0, status: "no_data" });
  const checkScope = scopedSite(roomTrackChecksTable.siteId, siteIds); const checkConditions = [eq(roomTrackChecksTable.clientId, clientId), eq(roomTrackChecksTable.checkDate, date), inArray(roomTrackChecksTable.roomId, rooms.map((r) => r.id))]; if (checkScope) checkConditions.push(checkScope);
  if (requestedSiteId != null) checkConditions.push(eq(roomTrackChecksTable.siteId, requestedSiteId));
  checkConditions.push(eq(roomTrackChecksTable.clean, true), eq(roomTrackChecksTable.tidy, true), eq(roomTrackChecksTable.toStandard, true));
  const checked = (await db.select({ count: sql<number>`count(*)::int` }).from(roomTrackChecksTable).where(and(...checkConditions)))[0]?.count ?? 0;
  res.json({ date, checked, total: rooms.length, unchecked: rooms.length - checked, status: checked === rooms.length ? "ok" : "attention" });
});

router.get("/daily", requireAuth, async (req, res) => {
  req.query.date = (req.query.date as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteIds = await allowedSites(clientId, getActiveDepartmentId(req)); const scope = scopedSite(roomTrackChecksTable.siteId, siteIds);
  const conditions = [eq(roomTrackChecksTable.clientId, clientId), eq(roomTrackChecksTable.checkDate, req.query.date as string)]; if (scope) conditions.push(scope);
  res.json(await db.select().from(roomTrackChecksTable).where(and(...conditions)).orderBy(roomTrackChecksTable.roomId));
});

export default router;