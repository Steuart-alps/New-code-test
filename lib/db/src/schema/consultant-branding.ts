import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// A consultant's practice branding, shown to the businesses they are linked to
// through consultant_clients ("Managed by <practice name>"). Keyed by the
// consultant user rather than a client because one practice spans many
// businesses. The logo is a finalised private object owned by the
// "consultant-<userId>" storage tenant, served only by the branding routes.
export const consultantBrandingTable = pgTable("consultant_branding", {
  consultantUserId: integer("consultant_user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  practiceName: text("practice_name"),
  logoObjectPath: text("logo_object_path"),
  logoContentType: text("logo_content_type"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ConsultantBrandingRow = typeof consultantBrandingTable.$inferSelect;
