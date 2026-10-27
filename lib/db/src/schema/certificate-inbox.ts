import { check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { complianceItemsTable } from "./compliance-items";
import { contractorsTable } from "./contractors";
import { certificatesTable } from "./certificates";
import { usersTable } from "./users";

/**
 * Certificates sent to ComplyTrack instead of being uploaded by a signed-in
 * person (api-server src/lib/certificateInbox.ts): emailed to the business's
 * own certificate address, or uploaded by a contractor through the "Upload
 * certificate" link in their emails. Each one waits in "Certificates to
 * confirm" until someone checks and saves it; nothing is filed on its own.
 * All tables are also created by the runtime migrations.
 */

/** The business's certificate address: <local_part>@CERTIFICATE_INBOX_DOMAIN. */
export const certificateInboxAddressesTable = pgTable("certificate_inbox_addresses", {
  clientId: integer("client_id").primaryKey().references(() => clientsTable.id, { onDelete: "cascade" }),
  localPart: text("local_part").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_certificate_inbox_addresses_local_part").on(table.localPart),
]);

/**
 * One email Resend received for a certificate address. The webhook only
 * records it; its attachments are fetched and filed as inbox items afterwards,
 * so a slow download never holds up (or repeats) the webhook.
 */
export const certificateInboxEmailStatusEnum = ["pending", "done", "failed", "ignored"] as const;
export const certificateInboxEmailsTable = pgTable("certificate_inbox_emails", {
  id: serial("id").primaryKey(),
  providerEmailId: text("provider_email_id").notNull(),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "cascade" }),
  fromAddress: text("from_address").notNull(),
  subject: text("subject"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("uq_certificate_inbox_emails_provider").on(table.providerEmailId),
  index("idx_certificate_inbox_emails_status").on(table.status, table.receivedAt),
  check("ck_certificate_inbox_emails_status", sql`${table.status} IN ('pending', 'done', 'failed', 'ignored')`),
]);

/** A contractor's "Upload certificate" link for one compliance check. Only the token's digest is kept. */
export const certificateUploadLinksTable = pgTable("certificate_upload_links", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => complianceItemsTable.id, { onDelete: "cascade" }),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull(),
  uploads: integer("uploads").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_certificate_upload_links_token").on(table.tokenHash),
  index("idx_certificate_upload_links_item").on(table.clientId, table.itemId),
]);

/**
 * A certificate waiting to be confirmed. "held" = from a sender the business
 * does not know (never read by AI until someone accepts it); "message" = an
 * email with no certificate attached, kept so a contractor's reply is not lost.
 */
export const certificateInboxItemStatusEnum = ["reading", "ready", "held", "message", "filed", "dismissed"] as const;
export type CertificateInboxItemStatus = (typeof certificateInboxItemStatusEnum)[number];
export const certificateInboxItemsTable = pgTable("certificate_inbox_items", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  status: text("status").notNull(),
  emailId: integer("email_id").references(() => certificateInboxEmailsTable.id, { onDelete: "set null" }),
  uploadLinkId: integer("upload_link_id").references(() => certificateUploadLinksTable.id, { onDelete: "set null" }),
  /** Provider attachment id (email) or a random id (upload): one item per file. */
  externalRef: text("external_ref").notNull(),
  senderEmail: text("sender_email"),
  senderName: text("sender_name"),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "set null" }),
  /** The check the upload link was for, or the one the AI matched. */
  itemId: integer("item_id").references(() => complianceItemsTable.id, { onDelete: "set null" }),
  subject: text("subject"),
  messageText: text("message_text"),
  fileName: text("file_name"),
  contentType: text("content_type"),
  objectPath: text("object_path"),
  byteSize: integer("byte_size"),
  reading: jsonb("reading"),
  readingError: text("reading_error"),
  certificateId: integer("certificate_id").references(() => certificatesTable.id, { onDelete: "set null" }),
  handledBy: integer("handled_by").references(() => usersTable.id, { onDelete: "set null" }),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_certificate_inbox_items_ref").on(table.clientId, table.externalRef),
  index("idx_certificate_inbox_items_client_status").on(table.clientId, table.status),
  check("ck_certificate_inbox_items_source", sql`${table.source} IN ('email', 'upload')`),
  check("ck_certificate_inbox_items_status", sql`${table.status} IN ('reading', 'ready', 'held', 'message', 'filed', 'dismissed')`),
]);

export type CertificateInboxItem = typeof certificateInboxItemsTable.$inferSelect;
