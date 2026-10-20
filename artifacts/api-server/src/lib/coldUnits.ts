import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";

/**
 * KitchenTrack fridges and freezers. They live in the kitchen settings
 * (`food_cold_units`, or a site's `site.<id>.food_cold_units` override) and
 * readings are saved against the unit's name. Each unit also carries an id,
 * so its QR label keeps working when it is renamed. Lists saved before ids
 * existed get one derived from the name, and the next save keeps it.
 */
export type ColdUnit = { id: string; name: string; type: "fridge" | "freezer" };

export const COLD_UNIT_ID = /^[A-Za-z0-9_-]{1,40}$/;

function idFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  return `n-${slug || "unit"}`;
}

function withUniqueIds(units: Array<{ id: string; name: string; type: "fridge" | "freezer" }>): ColdUnit[] {
  const used = new Set<string>();
  return units.map((unit) => {
    let id = unit.id;
    for (let n = 2; used.has(id); n++) id = `${unit.id.slice(0, 36)}-${n}`;
    used.add(id);
    return { ...unit, id };
  });
}

/** The units a stored setting describes, the same way the kitchen page reads it. */
export function parseStoredColdUnits(raw: string | null | undefined, numFridges: string | null | undefined, numFreezers: string | null | undefined): ColdUnit[] {
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return withUniqueIds(parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { id, name, type } = item as Record<string, unknown>;
      if (typeof name !== "string" || !name.trim() || (type !== "fridge" && type !== "freezer")) return [];
      return [{ id: typeof id === "string" && COLD_UNIT_ID.test(id) ? id : idFromName(name), name: name.trim(), type }];
    }));
  }
  const count = (value: string | null | undefined) => {
    const n = Number(value || "2");
    return Number.isInteger(n) && n > 0 ? Math.min(n, 30) : 0;
  };
  return [
    ...Array.from({ length: count(numFridges) }, (_, i) => ({ id: `fridge-${i + 1}`, name: `Fridge ${i + 1}`, type: "fridge" as const })),
    ...Array.from({ length: count(numFreezers) }, (_, i) => ({ id: `freezer-${i + 1}`, name: `Freezer ${i + 1}`, type: "freezer" as const })),
  ];
}

/** The fridges and freezers in use at a site (null: the business-wide list). */
export async function effectiveColdUnits(clientId: number, siteId: number | null): Promise<ColdUnit[]> {
  const baseKeys = ["food_cold_units", "food_num_fridges", "food_num_freezers"];
  const keys = [...baseKeys, ...(siteId === null ? [] : baseKeys.map((key) => `site.${siteId}.${key}`))];
  const rows = await db.select({ key: appSettingsTable.key, value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), inArray(appSettingsTable.key, keys)));
  const value = (key: string) => rows.find((row) => row.key === `site.${siteId}.${key}` && row.value != null)?.value
    ?? rows.find((row) => row.key === key)?.value ?? null;
  return parseStoredColdUnits(value("food_cold_units"), value("food_num_fridges"), value("food_num_freezers"));
}

/**
 * Ids for a list being saved: a unit keeps the id it was sent with, or the id
 * of the unit it replaces by name, or gets a new one.
 */
export function assignColdUnitIds(
  units: Array<{ id?: string; name: string; type: "fridge" | "freezer" }>,
  previous: ColdUnit[],
): ColdUnit[] {
  const used = new Set<string>();
  return units.map((unit) => {
    const sameName = previous.find((p) => p.name.toLowerCase() === unit.name.toLowerCase() && !used.has(p.id));
    let id = unit.id && COLD_UNIT_ID.test(unit.id) && !used.has(unit.id) ? unit.id
      : sameName ? sameName.id
      : `u-${randomBytes(5).toString("hex")}`;
    while (used.has(id)) id = `u-${randomBytes(5).toString("hex")}`;
    used.add(id);
    return { id, name: unit.name, type: unit.type };
  });
}
