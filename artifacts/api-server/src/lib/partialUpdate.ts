import { z } from "zod";
import type * as core from "zod/v4/core";

/**
 * `schema.partial()` for update bodies, where a field the request leaves out
 * must stay out so the saved value is kept.
 *
 * Zod 4's own `.partial()` still fills in each field's `.default()` when the
 * key is missing, so an update that omits, say, `clean` would reset it to
 * `false`. Wrapping each field in a pass-through preprocess stops the default
 * from running for a missing key while leaving the field's own validation and
 * error messages unchanged when a value is sent.
 */
export function partialUpdate<Shape extends core.$ZodShape, Config extends core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
): z.ZodObject<{ -readonly [K in keyof Shape]: z.ZodOptional<Shape[K]> }, Config> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = z.preprocess((value) => value, field as unknown as z.ZodType);
  }
  return schema.extend(shape).partial() as unknown as z.ZodObject<
    { -readonly [K in keyof Shape]: z.ZodOptional<Shape[K]> },
    Config
  >;
}
