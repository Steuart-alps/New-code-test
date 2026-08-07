import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { departmentsTable } from "./departments";

export const userRoleEnum = ["consultant", "client_admin", "client_staff", "client_viewer"] as const;
export type UserRole = (typeof userRoleEnum)[number];

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").$type<UserRole>().notNull().default("client_viewer"),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "cascade" }),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  stripeCustomerId: text("stripe_customer_id"),
  subscriptionStatus: text("subscription_status").default("trial"),
  gcMandateId: text("gc_mandate_id"),
  gcSubscriptionId: text("gc_subscription_id"),
  gcCustomerId: text("gc_customer_id"),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpRecoveryHash: text("totp_recovery_hash"),
  isMaintenanceManager: boolean("is_maintenance_manager").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  passwordHash: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type SafeUser = Omit<User, "passwordHash" | "totpRecoveryHash">;
