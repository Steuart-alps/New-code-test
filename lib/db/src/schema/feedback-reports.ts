import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const feedbackReportsTable = pgTable("feedback_reports", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  summary: text("summary").notNull(),
  details: text("details").notNull(),
  pagePath: text("page_path"),
  emailStatus: text("email_status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});