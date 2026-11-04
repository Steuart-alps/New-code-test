import { db } from "@workspace/db";
import { categoriesTable, complianceItemsTable, contractorsTable, sitesTable } from "@workspace/db/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { sitesTableVisibleTo } from "./departmentSites";
import { CONTRACTOR_VISIT_TYPES } from "./contractorVisits";
import type { CertificateCheckChoice } from "./certificateReading";

/**
 * The compliance checks a certificate can be filed against, described for
 * Claude (lib/certificateReading.ts). With a department, only checks for its
 * sites (or for every site); with null, all of the business's checks, as for a
 * certificate emailed to the business (lib/certificateInbox.ts).
 */
export async function certificateCheckChoicesFor(clientId: number, deptId: number | null): Promise<CertificateCheckChoice[]> {
  const conditions = [eq(complianceItemsTable.clientId, clientId)];
  if (deptId !== null) {
    const allowedSites = db.select({ id: sitesTable.id }).from(sitesTable)
      .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId)));
    conditions.push(or(isNull(complianceItemsTable.siteId), inArray(complianceItemsTable.siteId, allowedSites))!);
  }
  const rows = await db.select({
    id: complianceItemsTable.id, title: complianceItemsTable.title, frequencyMonths: complianceItemsTable.frequencyMonths,
    siteName: sitesTable.name, siteAddress: sitesTable.address, categoryName: categoriesTable.name, contractorName: contractorsTable.name,
  }).from(complianceItemsTable)
    .leftJoin(sitesTable, and(eq(sitesTable.id, complianceItemsTable.siteId), eq(sitesTable.clientId, clientId)))
    .leftJoin(categoriesTable, and(eq(categoriesTable.id, complianceItemsTable.categoryId), eq(categoriesTable.clientId, clientId)))
    .leftJoin(contractorsTable, and(eq(contractorsTable.id, complianceItemsTable.contractorId), eq(contractorsTable.clientId, clientId)))
    .where(and(...conditions))
    .orderBy(complianceItemsTable.title, complianceItemsTable.id);
  const trackOf = new Map(CONTRACTOR_VISIT_TYPES.map((type) => [type.title.trim().toLowerCase(), type.trackLabel]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    track: trackOf.get(row.title.trim().toLowerCase()) ?? row.categoryName ?? null,
    siteName: row.siteName ?? null,
    siteAddress: row.siteAddress ?? null,
    contractorName: row.contractorName ?? null,
    frequencyMonths: row.frequencyMonths ?? null,
  }));
}
