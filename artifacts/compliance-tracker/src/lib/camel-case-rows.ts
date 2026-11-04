/**
 * Some routes (e.g. /swim-track/*) return raw snake_case database rows, which
 * the mobile app reads as-is. Web pages that type those rows in camelCase map
 * them here so lists show every field and edit forms prefill losslessly.
 */
export function camelCaseRows<T>(rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [
      key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  ) as T);
}
