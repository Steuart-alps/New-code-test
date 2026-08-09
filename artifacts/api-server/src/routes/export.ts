/**
 * GET /api/export — full client data export as a ZIP archive.
 *
 * Returns every compliance record scoped to the caller's client as CSVs
 * organised by module, plus a README. Restricted to client_admin and
 * consultant roles; rate-limited by the express-rate-limit applied in app.ts.
 */
import { Router } from "express";
// archiver v8 is pure ESM — use ZipArchive directly, no factory function.
import { ZipArchive } from "archiver";
import { db } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
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
legionella/
  checks.csv                     — legionella / water hygiene checks
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

Note: file attachments (PDFs, photos) are stored in cloud object storage.
Their URLs are included in the relevant CSVs.
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

      // ── Legionella ────────────────────────────────────────────────────────
      const legChecks = await db.select().from(legionellaChecksTable).where(eq(legionellaChecksTable.clientId, cid));
      archive.append(rowsToCsv(legChecks), { name: "legionella/checks.csv" });

      // ── Kitchen ───────────────────────────────────────────────────────────
      const dailyChecklists = await db.select().from(dailyChecklistsTable).where(eq(dailyChecklistsTable.clientId, cid));
      archive.append(rowsToCsv(dailyChecklists), { name: "kitchen/daily-checklists.csv" });

      const mgSignoffs = await db.select().from(dailyManagerSignoffsTable).where(eq(dailyManagerSignoffsTable.clientId, cid));
      archive.append(rowsToCsv(mgSignoffs), { name: "kitchen/manager-signoffs.csv" });

      const kwRows = await db.execute(sql`SELECT * FROM kitchen_weekly_records WHERE client_id = ${cid} ORDER BY week_start_date DESC`);
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
      const staffRows = await db.execute(sql`SELECT id, client_id, site_id, name, job_title, department, employment_type, start_date, active, notes, created_at FROM staff_roster WHERE client_id = ${cid} ORDER BY name ASC`);
      archive.append(rawToCsv(staffRows.rows), { name: "staff-roster/staff.csv" });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Export query error", err);
      archive.append(`Export error: ${msg}\n`, { name: "_EXPORT_ERROR.txt" });
    }

    await archive.finalize();
  }
);

export default router;
