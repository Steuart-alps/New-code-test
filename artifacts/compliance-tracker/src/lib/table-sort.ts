// Sorting for list tables whose column headings people click to sort, filter
// and search (see components/column-header.tsx). Kept free of React so it can
// be tested on its own.

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }
export type SortValue = string | number | boolean | null | undefined;
export type SortAccessors<T> = Record<string, (row: T) => SortValue>;

const collator = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });

const isBlank = (v: SortValue) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Compares two non-blank values: numbers as numbers, text A to Z ignoring case. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * A copy of `rows` in the chosen order. Blank values always go last, whichever
 * way the column is sorted, and rows that tie keep the order they came in.
 * With no sort, or a key with no accessor, the rows are returned as they came.
 */
export function sortRows<T>(rows: readonly T[], sort: SortState | null | undefined, accessors: SortAccessors<T>): T[] {
  const accessor = sort ? accessors[sort.key] : undefined;
  if (!sort || !accessor) return [...rows];
  const flip = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: accessor(row) }))
    .sort((a, b) => {
      const blankA = isBlank(a.value), blankB = isBlank(b.value);
      if (blankA || blankB) return blankA === blankB ? a.index - b.index : blankA ? 1 : -1;
      return compareSortValues(a.value, b.value) * flip || a.index - b.index;
    })
    .map(entry => entry.row);
}

/** Position of `value` in a list whose order carries meaning (severity, status); unknown values go last. */
export function rankIn(order: readonly string[], value: string | null | undefined): number {
  const index = value == null ? -1 : order.indexOf(value);
  return index === -1 ? order.length : index;
}

/** Case-insensitive "contains" used by the column search boxes. */
export function matchesSearch(text: string | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || (text ?? "").toLowerCase().includes(q);
}
