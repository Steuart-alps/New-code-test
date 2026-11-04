import { inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";

/**
 * One Owner login for several businesses (Nov 2026). An Owner's own business
 * is users.client_id; every other business they own is a row in
 * owner_businesses. loadUser points currentUser.clientId at the one they're
 * working in, so routes need nothing extra. Code that looks for "the Owners
 * of business X" (emails, alerts) must also count the added Owners: use
 * ownersOfClient below.
 */

/** The businesses an Owner can switch between, in the order given (their own first). */
export async function ownerBusinessList(ids: number[]): Promise<{ id: number; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is { id: number; name: string } => row != null);
}

/**
 * SQL condition: the users row `alias` is an Owner of business `clientId`,
 * either their own business or one added to them. Use instead of
 * `client_id = X AND role = 'client_admin'`.
 */
export function ownersOfClient(clientId: number | SQL, alias = "users"): SQL {
  const u = sql.raw(`"${alias.replace(/"/g, "")}"`);
  return sql`(${u}.role = 'client_admin' AND (${u}.client_id = ${clientId}
    OR EXISTS (SELECT 1 FROM owner_businesses ob WHERE ob.user_id = ${u}.id AND ob.client_id = ${clientId})))`;
}

/** Whether user `userId` was added as an Owner of `clientId` (not their own business). */
export async function isAddedOwner(userId: number, clientId: number): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 FROM owner_businesses WHERE user_id = ${userId} AND client_id = ${clientId} LIMIT 1`);
  return (result.rows ?? []).length > 0;
}
