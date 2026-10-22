/**
 * KitchenTrack allergen recipes: a dish with recipe lines takes its allergens
 * from its ingredients. "Contains" is every allergen any ingredient contains;
 * "may contain" is every trace any ingredient may contain that the dish does
 * not already contain. A dish with no recipe lines keeps its hand ticks.
 *
 * Lock order, so concurrent saves cannot deadlock: ingredient rows first
 * (FOR SHARE when a dish is saved, FOR UPDATE when an ingredient is edited),
 * then dish rows. An ingredient edit pushes its new sets to every dish that
 * uses it and writes each dish's change log with the ingredient's reason.
 */
import { db } from "@workspace/db";
import {
  allergenIngredientsTable,
  allergenItemChangesTable,
  allergenItemIngredientsTable,
  allergenItemsTable,
} from "@workspace/db/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

/** The 14 allergens in Schedule 1 of the Food Information Regulations 2014 (retained Regulation (EU) 1169/2011, Annex II). */
export const ALLERGEN_KEYS = [
  "celery", "gluten", "crustaceans", "eggs", "fish", "lupin", "milk",
  "molluscs", "mustard", "tree_nuts", "peanuts", "sesame", "soya", "sulphites",
] as const;

export type AllergenKey = (typeof ALLERGEN_KEYS)[number];

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Canonical (regulated) order, de-duplicated, unknown keys dropped. */
export function canonicalAllergens(values: readonly string[]): AllergenKey[] {
  const chosen = new Set(values);
  return ALLERGEN_KEYS.filter((key) => chosen.has(key));
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

/** "May contain" never repeats an allergen the food definitely contains. */
export function splitSets(contains: readonly string[], mayContain: readonly string[]) {
  const allergens = canonicalAllergens(contains);
  return { allergens, mayContain: canonicalAllergens(mayContain).filter((key) => !allergens.includes(key)) };
}

/** A dish's sets worked out from its ingredients' sets. */
export function combineIngredients(ingredients: readonly { contains: readonly string[]; mayContain: readonly string[] }[]) {
  return splitSets(ingredients.flatMap((i) => i.contains), ingredients.flatMap((i) => i.mayContain));
}

/** Current sets for a dish's recipe lines, or null when it has none. */
export async function recipeSets(tx: Tx, clientId: number, itemId: number) {
  const rows = await tx.select({ contains: allergenIngredientsTable.contains, mayContain: allergenIngredientsTable.mayContain })
    .from(allergenItemIngredientsTable)
    .innerJoin(allergenIngredientsTable, eq(allergenIngredientsTable.id, allergenItemIngredientsTable.ingredientId))
    .where(and(eq(allergenItemIngredientsTable.itemId, itemId), eq(allergenItemIngredientsTable.clientId, clientId)));
  if (rows.length === 0) return null;
  return combineIngredients(rows.map((r) => ({ contains: r.contains ?? [], mayContain: r.mayContain ?? [] })));
}

/**
 * Re-works out every live dish that uses this ingredient (after the
 * ingredient row was updated in this transaction and is locked FOR UPDATE).
 * Returns how many dishes' sets changed.
 */
export async function pushIngredientChange(tx: Tx, opts: {
  clientId: number;
  ingredientId: number;
  ingredientName: string;
  reason: string | null;
  userId: number;
  userName: string | null;
}): Promise<number> {
  const linked = tx.select({ id: allergenItemIngredientsTable.itemId }).from(allergenItemIngredientsTable)
    .where(and(eq(allergenItemIngredientsTable.ingredientId, opts.ingredientId), eq(allergenItemIngredientsTable.clientId, opts.clientId)));
  const dishes = await tx.select().from(allergenItemsTable)
    .where(and(
      eq(allergenItemsTable.clientId, opts.clientId),
      isNull(allergenItemsTable.deletedAt),
      inArray(allergenItemsTable.id, linked),
    ))
    .orderBy(asc(allergenItemsTable.id))
    .for("update", { of: allergenItemsTable });
  let updated = 0;
  const reason = `Ingredient "${opts.ingredientName}" changed${opts.reason ? `: ${opts.reason}` : ""}`.slice(0, 1000);
  for (const dish of dishes) {
    const sets = await recipeSets(tx, opts.clientId, dish.id);
    if (!sets) continue;
    if (sameSet(dish.allergens ?? [], sets.allergens) && sameSet(dish.mayContain ?? [], sets.mayContain)) continue;
    const now = new Date();
    await tx.update(allergenItemsTable)
      .set({ allergens: sets.allergens, mayContain: sets.mayContain, chartChangedAt: now, updatedAt: now })
      .where(and(eq(allergenItemsTable.id, dish.id), eq(allergenItemsTable.clientId, opts.clientId)));
    await tx.insert(allergenItemChangesTable).values({
      clientId: opts.clientId,
      itemId: dish.id,
      changeType: "allergens_changed",
      allergensBefore: dish.allergens ?? [],
      allergensAfter: sets.allergens,
      mayContainBefore: dish.mayContain ?? [],
      mayContainAfter: sets.mayContain,
      reason,
      changedBy: opts.userId,
      changedByName: opts.userName,
    });
    updated++;
  }
  return updated;
}
