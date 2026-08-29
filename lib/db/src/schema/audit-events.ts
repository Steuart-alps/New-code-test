import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

/** Immutable, tenant-owned record of compliance changes. */
export const auditEventsTable = pgTable("audit_events", {
  id: serial("id").primaryKey(),
  // Preserve audit evidence; client cleanup must be an explicit retention process.
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "restrict" }),
  actorId: integer("actor_id").references(() => usersTable.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});