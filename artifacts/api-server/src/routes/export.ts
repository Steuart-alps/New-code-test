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
 *
 * Each dataset is queried on its own. One that fails is left out and named in
 * export-errors.csv, and the README, file name and X-Export-Status header mark
 * the archive incomplete, so it never cuts short the modules after it.
 */
import { Router } from "express";
import kitchenInspectionExport from "./kitchen-inspection-export";
// archiver v8 is pure ESM — use ZipArchive directly, no factory function.
import { ZipArchive } from "archiver";
import { db } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
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
router.use(kitchenInspectionExport);

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
  return `files/${row.module}/${filename}`;
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

export function rawToCsv(rows: unknown[], paths = exportContext.getStore()): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] as object);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(rewriteExportReference((row as any)[h], paths))).join(","));
  }
  return lines.join("\n") + "\n";
}

// A request handles one export at a time. Pass the request's resolved paths to
// the serializers rather than exposing storage links in its archived CSVs.
const exportContext = new AsyncLocalStorage<Map<string, string>>();
function rewriteExportReference(value: unknown, exportPaths?: Map<string, string>): unknown {
  if (!exportPaths) return value;
  if (typeof value === "string") return value.startsWith("/objects/") ? (exportPaths.get(value) ?? "") : value;
  if (Array.isArray(value)) return value.map((item) => rewriteExportReference(item, exportPaths));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteExportReference(item, exportPaths)]));
  }
  return value;
}

// ── Per-dataset isolation ──────────────────────────────────────────────────────

export type ExportErrorRow = { dataset: string; reason: string };

/** Stable, client-facing wording for a dataset that could not be exported.
 * Database errors keep their Postgres code and message (e.g. a missing
 * column) but never the SQL text or parameters Drizzle wraps around them. */
export function describeExportError(error: unknown): string {
  const pgError = [error, (error as { cause?: unknown } | null)?.cause]
    .find((candidate): candidate is { code: string; message: string } =>
      typeof (candidate as { code?: unknown } | null)?.code === "string"
      && /^[0-9A-Z]{5}$/.test((candidate as { code: string }).code));
  return pgError ? `database query failed: ${pgError.message} (${pgError.code})` : "unexpected export error";
}

export function exportErrorsToCsv(rows: ExportErrorRow[]): string {
  return `dataset,reason\n${rows.map((row) => `${escapeCell(row.dataset)},${escapeCell(row.reason)}\n`).join("")}`;
}

/** Writes each dataset on its own, so one failing query records an
 * export-errors.csv row instead of cutting short every later module. */
export function createExportWriter(archive: Pick<ZipArchive, "append">) {
  const errors: ExportErrorRow[] = [];
  const omit = (dataset: string, reason: string) => { errors.push({ dataset, reason }); };
  const fail = (dataset: string, error: unknown) => {
    console.error(`Export dataset failed: ${dataset}`, error);
    omit(dataset, describeExportError(error));
  };
  return {
    errors,
    omit,
    fail,
    /** Returns the rows written, or undefined when the dataset was omitted. */
    async csv<T>(dataset: string, load: () => Promise<T[]>): Promise<T[] | undefined> {
      try {
        const rows = await load();
        archive.append(rawToCsv(rows), { name: dataset });
        return rows;
      } catch (error) {
        fail(dataset, error);
        return undefined;
      }
    },
  };
}

export type ExportWriter = ReturnType<typeof createExportWriter>;

const README = `ComplyTrack Data Export
========================
Generated: {DATE}
Client ID: {CLIENT_ID}
Status: {STATUS}

Contents
--------
sites.csv                        — all sites
departments.csv                  — departments
users.csv                        — staff accounts (no passwords)
contractors/
  contractors.csv                — contractor records
  certificates.csv               — contractor certificates
  uploaded-certificates.csv      — contractor certificate uploads
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
site-documents/
  documents.csv                  — site documents
client-documents/
  documents.csv                  — client documents
check-photos/
  photos.csv                     — photos linked to checks
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

files/                           — available private-object attachments (up to {CAP} bytes total)
attachment-manifest.csv          — included and unavailable attachment records
export-errors.csv                — datasets that could not be exported, and why
                                   (header only when the export is complete)

Note: only attachments held in configured private object storage can be
bundled. External URLs remain in their relevant CSVs. Unavailable or omitted
private files have an empty reference in the CSV and their original path and
reason appear in attachment-manifest.csv.
{WARNING}
`;

/** Built after every dataset has been attempted, so the status is accurate. */
export function buildExportReadme(options: {
  now: Date; clientId: number; maxBytes: number; usedBytes: number;
  omittedForCap: number; errors: ExportErrorRow[];
}): string {
  const { now, clientId, maxBytes, usedBytes, omittedForCap, errors } = options;
  const warnings = [
    errors.length
      ? `WARNING: THIS EXPORT IS INCOMPLETE. ${errors.length} dataset(s) could not be exported and are missing from this archive: ${errors.map((e) => e.dataset).join(", ")}. See export-errors.csv for the reasons, and request a new export once the problem is fixed.`
      : "",
    omittedForCap
      ? `WARNING: ${omittedForCap} attachment(s) omitted because the ${maxBytes}-byte cap was reached. ${usedBytes} bytes included. See attachment-manifest.csv.`
      : "",
  ].filter(Boolean).join("\n");
  return README.replace("{DATE}", now.toISOString())
    .replace("{CLIENT_ID}", String(clientId))
    .replace("{STATUS}", errors.length ? `INCOMPLETE — ${errors.length} dataset(s) missing, see export-errors.csv` : "complete")
    .replace("{CAP}", String(maxBytes))
    .replace("{WARNING}", warnings);
}

/** Appends the export-errors manifest and README last, once the outcome of
 * every dataset is known. Returns whether the archive is incomplete. */
export function appendExportSummary(
  archive: Pick<ZipArchive, "append">,
  writer: ExportWriter,
  readme: Omit<Parameters<typeof buildExportReadme>[0], "errors">,
): boolean {
  archive.append(exportErrorsToCsv(writer.errors), { name: "export-errors.csv" });
  archive.append(buildExportReadme({ ...readme, errors: writer.errors }), { name: "README.txt" });
  return writer.errors.length > 0;
}

export function attachmentCap(): number {
  const raw = process.env.EXPORT_ATTACHMENT_MAX_BYTES;
  if (!raw) return 500 * 1024 * 1024;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid EXPORT_ATTACHMENT_MAX_BYTES");
  return value;
}

async function bundleAttachments(cid: number, archive: ZipArchive, maxBytes: number, writer: ExportWriter) {
  // Query each source separately: an absent optional legacy table should not
  // suppress the other files in a cancellation export, and any other failed
  // source is named in export-errors.csv rather than failing the export.
  const sources: Array<{ files: string; optional?: boolean; load: () => Promise<{ rows: unknown[] }> }> = [
    { files: "files/doc-track", load: () => db.execute(sql`SELECT 'doc-track' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM doc_track_documents WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/safe-track/risk-assessments", load: () => db.execute(sql`SELECT 'safe-track/risk-assessments' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM safe_risk_assessments WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/safe-track/sops", load: () => db.execute(sql`SELECT 'safe-track/sops' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM safe_sops WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/safe-track/handbook", load: () => db.execute(sql`SELECT 'safe-track/handbook' AS module, id::text AS record_id, title AS label, file_name, file_size::bigint AS file_size, object_path FROM safe_handbook WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/site-documents", optional: true, load: () => db.execute(sql`SELECT 'site-documents' AS module, id::text AS record_id, name AS label, name AS file_name, NULL::bigint AS file_size, object_path FROM site_documents WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/client-documents", optional: true, load: () => db.execute(sql`SELECT 'client-documents' AS module, id::text AS record_id, name AS label, name AS file_name, NULL::bigint AS file_size, object_path FROM client_documents WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/contractors/certificates (uploaded)", load: () => db.execute(sql`SELECT 'contractors/certificates' AS module, id::text AS record_id, certificate_name AS label, certificate_name AS file_name, NULL::bigint AS file_size, object_path FROM contractor_certificates WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/contractors/certificates (register)", load: () => db.execute(sql`SELECT 'contractors/certificates' AS module, cert.id::text AS record_id, cert.name AS label, cert.name AS file_name, NULL::bigint AS file_size, cert.file_url AS object_path FROM certificates cert JOIN contractors c ON c.id = cert.contractor_id WHERE c.client_id = ${cid} AND cert.file_url LIKE '/objects/%'`) },
    { files: "files/check-photos", load: () => db.execute(sql`SELECT CASE WHEN entity_type LIKE 'green%' THEN 'green-track/photos' WHEN entity_type LIKE 'swim%' THEN 'swim-track/photos' ELSE 'check-photos' END AS module, id::text AS record_id, COALESCE(caption, entity_type || '-' || entity_id::text) AS label, NULL::text AS file_name, NULL::bigint AS file_size, object_path FROM check_photos WHERE client_id = ${cid} AND object_path IS NOT NULL AND object_path != ''`) },
    { files: "files/fix-track/media", optional: true, load: () => db.execute(sql`SELECT 'fix-track/media' AS module, fi.id::text || '-' || media.ordinality::text AS record_id, fi.title AS label, NULL::text AS file_name, NULL::bigint AS file_size, media.object_path FROM fix_track_issues fi CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(fi.media_urls, '[]'::jsonb)) WITH ORDINALITY AS media(object_path, ordinality) WHERE fi.client_id = ${cid} AND media.object_path LIKE '/objects/%'`) },
    { files: "files/fix-track/completion-documents", optional: true, load: () => db.execute(sql`SELECT 'fix-track/completion-documents' AS module, id::text AS record_id, title AS label, NULL::text AS file_name, NULL::bigint AS file_size, completion_document_path AS object_path FROM fix_track_issues WHERE client_id = ${cid} AND completion_document_path IS NOT NULL AND completion_document_path != ''`) },
    { files: "files/fix-track/action-completions", optional: true, load: () => db.execute(sql`SELECT 'fix-track/action-completions' AS module, id::text AS record_id, id::text AS label, NULL::text AS file_name, NULL::bigint AS file_size, completion_object_path AS object_path FROM fix_track_action_tokens WHERE client_id = ${cid} AND completion_object_path IS NOT NULL AND completion_object_path != ''`) },
  ];
  const attachmentSources = await Promise.all(sources.map(async (source) => {
    try {
      return (await source.load()).rows;
    } catch (error) {
      if (!source.optional) writer.fail(`${source.files} (attachment list)`, error);
      return [];
    }
  }));
  const manifest: AttachmentManifestRow[] = [];
  const usedNames = new Set<string>();
  const included = new Map<string, string>();
  const storage = new ObjectStorageService();
  let usedBytes = 0;
  for (const row of attachmentSources.flat() as ExportAttachmentRow[]) {
    const prior = included.get(row.object_path);
    const zipPath = prior ?? getAttachmentZipPath(row, usedNames);
    if (prior) {
      manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "included", reason: "shared file" });
      continue;
    }
    const omit = (reason: string) => manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath: "", status: "omitted", reason });
    try {
      const file = await storage.getObjectEntityFile(row.object_path);
      const acl = await getObjectAclPolicy(file);
      if (!isExportAttachmentAuthorized(acl, cid)) { omit("not authorized for exporting client"); continue; }
      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size);
      if (!fitsAttachmentExportCap(size, usedBytes, maxBytes)) { omit("attachment size cap"); continue; }
      // The archive pipes to the HTTP response; the attachment is not buffered
      // into memory. A late storage read error aborts the incomplete download.
      const stream = file.createReadStream();
      stream.once("error", (error) => { archive.abort(); archive.emit("error", error); });
      archive.append(stream, { name: zipPath });
      included.set(row.object_path, zipPath);
      usedBytes += size;
      manifest.push({ module: row.module, recordId: row.record_id, objectPath: row.object_path, zipPath, status: "included", reason: "" });
    } catch (error) {
      omit(getAttachmentOmissionReason(error));
    }
  }
  return { manifest, included, usedBytes };
}

// ── Export endpoint ────────────────────────────────────────────────────────────

router.get(
  "/export",
  requireAuth,
  requireRole("consultant", "client_admin"),
  async (req, res) => exportContext.run(new Map(), async () => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    let maxBytes: number;
    try {
      maxBytes = attachmentCap();
    } catch {
      return res.status(503).json({ error: "Attachment export cap is misconfigured" });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    // ZipArchive types don't expose zlib in its constructor signature but the
    // underlying Zip plugin accepts it; cast to silence the check.
    const archive = new ZipArchive({ zlib: { level: 6 } } as any);
    let failed = false;
    archive.on("error", (err: Error) => {
      // Appends after an abort re-emit errors; answer the request only once.
      if (failed) return;
      failed = true;
      console.error("Export archive error", err);
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
      else res.destroy(err);
    });

    // Every dataset is queried before the archive is piped, so the response
    // headers can say whether anything had to be left out. The archive's own
    // buffer applies backpressure to queued attachment streams meanwhile.
    const out = createExportWriter(archive);
    let incomplete: boolean;
    try {
      const cid = clientId; // alias for SQL template tags
      const { manifest, included, usedBytes } = await bundleAttachments(cid, archive, maxBytes, out);
      // This map is private to the current async request, even if multiple
      // clients start exports at the same time.
      const paths = exportContext.getStore()!;
      for (const [objectPath, zipPath] of included) paths.set(objectPath, zipPath);
      archive.append(manifestToCsv(manifest), { name: "attachment-manifest.csv" });
      const omittedForCap = manifest.filter((entry) => entry.reason === "attachment size cap").length;

      // ── Core ────────────────────────────────────────────────────────────────
      await out.csv("sites.csv", () => db.select().from(sitesTable).where(eq(sitesTable.clientId, cid)));

      await out.csv("departments.csv", () => db.select().from(departmentsTable).where(eq(departmentsTable.clientId, cid)));

      await out.csv("users.csv", () => db
        .select({
          id: usersTable.id, email: usersTable.email, name: usersTable.name,
          role: usersTable.role, departmentId: usersTable.departmentId,
          active: usersTable.active, createdAt: usersTable.createdAt,
        })
        .from(usersTable)
        .where(eq(usersTable.clientId, cid)));

      // ── Contractors ────────────────────────────────────────────────────────
      const contractors = await out.csv("contractors/contractors.csv", () => db.select().from(contractorsTable).where(eq(contractorsTable.clientId, cid)));

      if (contractors) {
        const contractorIds = contractors.map((c) => c.id);
        await out.csv("contractors/certificates.csv", async () => contractorIds.length === 0 ? [] : db.select().from(certificatesTable)
          .where(sql`${certificatesTable.contractorId} = ANY(${sql.raw(`ARRAY[${contractorIds.join(",")}]::int[]`)})`));
      } else {
        out.omit("contractors/certificates.csv", "not exported because contractors/contractors.csv failed");
      }
      await out.csv("contractors/uploaded-certificates.csv", async () => (await db.execute(sql`SELECT * FROM contractor_certificates WHERE client_id = ${cid}`)).rows);

      // ── Compliance items ───────────────────────────────────────────────────
      await out.csv("compliance/items.csv", async () => (await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.clientId, cid)))
        .map(({ scheduleToken: _token, scheduleTokenHash: _digest, ...item }) => item));

      // ── Food safety ────────────────────────────────────────────────────────
      await out.csv("food-safety/records.csv", () => db.select().from(foodSafetyRecordsTable).where(eq(foodSafetyRecordsTable.clientId, cid)));

      // ── Fire safety ────────────────────────────────────────────────────────
      await out.csv("fire-safety/checks.csv", () => db.select().from(fireSafetyChecksTable).where(eq(fireSafetyChecksTable.clientId, cid)));
      await out.csv("fire-safety/control-profiles.csv", () => db.select().from(trackControlProfilesTable).where(and(
        eq(trackControlProfilesTable.clientId, cid),
        eq(trackControlProfilesTable.module, "fire"),
      )));
      await out.csv("fire-safety/evidence-requirements.csv", () => db.select().from(trackEvidenceRequirementsTable).where(and(
        eq(trackEvidenceRequirementsTable.clientId, cid),
        eq(trackEvidenceRequirementsTable.module, "fire"),
      )));
      await out.csv("fire-safety/evidence.csv", () => db.select().from(trackEvidenceTable).where(and(
        eq(trackEvidenceTable.clientId, cid),
        eq(trackEvidenceTable.module, "fire"),
      )));
      await out.csv("fire-safety/actions.csv", () => db.select().from(trackActionsTable).where(and(
        eq(trackActionsTable.clientId, cid),
        eq(trackActionsTable.module, "fire"),
      )));

      // ── Legionella ────────────────────────────────────────────────────────
      await out.csv("legionella/checks.csv", () => db.select().from(legionellaChecksTable).where(eq(legionellaChecksTable.clientId, cid)));
      await out.csv("legionella/control-profiles.csv", () => db.select().from(trackControlProfilesTable).where(and(
        eq(trackControlProfilesTable.clientId, cid),
        eq(trackControlProfilesTable.module, "legionella"),
      )));
      await out.csv("legionella/evidence-requirements.csv", () => db.select().from(trackEvidenceRequirementsTable).where(and(
        eq(trackEvidenceRequirementsTable.clientId, cid),
        eq(trackEvidenceRequirementsTable.module, "legionella"),
      )));
      await out.csv("legionella/evidence.csv", () => db.select().from(trackEvidenceTable).where(and(
        eq(trackEvidenceTable.clientId, cid),
        eq(trackEvidenceTable.module, "legionella"),
      )));
      await out.csv("legionella/actions.csv", () => db.select().from(trackActionsTable).where(and(
        eq(trackActionsTable.clientId, cid),
        eq(trackActionsTable.module, "legionella"),
      )));

      // ── Kitchen ───────────────────────────────────────────────────────────
      await out.csv("kitchen/daily-checklists.csv", () => db.select().from(dailyChecklistsTable).where(eq(dailyChecklistsTable.clientId, cid)));

      await out.csv("kitchen/manager-signoffs.csv", () => db.select().from(dailyManagerSignoffsTable).where(eq(dailyManagerSignoffsTable.clientId, cid)));

      await out.csv("kitchen/weekly-reviews.csv", async () => (await db.execute(sql`SELECT * FROM kitchen_weekly_records WHERE client_id = ${cid} ORDER BY week_commencing DESC`)).rows);

      await out.csv("kitchen/probe-checks.csv", async () => (await db.execute(sql`SELECT * FROM kitchen_probe_checks WHERE client_id = ${cid} ORDER BY check_date DESC`)).rows);

      // ── FixTrack ──────────────────────────────────────────────────────────
      await out.csv("fix-track/issues.csv", () => db.select().from(fixTrackIssuesTable).where(eq(fixTrackIssuesTable.clientId, cid)));

      // ── DocTrack ──────────────────────────────────────────────────────────
      await out.csv("doc-track/documents.csv", async () => (await db.execute(sql`SELECT * FROM doc_track_documents WHERE client_id = ${cid} ORDER BY created_at DESC`)).rows);

      await out.csv("doc-track/acknowledgements.csv", async () => (await db.execute(sql`SELECT * FROM doc_acknowledgements WHERE client_id = ${cid} ORDER BY acknowledged_at DESC`)).rows);
      await out.csv("site-documents/documents.csv", async () => (await db.execute(sql`SELECT * FROM site_documents WHERE client_id = ${cid}`)).rows);
      await out.csv("client-documents/documents.csv", async () => (await db.execute(sql`SELECT * FROM client_documents WHERE client_id = ${cid}`)).rows);
      await out.csv("check-photos/photos.csv", async () => (await db.execute(sql`SELECT * FROM check_photos WHERE client_id = ${cid}`)).rows);

      // ── TrainTrack ────────────────────────────────────────────────────────
      await out.csv("train-track/records.csv", async () => (await db.execute(sql`SELECT * FROM train_track_records WHERE client_id = ${cid} ORDER BY completed_date DESC`)).rows);

      // ── SafeTrack ─────────────────────────────────────────────────────────
      await out.csv("safe-track/risk-assessments.csv", () => db.select().from(safeRiskAssessmentsTable).where(eq(safeRiskAssessmentsTable.clientId, cid)));

      await out.csv("safe-track/sops.csv", () => db.select().from(safeSopsTable).where(eq(safeSopsTable.clientId, cid)));

      await out.csv("safe-track/handbooks.csv", () => db.select().from(safeHandbookTable).where(eq(safeHandbookTable.clientId, cid)));

      await out.csv("safe-track/training.csv", () => db.select().from(safeTrainingRecordsTable).where(eq(safeTrainingRecordsTable.clientId, cid)));

      await out.csv("safe-track/inductions.csv", () => db.select().from(safeInductionsTable).where(eq(safeInductionsTable.clientId, cid)));

      await out.csv("safe-track/competency-signoffs.csv", () => db.select().from(safeCompetencySignoffsTable).where(eq(safeCompetencySignoffsTable.clientId, cid)));

      await out.csv("safe-track/incidents.csv", async () => (await db.execute(sql`SELECT * FROM safe_incidents WHERE client_id = ${cid} ORDER BY incident_date DESC`).catch(() => ({ rows: [] }))).rows);

      // ── Hot tub ───────────────────────────────────────────────────────────
      await out.csv("hot-tub/tubs.csv", () => db.select().from(hotTubsTable).where(eq(hotTubsTable.clientId, cid)));

      await out.csv("hot-tub/checks.csv", () => db.select().from(hotTubChecksTable).where(eq(hotTubChecksTable.clientId, cid)));

      // ── PoolTrack ─────────────────────────────────────────────────────────
      await out.csv("pool-track/checks.csv", async () => (await db.execute(sql`SELECT * FROM pool_checks WHERE client_id = ${cid} ORDER BY check_date DESC`)).rows);

      // ── SwimTrack ─────────────────────────────────────────────────────────
      await out.csv("swim-track/sessions.csv", async () => (await db.execute(sql`SELECT * FROM swim_sessions WHERE client_id = ${cid} ORDER BY session_date DESC`)).rows);

      await out.csv("swim-track/surveillance-checks.csv", async () => (await db.execute(sql`SELECT * FROM swim_surveillance_checks WHERE client_id = ${cid} ORDER BY check_time DESC`)).rows);

      await out.csv("swim-track/incidents.csv", async () => (await db.execute(sql`SELECT * FROM swim_incidents WHERE client_id = ${cid} ORDER BY incident_date DESC`).catch(() => ({ rows: [] }))).rows);

      // ── GreenTrack ────────────────────────────────────────────────────────
      await out.csv("green-track/machines.csv", async () => (await db.execute(sql`SELECT * FROM green_machines WHERE client_id = ${cid} ORDER BY created_at DESC`)).rows);

      await out.csv("green-track/pre-use-checks.csv", async () => (await db.execute(sql`SELECT * FROM green_pre_use_checks WHERE client_id = ${cid} ORDER BY check_date DESC`)).rows);

      // ── TreeTrack ─────────────────────────────────────────────────────────
      await out.csv("tree-track/inspections.csv", () => db.select().from(treeInspectionsTable).where(eq(treeInspectionsTable.clientId, cid)));

      // ── BikeTrack ─────────────────────────────────────────────────────────
      await out.csv("bike-track/bikes.csv", () => db.select().from(bikesTable).where(eq(bikesTable.clientId, cid)));

      await out.csv("bike-track/hire-records.csv", () => db.select().from(bikeHireRecordsTable).where(eq(bikeHireRecordsTable.clientId, cid)));

      await out.csv("bike-track/checks.csv", () => db.select().from(bikeChecksTable).where(eq(bikeChecksTable.clientId, cid)));

      // ── PATtrack ──────────────────────────────────────────────────────────
      await out.csv("pat-track/appliances.csv", () => db.select().from(patAppliancesTable).where(eq(patAppliancesTable.clientId, cid)));

      await out.csv("pat-track/tests.csv", () => db.select().from(patTestsTable).where(eq(patTestsTable.clientId, cid)));

      // Certificate-led PAT register. Keep the linking and evidence tables in
      // the tenant export as well as the legacy appliance register above.
      await out.csv("pat-track/equipment-templates.csv", async () => (await db.execute(sql`SELECT * FROM pat_equipment_templates WHERE client_id = ${cid} ORDER BY id`)).rows);
      await out.csv("pat-track/equipment-template-items.csv", async () => (await db.execute(sql`SELECT * FROM pat_equipment_template_items WHERE client_id = ${cid} ORDER BY id`)).rows);
      await out.csv("pat-track/rooms.csv", async () => (await db.execute(sql`SELECT * FROM pat_rooms WHERE client_id = ${cid} ORDER BY id`)).rows);
      await out.csv("pat-track/certificates.csv", async () => (await db.execute(sql`SELECT * FROM pat_certificates WHERE client_id = ${cid} ORDER BY id`)).rows);
      await out.csv("pat-track/certificate-rooms.csv", async () => (await db.execute(sql`SELECT * FROM pat_certificate_rooms WHERE client_id = ${cid} ORDER BY id`)).rows);
      await out.csv("pat-track/replacements.csv", async () => (await db.execute(sql`SELECT * FROM pat_replacements WHERE client_id = ${cid} ORDER BY id`)).rows);
      await out.csv("pat-track/failures.csv", async () => (await db.execute(sql`SELECT * FROM pat_failures WHERE client_id = ${cid} ORDER BY id`)).rows);
      // Supplemental location corrections sit beside, never over, the recorded
      // failure location and its provenance (failures.csv snapshot_source).
      await out.csv("pat-track/failure-location-corrections.csv", async () => (await db.execute(sql`
        SELECT id, failure_id, previous_location_text, corrected_location_text, reason, corrected_by_name, created_at
        FROM pat_failure_location_corrections WHERE client_id = ${cid} ORDER BY failure_id, id
      `)).rows);

      // ── PestTrack ─────────────────────────────────────────────────────────
      await out.csv("pest-track/visits.csv", () => db.select().from(pestVisitsTable).where(eq(pestVisitsTable.clientId, cid)));

      await out.csv("pest-track/activity.csv", () => db.select().from(pestActivityTable).where(eq(pestActivityTable.clientId, cid)));

      // ── Incidents ─────────────────────────────────────────────────────────
      await out.csv("incidents/records.csv", () => db.select().from(incidentsTable).where(eq(incidentsTable.clientId, cid)));

      // ── PremisesTrack ─────────────────────────────────────────────────────
      await out.csv("premises-track/inspections.csv", () => db.select().from(premisesInspectionsTable).where(eq(premisesInspectionsTable.clientId, cid)));

      // ── Staff roster ──────────────────────────────────────────────────────
      await out.csv("staff-roster/staff.csv", async () => (await db.execute(sql`SELECT id, client_id, site_id, name, job_title, department, email, phone, start_date, active, notes, created_at, updated_at FROM staff_roster WHERE client_id = ${cid} ORDER BY name ASC`)).rows);

      // Privacy governance contains the customer's own operational records,
      // rights-request evidence and timers. Keep it in the tenant export so
      // administrators can retain a portable copy before offboarding.
      // A failed section is left out of the JSON and named in export-errors.csv.
      const privacySections = await Promise.all(([
        ["program", sql`SELECT * FROM privacy_programs WHERE client_id = ${cid} ORDER BY id`],
        ["processingActivities", sql`SELECT * FROM privacy_processing_activities WHERE client_id = ${cid} ORDER BY id`],
        ["rightsRequests", sql`SELECT * FROM privacy_rights_requests WHERE client_id = ${cid} ORDER BY id`],
        ["retentionSchedules", sql`SELECT * FROM privacy_retention_schedules WHERE client_id = ${cid} ORDER BY id`],
        ["retentionVerifications", sql`SELECT * FROM privacy_retention_verifications WHERE client_id = ${cid} ORDER BY id`],
        ["processorsAndTransfers", sql`SELECT * FROM privacy_processors WHERE client_id = ${cid} ORDER BY id`],
        ["breachAssessments", sql`SELECT * FROM privacy_breaches WHERE client_id = ${cid} ORDER BY id`],
      ] as const).map(async ([key, query]) => {
        try {
          return [[key, (await db.execute(query)).rows] as const];
        } catch (error) {
          out.fail(`privacy-governance.json (${key})`, error);
          return [];
        }
      }));
      archive.append(JSON.stringify(Object.fromEntries(privacySections.flat()), null, 2), { name: "privacy-governance.json" });

      incomplete = appendExportSummary(archive, out, { now, clientId: cid, maxBytes, usedBytes, omittedForCap });
    } catch (err: unknown) {
      // Only an unexpected fault outside a single dataset gets here (each
      // dataset records its own failure); nothing has been sent yet.
      console.error("Export query error", err);
      archive.abort();
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
      return;
    }
    if (failed) return;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="complytrack-export-${dateStr}${incomplete ? "-INCOMPLETE" : ""}.zip"`);
    res.setHeader("X-Export-Status", incomplete ? "incomplete" : "complete");
    res.setHeader("X-Export-Omitted-Datasets", String(out.errors.length));
    archive.pipe(res);
    await archive.finalize();
  })
);

export default router;
