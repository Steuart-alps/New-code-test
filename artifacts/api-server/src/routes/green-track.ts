import { Router } from "express";
import { db } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import { getClientId, requireClientAdmin, requireAuth } from "../middleware/requireAuth";
import { appSettingsTable } from "@workspace/db/schema";

const router = Router();

// ─── Machine types ────────────────────────────────────────────────────────────
export const MACHINE_TYPES = [
  "ride_on_cylinder",
  "ride_on_rotary",
  "fairway_mower",
  "walk_behind",
  "tractor",
  "utility_vehicle",
  "sprayer_spreader",
  "aerator",
  "scarifier",
  "roller",
  "edger_strimmer",
  "other",
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rows<T = any>(result: any): T[] {
  return [...result] as T[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MACHINES — fleet register
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/machines", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const result = await db.execute(sql`
      SELECT m.*, s.name AS site_name
      FROM green_machines m
      LEFT JOIN sites s ON s.id = m.site_id
      WHERE m.client_id = ${clientId}
      ORDER BY m.active DESC, m.type, m.name
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch machines" });
  }
});

router.post("/machines", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { name, type, make, model, serialNo, year, regNo, siteId, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Machine name is required" });
    if (!type) return res.status(400).json({ error: "Machine type is required" });
    const result = await db.execute(sql`
      INSERT INTO green_machines (client_id, site_id, name, type, make, model, serial_no, year, reg_no, notes)
      VALUES (${clientId}, ${siteId ?? null}, ${name.trim()}, ${type},
              ${make?.trim() ?? null}, ${model?.trim() ?? null}, ${serialNo?.trim() ?? null},
              ${year ?? null}, ${regNo?.trim() ?? null}, ${notes?.trim() ?? null})
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create machine" });
  }
});

router.put("/machines/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { id } = req.params;
    const { name, type, make, model, serialNo, year, regNo, siteId, active, notes } = req.body;
    const result = await db.execute(sql`
      UPDATE green_machines
      SET name = ${name?.trim()}, type = ${type}, make = ${make?.trim() ?? null},
          model = ${model?.trim() ?? null}, serial_no = ${serialNo?.trim() ?? null},
          year = ${year ?? null}, reg_no = ${regNo?.trim() ?? null},
          site_id = ${siteId ?? null}, active = ${active ?? true},
          notes = ${notes?.trim() ?? null}, updated_at = now()
      WHERE id = ${id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(result)[0];
    if (!row) return res.status(404).json({ error: "Machine not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update machine" });
  }
});

router.delete("/machines/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`
      DELETE FROM green_machines WHERE id = ${req.params.id} AND client_id = ${clientId}
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete machine" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-USE CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/pre-use-checks", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, limit = "100" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT c.*, m.name AS machine_name, m.type AS machine_type
      FROM green_pre_use_checks c
      JOIN green_machines m ON m.id = c.machine_id
      WHERE c.client_id = ${clientId}
        ${machineId ? sql`AND c.machine_id = ${machineId}` : sql``}
      ORDER BY c.check_date DESC, c.created_at DESC
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch pre-use checks" });
  }
});

router.post("/pre-use-checks", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      machineId, checkDate, operator,
      fluidLevelsOk, tyresOk, bladesOk, guardsOk, controlsOk, lightsOk, cleanlinessOk,
      defectNoted, result: checkResult, notes,
    } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!checkDate) return res.status(400).json({ error: "checkDate is required" });

    // Verify machine belongs to client
    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });

    const result = await db.execute(sql`
      INSERT INTO green_pre_use_checks (
        client_id, machine_id, check_date, operator,
        fluid_levels_ok, tyres_ok, blades_ok, guards_ok, controls_ok, lights_ok, cleanliness_ok,
        defect_noted, result, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${checkDate}, ${operator?.trim() ?? null},
        ${fluidLevelsOk ?? null}, ${tyresOk ?? null}, ${bladesOk ?? null},
        ${guardsOk ?? null}, ${controlsOk ?? null}, ${lightsOk ?? null}, ${cleanlinessOk ?? null},
        ${defectNoted ?? false}, ${checkResult ?? "pass"}, ${notes?.trim() ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create pre-use check" });
  }
});

router.put("/pre-use-checks/:id", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      checkDate, operator,
      fluidLevelsOk, tyresOk, bladesOk, guardsOk, controlsOk, lightsOk, cleanlinessOk,
      defectNoted, result: checkResult, notes,
    } = req.body;
    const result = await db.execute(sql`
      UPDATE green_pre_use_checks
      SET check_date = ${checkDate}, operator = ${operator?.trim() ?? null},
          fluid_levels_ok = ${fluidLevelsOk ?? null}, tyres_ok = ${tyresOk ?? null},
          blades_ok = ${bladesOk ?? null}, guards_ok = ${guardsOk ?? null},
          controls_ok = ${controlsOk ?? null}, lights_ok = ${lightsOk ?? null},
          cleanliness_ok = ${cleanlinessOk ?? null}, defect_noted = ${defectNoted ?? false},
          result = ${checkResult ?? "pass"}, notes = ${notes?.trim() ?? null}
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(result)[0];
    if (!row) return res.status(404).json({ error: "Check not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update pre-use check" });
  }
});

router.delete("/pre-use-checks/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`
      DELETE FROM green_pre_use_checks WHERE id = ${req.params.id} AND client_id = ${clientId}
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete pre-use check" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE RECORDS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/service-records", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, limit = "100" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT s.*, m.name AS machine_name, m.type AS machine_type
      FROM green_service_records s
      JOIN green_machines m ON m.id = s.machine_id
      WHERE s.client_id = ${clientId}
        ${machineId ? sql`AND s.machine_id = ${machineId}` : sql``}
      ORDER BY s.service_date DESC, s.created_at DESC
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch service records" });
  }
});

router.post("/service-records", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      machineId, serviceDate, serviceType, hoursAtService, nextServiceHours,
      nextServiceDate, workPerformed, servicedBy, costPence, notes,
    } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!serviceDate) return res.status(400).json({ error: "serviceDate is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });

    const result = await db.execute(sql`
      INSERT INTO green_service_records (
        client_id, machine_id, service_date, service_type, hours_at_service, next_service_hours,
        next_service_date, work_performed, serviced_by, cost_pence, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${serviceDate}, ${serviceType ?? "scheduled"},
        ${hoursAtService ?? null}, ${nextServiceHours ?? null}, ${nextServiceDate ?? null},
        ${workPerformed?.trim() ?? null}, ${servicedBy?.trim() ?? null},
        ${costPence ?? null}, ${notes?.trim() ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create service record" });
  }
});

router.put("/service-records/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      serviceDate, serviceType, hoursAtService, nextServiceHours,
      nextServiceDate, workPerformed, servicedBy, costPence, notes,
    } = req.body;
    const result = await db.execute(sql`
      UPDATE green_service_records
      SET service_date = ${serviceDate}, service_type = ${serviceType ?? "scheduled"},
          hours_at_service = ${hoursAtService ?? null}, next_service_hours = ${nextServiceHours ?? null},
          next_service_date = ${nextServiceDate ?? null}, work_performed = ${workPerformed?.trim() ?? null},
          serviced_by = ${servicedBy?.trim() ?? null}, cost_pence = ${costPence ?? null},
          notes = ${notes?.trim() ?? null}, updated_at = now()
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(result)[0];
    if (!row) return res.status(404).json({ error: "Service record not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update service record" });
  }
});

router.delete("/service-records/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`
      DELETE FROM green_service_records WHERE id = ${req.params.id} AND client_id = ${clientId}
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete service record" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFECTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/defects", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, status, limit = "200" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT d.*, m.name AS machine_name, m.type AS machine_type
      FROM green_defects d
      JOIN green_machines m ON m.id = d.machine_id
      WHERE d.client_id = ${clientId}
        ${machineId ? sql`AND d.machine_id = ${machineId}` : sql``}
        ${status ? sql`AND d.status = ${status}` : sql``}
      ORDER BY
        CASE d.status WHEN 'open' THEN 0 WHEN 'under_repair' THEN 1 ELSE 2 END,
        CASE d.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,
        d.report_date DESC
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch defects" });
  }
});

router.post("/defects", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, reportDate, reportedBy, description, severity, outOfService, notes } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!description?.trim()) return res.status(400).json({ error: "description is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });

    const result = await db.execute(sql`
      INSERT INTO green_defects (
        client_id, machine_id, report_date, reported_by, description, severity, out_of_service, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${reportDate ?? new Date().toISOString().split("T")[0]},
        ${reportedBy?.trim() ?? null}, ${description.trim()},
        ${severity ?? "minor"}, ${outOfService ?? false}, ${notes?.trim() ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create defect report" });
  }
});

router.put("/defects/:id", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { reportDate, reportedBy, description, severity, outOfService, status, resolution, resolvedDate, notes } = req.body;
    const result = await db.execute(sql`
      UPDATE green_defects
      SET report_date = ${reportDate}, reported_by = ${reportedBy?.trim() ?? null},
          description = ${description?.trim()}, severity = ${severity ?? "minor"},
          out_of_service = ${outOfService ?? false}, status = ${status ?? "open"},
          resolution = ${resolution?.trim() ?? null}, resolved_date = ${resolvedDate ?? null},
          notes = ${notes?.trim() ?? null}, updated_at = now()
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(result)[0];
    if (!row) return res.status(404).json({ error: "Defect not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update defect" });
  }
});

router.delete("/defects/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`
      DELETE FROM green_defects WHERE id = ${req.params.id} AND client_id = ${clientId}
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete defect" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUWER STATUTORY INSPECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/puwer-inspections", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, limit = "100" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT p.*, m.name AS machine_name, m.type AS machine_type
      FROM green_puwer_inspections p
      JOIN green_machines m ON m.id = p.machine_id
      WHERE p.client_id = ${clientId}
        ${machineId ? sql`AND p.machine_id = ${machineId}` : sql``}
      ORDER BY p.inspection_date DESC
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch PUWER inspections" });
  }
});

router.post("/puwer-inspections", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      machineId, inspectionDate, nextInspectionDate, inspectionType,
      inspectorName, inspectorCompany, certRef, safeToOperate, defectsFound, result: checkResult, notes,
    } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!inspectionDate) return res.status(400).json({ error: "inspectionDate is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });

    const result = await db.execute(sql`
      INSERT INTO green_puwer_inspections (
        client_id, machine_id, inspection_date, next_inspection_date, inspection_type,
        inspector_name, inspector_company, cert_ref, safe_to_operate, defects_found, result, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${inspectionDate}, ${nextInspectionDate ?? null},
        ${inspectionType ?? "thorough_examination"},
        ${inspectorName?.trim() ?? null}, ${inspectorCompany?.trim() ?? null},
        ${certRef?.trim() ?? null}, ${safeToOperate ?? true},
        ${defectsFound?.trim() ?? null}, ${checkResult ?? "pass"}, ${notes?.trim() ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create PUWER inspection" });
  }
});

router.put("/puwer-inspections/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      inspectionDate, nextInspectionDate, inspectionType,
      inspectorName, inspectorCompany, certRef, safeToOperate, defectsFound, result: checkResult, notes,
    } = req.body;
    const result = await db.execute(sql`
      UPDATE green_puwer_inspections
      SET inspection_date = ${inspectionDate}, next_inspection_date = ${nextInspectionDate ?? null},
          inspection_type = ${inspectionType ?? "thorough_examination"},
          inspector_name = ${inspectorName?.trim() ?? null}, inspector_company = ${inspectorCompany?.trim() ?? null},
          cert_ref = ${certRef?.trim() ?? null}, safe_to_operate = ${safeToOperate ?? true},
          defects_found = ${defectsFound?.trim() ?? null}, result = ${checkResult ?? "pass"},
          notes = ${notes?.trim() ?? null}, updated_at = now()
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(result)[0];
    if (!row) return res.status(404).json({ error: "Inspection not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update PUWER inspection" });
  }
});

router.delete("/puwer-inspections/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`
      DELETE FROM green_puwer_inspections WHERE id = ${req.params.id} AND client_id = ${clientId}
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete PUWER inspection" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUEL & OIL LOGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/fuel-logs", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, limit = "200" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT f.*, m.name AS machine_name, m.type AS machine_type
      FROM green_fuel_logs f
      JOIN green_machines m ON m.id = f.machine_id
      WHERE f.client_id = ${clientId}
        ${machineId ? sql`AND f.machine_id = ${machineId}` : sql``}
      ORDER BY f.log_date DESC, f.created_at DESC
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch fuel logs" });
  }
});

router.post("/fuel-logs", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, logDate, fuelType, quantityLitres, engineHours, costPence, filledBy, notes } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });

    const result = await db.execute(sql`
      INSERT INTO green_fuel_logs (
        client_id, machine_id, log_date, fuel_type, quantity_litres, engine_hours, cost_pence, filled_by, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${logDate ?? new Date().toISOString().split("T")[0]},
        ${fuelType ?? "diesel"}, ${quantityLitres ?? null}, ${engineHours ?? null},
        ${costPence ?? null}, ${filledBy?.trim() ?? null}, ${notes?.trim() ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create fuel log" });
  }
});

router.put("/fuel-logs/:id", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { logDate, fuelType, quantityLitres, engineHours, costPence, filledBy, notes } = req.body;
    const result = await db.execute(sql`
      UPDATE green_fuel_logs
      SET log_date = ${logDate}, fuel_type = ${fuelType ?? "diesel"},
          quantity_litres = ${quantityLitres ?? null}, engine_hours = ${engineHours ?? null},
          cost_pence = ${costPence ?? null}, filled_by = ${filledBy?.trim() ?? null},
          notes = ${notes?.trim() ?? null}
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(result)[0];
    if (!row) return res.status(404).json({ error: "Fuel log not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update fuel log" });
  }
});

router.delete("/fuel-logs/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`
      DELETE FROM green_fuel_logs WHERE id = ${req.params.id} AND client_id = ${clientId}
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete fuel log" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/status", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const today = new Date().toISOString().split("T")[0];

    const [machinesResult, defectsResult, preUseResult, serviceResult] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active
        FROM green_machines WHERE client_id = ${clientId}
      `),
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('open','under_repair')) AS open_count,
          COUNT(*) FILTER (WHERE status IN ('open','under_repair') AND out_of_service) AS out_of_service_count,
          COUNT(*) FILTER (WHERE status IN ('open','under_repair') AND severity = 'critical') AS critical_count
        FROM green_defects WHERE client_id = ${clientId}
      `),
      db.execute(sql`
        SELECT COUNT(DISTINCT m.id) AS checked_today
        FROM green_machines m
        LEFT JOIN green_pre_use_checks c
          ON c.machine_id = m.id AND c.check_date = ${today} AND c.client_id = ${clientId}
        WHERE m.client_id = ${clientId} AND m.active AND c.id IS NOT NULL
      `),
      db.execute(sql`
        SELECT COUNT(*) AS overdue_service
        FROM (
          SELECT DISTINCT ON (machine_id) machine_id, next_service_date
          FROM green_service_records
          WHERE client_id = ${clientId}
          ORDER BY machine_id, service_date DESC
        ) latest
        WHERE next_service_date < ${today}
      `),
    ]);

    const machines = rows(machinesResult)[0] as any;
    const defects = rows(defectsResult)[0] as any;
    const preUse = rows(preUseResult)[0] as any;
    const service = rows(serviceResult)[0] as any;

    res.json({
      totalMachines: Number(machines?.total ?? 0),
      activeMachines: Number(machines?.active ?? 0),
      openDefects: Number(defects?.open_count ?? 0),
      outOfService: Number(defects?.out_of_service_count ?? 0),
      criticalDefects: Number(defects?.critical_count ?? 0),
      checkedTodayCount: Number(preUse?.checked_today ?? 0),
      overdueService: Number(service?.overdue_service ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ── Template config ───────────────────────────────────────────────────────────
const GREEN_CONFIG_KEYS = [
  "green_default_operators", // JSON: string[]
  "green_show_fuel",         // "true"|"false"
] as const;

const GREEN_DEFAULT_CONFIG = {
  green_default_operators: "",
  green_show_fuel: "true",
};

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...GREEN_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (GREEN_CONFIG_KEYS.includes(row.key as (typeof GREEN_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  res.json(config);
});

router.put("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updates = req.body as Record<string, string>;
  for (const key of GREEN_CONFIG_KEYS) {
    if (key in updates) {
      const existing = await db.select({ id: appSettingsTable.clientId }).from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key))).limit(1);
      if (existing.length > 0) {
        await db.update(appSettingsTable).set({ value: updates[key], updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db.insert(appSettingsTable).values({ clientId, key, value: updates[key] });
      }
    }
  }
  res.json({ ok: true });
});

export default router;
