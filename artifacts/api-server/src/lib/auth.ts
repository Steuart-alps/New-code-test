import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, clientsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { SafeUser } from "@workspace/db/schema";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function getUserById(id: number): Promise<SafeUser | null> {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      clientId: usersTable.clientId,
      departmentId: usersTable.departmentId,
      active: usersTable.active,
      createdAt: usersTable.createdAt,
      updatedAt: usersTable.updatedAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id));
  return rows[0] ?? null;
}

export async function getUserWithClientByEmail(email: string) {
  const rows = await db
    .select({
      user: usersTable,
      client: clientsTable,
    })
    .from(usersTable)
    .leftJoin(clientsTable, eq(usersTable.clientId, clientsTable.id))
    .where(eq(usersTable.email, email));
  return rows[0] ?? null;
}
