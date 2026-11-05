import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { TRACK_MODULES } from "./trackModules";

/** app_settings key holding the service keys picked in the setup wizard's Modules step. */
export const PICKED_MODULES_SETTING = "setup_modules";

export function parsePickedModules(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Service keys picked in the setup wizard ("Modules to start with"); empty when none were picked. */
export async function getPickedModules(clientId: number): Promise<string[]> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, PICKED_MODULES_SETTING)));
  return parsePickedModules(row?.value);
}

/**
 * The track module keys (lib/trackModules.ts) that the business picked in
 * setup. Only explicit picks count: nothing picked gives an empty set.
 */
export function pickedTrackModuleKeys(picked: readonly string[]): Set<string> {
  const keys = new Set(picked);
  return new Set(TRACK_MODULES
    .filter((module) => module.services.some((service) => service !== "core" && keys.has(service)))
    .map((module) => module.key));
}
