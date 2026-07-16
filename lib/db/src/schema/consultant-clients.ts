import { pgTable, serial, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

// Consultant <-> client membership. A consultant-role user may only view or act
// on client accounts they are explicitly linked to here (in addition to their
// own users.client_id). Self-signup owners get exactly one link — their
// auto-provisioned business.
export const consultantClientsTable = pgTable(
  "consultant_clients",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("consultant_clients_user_client_uq").on(t.userId, t.clientId)],
);

export type ConsultantClient = typeof consultantClientsTable.$inferSelect;
