/**
 * Shared helper: resolve the notification email recipients for a client.
 *
 * Priority order:
 * 1. If the client has a `notificationEmail` setting configured in app_settings,
 *    that address is the senior/admin recipient for automated digest emails.
 *    Individual jobs may add separately configured operational recipients.
 * 2. Otherwise, falls back to querying active client_admin users (and optionally
 *    maintenance managers) for the client.
 *
 * Returns `{ emails, userIds }` so callers can pass userIds to push notification
 * helpers without breaking their existing push logic.
 */

import { db } from "@workspace/db";
import { appSettingsTable, usersTable } from "@workspace/db/schema";
import { and, eq, or } from "drizzle-orm";

export interface NotificationRecipients {
  /** De-duplicated list of email addresses to notify. */
  emails: string[];
  /**
   * User IDs of the recipients (for push notification dispatch).
   * Empty when a client-level notificationEmail overrides the user lookup.
   */
  userIds: number[];
}

export async function getNotificationEmails(
  clientId: number,
  options: { includeMaintenanceManagers?: boolean } = {},
): Promise<NotificationRecipients> {
  // 1. Check for a client-level notification email override.
  const [notifRow] = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(
      and(
        eq(appSettingsTable.clientId, clientId),
        eq(appSettingsTable.key, "notificationEmail"),
      ),
    )
    .limit(1);

  const notifEmail = notifRow?.value?.trim();
  if (notifEmail) {
    return { emails: [notifEmail], userIds: [] };
  }

  // 2. Fall back to admin (and optionally maintenance manager) user accounts.
  const whereClause = options.includeMaintenanceManagers
    ? and(
        eq(usersTable.clientId, clientId),
        eq(usersTable.active, true),
        or(
          eq(usersTable.role, "client_admin"),
          eq(usersTable.isMaintenanceManager, true),
        ),
      )
    : and(
        eq(usersTable.clientId, clientId),
        eq(usersTable.active, true),
        eq(usersTable.role, "client_admin"),
      );

  const admins = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(whereClause)
    .limit(30);

  const emails = [
    ...new Set(admins.map((a) => a.email).filter(Boolean) as string[]),
  ];
  const userIds = [...new Set(admins.map((a) => a.id))];

  return { emails, userIds };
}
