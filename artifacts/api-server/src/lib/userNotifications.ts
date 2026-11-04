/**
 * In-app notifications: rows in user_notifications, shown by the web app's
 * header bell and mirrored to the mobile app as an Expo push. Creation is
 * idempotent per (user, dedupe key), so a reminder job can re-run safely and
 * two instances cannot notify the same person twice; a push is sent only for
 * rows that were actually inserted. Push failures never fail the caller.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendPushToUsers } from "./pushNotifications";
import { getTrackModule } from "./trackModules";

export interface NewUserNotification {
  clientId: number;
  userId: number;
  module: string | null;
  siteId: number | null;
  kind: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  dedupeKey: string;
}

export interface CreateNotificationOptions {
  sendPush?: typeof sendPushToUsers;
}

/** Notifications older than this are deleted by the reminder job. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** Insert notifications (skipping duplicates) and push each new one. Returns how many were created. */
export async function createUserNotifications(
  notifications: NewUserNotification[],
  options: CreateNotificationOptions = {},
): Promise<number> {
  const sendPush = options.sendPush ?? sendPushToUsers;
  let created = 0;
  for (const item of notifications) {
    const inserted = await db.execute(sql`
      INSERT INTO user_notifications
        (client_id, user_id, module, site_id, kind, title, body, link_path, dedupe_key)
      VALUES (${item.clientId}, ${item.userId}, ${item.module}, ${item.siteId}, ${item.kind},
              ${item.title}, ${item.body}, ${item.linkPath}, ${item.dedupeKey})
      ON CONFLICT (user_id, dedupe_key) DO NOTHING
      RETURNING id
    `);
    const row = (inserted.rows[0] as { id: number } | undefined);
    if (!row) continue;
    created++;
    try {
      await sendPush([item.userId], {
        title: item.title,
        body: item.body ?? "",
        data: {
          route: (item.module && getTrackModule(item.module)?.mobileRoute) ?? "/(tabs)",
          link: item.linkPath,
          notificationId: Number(row.id),
          clientId: item.clientId,
        },
      });
    } catch (err) {
      logger.warn({ err, notificationId: row.id }, "Notification push failed");
    }
  }
  return created;
}

/** Delete notifications past the retention window. Returns the number removed. */
export async function purgeOldUserNotifications(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM user_notifications
    WHERE created_at < now() - make_interval(days => ${NOTIFICATION_RETENTION_DAYS})
    RETURNING id
  `);
  return result.rows.length;
}
