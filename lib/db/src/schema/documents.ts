import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const clientDocumentsTable = pgTable("client_documents", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  objectPath: text("object_path").notNull(), // e.g. /objects/uploads/<uuid>
  fileSize: integer("file_size"),           // bytes
  mimeType: text("mime_type"),
  uploadedById: integer("uploaded_by_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  uploadedByName: text("uploaded_by_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
