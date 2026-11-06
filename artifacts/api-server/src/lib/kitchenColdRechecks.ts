/**
 * Cold storage re-checks (Steuart, 5 Nov 2026: "if a fail on cold storage,
 * request a re-check after 1 hour").
 *
 * When a fridge or freezer reading (the diary's AM or PM reading) fails, its
 * "Failed temperature" action asks for a re-check in an hour, and the diary
 * line gets a Re-check box (coldFood row `recheckTemp`, assessed against the
 * same limit as the reading). This job runs every five minutes and, once an
 * hour has passed since the failed reading was saved and the line still has
 * no re-check, sends one in-app reminder (bell + phone push) to whoever
 * recorded the reading and to KitchenTrack's owner for the site. Each failed
 * reading is reminded once (dedupe key per action). A re-check that fails
 * opens its own failed-temperature action but asks for no further re-check.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { getTrackModule } from "./trackModules";
import { isClientBillingLocked } from "./trialLock";
import { loadOwnerContext, resolveOwnersFromContext, type OwnerContext } from "./trackOwners";
import { createUserNotifications, type NewUserNotification } from "./userNotifications";
import type { sendPushToUsers } from "./pushNotifications";

/** Minutes after a failed fridge or freezer reading that the re-check is due. */
export const COLD_RECHECK_AFTER_MINUTES = 60;
/** Failed readings older than this are not reminded (a restart or outage never sends stale reminders). */
const RECHECK_REMINDER_WINDOW_HOURS = 6;
/** The diary fields whose failure asks for a re-check. */
export const COLD_RECHECK_FIELDS = ["tempAm", "tempPm"] as const;

export interface ColdRecheckJobOptions {
  now?: Date;
  clientIds?: number[];
  sendPush?: typeof sendPushToUsers;
}

interface DueRow {
  action_id: number;
  client_id: number;
  site_id: number | null;
  created_by: number | null;
  site_name: string | null;
  failure: { rowIndex?: number; label?: string; value?: number } | null;
  cold_food: unknown;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

export async function runKitchenColdRecheckJob(options: ColdRecheckJobOptions = {}) {
  const now = options.now ?? new Date();
  const dueBefore = new Date(now.getTime() - COLD_RECHECK_AFTER_MINUTES * 60_000);
  const notBefore = new Date(now.getTime() - RECHECK_REMINDER_WINDOW_HOURS * 3_600_000);
  const clientFilter = options.clientIds
    ? options.clientIds.length
      ? sql`AND a.client_id IN (${sql.join(options.clientIds.map((id) => sql`${id}`), sql`, `)})`
      : sql`AND false`
    : sql``;
  const due = rowsOf<DueRow>(await db.execute(sql`
    SELECT a.id AS action_id, a.client_id, a.site_id, a.created_by, s.name AS site_name,
           e.metadata->'failure' AS failure, f.cold_food
    FROM track_actions a
    JOIN audit_events e ON e.client_id = a.client_id AND e.entity_type = 'track_action'
      AND e.entity_id = a.id AND e.action = 'temperature_failure_created'
    JOIN food_safety_records f ON f.id = a.source_record_id AND f.client_id = a.client_id
    JOIN clients c ON c.id = a.client_id AND c.active = true
    LEFT JOIN sites s ON s.id = a.site_id
    WHERE a.module = 'kitchen' AND a.source_kind LIKE 'kitchen_temperature_%'
      AND a.status <> 'resolved'
      AND e.metadata->'failure'->>'section' = 'coldFood'
      AND e.metadata->'failure'->>'field' IN ('tempAm', 'tempPm')
      AND a.created_at <= ${dueBefore.toISOString()}::timestamp
      AND a.created_at > ${notBefore.toISOString()}::timestamp
      ${clientFilter}
  `));
  const result = { found: 0, notificationsCreated: 0, errors: 0 };
  const byClient = new Map<number, DueRow[]>();
  for (const row of due) {
    const rows = Array.isArray(row.cold_food) ? row.cold_food as Array<Record<string, unknown>> : [];
    const line = rows[Number(row.failure?.rowIndex)];
    // Already re-checked (or the line was removed): nothing to ask.
    if (!line || String(line.recheckTemp ?? "").trim() !== "") continue;
    result.found++;
    const clientId = Number(row.client_id);
    byClient.set(clientId, [...(byClient.get(clientId) ?? []), row]);
  }
  for (const [clientId, rows] of byClient) {
    try {
      if (await isClientBillingLocked(clientId).catch(() => false)) continue;
      const ctx: OwnerContext = await loadOwnerContext(clientId);
      const items: NewUserNotification[] = [];
      for (const row of rows) {
        const siteId = row.site_id == null ? null : Number(row.site_id);
        const unit = row.failure?.label || "the fridge or freezer";
        const recipients = new Set(resolveOwnersFromContext(ctx, "kitchen", siteId));
        if (row.created_by != null && ctx.eligible.has(Number(row.created_by))) recipients.add(Number(row.created_by));
        for (const userId of recipients) {
          items.push({
            clientId, userId, module: "kitchen", siteId, kind: "kitchen_cold_recheck",
            title: `Re-check ${unit} now${row.site_name ? ` — ${row.site_name}` : ""}`,
            body: `${unit} read ${row.failure?.value ?? "out of range"}°C an hour ago. Take the temperature again and record it in the Re-check box on today's kitchen diary.`,
            linkPath: getTrackModule("kitchen")!.path,
            dedupeKey: `kitchen_cold_recheck:action:${row.action_id}`,
          });
        }
      }
      if (items.length) result.notificationsCreated += await createUserNotifications(items, { sendPush: options.sendPush });
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Kitchen cold re-check reminders failed");
    }
  }
  return result;
}
