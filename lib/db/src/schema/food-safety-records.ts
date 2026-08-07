import { pgTable, serial, text, timestamp, integer, date, jsonb } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const foodSafetyRecordsTable = pgTable("food_safety_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  recordDate: date("record_date").notNull(),
  deliveries: jsonb("deliveries").notNull().default([]),
  coldFood: jsonb("cold_food").notNull().default([]),
  hotTemperature: jsonb("hot_temperature").notNull().default([]),
  cooling: jsonb("cooling").notNull().default([]),
  reheating: jsonb("reheating").notNull().default([]),
  hotHolding: jsonb("hot_holding").notNull().default([]),
  sousVide: jsonb("sous_vide").notNull().default([]),
  cookingLimit: text("cooking_limit").notNull().default("Above 75°C (10 seconds)"),
  coolingLimit: text("cooling_limit").notNull().default("8°C within 90 minutes"),
  reheatingLimit: text("reheating_limit").notNull().default("Above 82°C"),
  hotHoldingLimit: text("hot_holding_limit").notNull().default("Above 63°C"),
  correctives: text("correctives"),
  managerSignature: text("manager_signature"),
  submittedAt: timestamp("submitted_at"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FoodSafetyRecord = typeof foodSafetyRecordsTable.$inferSelect;
