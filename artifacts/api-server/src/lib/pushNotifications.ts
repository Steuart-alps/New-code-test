/**
 * Server-side Expo push notification sending.
 *
 * Sends notifications to registered device tokens (push_tokens table) via
 * Expo's push service (https://exp.host/--/api/v2/push/send). No API key is
 * required. Tokens that Expo reports as DeviceNotRegistered are pruned so we
 * stop sending to uninstalled apps.
 *
 * All failures are non-fatal: callers (notification jobs) should never break
 * because a push failed to send. Errors are logged and swallowed.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
// Expo recommends a max of 100 messages per request.
const BATCH_SIZE = 100;

export interface PushPayload {
  title: string;
  body: string;
  /** Optional structured data delivered with the notification (e.g. a route hint). */
  data?: Record<string, unknown>;
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  data?: Record<string, unknown>;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Look up all registered Expo push tokens for the given user IDs. */
async function getTokensForUsers(userIds: number[]): Promise<string[]> {
  const unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length === 0) return [];
  const result = await db.execute(sql`
    SELECT DISTINCT token FROM push_tokens
    WHERE user_id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
  `);
  return ((result as any).rows ?? [])
    .map((r: any) => r.token as string)
    .filter(Boolean);
}

/** Delete tokens that Expo reported as no longer registered. */
async function pruneTokens(tokens: string[]): Promise<void> {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (unique.length === 0) return;
  try {
    await db.execute(sql`
      DELETE FROM push_tokens
      WHERE token IN (${sql.join(unique.map((t) => sql`${t}`), sql`, `)})
    `);
    logger.info({ count: unique.length }, "Pruned unregistered push tokens");
  } catch (err) {
    logger.warn({ err }, "Failed to prune push tokens");
  }
}

/**
 * Send a push notification to every device registered to any of the given
 * users. Non-fatal: logs and returns on any error. Returns the number of
 * messages Expo accepted (best-effort; 0 on failure).
 */
export async function sendPushToUsers(
  userIds: number[],
  payload: PushPayload,
): Promise<number> {
  try {
    const tokens = await getTokensForUsers(userIds);
    if (tokens.length === 0) return 0;

    const messages: ExpoMessage[] = tokens.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      sound: "default",
      ...(payload.data ? { data: payload.data } : {}),
    }));

    let accepted = 0;
    const tokensToPrune: string[] = [];

    for (const batch of chunk(messages, BATCH_SIZE)) {
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, "Expo push request failed");
          continue;
        }
        const json = (await res.json()) as { data?: ExpoTicket[] };
        const tickets = json.data ?? [];
        tickets.forEach((ticket, i) => {
          if (ticket.status === "ok") {
            accepted++;
          } else if (ticket.details?.error === "DeviceNotRegistered") {
            const bad = batch[i]?.to;
            if (bad) tokensToPrune.push(bad);
          } else {
            logger.warn({ ticket }, "Expo push ticket error");
          }
        });
      } catch (batchErr) {
        logger.warn({ err: batchErr }, "Expo push batch failed");
      }
    }

    if (tokensToPrune.length > 0) await pruneTokens(tokensToPrune);
    return accepted;
  } catch (err) {
    logger.error({ err }, "sendPushToUsers failed");
    return 0;
  }
}
