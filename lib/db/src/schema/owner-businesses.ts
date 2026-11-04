import { pgTable, serial, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

// An Owner (client_admin) who also owns other businesses. Their own business
// stays users.client_id; each extra business they own is a row here. They use
// one login and switch between the businesses (PUT /users/me/active-business),
// and each business keeps its own data and its own subscription.
export const ownerBusinessesTable = pgTable(
  "owner_businesses",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    addedBy: integer("added_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("owner_businesses_user_client_uq").on(t.userId, t.clientId),
    index("owner_businesses_client_idx").on(t.clientId),
  ],
);

export type OwnerBusiness = typeof ownerBusinessesTable.$inferSelect;
