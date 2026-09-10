import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * PIN roster API model.  The physical table is staff_roster for compatibility
 * with the richer roster and its existing compliance foreign keys.
 */
export const staffMembersTable = pgTable("staff_roster", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  name: text("name").notNull(),
  // Legacy roster columns remain nullable so name-based PIN CRUD can create
  // rows on both the original and compatibility layouts.
  firstName: text("first_name"),
  lastName: text("last_name"),
  role: text("role"),
  pinHash: text("pin_hash"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  pinAttempts: integer("pin_attempts").notNull().default(0),
  pinLockedUntil: timestamp("pin_locked_until"),
  pinSetupAttempts: integer("pin_setup_attempts").notNull().default(0),
  pinSetupLockedUntil: timestamp("pin_setup_locked_until"),
});

export const insertStaffMemberSchema = createInsertSchema(staffMembersTable).omit({
  id: true,
  createdAt: true,
  pinAttempts: true,
  pinLockedUntil: true,
});
export type StaffMember = typeof staffMembersTable.$inferSelect;
export type InsertStaffMember = z.infer<typeof insertStaffMemberSchema>;