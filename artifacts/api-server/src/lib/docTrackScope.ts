import { sql, type SQL } from "drizzle-orm";
import type { Entitlements } from "./services";

/**
 * KitchenTrack keeps its HACCP plans and recipe spec sheets in DocTrack, so
 * staff read and sign them the same way. An account with KitchenTrack but not
 * DocTrack sees and manages only these two categories.
 */
export const KITCHEN_DOCUMENT_CATEGORIES = ["haccp", "recipe_spec"] as const;

/** The DocTrack categories these services allow: null means every category. */
export function docTrackCategoriesFor(services: Entitlements): readonly string[] | null {
  const has = (key: "doctrack" | "safetrack" | "kitchentrack") => services === "all" || services.includes(key);
  if (has("doctrack") || has("safetrack")) return null;
  return has("kitchentrack") ? KITCHEN_DOCUMENT_CATEGORIES : [];
}

/** `AND <column> IN (...)` for a limited account; nothing for a full one. */
export function docCategoryFilter(column: SQL, categories: readonly string[] | null): SQL {
  if (categories === null) return sql``;
  if (categories.length === 0) return sql`AND false`;
  return sql`AND ${column} IN (${sql.join(categories.map((category) => sql`${category}`), sql`, `)})`;
}

export function docCategoryAllowed(category: string, categories: readonly string[] | null) {
  return categories === null || categories.includes(category);
}
