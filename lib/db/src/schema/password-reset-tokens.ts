import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const passwordResetTokensTable = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  // Set (with used_at) when an admin cancels a setup link without sending a
  // new one. Who did it is in audit_events (entity "user", "setup_link_revoked").
  revokedAt: timestamp("revoked_at"),
  // Set (with used_at) when the invitation email couldn't be delivered.
  emailFailedAt: timestamp("email_failed_at"),
  // "invite" for admin-sent password setup links, "reset" for forgot-password
  // links. User Management shows setup state from the latest "invite" row.
  purpose: text("purpose").$type<"invite" | "reset">().notNull().default("reset"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
