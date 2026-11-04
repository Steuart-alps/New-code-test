import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { addMonthsUtc } from "./complianceCompletion";

const DEFAULT_VISIT_FREQUENCY_MONTHS = 3;

/**
 * A new visit saved without a next visit date is due again after the
 * business's visit frequency (PestTrack settings), so every site keeps a due
 * date and an overdue visit shows up.
 */
export async function defaultNextVisitDate(clientId: number, visitDate: string): Promise<string | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return null;
  const [setting] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, "pest_visit_frequency_months")))
    .limit(1);
  const stored = Number(setting?.value);
  const months = Number.isInteger(stored) && stored >= 1 && stored <= 24 ? stored : DEFAULT_VISIT_FREQUENCY_MONTHS;
  const visit = new Date(`${visitDate}T00:00:00Z`);
  if (Number.isNaN(visit.getTime())) return null;
  return addMonthsUtc(visit, months).toISOString().slice(0, 10);
}
