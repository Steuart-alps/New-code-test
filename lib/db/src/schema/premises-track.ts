import { pgTable, serial, integer, text, timestamp, date } from "drizzle-orm/pg-core";
import { staffMembersTable } from "./staff-members";

export const premisesInspectionsTable = pgTable("premises_inspections", {
  id:              serial("id").primaryKey(),
  clientId:        integer("client_id").notNull(),
  siteId:          integer("site_id"),
  inspectionDate:  date("inspection_date").notNull(),
  nextInspectionDate: date("next_inspection_date"),
  inspectionType:  text("inspection_type").notNull().default("routine"),
  area:            text("area"),
  findings:        text("findings"),
  hazardDetails:   text("hazard_details"),
  actionRequired:  text("action_required"),
  actionTaken:     text("action_taken"),
  status:          text("status").notNull().default("open"),
  inspectedBy:     text("inspected_by"),
  staffRosterId:   integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  createdBy:       integer("created_by"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
});
