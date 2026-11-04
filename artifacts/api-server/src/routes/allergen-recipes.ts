/**
 * KitchenTrack allergen recipes, mounted at /registers next to the allergen
 * records in registers.ts:
 *  - Ingredients: what each bought-in ingredient contains and may contain,
 *    for every site or one site. Changing an ingredient's allergens needs a
 *    reason and re-works out every dish that uses it, each with a change log
 *    row (lib/allergenRecipes.ts). An ingredient still in a recipe cannot be
 *    removed.
 *  - Menus: named menus at a site; dishes join them from the dish form.
 *  - Charts: one chart per site plus one per menu. A named, signed-in person
 *    signs a chart off (append-only); a dish change after the latest sign-off
 *    shows the chart as "changed since last checked".
 *
 * Tenant and department scoping follow registers.ts (siteScope, canUseSite).
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  allergenChartSignoffsTable,
  allergenIngredientChangesTable,
  allergenIngredientsTable,
  allergenItemIngredientsTable,
  allergenItemsTable,
  allergenMenuItemsTable,
  allergenMenusTable,
  sitesTable,
} from "@workspace/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { requireAuth, denyViewers } from "../middleware/requireAuth";
import { requireService } from "../lib/services";
import { ALLERGEN_KEYS, pushIngredientChange, sameSet, splitSets } from "../lib/allergenRecipes";
import {
  DATE, OPTIONAL_TEXT, TEXT, canUseSite, parseId, requireClient, siteFilter, siteScope,
} from "./registers";

const router = Router();

router.use("/allergen-ingredients", requireService("kitchentrack"));
router.use("/allergen-menus", requireService("kitchentrack"));
router.use("/allergen-charts", requireService("kitchentrack"));

function actorName(req: Request): string | null {
  return req.currentUser?.name ?? null;
}

// ── Ingredients ───────────────────────────────────────────────────────────────

const IngredientBody = z.object({
  // null: the ingredient can be used at every site.
  siteId: z.number().int().positive().nullable(),
  name: TEXT(200).min(1, "Name is required"),
  supplier: OPTIONAL_TEXT(200),
  productCode: OPTIONAL_TEXT(100),
  contains: z.array(z.enum(ALLERGEN_KEYS)).max(ALLERGEN_KEYS.length),
  mayContain: z.array(z.enum(ALLERGEN_KEYS)).max(ALLERGEN_KEYS.length).optional().default([]),
  notes: OPTIONAL_TEXT(2000),
  lastCheckedAt: DATE.nullish(),
  checkedBy: OPTIONAL_TEXT(200),
  // Required when the allergens change on an edit (new supplier, new recipe).
  changeReason: OPTIONAL_TEXT(1000),
});

/** Live dishes using each ingredient, limited to sites the caller can see. */
async function withUsage<T extends { id: number }>(req: Request, clientId: number, rows: T[]) {
  const ids = rows.map((row) => row.id);
  const uses = ids.length === 0 ? [] : await db.select({
    ingredientId: allergenItemIngredientsTable.ingredientId,
    id: allergenItemsTable.id,
    name: allergenItemsTable.name,
    siteId: allergenItemsTable.siteId,
  }).from(allergenItemIngredientsTable)
    .innerJoin(allergenItemsTable, eq(allergenItemsTable.id, allergenItemIngredientsTable.itemId))
    .where(and(
      eq(allergenItemIngredientsTable.clientId, clientId),
      inArray(allergenItemIngredientsTable.ingredientId, ids),
      isNull(allergenItemsTable.deletedAt),
      siteScope(req, clientId, allergenItemsTable.siteId),
    ))
    .orderBy(asc(allergenItemsTable.name), asc(allergenItemsTable.id));
  return rows.map((row) => ({
    ...row,
    usedIn: uses.filter((use) => use.ingredientId === row.id).map(({ id, name, siteId }) => ({ id, name, siteId })),
  }));
}

async function findIngredient(req: Request, clientId: number, id: number, executor: Pick<typeof db, "select"> = db, lock = false) {
  const query = executor.select().from(allergenIngredientsTable)
    .where(and(
      eq(allergenIngredientsTable.id, id),
      eq(allergenIngredientsTable.clientId, clientId),
      isNull(allergenIngredientsTable.deletedAt),
      siteScope(req, clientId, allergenIngredientsTable.siteId),
    ))
    .limit(1);
  const [row] = lock ? await query.for("update", { of: allergenIngredientsTable }) : await query;
  return row ?? null;
}

router.get("/allergen-ingredients", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const rows = await db.select().from(allergenIngredientsTable)
    .where(and(
      eq(allergenIngredientsTable.clientId, clientId),
      isNull(allergenIngredientsTable.deletedAt),
      siteScope(req, clientId, allergenIngredientsTable.siteId),
    ))
    .orderBy(asc(allergenIngredientsTable.name), asc(allergenIngredientsTable.id));
  res.json(await withUsage(req, clientId, rows));
});

router.get("/allergen-ingredients/:id/changes", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  // The change log stays readable after an ingredient is removed.
  const [ingredient] = await db.select({ id: allergenIngredientsTable.id }).from(allergenIngredientsTable)
    .where(and(eq(allergenIngredientsTable.id, id), eq(allergenIngredientsTable.clientId, clientId), siteScope(req, clientId, allergenIngredientsTable.siteId)))
    .limit(1);
  if (!ingredient) return res.status(404).json({ error: "Not found" });
  const rows = await db.select().from(allergenIngredientChangesTable)
    .where(and(eq(allergenIngredientChangesTable.ingredientId, id), eq(allergenIngredientChangesTable.clientId, clientId)))
    .orderBy(desc(allergenIngredientChangesTable.createdAt), desc(allergenIngredientChangesTable.id));
  res.json(rows);
});

router.post("/allergen-ingredients", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = IngredientBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (d.siteId !== null && !(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const sets = splitSets(d.contains, d.mayContain);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(allergenIngredientsTable).values({
      clientId,
      siteId: d.siteId,
      name: d.name,
      supplier: d.supplier,
      productCode: d.productCode,
      contains: sets.allergens,
      mayContain: sets.mayContain,
      notes: d.notes,
      lastCheckedAt: d.lastCheckedAt ?? null,
      checkedBy: d.checkedBy,
      createdBy: req.currentUser!.id,
    }).returning();
    await tx.insert(allergenIngredientChangesTable).values({
      clientId,
      ingredientId: created.id,
      changeType: "created",
      containsAfter: sets.allergens,
      mayContainAfter: sets.mayContain,
      reason: d.changeReason,
      changedBy: req.currentUser!.id,
      changedByName: actorName(req),
    });
    return created;
  });
  res.status(201).json({ ...row, usedIn: [] });
});

router.put("/allergen-ingredients/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = IngredientBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await findIngredient(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  if (d.siteId !== null && !(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const sets = splitSets(d.contains, d.mayContain);

  const outcome = await db.transaction(async (tx) => {
    // Ingredient first, then its dishes (lock order in lib/allergenRecipes.ts).
    const existing = await findIngredient(req, clientId, id, tx, true);
    if (!existing) return { status: 404 as const, error: "Not found" };
    const changed = !sameSet(existing.contains ?? [], sets.allergens) || !sameSet(existing.mayContain ?? [], sets.mayContain);
    if (changed && !d.changeReason) {
      return { status: 400 as const, error: "Say what changed (for example a new supplier) when the allergens change" };
    }
    if (d.siteId !== null && d.siteId !== existing.siteId) {
      const [elsewhere] = await tx.select({ id: allergenItemsTable.id }).from(allergenItemIngredientsTable)
        .innerJoin(allergenItemsTable, eq(allergenItemsTable.id, allergenItemIngredientsTable.itemId))
        .where(and(
          eq(allergenItemIngredientsTable.ingredientId, id),
          eq(allergenItemIngredientsTable.clientId, clientId),
          isNull(allergenItemsTable.deletedAt),
          sql`${allergenItemsTable.siteId} IS DISTINCT FROM ${d.siteId}`,
        ))
        .limit(1);
      if (elsewhere) return { status: 400 as const, error: "Dishes at other sites use this ingredient" };
    }
    const [updated] = await tx.update(allergenIngredientsTable).set({
      siteId: d.siteId,
      name: d.name,
      supplier: d.supplier,
      productCode: d.productCode,
      contains: sets.allergens,
      mayContain: sets.mayContain,
      notes: d.notes,
      lastCheckedAt: d.lastCheckedAt ?? null,
      checkedBy: d.checkedBy,
      updatedAt: new Date(),
    }).where(and(eq(allergenIngredientsTable.id, id), eq(allergenIngredientsTable.clientId, clientId))).returning();
    let dishesUpdated = 0;
    if (changed) {
      dishesUpdated = await pushIngredientChange(tx, {
        clientId, ingredientId: id, ingredientName: d.name, reason: d.changeReason,
        userId: req.currentUser!.id, userName: actorName(req),
      });
      await tx.insert(allergenIngredientChangesTable).values({
        clientId,
        ingredientId: id,
        changeType: "allergens_changed",
        containsBefore: existing.contains ?? [],
        containsAfter: sets.allergens,
        mayContainBefore: existing.mayContain ?? [],
        mayContainAfter: sets.mayContain,
        reason: d.changeReason,
        dishesUpdated,
        changedBy: req.currentUser!.id,
        changedByName: actorName(req),
      });
    } else if (existing.name !== d.name) {
      // Dishes print their own names, but a renamed ingredient changes what
      // the recipe shows; mark the charts of dishes using it.
      await tx.update(allergenItemsTable).set({ chartChangedAt: new Date() }).where(and(
        eq(allergenItemsTable.clientId, clientId),
        isNull(allergenItemsTable.deletedAt),
        inArray(allergenItemsTable.id, tx.select({ id: allergenItemIngredientsTable.itemId }).from(allergenItemIngredientsTable)
          .where(and(eq(allergenItemIngredientsTable.ingredientId, id), eq(allergenItemIngredientsTable.clientId, clientId)))),
      ));
    }
    return { status: 200 as const, row: updated, dishesUpdated };
  });
  if (outcome.status !== 200) return res.status(outcome.status).json({ error: outcome.error });
  const [row] = await withUsage(req, clientId, [outcome.row]);
  res.json({ ...row, dishesUpdated: outcome.dishesUpdated });
});

router.delete("/allergen-ingredients/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const outcome = await db.transaction(async (tx) => {
    const existing = await findIngredient(req, clientId, id, tx, true);
    if (!existing) return { status: 404 as const, error: "Not found" };
    const [used] = await tx.select({ n: count() }).from(allergenItemIngredientsTable)
      .innerJoin(allergenItemsTable, eq(allergenItemsTable.id, allergenItemIngredientsTable.itemId))
      .where(and(
        eq(allergenItemIngredientsTable.ingredientId, id),
        eq(allergenItemIngredientsTable.clientId, clientId),
        isNull(allergenItemsTable.deletedAt),
      ));
    if ((used?.n ?? 0) > 0) {
      return { status: 409 as const, error: `Used in ${used.n} dish${used.n === 1 ? "" : "es"}. Take it out of those recipes first.` };
    }
    await tx.update(allergenIngredientsTable).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(allergenIngredientsTable.id, id), eq(allergenIngredientsTable.clientId, clientId)));
    await tx.insert(allergenIngredientChangesTable).values({
      clientId,
      ingredientId: id,
      changeType: "removed",
      containsBefore: existing.contains ?? [],
      mayContainBefore: existing.mayContain ?? [],
      changedBy: req.currentUser!.id,
      changedByName: actorName(req),
    });
    return { status: 204 as const };
  });
  if (outcome.status !== 204) return res.status(outcome.status).json({ error: outcome.error });
  res.status(204).end();
});

// ── Menus ─────────────────────────────────────────────────────────────────────

const MenuCreateBody = z.object({
  siteId: z.number().int().positive(),
  name: TEXT(100).min(1, "Name is required"),
});
const MenuRenameBody = z.object({ name: TEXT(100).min(1, "Name is required") });

async function findMenu(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(allergenMenusTable)
    .where(and(
      eq(allergenMenusTable.id, id),
      eq(allergenMenusTable.clientId, clientId),
      isNull(allergenMenusTable.deletedAt),
      siteScope(req, clientId, allergenMenusTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

router.get("/allergen-menus", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, allergenMenusTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const rows = await db.select().from(allergenMenusTable)
    .where(and(
      eq(allergenMenusTable.clientId, clientId),
      isNull(allergenMenusTable.deletedAt),
      siteScope(req, clientId, allergenMenusTable.siteId),
      site,
    ))
    .orderBy(asc(allergenMenusTable.name), asc(allergenMenusTable.id));
  res.json(rows);
});

router.post("/allergen-menus", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = MenuCreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const [row] = await db.insert(allergenMenusTable).values({
    clientId, siteId: d.siteId, name: d.name, createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(row);
});

// A menu stays at its site; only its name changes.
router.put("/allergen-menus/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = MenuRenameBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  if (!(await findMenu(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  const now = new Date();
  const [row] = await db.update(allergenMenusTable)
    .set({ name: parsed.data.name, contentsChangedAt: now, updatedAt: now })
    .where(and(eq(allergenMenusTable.id, id), eq(allergenMenusTable.clientId, clientId), isNull(allergenMenusTable.deletedAt)))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/allergen-menus/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findMenu(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  // Soft delete: the menu's dishes and sign-offs stay for the record.
  await db.update(allergenMenusTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(allergenMenusTable.id, id), eq(allergenMenusTable.clientId, clientId)));
  res.status(204).end();
});

// ── Charts and sign-offs ─────────────────────────────────────────────────────

interface ChartKey { siteId: number; menuId: number | null }

/**
 * Status of each chart the caller can see: every site with a dish or a menu,
 * and every live menu. changedSinceCheck is true when a dish on the chart
 * (including one removed since) changed after the latest sign-off.
 */
async function chartStatuses(req: Request, clientId: number, only?: ChartKey) {
  const siteRows = await db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), siteScope(req, clientId, sitesTable.id)))
    .orderBy(asc(sitesTable.name), asc(sitesTable.id));
  const visibleSiteIds = siteRows.map((site) => site.id);
  if (visibleSiteIds.length === 0) return [];
  const menus = await db.select().from(allergenMenusTable)
    .where(and(eq(allergenMenusTable.clientId, clientId), isNull(allergenMenusTable.deletedAt), inArray(allergenMenusTable.siteId, visibleSiteIds)))
    .orderBy(asc(allergenMenusTable.name), asc(allergenMenusTable.id));

  // Live dish count and latest chart change per site and per menu.
  const siteDishes = await db.select({
    siteId: allergenItemsTable.siteId,
    live: sql<number>`count(*) FILTER (WHERE ${allergenItemsTable.deletedAt} IS NULL)`.mapWith(Number),
    lastChange: max(allergenItemsTable.chartChangedAt),
  }).from(allergenItemsTable)
    .where(and(eq(allergenItemsTable.clientId, clientId), inArray(allergenItemsTable.siteId, visibleSiteIds)))
    .groupBy(allergenItemsTable.siteId);
  const menuIds = menus.map((menu) => menu.id);
  const menuDishes = menuIds.length === 0 ? [] : await db.select({
    menuId: allergenMenuItemsTable.menuId,
    live: sql<number>`count(*) FILTER (WHERE ${allergenItemsTable.deletedAt} IS NULL)`.mapWith(Number),
    lastChange: max(allergenItemsTable.chartChangedAt),
  }).from(allergenMenuItemsTable)
    .innerJoin(allergenItemsTable, eq(allergenItemsTable.id, allergenMenuItemsTable.itemId))
    .where(and(eq(allergenMenuItemsTable.clientId, clientId), inArray(allergenMenuItemsTable.menuId, menuIds)))
    .groupBy(allergenMenuItemsTable.menuId);

  // Latest sign-off per chart.
  const signoffs = await db.selectDistinctOn([allergenChartSignoffsTable.siteId, allergenChartSignoffsTable.menuId]).from(allergenChartSignoffsTable)
    .where(and(eq(allergenChartSignoffsTable.clientId, clientId), inArray(allergenChartSignoffsTable.siteId, visibleSiteIds)))
    .orderBy(allergenChartSignoffsTable.siteId, allergenChartSignoffsTable.menuId, desc(allergenChartSignoffsTable.createdAt), desc(allergenChartSignoffsTable.id));

  const charts = [];
  for (const site of siteRows) {
    const dishes = siteDishes.find((row) => row.siteId === site.id);
    const siteMenus = menus.filter((menu) => menu.siteId === site.id);
    if (!dishes?.live && siteMenus.length === 0) continue;
    const entries: { menuId: number | null; menuName: string | null; dishCount: number; lastChange: Date | null }[] = [
      { menuId: null, menuName: null, dishCount: dishes?.live ?? 0, lastChange: dishes?.lastChange ?? null },
      ...siteMenus.map((menu) => {
        const row = menuDishes.find((m) => m.menuId === menu.id);
        const latest = [row?.lastChange, menu.contentsChangedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return { menuId: menu.id, menuName: menu.name, dishCount: row?.live ?? 0, lastChange: latest };
      }),
    ];
    for (const entry of entries) {
      if (only && (only.siteId !== site.id || only.menuId !== entry.menuId)) continue;
      const signoff = signoffs.find((row) => row.siteId === site.id && row.menuId === entry.menuId) ?? null;
      charts.push({
        siteId: site.id,
        siteName: site.name,
        menuId: entry.menuId,
        menuName: entry.menuName,
        dishCount: entry.dishCount,
        lastSignoff: signoff && {
          id: signoff.id, checkedByName: signoff.checkedByName, createdAt: signoff.createdAt,
          note: signoff.note, dishCount: signoff.dishCount,
        },
        changedSinceCheck: !!signoff && !!entry.lastChange && entry.lastChange > signoff.createdAt,
      });
    }
  }
  return charts;
}

router.get("/allergen-charts", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  res.json(await chartStatuses(req, clientId));
});

const ChartQuery = z.object({
  siteId: z.coerce.number().int().positive(),
  menuId: z.coerce.number().int().positive().optional(),
});

router.get("/allergen-charts/signoffs", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = ChartQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Choose a site" });
  const { siteId, menuId } = parsed.data;
  if (!(await canUseSite(req, clientId, siteId))) return res.status(404).json({ error: "Not found" });
  const rows = await db.select().from(allergenChartSignoffsTable)
    .where(and(
      eq(allergenChartSignoffsTable.clientId, clientId),
      eq(allergenChartSignoffsTable.siteId, siteId),
      menuId === undefined ? isNull(allergenChartSignoffsTable.menuId) : eq(allergenChartSignoffsTable.menuId, menuId),
    ))
    .orderBy(desc(allergenChartSignoffsTable.createdAt), desc(allergenChartSignoffsTable.id))
    .limit(200);
  res.json(rows);
});

const SignoffBody = z.object({
  siteId: z.number().int().positive(),
  menuId: z.number().int().positive().nullish().transform((value) => value ?? null),
  // The person ticks that they checked every dish against current recipes and labels.
  confirmed: z.boolean().refine((value) => value, "Confirm you have checked every dish on the chart"),
  note: OPTIONAL_TEXT(1000),
});

router.post("/allergen-charts/signoffs", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = SignoffBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const [chart] = await chartStatuses(req, clientId, { siteId: d.siteId, menuId: d.menuId });
  if (!chart) return res.status(400).json({ error: "Invalid menu" });
  if (chart.dishCount === 0) return res.status(400).json({ error: "Add dishes to this chart before signing it off" });
  const name = actorName(req) ?? req.currentUser!.email;
  const [row] = await db.insert(allergenChartSignoffsTable).values({
    clientId,
    siteId: d.siteId,
    menuId: d.menuId,
    dishCount: chart.dishCount,
    note: d.note,
    checkedBy: req.currentUser!.id,
    checkedByName: name,
  }).returning();
  res.status(201).json(row);
});


export default router;
