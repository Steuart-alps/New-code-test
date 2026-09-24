/**
 * GET /api/export — full client data export as a ZIP archive.
 *
 * Returns every compliance record scoped to the caller's client as CSVs
 * organised by module, plus a README. Restricted to client_admin and
 * consultant roles; rate-limited by the express-rate-limit applied in app.ts.
 *
 * Attachments stored by supported modules are bundled when they can be safely
 * read from configured private object storage. A manifest records omissions
 * so one stale upload never prevents a client receiving its export.
 */
import { Router } from "express";
// archiver v8 is pure ESM — use ZipArchive directly, no factory function.
import { ZipArchive } from "archiver";
import { db } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import path from "path";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getObjectAclPolicy } from "../lib/objectAcl";
import {
  sitesTable,
  departmentsTable,
  usersTable,
  contractorsTable,
  certificatesTable,
  complianceItemsTable,
  fireSafetyChecksTable,
  foodSafetyRecordsTable,
  legionellaChecksTable,
  trackControlProfilesTable,
  trackEvidenceRequirementsTable,
  trackEvidenceTable,
  trackActionsTable,
  fixTrackIssuesTable,
  hotTubsTable,
  hotTubChecksTable,
  treeInspectionsTable,
  bikesTable,
  bikeHireRecordsTable,
  bikeChecksTable,
  incidentsTable,
  patAppliancesTable,
  patTestsTable,
  pestVisitsTable,
  pestActivityTable,
  premisesInspectionsTable,
  safeRiskAssessmentsTable,
  safeSopsTable,
  safeTrainingRecordsTable,
  safeInductionsTable,
  safeCompetencySignoffsTable,
  safeHandbookTable,
  dailyChecklistsTable,
  dailyManagerSignoffsTable,
} from "@workspace/db/schema";
import { requireAuth, getClientId, requireRole } from "../middleware/requireAuth";

const router = Router();

// ── CSV helpers ────────────────────────────────────────────────────────────────

/** Deliberately fail closed: an export may read only a private object stamped
 * with the same tenant ID by an upload route. */
export function isExportAttachmentAuthorized(
  acl: { owner: string; visibility: string } | null,
  clientId: number,
): boolean {
  return acl?.visibility === "private" && acl.owner === String(clientId);
}

type ExportAttachmentRow = {
  module: string;
  record_id: string;
  label: string | null;
  file_name: string | null;
  file_size: number | string | null;
  object_path: string;
};

type AttachmentManifestRow = {
  module: string;
  recordId: string;
  objectPath: string;
  zipPath: string;
  status: "included" | "omitted";
  reason: string;
};

/** Gives every archive member a deterministic, safe name without overwriting a
 * different attachment that happened to have the same display name. */
export function getAttachmentZipPath(
  row: Pick<ExportAttachmentRow, "module" | "record_id" | "label" | "file_name">,
  usedNames: Set<string>,
): string {
  const base = (row.label || `${row.module}-${row.record_id}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 180).trim()
    || `attachment-${row.record_id}`;
  const ext = (row.file_name ? path.extname(path.basename(row.file_name)) : "")
    .replace(/[^a-zA-Z0-9.]/g, "").slice(0, 20);
  let filename = base.endsWith(ext) && ext ? base : `${base}${ext}`;
  let n = 2;
  while (usedNames.has(`${row.module}/${filename}`)) filename = `${base} (${n++})${ext}`;
  usedNames.add(`${row.module}/${filename}`);
  return `attachments/${row.module}/${filename}`;
}

/** Kept separate so omissions have stable, supportable manifest wording. */
export function getAttachmentOmissionReason(error: unknown): string {
  return error instanceof ObjectNotFoundError
    ? "object unavailable"
    : "object storage unavailable";
}

export function fitsAttachmentExportCap(bytes: unknown, usedBytes: number, maxBytes: number): boolean {
  const size = Number(bytes);
  return Number.isFinite(size) && size >= 0 && usedBytes + size <= maxBytes;
}

function manifestToCsv(rows: AttachmentManifestRow[]): string {
  const headers = ["module", "recordId", "objectPath", "zipPath", "status", "reason"];
  return `${headers.join(",")}\n${rows.map((row) => headers.map((h) => escapeCell(row[h as keyof AttachmentManifestRow])).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

function rawToCsv(rows: unknown[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] as object);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell((row as any)[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

const README = `ComplyTrack Data Export
========================
Generated: {DATE}
Client ID: {CLIENT_ID}

Contents
--------
sites.csv                        — all sites
departments.csv                  — departments
users.csv                        — staff accounts (no passwords)
contractors/
  contractors.csv                — contractor records
  certificates.csv               — contractor certificates
compliance/
  items.csv                      — compliance action items
food-safety/
  records.csv                    — daily food safety diary entries
fire-safety/
  checks.csv                     — fire safety checks
  control-profiles.csv           — site-specific risk controls and frequencies
  evidence-requirements.csv      — required FireTrack evidence profile
  evidence.csv                   — recorded and independently reviewed evidence
  actions.csv                    — corrective actions and signed closures
legionella/
  checks.csv                     — legionella / water hygiene checks
  control-profiles.csv           — site-specific risk controls and frequencies
  evidence-requirements.csv      — required LegionellaTrack evidence profile
  evidence.csv                   — recorded and independently reviewed evidence
  actions.csv                    — corrective actions and signed closures
kitchen/
  daily-checklists.csv           — AM/PM kitchen opening/closing checklists
  manager-signoffs.csv           — daily manager sign-offs
  weekly-reviews.csv             — weekly kitchen review records
  probe-checks.csv               — probe thermometer checks
fix-track/
  issues.csv                     — maintenance issues
doc-track/
  documents.csv                  — managed documents
  acknowledgements.csv           — staff document acknowledgements
train-track/
  records.csv                    — training records
safe-track/
  risk-assessments.csv           — risk assessments
  sops.csv                       — standard operating procedures
  handbooks.csv                  — staff handbooks
  training.csv                   — SafeTrack training records
  inductions.csv                 — inductions
  competency-signoffs.csv        — competency sign-offs
  incidents.csv                  — SafeTrack incidents
hot-tub/
  tubs.csv                       — hot tub / spa register
  checks.csv                     — hot tub chemical / safety checks
pool-track/
  checks.csv                     — swimming pool water tests
swim-track/
  sessions.csv                   — supervised swim sessions
  surveillance-checks.csv        — lifeguard surveillance checks
  incidents.csv                  — swim incidents
green-track/
  machines.csv                   — grounds machinery register
  pre-use-checks.csv             — pre-use inspection records
tree-track/
  inspections.csv                — tree inspection records
bike-track/
  bikes.csv                      — bike register
  hire-records.csv               — hire records
  checks.csv                     — pre-hire checks
pat-track/
  appliances.csv                 — PAT appliance register
  tests.csv                      — PAT test results
pest-track/
  visits.csv                     — pest control visit reports
  activity.csv                   — pest activity log
incidents/
  records.csv                    — general incident reports
premises-track/
  inspections.csv                — premises inspection records
staff-roster/
  staff.csv                      — staff roster

attachments/                     — available private-object attachments (capped at 500 MB total)
attachment-manifest.csv          — included and unavailable attachment records

Note: only attachments held in configured private object storage can be
bundled. External URLs remain in their relevant CSVs.
`;

// ── Export endpoint ────────────────────────────────────────────────────────────

router.get(
  "/export",
  requireAuth,
  requireRole("consultant", "client_admin"),
  async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const filename = `complytrack-export-${dateStr}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // ZipArchive types don't expose zlib in its constructor signature but the
    // underlying Zip plugin accepts it; cast to silence the check.
    const archive = new ZipArchive({ zlib: { level: 6 } } as any);
    archive.on("error", (err: Error) => {
      console.error("Export archive error", err);
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
    });
    archive.pipe(res);

    // README
    archive.append(
      README.replace("{DATE}", now.toISOString()).replace("{CLIENT_ID}", String(clientId)),
      { name: "README.txt" }
    );

    try {
      const cid = clientId; // alias for SQL template tags

      // ── Core ────────────────────────────────────────────────────────────────
      const sites = await db.select().from(sitesTable).where(eq(sitesTable.clientId, cid));
      archive.append(rowsToCsv(sites), { name: "sites.csv" });

      const depts = await db.select().from(departmentsTable).where(eq(departmentsTable.clientId, cid));
      archive.append(rowsToCsv(depts), { name: "departments.csv" });

      const users = await db
        .select({
          id: usersTable.id, email: usersTable.email, name: usersTable.name,
          role: usersTable.role, departmentId: usersTable.departmentId,
          active: usersTable.active, createdAt: usersTable.createdAt,
        })
        .from(usersTable)
        .where(eq(usersTable.clientId, cid));
      archive.append(rowsToCsv(users), { name: "users.csv" });

      // ── Contractors ────────────────────────────────────────────────────────
      const contractors = await db.select().from(contractorsTable).where(eq(contractorsTable.clientId, cid));
      archive.append(rowsToCsv(contractors), { name: "contractors/contractors.csv" });

      const contractorIds = contractors.map((c) => c.id);
      let certs: any[] = [];
      if (contractorIds.length > 0) {
        certs = await db.select().from(certificatesTable)
          .where(sql`${certificatesTable.contractorId} = ANY(${sql.raw(`ARRAY[${contractorIds.join(",")}]::int[]`)})`);
      }
      archive.append(rowsToCsv(certs), { name: "contractors/certificates.csv" });

      // ── Compliance items ───────────────────────────────────────────────────
      const compItems = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.clientId, cid));
      archive.append(rowsToCsv(compItems), { name: "compliance/items.csv" });

      // ── Food safety ────────────────────────────────────────────────────────
      const foodRecs = await db.select().from(foodSafetyRecordsTable).where(eq(foodSafetyRecordsTable.clientId, cid));
      archive.append(rowsToCsv(foodRecs), { name: "food-safety/records.csv" });

      // ── Fire safety ────────────────────────────────────────────────────────
      const fireChecks = await db.select().from(fireSafetyChecksTable).where(eq(fireSafetyChecksTable.clientId, cid));
      archive.append(rowsToCsv(fireChecks), { name: "fire-safety/checks.csv" });
      const fireProfiles = await db.select().from(trackControlProfilesTable).where(and(
        eq(trackControlProfilesTable.clientId, cid),
        eq(trackControlProfilesTable.module, "fire"),
      ));
      archive.append(rowsToCsv(fireProfiles), { name: "fire-safety/control-profiles.csv" });
      const fireRequirements = await db.select().from(trackEvidenceRequirementsTable).where(and(
        eq(trackEvidenceRequirementsTable.clientId, cid),
        eq(trackEvidenceRequirementsTable.module, "fire"),
      ));
      archive.append(rowsToCsv(fireRequirements), { name: "fire-safety/evidence-requirements.csv" });
      const fireEvidence = await db.select().from(trackEvidenceTable).where(and(
        eq(trackEvidenceTable.clientId, cid),
        eq(trackEvidenceTable.module, "fire"),
      ));
      archive.append(rowsToCsv(fireEvidence), { name: "fire-safety/evidence.csv" });
      const fireActions = await db.select().from(trackActionsTable).where(and(
        eq(trackActionsTable.clientId, cid),
        eq(trackActionsTable.module, "fire"),
      ));
      archive.append(rowsToCsv(fireActions), { name: "fire-safety/actions.csv" });

      // ── Legionella ────────────────────────────────────────────────────────
      const legChecks = await db.select().from(legionellaChecksTable).where(eq(legionellaChecksTable.clientId, cid));
      archive.append(rowsToCsv(legChecks), { name: "legionella/checks.csv" });
      const legionellaProfiles = await db.select().from(trackControlProfilesTable).where(and(
        eq(trackControlProfilesTable.clientId, cid),
        eq(trackControlProfilesTable.module, "legionella"),
      ));
      archive.append(rowsToCsv(legionellaProfiles), { name: "legionella/control-profiles.csv" });
      const legionellaRequirements = await db.select().from(trackEvidenceRequirementsTable).where(and(
        eq(trackEvidenceRequirementsTable.clientId, cid),
        eq(trackEvidenceRequirementsTable.module, "legionella"),
      ));
      archive.append(rowsToCsv(legionellaRequirements), { name: "legionella/evidence-requirements.csv" });
      const legionellaEvidence = await db.select().from(trackEvidenceTable).where(and(
        eq(trackEvidenceTable.clientId, cid),
        eq(trackEvidenceTable.module, "legionella"),
      ));
      archive.append(rowsToCsv(legionellaEvidence), { name: "legionella/evidence.csv" });
      const legionellaActions = await db.select().from(trackActionsTable).where(and(
        eq(trackActionsTable.clientId, cid),
        eq(trackActionsTable.module, "legionella"),
      ));
      archive.append(rowsToCsv(legionellaActions), { name: "legionella/actions.csv" });

      // ── Kitchen ───────────────────────────────────────────────────────────
      const dailyChecklists = await db.select().from(dailyChecklistsTable).where(eq(dailyChecklistsTable.clientId, cid));
      archive.append(rowsToCsv(dailyChecklists), { name: "kitchen/daily-checklists.csv" });

      const mgSignoffs = await db.select().from(dailyManagerSignoffsTable).where(eq(dailyManagerSignoffsTable.clientId, cid));
      archive.append(rowsToCsv(mgSignoffs), { name: "kitchen/manager-signoffs.csv" });

      const kwRows = await db.execute(sql`SELECT * FROM kitchen_weekly_records WHERE client_id = ${cid} ORDER BY week_commencing DESC`);
      archive.append(rawToCsv(kwRows.rows), { name: "kitchen/weekly-reviews.csv" });

      const kpRows = await db.execute(sql`SELECT * FROM kitchen_probe_checks WHERE client_id = ${cid} ORDER BY check_date DESC`);
      archive.append(rawToCsv(kpRows.rows), { name: "kitchen/probe-checks.csv" });

      // ── FixTrack ──────────────────────────────────────────────────────────
      const fixIssues = await db.select().from(fixTrackIssuesTable).where(eq(fixTrackIssuesTable.clientId, cid));
      archive.append(rowsToCsv(fixIssues), { name: "fix-track/issues.csv" });

      // ── DocTrack ──────────────────────────────────────────────────────────
      const docRows = await db.execute(sql`SELECT * FROM doc_track_documents WHERE client_id = ${cid} ORDER BY created_at DESC`);
      archive.append(rawToCsv(docRows.rows), { name: "doc-track/documents.csv" });

      const ackRows = await db.execute(sql`SELECT * FROM doc_acknowledgements WHERE client_id = ${cid} ORDER BY acknowledged_at DESC`);
      archive.append(rawToCsv(ackRows.rows), { name: "doc-track/acknowledgements.csv" });

      // Bundle every supported private-object attachment. Each query is
      // client-scoped; paths are accepted only through ObjectStorageService,
      // which rejects anything outside /objects/ and the configured bucket.
      // Keep this after the DocTrack CSVs to preserve the historical export.
       // Do not use a single UNION here. Some installations acquired optional
       // attachment tables over time; one absent legacy table must not suppress
       // every other document in a cancellation export.
       const attachmentSources = await Promise.all([
         db.execute(sql`SELECT 'doc-track' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM doc_track_documents WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'safe-track/risk-assessments' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM safe_risk_assessments WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'safe-track/sops' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM safe_sops WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'safe-track/handbook' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM safe_handbook WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'site-documents' AS module, id::text AS record_id, name AS label, name AS file_name, NULL::bigint AS file_size, object_path FROM site_documents WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'contractors/certificates' AS module, id::text AS record_id, certificate_name AS label, certificate_name AS file_name, NULL::bigint AS file_size, object_path FROM contractor_certificates WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         // The primary certificates table uses file_url and is linked through
         // contractors/items rather than carrying client_id itself.
         db.execute(sql`SELECT 'contractors/certificates' AS module, cert.id::text AS record_id, cert.name AS label, cert.name AS file_name, NULL::bigint AS file_size, cert.file_url AS object_path FROM certificates cert JOIN contractors c ON c.id = cert.contractor_id WHERE c.client_id = ${cid} AND cert.file_url LIKE '/objects/%'`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT CASE WHEN entity_type LIKE 'green%' THEN 'green-track/photos' WHEN entity_type LIKE 'swim%' THEN 'swim-track/photos' ELSE 'check-photos' END AS module, id::text AS record_id, COALESCE(caption, entity_type || '-' || entity_id::text) AS label, NULL::text AS file_name, NULL::bigint AS file_size, object_path FROM check_photos WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'fix-track/media' AS module, fi.id::text || '-' || media.ordinality::text AS record_id, fi.title AS label, NULL::text AS file_name, NULL::bigint AS file_size, media.object_path FROM fix_track_issues fi CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(fi.media_urls, '[]'::jsonb)) WITH ORDINALITY AS media(object_path, ordinality) WHERE fi.client_id = ${cid} AND media.object_path LIKE '/objects/%'`).catch(() => ({ rows: [] })),
         db.execute(sql`SELECT 'fix-track/completion-documents' AS module, id::text AS record_id, title AS label, NULL::text AS file_name, NULL::bigint AS file_size, completion_document_path AS object_path FROM fix_track_issues WHERE client_id = ${cid} AND completion_document_path IS NOT NULL AND completion_document_path != ''`).catch(() => ({ rows: [] })),
       ]);
       const attachmentRows = attachmentSources.flatMap((source) => source.rows) as ExportAttachmentRow[];

      const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
      let attachmentBytesUsed = 0;
      const storage = new ObjectStorageService();
      const usedNames = new Set<string>();
      const seenObjectPaths = new Set<string>();
       const manifest: AttachmentManifestRow[] = [];
       for (const row of attachmentRows) {
        const size = Number(row.file_size ?? 0);
        const zipPath = getAttachmentZipPath(row, usedNames);

        if (seenObjectPaths.has(row.object_path)) {
          manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "omitted", reason: "duplicate object path" });
          continue;
        }
        seenObjectPaths.add(row.object_path);
        if (!fitsAttachmentExportCap(size, attachmentBytesUsed, MAX_ATTACHMENT_BYTES)) {
          manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "omitted", reason: "500 MB export cap" });
          continue;
        }
        try {
          const file = await storage.getObjectEntityFile(row.object_path);
          // Object paths are opaque and a compromised/incorrect record must
          // never turn an export into a cross-tenant download. Every private
          // upload route stamps the owning client ID in this ACL metadata.
          let acl = await getObjectAclPolicy(file);
          // A legacy row is already tenant-scoped by the source query above,
          // unlike a request body. It is therefore safe to backfill only an
          // unowned private object; the storage helper refuses foreign/public
          // ACLs and never overwrites another owner's claim.
          if (!acl) {
            await storage.backfillTenantObjectAcl(row.object_path, cid);
            acl = await getObjectAclPolicy(file);
          }
          if (!isExportAttachmentAuthorized(acl, cid)) {
            manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "omitted", reason: "not authorized for exporting client" });
            continue;
          }
          // Some legacy records have no stored file_size. Use object metadata
          // before adding their stream so those records cannot bypass the cap.
          const [metadata] = await file.getMetadata();
          const actualSize = Number(metadata.size ?? size);
          if (!fitsAttachmentExportCap(actualSize, attachmentBytesUsed, MAX_ATTACHMENT_BYTES)) {
            manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "omitted", reason: "500 MB export cap" });
            continue;
          }
          archive.append(file.createReadStream(), { name: zipPath });
          attachmentBytesUsed += actualSize;
          manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "included", reason: "" });
        } catch (err) {
          const reason = getAttachmentOmissionReason(err);
          manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "omitted", reason });
          console.warn(`Export attachment omitted: ${row.module}/${row.record_id}`, err);
        }
      }
      archive.append(manifestToCsv(manifest), { name: "attachment-manifest.csv" });

      // ── TrainTrack ────────────────────────────────────────────────────────
      const ttRows = await db.execute(sql`SELECT * FROM train_track_records WHERE client_id = ${cid} ORDER BY completed_date DESC`);
      archive.append(rawToCsv(ttRows.rows), { name: "train-track/records.csv" });

      // ── SafeTrack ─────────────────────────────────────────────────────────
      const ras = await db.select().from(safeRiskAssessmentsTable).where(eq(safeRiskAssessmentsTable.clientId, cid));
      archive.append(rowsToCsv(ras), { name: "safe-track/risk-assessments.csv" });

      const sops = await db.select().from(safeSopsTable).where(eq(safeSopsTable.clientId, cid));
      archive.append(rowsToCsv(sops), { name: "safe-track/sops.csv" });

      const handbooks = await db.select().from(safeHandbookTable).where(eq(safeHandbookTable.clientId, cid));
      archive.append(rowsToCsv(handbooks), { name: "safe-track/handbooks.csv" });

      const safeTraining = await db.select().from(safeTrainingRecordsTable).where(eq(safeTrainingRecordsTable.clientId, cid));
      archive.append(rowsToCsv(safeTraining), { name: "safe-track/training.csv" });

      const inductions = await db.select().from(safeInductionsTable).where(eq(safeInductionsTable.clientId, cid));
      archive.append(rowsToCsv(inductions), { name: "safe-track/inductions.csv" });

      const competency = await db.select().from(safeCompetencySignoffsTable).where(eq(safeCompetencySignoffsTable.clientId, cid));
      archive.append(rowsToCsv(competency), { name: "safe-track/competency-signoffs.csv" });

      const safeIncidents = await db.execute(sql`SELECT * FROM safe_incidents WHERE client_id = ${cid} ORDER BY incident_date DESC`).catch(() => ({ rows: [] }));
      archive.append(rawToCsv(safeIncidents.rows), { name: "safe-track/incidents.csv" });

      // ── Hot tub ───────────────────────────────────────────────────────────
      const tubs = await db.select().from(hotTubsTable).where(eq(hotTubsTable.clientId, cid));
      archive.append(rowsToCsv(tubs), { name: "hot-tub/tubs.csv" });

      const tubChecks = await db.select().from(hotTubChecksTable).where(eq(hotTubChecksTable.clientId, cid));
      archive.append(rowsToCsv(tubChecks), { name: "hot-tub/checks.csv" });

      // ── PoolTrack ─────────────────────────────────────────────────────────
      const poolRows = await db.execute(sql`SELECT * FROM pool_checks WHERE client_id = ${cid} ORDER BY check_date DESC`);
      archive.append(rawToCsv(poolRows.rows), { name: "pool-track/checks.csv" });

      // ── SwimTrack ─────────────────────────────────────────────────────────
      const swimSessions = await db.execute(sql`SELECT * FROM swim_sessions WHERE client_id = ${cid} ORDER BY session_date DESC`);
      archive.append(rawToCsv(swimSessions.rows), { name: "swim-track/sessions.csv" });

      const swimChecks = await db.execute(sql`SELECT * FROM swim_surveillance_checks WHERE client_id = ${cid} ORDER BY check_time DESC`);
      archive.append(rawToCsv(swimChecks.rows), { name: "swim-track/surveillance-checks.csv" });

      const swimIncidents = await db.execute(sql`SELECT * FROM swim_incidents WHERE client_id = ${cid} ORDER BY incident_date DESC`).catch(() => ({ rows: [] }));
      archive.append(rawToCsv(swimIncidents.rows), { name: "swim-track/incidents.csv" });

      // ── GreenTrack ────────────────────────────────────────────────────────
      const greenMachines = await db.execute(sql`SELECT * FROM green_machines WHERE client_id = ${cid} ORDER BY created_at DESC`);
      archive.append(rawToCsv(greenMachines.rows), { name: "green-track/machines.csv" });

      const greenChecks = await db.execute(sql`SELECT * FROM green_pre_use_checks WHERE client_id = ${cid} ORDER BY check_date DESC`);
      archive.append(rawToCsv(greenChecks.rows), { name: "green-track/pre-use-checks.csv" });

      // ── TreeTrack ─────────────────────────────────────────────────────────
      const treeInspections = await db.select().from(treeInspectionsTable).where(eq(treeInspectionsTable.clientId, cid));
      archive.append(rowsToCsv(treeInspections), { name: "tree-track/inspections.csv" });

      // ── BikeTrack ─────────────────────────────────────────────────────────
      const bikes = await db.select().from(bikesTable).where(eq(bikesTable.clientId, cid));
      archive.append(rowsToCsv(bikes), { name: "bike-track/bikes.csv" });

      const hireRecords = await db.select().from(bikeHireRecordsTable).where(eq(bikeHireRecordsTable.clientId, cid));
      archive.append(rowsToCsv(hireRecords), { name: "bike-track/hire-records.csv" });

      const bikeChecks = await db.select().from(bikeChecksTable).where(eq(bikeChecksTable.clientId, cid));
      archive.append(rowsToCsv(bikeChecks), { name: "bike-track/checks.csv" });

      // ── PATtrack ──────────────────────────────────────────────────────────
      const appliances = await db.select().from(patAppliancesTable).where(eq(patAppliancesTable.clientId, cid));
      archive.append(rowsToCsv(appliances), { name: "pat-track/appliances.csv" });

      const patTests = await db.select().from(patTestsTable).where(eq(patTestsTable.clientId, cid));
      archive.append(rowsToCsv(patTests), { name: "pat-track/tests.csv" });

      // Certificate-led PAT register. Keep the linking and evidence tables in
      // the tenant export as well as the legacy appliance register above.
      const patTemplates = await db.execute(sql`SELECT * FROM pat_equipment_templates WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patTemplates.rows), { name: "pat-track/equipment-templates.csv" });
      const patTemplateItems = await db.execute(sql`SELECT * FROM pat_equipment_template_items WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patTemplateItems.rows), { name: "pat-track/equipment-template-items.csv" });
      const patRooms = await db.execute(sql`SELECT * FROM pat_rooms WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patRooms.rows), { name: "pat-track/rooms.csv" });
      const patCertificates = await db.execute(sql`SELECT * FROM pat_certificates WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patCertificates.rows), { name: "pat-track/certificates.csv" });
      const patCertificateRooms = await db.execute(sql`SELECT * FROM pat_certificate_rooms WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patCertificateRooms.rows), { name: "pat-track/certificate-rooms.csv" });
      const patReplacements = await db.execute(sql`SELECT * FROM pat_replacements WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patReplacements.rows), { name: "pat-track/replacements.csv" });
      const patFailures = await db.execute(sql`SELECT * FROM pat_failures WHERE client_id = ${cid} ORDER BY id`);
      archive.append(rawToCsv(patFailures.rows), { name: "pat-track/failures.csv" });

      // ── PestTrack ─────────────────────────────────────────────────────────
      const pestVisits = await db.select().from(pestVisitsTable).where(eq(pestVisitsTable.clientId, cid));
      archive.append(rowsToCsv(pestVisits), { name: "pest-track/visits.csv" });

      const pestActivity = await db.select().from(pestActivityTable).where(eq(pestActivityTable.clientId, cid));
      archive.append(rowsToCsv(pestActivity), { name: "pest-track/activity.csv" });

      // ── Incidents ─────────────────────────────────────────────────────────
      const incidents = await db.select().from(incidentsTable).where(eq(incidentsTable.clientId, cid));
      archive.append(rowsToCsv(incidents), { name: "incidents/records.csv" });

      // ── PremisesTrack ─────────────────────────────────────────────────────
      const premises = await db.select().from(premisesInspectionsTable).where(eq(premisesInspectionsTable.clientId, cid));
      archive.append(rowsToCsv(premises), { name: "premises-track/inspections.csv" });

      // ── Staff roster ──────────────────────────────────────────────────────
      const staffRows = await db.execute(sql`SELECT id, client_id, site_id, name, job_title, department, email, phone, start_date, active, notes, created_at, updated_at FROM staff_roster WHERE client_id = ${cid} ORDER BY name ASC`);
      archive.append(rawToCsv(staffRows.rows), { name: "staff-roster/staff.csv" });

      // Privacy governance contains the customer's own operational records,
      // rights-request evidence and timers. Keep it in the tenant export so
      // administrators can retain a portable copy before offboarding.
      const [privacyProgram, privacyActivities, privacyRequests, privacyRetention, privacyVerifications, privacyProcessors, privacyBreaches] = await Promise.all([
        db.execute(sql`SELECT * FROM privacy_programs WHERE client_id = ${cid} ORDER BY id`),
        db.execute(sql`SELECT * FROM privacy_processing_activities WHERE client_id = ${cid} ORDER BY id`),
        db.execute(sql`SELECT * FROM privacy_rights_requests WHERE client_id = ${cid} ORDER BY id`),
        db.execute(sql`SELECT * FROM privacy_retention_schedules WHERE client_id = ${cid} ORDER BY id`),
        db.execute(sql`SELECT * FROM privacy_retention_verifications WHERE client_id = ${cid} ORDER BY id`),
        db.execute(sql`SELECT * FROM privacy_processors WHERE client_id = ${cid} ORDER BY id`),
        db.execute(sql`SELECT * FROM privacy_breaches WHERE client_id = ${cid} ORDER BY id`),
      ]);
      archive.append(JSON.stringify({
        program: privacyProgram.rows,
        processingActivities: privacyActivities.rows,
        rightsRequests: privacyRequests.rows,
        retentionSchedules: privacyRetention.rows,
        retentionVerifications: privacyVerifications.rows,
        processorsAndTransfers: privacyProcessors.rows,
        breachAssessments: privacyBreaches.rows,
      }, null, 2), { name: "privacy-governance.json" });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Export query error", err);
      archive.append(`Export error: ${msg}\n`, { name: "_EXPORT_ERROR.txt" });
    }

    await archive.finalize();
  }
);

export default router;
