// Dropdown lists read A to Z so people can find an entry quickly. Catch-alls
// ("Other", "None", "N/A", "Not ...") stay at the bottom. Lists whose order
// carries meaning (pass/fail, severity, status, frequency, call point
// rotation) are left as written and should not go through these helpers.

const collator = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });
const CATCH_ALL = /^(other|none|n\/a|not)\b/i;

export function compareOptionLabels(a: string, b: string): number {
  const lastA = CATCH_ALL.test(a.trim());
  const lastB = CATCH_ALL.test(b.trim());
  if (lastA !== lastB) return lastA ? 1 : -1;
  return collator.compare(a, b);
}

/** A copy of `items` in A to Z order of `label`, catch-alls last. */
export function sortByLabel<T>(items: readonly T[], label: (item: T) => string | null | undefined): T[] {
  return [...items].sort((a, b) => compareOptionLabels(label(a) ?? "", label(b) ?? ""));
}

/** `Object.entries` of a value-to-label map, in A to Z order of label. */
export function sortedEntries<V extends string>(labels: Record<string, V>): [string, V][] {
  return sortByLabel(Object.entries(labels), ([, label]) => label);
}
