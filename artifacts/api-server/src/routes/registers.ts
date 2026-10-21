/**
 * Site registers, mounted at /registers:
 *  - Allergen records (KitchenTrack): dishes/products per site with the 14
 *    regulated allergens and "may contain" traces, ticked by hand or worked
 *    out from recipe lines, menus, a PPDS flag and an append-only tick change
 *    log. Ingredients, menus and chart sign-offs are in allergen-recipes.ts.
 *  - COSHH register (core): hazardous substances per site with a safety data
 *    sheet, assessment and review dates, controls/PPE and status.
 *  - Asbestos (core): one current record per site (build age, survey, report,
 *    management plan review) plus its register of asbestos-containing
 *    materials; replaced survey reports stay listed in its survey history.
 *
 * Every row belongs to the caller's client (getClientId) and to a site the
 * caller can see: client_staff/client_viewer are limited to sites in their
 * department or with no department, as on GET /sites. Deletes are soft
 * (deleted_at) so nothing is lost. Uploaded documents use the verified
 * finalisation flow in lib/registerDocuments.ts.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  allergenItemsTable,
  allergenItemChangesTable,
  allergenIngredientsTable,
  allergenItemIngredientsTable,
  allergenMenusTable,
  allergenMenuItemsTable,
  coshhSubstancesTable,
  asbestosRecordsTable,
  asbestosRegisterEntriesTable,
  asbestosSurveyHistoryTable,
  sitesTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireAuth, denyViewers, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { requireService } from "../lib/services";
import { type AllowedUploadType } from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import {
  ALLOWED_DOCUMENT_TYPES,
  documentFields,
  documentStorage as storage,
  resolveDocument,
  sendDownloadUrl,
} from "../lib/registerDocuments";
import { ensureUploadCapacity } from "../lib/storageLimit";
import { ALLERGEN_KEYS, recipeSets, sameSet, splitSets, type Tx } from "../lib/allergenRecipes";

const router = Router();

// Allergen records are part of KitchenTrack; COSHH and asbestos are core.
router.use("/allergens", requireService("kitchentrack"));

// ── Vocabularies ──────────────────────────────────────────────────────────────

// The 14 regulated allergens live with the recipe logic.
export { ALLERGEN_KEYS };

/** GHS hazard pictograms (GB CLP). */
export const GHS_PICTOGRAM_KEYS = [
  "ghs01", "ghs02", "ghs03", "ghs04", "ghs05", "ghs06", "ghs07", "ghs08", "ghs09",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Invalid date");
export const TEXT = (max: number) => z.string().trim().max(max);
export const OPTIONAL_TEXT = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus whole calendar months, clamped to the end of the month. */
export function addMonthsIso(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, lastDay));
  return first.toISOString().slice(0, 10);
}

/** Canonical, de-duplicated order for a set of vocabulary keys. */
function canonical<T extends string>(values: readonly T[], vocabulary: readonly T[]): T[] {
  const chosen = new Set(values);
  return vocabulary.filter((key) => chosen.has(key));
}

export function parseId(raw: string | string[] | undefined): number | null {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function requireClient(req: Request, res: Response): number | null {
  const clientId = getClientId(req);
  if (!clientId) res.status(400).json({ error: "No client context" });
  return clientId;
}

/**
 * Department scoping for a site_id column: staff/viewers see rows for sites in
 * their department or with no department, plus rows whose site was removed.
 */
export function siteScope(req: Request, clientId: number, column: PgColumn): SQL | undefined {
  const deptId = getActiveDepartmentId(req);
  if (deptId === null) return undefined;
  const visibleSites = db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId)));
  return or(isNull(column), inArray(column, visibleSites));
}

/** The site must belong to this client and be visible to the caller. */
export async function canUseSite(req: Request, clientId: number, siteId: number): Promise<boolean> {
  const deptId = getActiveDepartmentId(req);
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(
      eq(sitesTable.id, siteId),
      eq(sitesTable.clientId, clientId),
      deptId === null ? undefined : sitesTableVisibleTo(deptId),
    ))
    .limit(1);
  return !!site;
}

export function siteFilter(req: Request, column: PgColumn): SQL | undefined | "invalid" {
  if (req.query.siteId === undefined || req.query.siteId === "") return undefined;
  const siteId = parseId(req.query.siteId as string);
  return siteId === null ? "invalid" : eq(column, siteId);
}


// Presigned upload for a safety data sheet or survey report.
router.post("/uploads/request-url", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = z.object({ contentType: z.string().max(100) }).safeParse(req.body);
  const contentType = parsed.success ? parsed.data.contentType.toLowerCase() : "";
  if (!ALLOWED_DOCUMENT_TYPES.has(contentType as AllowedUploadType)) {
    return res.status(400).json({ error: "Upload a PDF, JPEG or PNG file" });
  }
  try {
    await ensureUploadCapacity(clientId, req.log);
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId, contentType);
    res.json({ uploadUrl, objectPath: storage.normalizeObjectEntityPath(uploadUrl) });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "register document upload");
  }
});

// ── Allergen records (KitchenTrack) ───────────────────────────────────────────
// A dish either has hand ticks or recipe lines. With recipe lines its
// allergens and "may contain" traces are worked out from the ingredients
// (lib/allergenRecipes.ts) and any ticks sent are ignored.

const RecipeLine = z.object({
  ingredientId: z.number().int().positive(),
  quantity: z.number().positive().max(1_000_000).nullish().transform((value) => value ?? null),
  unit: OPTIONAL_TEXT(20),
});

const AllergenBody = z.object({
  siteId: z.number().int().positive(),
  name: TEXT(200).min(1, "Name is required"),
  description: OPTIONAL_TEXT(2000),
  allergens: z.array(z.enum(ALLERGEN_KEYS)).max(ALLERGEN_KEYS.length),
  // Left out: kept as they are on an edit, none on a new dish.
  mayContain: z.array(z.enum(ALLERGEN_KEYS)).max(ALLERGEN_KEYS.length).optional(),
  ingredients: z.array(RecipeLine).max(100).optional(),
  menuIds: z.array(z.number().int().positive()).max(50).optional(),
  ppds: z.boolean().optional().default(false),
  lastReviewedAt: DATE.nullish(),
  reviewedBy: OPTIONAL_TEXT(200),
  // Required when the allergen ticks change on an edit (recipe or supplier change).
  changeReason: OPTIONAL_TEXT(1000),
});
type AllergenInput = z.infer<typeof AllergenBody>;

/** Thrown inside a transaction to roll it back and answer with this status. */
class Refusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function actorName(req: Request): string | null {
  return req.currentUser?.name ?? null;
}

/** Recipe lines and menus for each dish, for GET /allergens. */
async function withRecipes<T extends { id: number }>(clientId: number, rows: T[]) {
  const ids = rows.map((row) => row.id);
  const lines = ids.length === 0 ? [] : await db.select({
    itemId: allergenItemIngredientsTable.itemId,
    ingredientId: allergenItemIngredientsTable.ingredientId,
    name: allergenIngredientsTable.name,
    quantity: allergenItemIngredientsTable.quantity,
    unit: allergenItemIngredientsTable.unit,
  }).from(allergenItemIngredientsTable)
    .innerJoin(allergenIngredientsTable, eq(allergenIngredientsTable.id, allergenItemIngredientsTable.ingredientId))
    .where(and(eq(allergenItemIngredientsTable.clientId, clientId), inArray(allergenItemIngredientsTable.itemId, ids)))
    .orderBy(asc(allergenItemIngredientsTable.position), asc(allergenItemIngredientsTable.id));
  const menus = ids.length === 0 ? [] : await db.select({ itemId: allergenMenuItemsTable.itemId, menuId: allergenMenuItemsTable.menuId })
    .from(allergenMenuItemsTable)
    .innerJoin(allergenMenusTable, eq(allergenMenusTable.id, allergenMenuItemsTable.menuId))
    .where(and(eq(allergenMenuItemsTable.clientId, clientId), inArray(allergenMenuItemsTable.itemId, ids), isNull(allergenMenusTable.deletedAt)))
    .orderBy(asc(allergenMenuItemsTable.menuId));
  return rows.map((row) => ({
    ...row,
    ingredients: lines.filter((line) => line.itemId === row.id)
      .map(({ ingredientId, name, quantity, unit }) => ({ ingredientId, name, quantity, unit })),
    menuIds: menus.filter((menu) => menu.itemId === row.id).map((menu) => menu.menuId),
  }));
}

router.get("/allergens", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, allergenItemsTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const rows = await db.select().from(allergenItemsTable)
    .where(and(
      eq(allergenItemsTable.clientId, clientId),
      isNull(allergenItemsTable.deletedAt),
      siteScope(req, clientId, allergenItemsTable.siteId),
      site,
    ))
    .orderBy(asc(allergenItemsTable.name), asc(allergenItemsTable.id));
  res.json(await withRecipes(clientId, rows));
});

/** Loads a live allergen item the caller can see, or null. */
async function findAllergenItem(req: Request, clientId: number, id: number, executor: Pick<typeof db, "select"> = db, lock = false) {
  const query = executor.select().from(allergenItemsTable)
    .where(and(
      eq(allergenItemsTable.id, id),
      eq(allergenItemsTable.clientId, clientId),
      isNull(allergenItemsTable.deletedAt),
      siteScope(req, clientId, allergenItemsTable.siteId),
    ))
    .limit(1);
  const [row] = lock ? await query.for("update", { of: allergenItemsTable }) : await query;
  return row ?? null;
}

router.get("/allergens/:id/changes", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  // The change log stays readable after an item is removed.
  const [item] = await db.select({ id: allergenItemsTable.id }).from(allergenItemsTable)
    .where(and(eq(allergenItemsTable.id, id), eq(allergenItemsTable.clientId, clientId), siteScope(req, clientId, allergenItemsTable.siteId)))
    .limit(1);
  if (!item) return res.status(404).json({ error: "Not found" });
  const rows = await db.select().from(allergenItemChangesTable)
    .where(and(eq(allergenItemChangesTable.itemId, id), eq(allergenItemChangesTable.clientId, clientId)))
    .orderBy(desc(allergenItemChangesTable.createdAt), desc(allergenItemChangesTable.id));
  res.json(rows);
});

/**
 * Locks the recipe's ingredients (FOR SHARE, before the dish row: see
 * lib/allergenRecipes.ts) and checks each is live, visible to the caller and
 * usable at the dish's site.
 */
async function lockRecipeIngredients(tx: Tx, req: Request, clientId: number, siteId: number, lines: AllergenInput["ingredients"]) {
  if (!lines || lines.length === 0) return;
  const ids = lines.map((line) => line.ingredientId);
  if (new Set(ids).size !== ids.length) throw new Refusal(400, "List each ingredient once");
  const found = await tx.select({ id: allergenIngredientsTable.id, siteId: allergenIngredientsTable.siteId })
    .from(allergenIngredientsTable)
    .where(and(
      inArray(allergenIngredientsTable.id, ids),
      eq(allergenIngredientsTable.clientId, clientId),
      isNull(allergenIngredientsTable.deletedAt),
      siteScope(req, clientId, allergenIngredientsTable.siteId),
    ))
    .orderBy(asc(allergenIngredientsTable.id))
    .for("share", { of: allergenIngredientsTable });
  if (found.length !== ids.length) throw new Refusal(400, "Choose ingredients from your ingredients list");
  if (found.some((row) => row.siteId !== null && row.siteId !== siteId)) {
    throw new Refusal(400, "An ingredient in this recipe belongs to a different site");
  }
}

async function replaceRecipe(tx: Tx, clientId: number, itemId: number, lines: NonNullable<AllergenInput["ingredients"]>) {
  await tx.delete(allergenItemIngredientsTable)
    .where(and(eq(allergenItemIngredientsTable.itemId, itemId), eq(allergenItemIngredientsTable.clientId, clientId)));
  if (lines.length === 0) return;
  await tx.insert(allergenItemIngredientsTable).values(lines.map((line, position) => ({
    clientId, itemId, ingredientId: line.ingredientId, quantity: line.quantity, unit: line.unit, position,
  })));
}

/**
 * Puts the dish on exactly these menus (all at its site) or, with menuIds
 * left out, takes it off menus at any other site. Returns whether its menus
 * changed; each menu it joined or left is marked as changed.
 */
async function syncMenus(tx: Tx, clientId: number, itemId: number, siteId: number, menuIds: number[] | undefined): Promise<boolean> {
  const current = await tx.select({ menuId: allergenMenuItemsTable.menuId, siteId: allergenMenusTable.siteId })
    .from(allergenMenuItemsTable)
    .innerJoin(allergenMenusTable, eq(allergenMenusTable.id, allergenMenuItemsTable.menuId))
    .where(and(eq(allergenMenuItemsTable.itemId, itemId), eq(allergenMenuItemsTable.clientId, clientId), isNull(allergenMenusTable.deletedAt)));
  let wanted: number[];
  if (menuIds === undefined) {
    wanted = current.filter((row) => row.siteId === siteId).map((row) => row.menuId);
  } else {
    wanted = [...new Set(menuIds)];
    if (wanted.length > 0) {
      const valid = await tx.select({ id: allergenMenusTable.id }).from(allergenMenusTable)
        .where(and(
          inArray(allergenMenusTable.id, wanted),
          eq(allergenMenusTable.clientId, clientId),
          eq(allergenMenusTable.siteId, siteId),
          isNull(allergenMenusTable.deletedAt),
        ));
      if (valid.length !== wanted.length) throw new Refusal(400, "Choose menus at the dish's site");
    }
  }
  const have = current.map((row) => row.menuId);
  const added = wanted.filter((id) => !have.includes(id));
  const removed = have.filter((id) => !wanted.includes(id));
  if (removed.length > 0) {
    await tx.delete(allergenMenuItemsTable).where(and(
      eq(allergenMenuItemsTable.itemId, itemId),
      eq(allergenMenuItemsTable.clientId, clientId),
      inArray(allergenMenuItemsTable.menuId, removed),
    ));
  }
  if (added.length > 0) {
    await tx.insert(allergenMenuItemsTable).values(added.map((menuId) => ({ clientId, menuId, itemId })))
      .onConflictDoNothing();
  }
  const touched = [...added, ...removed];
  if (touched.length > 0) {
    await tx.update(allergenMenusTable).set({ contentsChangedAt: new Date() })
      .where(and(inArray(allergenMenusTable.id, touched), eq(allergenMenusTable.clientId, clientId)));
  }
  return touched.length > 0;
}

function sendRefusal(res: Response, err: unknown): boolean {
  if (!(err instanceof Refusal)) return false;
  res.status(err.status).json({ error: err.message });
  return true;
}

router.post("/allergens", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = AllergenBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  try {
    const row = await db.transaction(async (tx) => {
      await lockRecipeIngredients(tx, req, clientId, d.siteId, d.ingredients);
      const hand = splitSets(d.allergens, d.mayContain ?? []);
      const [created] = await tx.insert(allergenItemsTable).values({
        clientId,
        siteId: d.siteId,
        name: d.name,
        description: d.description,
        allergens: hand.allergens,
        mayContain: hand.mayContain,
        ppds: d.ppds,
        lastReviewedAt: d.lastReviewedAt ?? null,
        reviewedBy: d.reviewedBy,
        createdBy: req.currentUser!.id,
      }).returning();
      let saved = created;
      if (d.ingredients && d.ingredients.length > 0) {
        await replaceRecipe(tx, clientId, created.id, d.ingredients);
        const sets = (await recipeSets(tx, clientId, created.id))!;
        [saved] = await tx.update(allergenItemsTable).set({ allergens: sets.allergens, mayContain: sets.mayContain })
          .where(eq(allergenItemsTable.id, created.id)).returning();
      }
      await syncMenus(tx, clientId, created.id, d.siteId, d.menuIds ?? []);
      await tx.insert(allergenItemChangesTable).values({
        clientId,
        itemId: created.id,
        changeType: "created",
        allergensBefore: null,
        allergensAfter: saved.allergens,
        mayContainBefore: null,
        mayContainAfter: saved.mayContain,
        reason: d.changeReason,
        changedBy: req.currentUser!.id,
        changedByName: actorName(req),
      });
      return saved;
    });
    res.status(201).json((await withRecipes(clientId, [row]))[0]);
  } catch (err) {
    if (!sendRefusal(res, err)) throw err;
  }
});

router.put("/allergens/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = AllergenBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await findAllergenItem(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });

  try {
    const row = await db.transaction(async (tx) => {
      await lockRecipeIngredients(tx, req, clientId, d.siteId, d.ingredients);
      // Lock the row so the logged "before" set is the one actually replaced.
      const existing = await findAllergenItem(req, clientId, id, tx, true);
      if (!existing) throw new Refusal(404, "Not found");
      if (d.ingredients !== undefined) {
        await replaceRecipe(tx, clientId, id, d.ingredients);
      } else if (d.siteId !== existing.siteId) {
        // The kept recipe must still suit the new site.
        const elsewhere = await tx.select({ id: allergenIngredientsTable.id }).from(allergenItemIngredientsTable)
          .innerJoin(allergenIngredientsTable, eq(allergenIngredientsTable.id, allergenItemIngredientsTable.ingredientId))
          .where(and(
            eq(allergenItemIngredientsTable.itemId, id),
            eq(allergenItemIngredientsTable.clientId, clientId),
            isNotNull(allergenIngredientsTable.siteId),
            ne(allergenIngredientsTable.siteId, d.siteId),
          ))
          .limit(1);
        if (elsewhere.length > 0) throw new Refusal(400, "An ingredient in this recipe belongs to a different site");
      }
      const sets = (await recipeSets(tx, clientId, id)) ?? splitSets(d.allergens, d.mayContain ?? existing.mayContain ?? []);
      const setsChanged = !sameSet(existing.allergens ?? [], sets.allergens) || !sameSet(existing.mayContain ?? [], sets.mayContain);
      if (setsChanged && !d.changeReason) {
        throw new Refusal(400, "Say what changed (recipe or supplier) when the allergens change");
      }
      const menusChanged = await syncMenus(tx, clientId, id, d.siteId, d.menuIds);
      const chartChanged = setsChanged || menusChanged
        || existing.name !== d.name || existing.description !== d.description
        || existing.ppds !== d.ppds || existing.siteId !== d.siteId;
      const now = new Date();
      const [updated] = await tx.update(allergenItemsTable).set({
        siteId: d.siteId,
        name: d.name,
        description: d.description,
        allergens: sets.allergens,
        mayContain: sets.mayContain,
        ppds: d.ppds,
        lastReviewedAt: d.lastReviewedAt ?? null,
        reviewedBy: d.reviewedBy,
        ...(chartChanged ? { chartChangedAt: now } : {}),
        updatedAt: now,
      }).where(and(eq(allergenItemsTable.id, id), eq(allergenItemsTable.clientId, clientId))).returning();
      if (setsChanged) {
        await tx.insert(allergenItemChangesTable).values({
          clientId,
          itemId: id,
          changeType: "allergens_changed",
          allergensBefore: existing.allergens ?? [],
          allergensAfter: sets.allergens,
          mayContainBefore: existing.mayContain ?? [],
          mayContainAfter: sets.mayContain,
          reason: d.changeReason,
          changedBy: req.currentUser!.id,
          changedByName: actorName(req),
        });
      }
      return updated;
    });
    res.json((await withRecipes(clientId, [row]))[0]);
  } catch (err) {
    if (!sendRefusal(res, err)) throw err;
  }
});

router.delete("/allergens/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const found = await db.transaction(async (tx) => {
    const existing = await findAllergenItem(req, clientId, id, tx, true);
    if (!existing) return false;
    const now = new Date();
    // Recipe lines and menus stay with the removed row for the record; the
    // chart change time marks charts it was on as changed.
    await tx.update(allergenItemsTable).set({ deletedAt: now, chartChangedAt: now, updatedAt: now })
      .where(and(eq(allergenItemsTable.id, id), eq(allergenItemsTable.clientId, clientId)));
    await tx.insert(allergenItemChangesTable).values({
      clientId,
      itemId: id,
      changeType: "removed",
      allergensBefore: existing.allergens ?? [],
      allergensAfter: null,
      mayContainBefore: existing.mayContain ?? [],
      mayContainAfter: null,
      changedBy: req.currentUser!.id,
      changedByName: actorName(req),
    });
    return true;
  });
  if (!found) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

// ── COSHH register (core) ─────────────────────────────────────────────────────

const COSHH_STATUSES = ["in_use", "withdrawn"] as const;

const CoshhBody = z.object({
  siteId: z.number().int().positive(),
  productName: TEXT(200).min(1, "Product name is required"),
  supplier: OPTIONAL_TEXT(200),
  hazardPictograms: z.array(z.enum(GHS_PICTOGRAM_KEYS)).max(GHS_PICTOGRAM_KEYS.length).optional().default([]),
  whereUsed: OPTIONAL_TEXT(1000),
  assessmentDate: DATE.nullish(),
  // Omitted on create: 12 months after the assessment date (editable).
  reviewDue: DATE.nullish(),
  controls: OPTIONAL_TEXT(4000),
  status: z.enum(COSHH_STATUSES).optional().default("in_use"),
  ...documentFields,
});

function withCoshhStatus<T extends { reviewDue: string | null; status: string }>(row: T) {
  return { ...row, reviewOverdue: row.status === "in_use" && !!row.reviewDue && row.reviewDue < todayIso() };
}

async function findCoshh(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(coshhSubstancesTable)
    .where(and(
      eq(coshhSubstancesTable.id, id),
      eq(coshhSubstancesTable.clientId, clientId),
      isNull(coshhSubstancesTable.deletedAt),
      siteScope(req, clientId, coshhSubstancesTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

router.get("/coshh", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, coshhSubstancesTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const rows = await db.select().from(coshhSubstancesTable)
    .where(and(
      eq(coshhSubstancesTable.clientId, clientId),
      isNull(coshhSubstancesTable.deletedAt),
      siteScope(req, clientId, coshhSubstancesTable.siteId),
      site,
    ))
    .orderBy(asc(coshhSubstancesTable.productName), asc(coshhSubstancesTable.id));
  res.json(rows.map(withCoshhStatus));
});

router.post("/coshh", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = CoshhBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, null);
  if (!document || document === "kept") return;
  const reviewDue = d.reviewDue !== undefined ? d.reviewDue : d.assessmentDate ? addMonthsIso(d.assessmentDate, 12) : null;
  const [row] = await db.insert(coshhSubstancesTable).values({
    clientId,
    siteId: d.siteId,
    productName: d.productName,
    supplier: d.supplier,
    hazardPictograms: canonical(d.hazardPictograms, GHS_PICTOGRAM_KEYS),
    whereUsed: d.whereUsed,
    sdsObjectPath: document.objectPath,
    sdsFileName: document.fileName,
    sdsFileSize: document.fileSize,
    sdsMimeType: document.mimeType,
    assessmentDate: d.assessmentDate ?? null,
    reviewDue,
    controls: d.controls,
    status: d.status,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(withCoshhStatus(row));
});

router.put("/coshh/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = CoshhBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const existing = await findCoshh(req, clientId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, {
    objectPath: existing.sdsObjectPath, fileName: existing.sdsFileName,
    fileSize: existing.sdsFileSize, mimeType: existing.sdsMimeType,
  });
  if (!document) return;
  const [row] = await db.update(coshhSubstancesTable).set({
    siteId: d.siteId,
    productName: d.productName,
    supplier: d.supplier,
    hazardPictograms: canonical(d.hazardPictograms, GHS_PICTOGRAM_KEYS),
    whereUsed: d.whereUsed,
    ...(document === "kept" ? {} : {
      sdsObjectPath: document.objectPath,
      sdsFileName: document.fileName,
      sdsFileSize: document.fileSize,
      sdsMimeType: document.mimeType,
    }),
    assessmentDate: d.assessmentDate ?? null,
    ...(d.reviewDue !== undefined ? { reviewDue: d.reviewDue } : {}),
    controls: d.controls,
    status: d.status,
    updatedAt: new Date(),
  }).where(and(eq(coshhSubstancesTable.id, id), eq(coshhSubstancesTable.clientId, clientId), isNull(coshhSubstancesTable.deletedAt))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(withCoshhStatus(row));
});

router.delete("/coshh/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findCoshh(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  await db.update(coshhSubstancesTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(coshhSubstancesTable.id, id), eq(coshhSubstancesTable.clientId, clientId)));
  res.status(204).end();
});

router.get("/coshh/:id/sds-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const row = await findCoshh(req, clientId, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, row.sdsObjectPath, row.sdsFileName, clientId, id);
});

// ── Asbestos (core) ───────────────────────────────────────────────────────────

const BUILT_BEFORE_2000 = ["yes", "no", "unknown"] as const;
const SURVEY_TYPES = ["management", "refurbishment_demolition"] as const;
const CONDITIONS = ["good", "low_damage", "medium_damage", "high_damage"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;
const ACTIONS = ["manage", "encapsulate", "remove"] as const;

const AsbestosBody = z.object({
  siteId: z.number().int().positive(),
  builtBefore2000: z.enum(BUILT_BEFORE_2000),
  noAsbestosExpected: z.boolean().optional().default(false),
  surveyType: z.enum(SURVEY_TYPES).nullish(),
  surveyDate: DATE.nullish(),
  surveyor: OPTIONAL_TEXT(200),
  // Omitted on create: 12 months after the survey date (or today).
  planReviewDue: DATE.nullish(),
  notes: OPTIONAL_TEXT(4000),
  ...documentFields,
}).refine((d) => !d.noAsbestosExpected || d.builtBefore2000 === "no", {
  message: "\"No asbestos expected\" applies only to buildings built in or after 2000",
});

const EntryBody = z.object({
  location: TEXT(300).min(1, "Location is required"),
  material: TEXT(300).min(1, "Material is required"),
  condition: z.enum(CONDITIONS),
  riskScore: z.number().int().min(0).max(24).nullish(),
  priority: z.enum(PRIORITIES),
  action: z.enum(ACTIONS),
  lastInspected: DATE.nullish(),
  notes: OPTIONAL_TEXT(2000),
});

function withPlanStatus<T extends { planReviewDue: string | null; noAsbestosExpected: boolean }>(row: T) {
  return { ...row, planReviewOverdue: !row.noAsbestosExpected && !!row.planReviewDue && row.planReviewDue < todayIso() };
}

async function findAsbestosRecord(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(asbestosRecordsTable)
    .where(and(
      eq(asbestosRecordsTable.id, id),
      eq(asbestosRecordsTable.clientId, clientId),
      isNull(asbestosRecordsTable.deletedAt),
      siteScope(req, clientId, asbestosRecordsTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

function isUniqueViolation(err: any): boolean {
  return (err?.code ?? err?.cause?.code) === "23505";
}

router.get("/asbestos", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, asbestosRecordsTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const records = await db.select().from(asbestosRecordsTable)
    .where(and(
      eq(asbestosRecordsTable.clientId, clientId),
      isNull(asbestosRecordsTable.deletedAt),
      siteScope(req, clientId, asbestosRecordsTable.siteId),
      site,
    ))
    .orderBy(asc(asbestosRecordsTable.id));
  const entries = records.length === 0 ? [] : await db.select().from(asbestosRegisterEntriesTable)
    .where(and(
      eq(asbestosRegisterEntriesTable.clientId, clientId),
      isNull(asbestosRegisterEntriesTable.deletedAt),
      inArray(asbestosRegisterEntriesTable.recordId, records.map((record) => record.id)),
    ))
    .orderBy(asc(asbestosRegisterEntriesTable.location), asc(asbestosRegisterEntriesTable.id));
  const history = records.length === 0 ? [] : await db.select().from(asbestosSurveyHistoryTable)
    .where(and(
      eq(asbestosSurveyHistoryTable.clientId, clientId),
      inArray(asbestosSurveyHistoryTable.recordId, records.map((record) => record.id)),
    ))
    .orderBy(desc(asbestosSurveyHistoryTable.replacedAt), desc(asbestosSurveyHistoryTable.id));
  res.json(records.map((record) => ({
    ...withPlanStatus(record),
    entries: entries.filter((entry) => entry.recordId === record.id),
    surveyHistory: history.filter((survey) => survey.recordId === record.id),
  })));
});

router.post("/asbestos", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = AsbestosBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, null);
  if (!document || document === "kept") return;
  const planReviewDue = d.planReviewDue !== undefined ? d.planReviewDue
    : d.noAsbestosExpected ? null : addMonthsIso(d.surveyDate ?? todayIso(), 12);
  try {
    const [row] = await db.insert(asbestosRecordsTable).values({
      clientId,
      siteId: d.siteId,
      builtBefore2000: d.builtBefore2000,
      noAsbestosExpected: d.noAsbestosExpected,
      surveyType: d.surveyType ?? null,
      surveyDate: d.surveyDate ?? null,
      surveyor: d.surveyor,
      reportObjectPath: document.objectPath,
      reportFileName: document.fileName,
      reportFileSize: document.fileSize,
      reportMimeType: document.mimeType,
      planReviewDue,
      notes: d.notes,
      createdBy: req.currentUser!.id,
    }).returning();
    res.status(201).json({ ...withPlanStatus(row), entries: [], surveyHistory: [] });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "This site already has an asbestos record; edit that one instead" });
    throw err;
  }
});

router.put("/asbestos/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = AsbestosBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const existing = await findAsbestosRecord(req, clientId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  const document = await resolveDocument(req, res, clientId, d, {
    objectPath: existing.reportObjectPath, fileName: existing.reportFileName,
    fileSize: existing.reportFileSize, mimeType: existing.reportMimeType,
  });
  if (!document) return;
  try {
    const row = await db.transaction(async (tx) => {
      // Lock the record so concurrent replacements each archive the report
      // they actually replaced.
      const [current] = await tx.select().from(asbestosRecordsTable)
        .where(and(eq(asbestosRecordsTable.id, id), eq(asbestosRecordsTable.clientId, clientId), isNull(asbestosRecordsTable.deletedAt)))
        .for("update");
      if (!current) return null;
      // A replaced or detached report moves to the survey history with the
      // survey details it was recorded against, so the old file stays listed.
      if (document !== "kept" && current.reportObjectPath && document.objectPath !== current.reportObjectPath) {
        await tx.insert(asbestosSurveyHistoryTable).values({
          clientId,
          recordId: id,
          surveyType: current.surveyType,
          surveyDate: current.surveyDate,
          surveyor: current.surveyor,
          reportObjectPath: current.reportObjectPath,
          reportFileName: current.reportFileName,
          reportFileSize: current.reportFileSize,
          reportMimeType: current.reportMimeType,
          replacedBy: req.currentUser!.id,
        });
      }
      const [updated] = await tx.update(asbestosRecordsTable).set({
        siteId: d.siteId,
        builtBefore2000: d.builtBefore2000,
        noAsbestosExpected: d.noAsbestosExpected,
        surveyType: d.surveyType ?? null,
        surveyDate: d.surveyDate ?? null,
        surveyor: d.surveyor,
        ...(document === "kept" ? {} : {
          reportObjectPath: document.objectPath,
          reportFileName: document.fileName,
          reportFileSize: document.fileSize,
          reportMimeType: document.mimeType,
        }),
        ...(d.planReviewDue !== undefined ? { planReviewDue: d.planReviewDue } : {}),
        notes: d.notes,
        updatedAt: new Date(),
      }).where(and(eq(asbestosRecordsTable.id, id), eq(asbestosRecordsTable.clientId, clientId))).returning();
      return updated ?? null;
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(withPlanStatus(row));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: "That site already has an asbestos record" });
    throw err;
  }
});

router.delete("/asbestos/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findAsbestosRecord(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  await db.update(asbestosRecordsTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(asbestosRecordsTable.id, id), eq(asbestosRecordsTable.clientId, clientId)));
  res.status(204).end();
});

router.get("/asbestos/:id/report-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const row = await findAsbestosRecord(req, clientId, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, row.reportObjectPath, row.reportFileName, clientId, id);
});

router.get("/asbestos/:id/history/:historyId/report-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  const historyId = parseId(req.params.historyId);
  if (id === null || historyId === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findAsbestosRecord(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  const [survey] = await db.select().from(asbestosSurveyHistoryTable)
    .where(and(
      eq(asbestosSurveyHistoryTable.id, historyId),
      eq(asbestosSurveyHistoryTable.recordId, id),
      eq(asbestosSurveyHistoryTable.clientId, clientId),
    ))
    .limit(1);
  if (!survey) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, survey.reportObjectPath, survey.reportFileName, clientId, id);
});

router.post("/asbestos/:id/entries", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = EntryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  if (!(await findAsbestosRecord(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  const d = parsed.data;
  const [row] = await db.insert(asbestosRegisterEntriesTable).values({
    clientId,
    recordId: id,
    location: d.location,
    material: d.material,
    condition: d.condition,
    riskScore: d.riskScore ?? null,
    priority: d.priority,
    action: d.action,
    lastInspected: d.lastInspected ?? null,
    notes: d.notes,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(row);
});

/** A live entry whose live parent record the caller can see. */
async function findEntry(req: Request, clientId: number, entryId: number) {
  const [entry] = await db.select().from(asbestosRegisterEntriesTable)
    .where(and(
      eq(asbestosRegisterEntriesTable.id, entryId),
      eq(asbestosRegisterEntriesTable.clientId, clientId),
      isNull(asbestosRegisterEntriesTable.deletedAt),
    ))
    .limit(1);
  if (!entry || !(await findAsbestosRecord(req, clientId, entry.recordId))) return null;
  return entry;
}

router.put("/asbestos/entries/:entryId", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = EntryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  if (!(await findEntry(req, clientId, entryId))) return res.status(404).json({ error: "Not found" });
  const d = parsed.data;
  const [row] = await db.update(asbestosRegisterEntriesTable).set({
    location: d.location,
    material: d.material,
    condition: d.condition,
    riskScore: d.riskScore ?? null,
    priority: d.priority,
    action: d.action,
    lastInspected: d.lastInspected ?? null,
    notes: d.notes,
    updatedAt: new Date(),
  }).where(and(eq(asbestosRegisterEntriesTable.id, entryId), eq(asbestosRegisterEntriesTable.clientId, clientId), isNull(asbestosRegisterEntriesTable.deletedAt))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/asbestos/entries/:entryId", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findEntry(req, clientId, entryId))) return res.status(404).json({ error: "Not found" });
  await db.update(asbestosRegisterEntriesTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(asbestosRegisterEntriesTable.id, entryId), eq(asbestosRegisterEntriesTable.clientId, clientId)));
  res.status(204).end();
});

export default router;
