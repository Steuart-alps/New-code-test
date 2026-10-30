import { pgTable, serial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { departmentsTable } from "./departments";

export const sitesTable = pgTable("sites", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  departmentId: integer("department_id")
    .references(() => departmentsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  responsiblePerson: text("responsible_person"),
  address: text("address"),
  phone: text("phone"),
  // Bedrooms or other sleeping accommodation at the site, and whether a night
  // porter is on duty overnight; null until answered (set-up or Sites). They
  // decide the site's fire walks: the escape route sign-off only applies with
  // sleeping accommodation, a night porter walks at 22:00, 02:00 and 06:00,
  // and without one the walk is on the opening and closing checklists.
  sleepingAccommodation: boolean("sleeping_accommodation"),
  nightPorter: boolean("night_porter"),
  // When the night porter answer last became yes: walks before it are never
  // counted as missed.
  nightPorterSince: timestamp("night_porter_since"),
  // When the site's opening and closing checks are due ("HH:MM" on the
  // business's clock); null means 06:00 and 18:00. Owners and Managers set
  // them (api-server lib/checklistDueTimes.ts).
  openingChecksDue: text("opening_checks_due"),
  closingChecksDue: text("closing_checks_due"),
  // When the reminder about checks still not submitted goes out ("HH:MM");
  // null means 11:00 for opening and 21:00 for closing.
  openingReminderAt: text("opening_reminder_at"),
  closingReminderAt: text("closing_reminder_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Created by the api-server runtime migrations (dashboard read paths).
  index("IDX_sites_client").on(table.clientId),
]);

export const insertSiteSchema = createInsertSchema(sitesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sitesTable.$inferSelect;
