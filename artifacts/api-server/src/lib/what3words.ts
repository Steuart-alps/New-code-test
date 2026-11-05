import { z } from "zod";

/**
 * A what3words address as typed or pasted ("///filled.count.soap",
 * "Filled.Count.Soap", "filled count soap"), stored as "filled.count.soap".
 * Anything else is refused, so the link to what3words.com always opens.
 */
export function normaliseWhat3Words(value: string): string | null {
  const words = value.replace(/[​\s]+$/u, "").trim().replace(/^\/+/u, "").replace(/[​]/gu, "")
    .toLowerCase().split(/[.\s。．｡・]+/u).filter(Boolean);
  return words.length === 3 && words.every((w) => /^\p{L}+$/u.test(w)) ? words.join(".") : null;
}

/** Optional what3words field: blank saves null, anything else must be three words. */
export const what3wordsField = z.string().max(120).nullable().optional()
  .transform((value, ctx) => {
    if (value == null || !value.trim()) return value == null ? value : null;
    const words = normaliseWhat3Words(value);
    if (!words) {
      ctx.addIssue({ code: "custom", message: "A what3words address is three words with dots, like ///filled.count.soap" });
      return z.NEVER;
    }
    return words;
  });
export const latitudeField = z.number().min(-90).max(90).nullable().optional();
export const longitudeField = z.number().min(-180).max(180).nullable().optional();
