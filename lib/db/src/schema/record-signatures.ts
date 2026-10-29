import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/**
 * A drawn signature on a recorded check (api-server src/lib/recordSignatures.ts).
 * The web app asks for one when a check is saved or submitted: the person
 * draws it, it is stored here first under a one-use token, and the save that
 * carries the token links it to the record it created. The signer is always
 * the logged-in user. Strokes are points in a 600 x 200 box ([x, y, x, y, ...]
 * per stroke), about 1-2 KB a signature. Also created by the runtime
 * migrations.
 */
export const recordSignaturesTable = pgTable("record_signatures", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  signerName: text("signer_name").notNull(),
  strokes: jsonb("strokes").notNull(),
  recordType: text("record_type"),
  recordId: integer("record_id"),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
}, table => ({
  token: uniqueIndex("uq_record_signatures_token").on(table.token),
  record: index("idx_record_signatures_record").on(table.clientId, table.recordType, table.recordId),
}));

export type RecordSignature = typeof recordSignaturesTable.$inferSelect;
