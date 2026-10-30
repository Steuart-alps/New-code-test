/**
 * Reading suppliers' allergen information in a spreadsheet, for the
 * KitchenTrack ingredients import (csvImport.ts "allergen-ingredients").
 *
 * Suppliers send it in one of two shapes, and both are accepted:
 *  - a matrix: a column per allergen with Y / N / May contain in each cell;
 *  - lists: a "Contains" column and a "May contain" column naming allergens.
 *
 * Nothing is guessed: a cell or a name that is not clearly one of the 14
 * allergens is reported on that row, so a person fixes the file rather than
 * the app deciding. Pure, so it can be tested without a database.
 */
import { ALLERGEN_KEYS, type AllergenKey } from "./allergenRecipes";

/**
 * Header spellings for the per-allergen columns. A header matches when its
 * letters and digits (lower case) start with one of these, so
 * "Cereals containing gluten (wheat, rye)" and "Milk / lactose" match.
 */
export const ALLERGEN_COLUMN_PREFIXES: Record<AllergenKey, string[]> = {
  celery: ["celery", "celeriac"],
  gluten: ["gluten", "cereals", "cereal", "wheat"],
  crustaceans: ["crustacean"],
  eggs: ["egg"],
  fish: ["fish"],
  lupin: ["lupin", "lupine"],
  milk: ["milk", "dairy", "lactose"],
  molluscs: ["mollusc", "mollusk"],
  mustard: ["mustard"],
  // "nuts" but never "nut": that would also match "Nutrition".
  tree_nuts: ["treenut", "nuts"],
  peanuts: ["peanut", "groundnut", "arachis"],
  sesame: ["sesame"],
  soya: ["soya", "soy"],
  sulphites: ["sulphite", "sulphur", "sulfite", "sulfur", "so2"],
};

/** The column labels the import template uses, in the regulated order. */
export const ALLERGEN_COLUMN_LABELS: Record<AllergenKey, string> = {
  celery: "Celery", gluten: "Gluten", crustaceans: "Crustaceans", eggs: "Eggs", fish: "Fish",
  lupin: "Lupin", milk: "Milk", molluscs: "Molluscs", mustard: "Mustard", tree_nuts: "Tree nuts",
  peanuts: "Peanuts", sesame: "Sesame", soya: "Soya", sulphites: "Sulphites",
};

/**
 * Names in a "Contains" or "May contain" list: the allergens, plus the foods
 * the law names inside them (wheat is gluten, almond is a tree nut). Matched
 * on the start of each name; coconut, nutmeg and pine nut are not tree nuts
 * in UK law and are not listed.
 */
const NAME_PREFIXES: Array<[string, AllergenKey]> = [
  ["celery", "celery"], ["celeriac", "celery"],
  ["cerealscontaininggluten", "gluten"], ["gluten", "gluten"], ["cereal", "gluten"], ["wheat", "gluten"],
  ["barley", "gluten"], ["rye", "gluten"], ["oat", "gluten"], ["spelt", "gluten"], ["kamut", "gluten"], ["khorasan", "gluten"],
  ["crustacean", "crustaceans"], ["prawn", "crustaceans"], ["shrimp", "crustaceans"], ["crab", "crustaceans"],
  ["lobster", "crustaceans"], ["crayfish", "crustaceans"], ["langoustine", "crustaceans"], ["scampi", "crustaceans"],
  ["egg", "eggs"],
  ["fish", "fish"],
  ["lupin", "lupin"],
  ["milk", "milk"], ["dairy", "milk"], ["lactose", "milk"], ["butter", "milk"], ["cream", "milk"], ["cheese", "milk"],
  ["yoghurt", "milk"], ["yogurt", "milk"], ["whey", "milk"], ["casein", "milk"],
  ["mollusc", "molluscs"], ["mollusk", "molluscs"], ["mussel", "molluscs"], ["oyster", "molluscs"], ["squid", "molluscs"],
  ["octopus", "molluscs"], ["clam", "molluscs"], ["scallop", "molluscs"], ["snail", "molluscs"], ["whelk", "molluscs"],
  ["cockle", "molluscs"], ["cuttlefish", "molluscs"],
  ["mustard", "mustard"],
  ["treenut", "tree_nuts"], ["nuts", "tree_nuts"], ["nut", "tree_nuts"], ["almond", "tree_nuts"], ["hazelnut", "tree_nuts"],
  ["walnut", "tree_nuts"], ["cashew", "tree_nuts"], ["pecan", "tree_nuts"], ["brazilnut", "tree_nuts"], ["pistachio", "tree_nuts"],
  ["macadamia", "tree_nuts"], ["queenslandnut", "tree_nuts"],
  ["peanut", "peanuts"], ["groundnut", "peanuts"], ["arachis", "peanuts"],
  ["sesame", "sesame"],
  ["soya", "soya"], ["soy", "soya"],
  ["sulphite", "sulphites"], ["sulphurdioxide", "sulphites"], ["sulfite", "sulphites"], ["sulfurdioxide", "sulphites"],
  ["so2", "sulphites"], ["sulphur", "sulphites"], ["sulfur", "sulphites"],
];

/** Words in a list cell that mean "none of them". */
const NONE_WORDS = new Set(["", "none", "nil", "na", "no", "nothing", "noallergens", "free", "notapplicable"]);

const letters = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The allergen a matrix column heading is for, if any. */
export function allergenForHeader(normalisedHeader: string): AllergenKey | null {
  for (const key of ALLERGEN_KEYS) {
    if (ALLERGEN_COLUMN_PREFIXES[key].some((prefix) => normalisedHeader.startsWith(prefix))) return key;
  }
  return null;
}

export type AllergenCell = "contains" | "may" | "none";

/**
 * One matrix cell. Y / Yes / X / a tick / Contains mean it contains the
 * allergen; M / May contain / Trace mean a "may contain" warning; N / No /
 * blank / a dash mean it does not. Anything else is null (not understood).
 */
export function parseAllergenCell(raw: string): AllergenCell | null {
  const text = raw.trim().toLowerCase();
  const word = letters(text);
  if (!word && /^[-–—]?$/.test(text)) return "none";
  if (word.startsWith("may") || word.includes("trace") || word === "m" || word === "mc" || word === "t" || word.includes("risk")) return "may";
  if (/^[✓✔√☑]$/.test(text) || ["y", "yes", "x", "c", "1", "true", "contains", "present", "ingredient"].includes(word)
    || word.startsWith("yes") || word.startsWith("contains")) return "contains";
  if (["n", "no", "0", "false", "none", "free", "absent", "na", "nil", "notpresent", "doesnotcontain"].includes(word)
    || word.startsWith("no") || word.startsWith("free")) return "none";
  return null;
}

/**
 * The allergens named in a "Contains" or "May contain" cell, such as
 * "Milk; Eggs" or "Cereals containing gluten (wheat, barley), soya".
 * Names that are not one of the 14 come back in `unknown`.
 */
export function allergensInText(raw: string): { keys: AllergenKey[]; unknown: string[] } {
  const keys = new Set<AllergenKey>();
  const unknown: string[] = [];
  const parts = raw.split(/[;,|/\n()]+|\s+and\s+|\s*&\s*/i).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const word = letters(part.replace(/^(contains|may contain|traces? of|may contain traces of)\s*:?\s*/i, ""));
    if (NONE_WORDS.has(word)) continue;
    const match = NAME_PREFIXES.find(([prefix]) => word.startsWith(prefix));
    if (match) keys.add(match[1]);
    else unknown.push(part);
  }
  return { keys: ALLERGEN_KEYS.filter((key) => keys.has(key)), unknown };
}
