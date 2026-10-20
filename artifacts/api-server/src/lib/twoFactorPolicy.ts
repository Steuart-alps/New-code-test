import { and, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { appSettingsTable, consultantClientsTable } from "@workspace/db/schema";
import type { UserRole } from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Client setting that lets a manager choose whether login accounts in their
 * business must use an authenticator app. Only "true" means required: absent,
 * blank or "false" leaves 2FA optional, so a new business can sign in with a
 * password and each person can turn 2FA on or off for their own account.
 */
export const REQUIRE_TWO_FACTOR_SETTING = "requireTwoFactor";

export function parseRequireTwoFactorSetting(value: string | null | undefined): boolean {
  return value === "true";
}

/**
 * Whether this account must have TOTP enrolled before it can use the app.
 * The strictest client wins: a user must enrol when any client account they
 * belong to (their own plus, for consultants, every linked client) has turned
 * the requirement on. Accounts with no client are not required, and a lookup
 * failure fails closed.
 */
export async function isTwoFactorRequired(user: {
  id: number;
  role: UserRole;
  clientId: number | null;
}): Promise<boolean> {
  try {
    const clientIds = new Set<number>();
    if (user.clientId != null) clientIds.add(user.clientId);
    if (user.role === "consultant") {
      const memberships = await db
        .select({ clientId: consultantClientsTable.clientId })
        .from(consultantClientsTable)
        .where(eq(consultantClientsTable.userId, user.id));
      for (const membership of memberships) clientIds.add(membership.clientId);
    }
    if (clientIds.size === 0) return false;

    const rows = await db
      .select({ clientId: appSettingsTable.clientId, value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(and(
        inArray(appSettingsTable.clientId, [...clientIds]),
        eq(appSettingsTable.key, REQUIRE_TWO_FACTOR_SETTING),
      ));
    return rows.some((row) => parseRequireTwoFactorSetting(row.value));
  } catch (err) {
    logger.error({ err, userId: user.id }, "Could not read the two-factor policy; requiring 2FA");
    return true;
  }
}
