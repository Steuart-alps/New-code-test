import { randomUUID } from 'node:crypto';
import { db } from '@workspace/db';
import { appSettingsTable, auditEventsTable, trackActionsTable } from '@workspace/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { assessKitchenTemperatures, kitchenFailureValue, parseKitchenTemperatureRules } from '@workspace/api-zod/kitchen-temperature';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class KitchenTemperatureError extends Error {}
/** Diary write, failure provenance and follow-up creation share the transaction. */
export async function recordKitchenTemperatureActions(
  tx: Tx, before: Record<string, unknown> | null,
  after: Record<string, unknown>, clientId: number, siteId: number | null, actorId: number,
) {
  const keys = ['food_temperature_rules', 'food_cold_units', 'food_jurisdiction',
    ...(siteId === null ? [] : [`site.${siteId}.food_temperature_rules`, `site.${siteId}.food_cold_units`, `site.${siteId}.food_jurisdiction`])];
  const settings = await tx.select().from(appSettingsTable).where(and(
    eq(appSettingsTable.clientId, clientId), inArray(appSettingsTable.key, keys),
  ));
  const value = (key: string) => settings.find(s => s.key === `site.${siteId}.${key}`)?.value
    ?? settings.find(s => s.key === key)?.value;
  const rawRules = value('food_temperature_rules');
  let failures;
  try {
    failures = assessKitchenTemperatures(before, after, parseKitchenTemperatureRules(rawRules, value('food_jurisdiction')),
      JSON.parse(value('food_cold_units') || '[]'));
  } catch (error) {
    throw new KitchenTemperatureError(error instanceof Error ? error.message : 'Temperature rules could not be evaluated');
  }
  const missing = failures.filter(failure => !failure.actionTaken);
  if (missing.length) throw new KitchenTemperatureError(
    `Record the corrective action taken for each failed reading: ${missing.map(f => `${f.label} · ${f.field} (${kitchenFailureValue(f)})`).join('; ')}`,
  );
  for (const failure of failures) {
    const [action] = await tx.insert(trackActionsTable).values({
      clientId, siteId, module: 'kitchen',
      sourceKind: `kitchen_temperature_${randomUUID()}`, sourceRecordId: Number(after.id),
      provenance: 'product_default', severity: 'action_required', status: 'open',
      title: `Failed temperature: ${failure.label} · ${after.recordDate}`,
      instruction: `Diary ${after.recordDate}. ${failure.label} · ${failure.field}: ${kitchenFailureValue(failure)}. `
        + `Required range: ${failure.limit.min === null ? '' : `minimum ${failure.limit.min}; `}${failure.limit.max === null ? '' : `maximum ${failure.limit.max}; `}${failure.unit}. `
        + `Initial action taken: ${failure.actionTaken}. Keep the failed observation as historical evidence; attach verification evidence before manager sign-off.`,
      remedialAction: failure.actionTaken, createdBy: actorId,
    }).returning();
    await tx.insert(auditEventsTable).values({
      clientId, actorId, entityType: 'track_action', entityId: action.id,
      action: 'temperature_failure_created', after: action,
      metadata: { module: 'kitchen', diaryId: after.id, failure },
    });
  }
}