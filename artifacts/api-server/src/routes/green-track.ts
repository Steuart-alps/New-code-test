import { Router } from "express";
import { db } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import { getClientId, requireClientAdmin, requireAuth, denyViewers } from "../middleware/requireAuth";
import { appSettingsTable } from "@workspace/db/schema";
import { resolveStaffPerformer as resolveStaffRoster, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { createWithStagedPhotoReceipts, StagedPhotoReceiptError } from "../lib/stagedPhotoReceipts";

const router = Router();

// ─── Machine types ────────────────────────────────────────────────────────────
export const MACHINE_TYPES = [
  "ride_on_cylinder",
  "ride_on_rotary",
  "ride_on",
  "pedestrian",
  "fairway_mower",
  "walk_behind",
  "tractor",
  "utility_vehicle",
  "sprayer_spreader",
  "aerator",
  "atv_quad",
  "blower",
  "chainsaw",
  "hedge_trimmer",
  "topdresser",
  "scarifier",
  "roller",
  "edger_strimmer",
  "other",
] as const;

const MACHINE_TYPE_ALIASES: Record<string, string> = {
  "ride-on": "ride_on",
  "ride on": "ride_on",
  rideon: "ride_on",
  ride_on_mower: "ride_on",
  pedestrian: "pedestrian",
  pedestrian_mower: "pedestrian",
  "walk behind": "walk_behind",
  "walk-behind": "walk_behind",
  "walk behind mower": "walk_behind",
  "ride-on cylinder": "ride_on_cylinder",
  "ride-on rotary": "ride_on_rotary",
  "fairway": "fairway_mower",
  "utility": "utility_vehicle",
  "sprayer": "sprayer_spreader",
  "spreader": "sprayer_spreader",
  "atv": "atv_quad",
  "quad": "atv_quad",
  "hedge trimmer": "hedge_trimmer",
  "edger": "edger_strimmer",
  "strimmer": "edger_strimmer",
};

function normalizeMachineType(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const underscored = raw.replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const normalized = MACHINE_TYPE_ALIASES[raw] ?? MACHINE_TYPE_ALIASES[underscored] ?? underscored;
  return (MACHINE_TYPES as readonly string[]).includes(normalized) ? normalized : null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rows<T = any>(result: any): T[] {
  return result.rows as T[];
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

router.post("/machines/import", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const input = req.body?.rows;
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ error: "At least one equipment row is required" });
    }
    if (input.length > 500) {
      return res.status(400).json({ error: "Import is limited to 500 equipment rows" });
    }

    const siteRows = rows<{ id: number }>(await db.execute(sql`
      SELECT id FROM sites WHERE client_id = ${clientId}
    `));
    const siteIds = new Set(siteRows.map(site => Number(site.id)));
    const errors: Array<{ row: number; error: string }> = [];
    const normalizedRows: Array<{
      name: string;
      type: string;
      make: string | null;
      model: string | null;
      serialNo: string | null;
      year: number | null;
      regNo: string | null;
      siteId: number | null;
      notes: string | null;
      active: boolean;
    }> = [];

    input.forEach((rawRow: any, index: number) => {
      const rowNumber = index + 2;
      const name = String(rawRow?.name ?? "").trim();
      const type = normalizeMachineType(rawRow?.type);
      const yearValue = rawRow?.year === undefined || rawRow?.year === null || String(rawRow.year).trim() === ""
        ? null
        : Number(rawRow.year);
      const siteId = rawRow?.siteId === undefined || rawRow?.siteId === null || String(rawRow.siteId).trim() === ""
        ? null
        : Number(rawRow.siteId);

      if (!name) errors.push({ row: rowNumber, error: "Name is required" });
      if (!type) errors.push({ row: rowNumber, error: "Type must be one of the approved GreenTrack types (ride-on and pedestrian are supported aliases)" });
      if (yearValue !== null && (!Number.isInteger(yearValue) || yearValue < 1900 || yearValue > 2100)) {
        errors.push({ row: rowNumber, error: "Year must be a whole number between 1900 and 2100" });
      }
      if (siteId !== null && (!Number.isInteger(siteId) || !siteIds.has(siteId))) {
        errors.push({ row: rowNumber, error: "Site does not belong to this account" });
      }
      if (!name || !type || errors.some(error => error.row === rowNumber)) return;

      normalizedRows.push({
        name,
        type,
        make: String(rawRow?.make ?? "").trim() || null,
        model: String(rawRow?.model ?? "").trim() || null,
        serialNo: String(rawRow?.serialNo ?? "").trim() || null,
        year: yearValue,
        regNo: String(rawRow?.regNo ?? "").trim() || null,
        siteId,
        notes: String(rawRow?.notes ?? "").trim() || null,
        active: rawRow?.active !== false,
      });
    });

    if (errors.length) {
      return res.status(400).json({ error: "Import contains invalid rows", errors });
    }

    const result = await db.transaction(async tx => {
      const existing = rows<{ name: string; type: string; serial_no: string | null; reg_no: string | null }>(
        await tx.execute(sql`
          SELECT name, type, serial_no, reg_no
          FROM green_machines
          WHERE client_id = ${clientId}
        `),
      );
      const existingKeys = new Set<string>();
      for (const machine of existing) {
        if (machine.serial_no) existingKeys.add(`serial:${machine.serial_no.trim().toLowerCase()}`);
        if (machine.reg_no) existingKeys.add(`reg:${machine.reg_no.trim().toLowerCase()}`);
        existingKeys.add(`name:${machine.name.trim().toLowerCase()}|${machine.type}`);
      }

      let imported = 0;
      const skipped: Array<{ row: number; name: string; reason: string }> = [];
      for (const [index, machine] of normalizedRows.entries()) {
        const keys = [
          machine.serialNo ? `serial:${machine.serialNo.toLowerCase()}` : null,
          machine.regNo ? `reg:${machine.regNo.toLowerCase()}` : null,
          `name:${machine.name.toLowerCase()}|${machine.type}`,
        ].filter(Boolean) as string[];
        if (keys.some(key => existingKeys.has(key))) {
          skipped.push({ row: index + 2, name: machine.name, reason: "Already in fleet" });
          continue;
        }
        await tx.execute(sql`
          INSERT INTO green_machines
            (client_id, site_id, name, type, make, model, serial_no, year, reg_no, active, notes)
          VALUES
            (${clientId}, ${machine.siteId}, ${machine.name}, ${machine.type}, ${machine.make},
             ${machine.model}, ${machine.serialNo}, ${machine.year}, ${machine.regNo},
             ${machine.active}, ${machine.notes})
        `);
        keys.forEach(key => existingKeys.add(key));
        imported += 1;
      }
      return { imported, skipped };
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to import equipment roster" });
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

router.post("/pre-use-checks", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const {
       machineId, checkDate, operator, operatorRosterId,
      fluidLevelsOk, tyresOk, bladesOk, guardsOk, controlsOk, lightsOk, cleanlinessOk,
        checklistItems, fuelLevel, defectNoted, notes, photoUploadIds,
    } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!checkDate) return res.status(400).json({ error: "checkDate is required" });

    let parsedChecklist: Array<{ key: string; label: string; section: string; status: "ok" | "fail" | "na"; note?: string }> | null = null;
    if (checklistItems !== undefined) {
      if (!Array.isArray(checklistItems) || checklistItems.length === 0) {
        return res.status(400).json({ error: "checklistItems must contain at least one item" });
      }
      parsedChecklist = checklistItems.map((item: any) => ({
        key: String(item?.key ?? "").trim(),
        label: String(item?.label ?? "").trim(),
        section: String(item?.section ?? "General").trim(),
        status: item?.status,
        ...(item?.note?.trim() ? { note: String(item.note).trim() } : {}),
      }));
      if (parsedChecklist.some(item =>
        !item.key || !item.label || !["ok", "fail", "na"].includes(item.status)
      )) {
        return res.status(400).json({ error: "Every checklist item needs a key, label and OK, FAIL or N/A status" });
      }
    }

    // Verify machine belongs to client
    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });
    const performer = await resolveStaffRoster(clientId, operatorRosterId, operator);
    if (operatorRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });

    // The checklist is the source of truth. Never persist caller-supplied
    // aliases such as "advisory" as a newly recorded observation.
    const canonicalResult = parsedChecklist
      ? (parsedChecklist.some(item => item.status === "fail") ? "fail" : "pass")
      : ([fluidLevelsOk, tyresOk, bladesOk, guardsOk, controlsOk, lightsOk, cleanlinessOk]
        .some((value) => value === false) ? "fail" : "pass");
    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "green_pre_use_check",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO green_pre_use_checks (
           client_id, machine_id, check_date, operator, operator_roster_id,
          fluid_levels_ok, tyres_ok, blades_ok, guards_ok, controls_ok, lights_ok, cleanliness_ok,
           defect_noted, result, notes, checklist_items, fuel_level, submitted_at
        ) VALUES (
           ${clientId}, ${machineId}, ${checkDate}, ${performer?.performedBy ?? operator?.trim() ?? null}, ${performer?.staffRosterId ?? null},
          ${fluidLevelsOk ?? null}, ${tyresOk ?? null}, ${bladesOk ?? null},
          ${guardsOk ?? null}, ${controlsOk ?? null}, ${lightsOk ?? null}, ${cleanlinessOk ?? null},
           ${parsedChecklist?.some(item => item.status === "fail") ?? defectNoted ?? false},
           ${canonicalResult}, ${notes?.trim() ?? null}, ${parsedChecklist ? JSON.stringify(parsedChecklist) : null},
           ${fuelLevel?.trim() ?? null}, now()
        )
        RETURNING *
      `);
      return rows(result)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create pre-use check" });
  }
});

router.put("/pre-use-checks/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
       checkDate, operator, operatorRosterId,
      fluidLevelsOk, tyresOk, bladesOk, guardsOk, controlsOk, lightsOk, cleanlinessOk,
       checklistItems, fuelLevel, defectNoted, notes,
    } = req.body;
    const existing = (await db.execute(sql`SELECT * FROM green_pre_use_checks WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
    if (!existing) return res.status(404).json({ error: "Check not found" });
    const performer = await resolveStaffPerformerUpdate(clientId, operatorRosterId, operator, existing.operator_roster_id, existing.operator);
    if (operatorRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    let parsedChecklist: Array<{ key: string; label: string; section: string; status: "ok" | "fail" | "na"; note?: string }> | null | undefined;
    if (checklistItems !== undefined) {
      if (!Array.isArray(checklistItems) || checklistItems.length === 0) {
        return res.status(400).json({ error: "checklistItems must contain at least one item" });
      }
      parsedChecklist = checklistItems.map((item: any) => ({
        key: String(item?.key ?? "").trim(),
        label: String(item?.label ?? "").trim(),
        section: String(item?.section ?? "General").trim(),
        status: item?.status,
        ...(item?.note?.trim() ? { note: String(item.note).trim() } : {}),
      }));
      if (parsedChecklist.some(item =>
        !item.key || !item.label || !["ok", "fail", "na"].includes(item.status)
      )) {
        return res.status(400).json({ error: "Every checklist item needs a key, label and OK, FAIL or N/A status" });
      }
    }
    const value = (input: any, stored: any) => input === undefined ? stored : input;
    const merged = [fluidLevelsOk, tyresOk, bladesOk, guardsOk, controlsOk, lightsOk, cleanlinessOk]
      .map((input, index) => value(input, [existing.fluid_levels_ok, existing.tyres_ok, existing.blades_ok, existing.guards_ok, existing.controls_ok, existing.lights_ok, existing.cleanliness_ok][index]));
    const storedChecklist = Array.isArray(existing.checklist_items) ? existing.checklist_items : null;
    const effectiveChecklist = parsedChecklist === undefined ? storedChecklist : parsedChecklist;
    const canonicalResult = effectiveChecklist
      ? (effectiveChecklist.some((item: any) => item.status === "fail") ? "fail" : "pass")
      : (merged.some((value) => value === false) ? "fail" : "pass");
    const result = await db.execute(sql`
      UPDATE green_pre_use_checks
       SET check_date = ${value(checkDate, existing.check_date)},
           operator = ${performer?.performedBy ?? null}, operator_roster_id = ${performer?.staffRosterId ?? null},
           fluid_levels_ok = ${merged[0]}, tyres_ok = ${merged[1]},
          blades_ok = ${merged[2]}, guards_ok = ${merged[3]},
          controls_ok = ${merged[4]}, lights_ok = ${merged[5]},
           cleanliness_ok = ${merged[6]},
           defect_noted = ${effectiveChecklist ? effectiveChecklist.some((item: any) => item.status === "fail") : value(defectNoted, existing.defect_noted)},
           result = ${canonicalResult},
           notes = ${notes === undefined ? existing.notes : notes?.trim() ?? null},
           checklist_items = ${parsedChecklist === undefined ? existing.checklist_items ?? null : JSON.stringify(parsedChecklist)},
           fuel_level = ${fuelLevel === undefined ? existing.fuel_level ?? null : fuelLevel?.trim() ?? null},
           submitted_at = COALESCE(submitted_at, now())
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
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const {
      machineId, serviceDate, serviceType, hoursAtService, nextServiceHours,
      nextServiceDate, workPerformed, servicedBy, servicedByRosterId, costPence, notes, photoUploadIds,
    } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!serviceDate) return res.status(400).json({ error: "serviceDate is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });
    const performer = await resolveStaffRoster(clientId, servicedByRosterId, servicedBy);
    if (servicedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });

    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "green_service",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO green_service_records (
          client_id, machine_id, service_date, service_type, hours_at_service, next_service_hours,
          next_service_date, work_performed, serviced_by, serviced_by_roster_id, cost_pence, notes
        ) VALUES (
          ${clientId}, ${machineId}, ${serviceDate}, ${serviceType ?? "scheduled"},
          ${hoursAtService ?? null}, ${nextServiceHours ?? null}, ${nextServiceDate ?? null},
          ${workPerformed?.trim() ?? null}, ${performer?.performedBy ?? servicedBy?.trim() ?? null}, ${performer?.staffRosterId ?? null},
          ${costPence ?? null}, ${notes?.trim() ?? null}
        )
        RETURNING *
      `);
      return rows(result)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create service record" });
  }
});

router.put("/service-records/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      serviceDate, serviceType, hoursAtService, nextServiceHours,
      nextServiceDate, workPerformed, servicedBy, servicedByRosterId, costPence, notes,
    } = req.body;
    const existing = (await db.execute(sql`SELECT * FROM green_service_records WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
    if (!existing) return res.status(404).json({ error: "Service record not found" });
    const performer = await resolveStaffPerformerUpdate(clientId, servicedByRosterId, servicedBy, existing.serviced_by_roster_id, existing.serviced_by);
    if (servicedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const value = (input: any, stored: any) => input === undefined ? stored : input;
    const result = await db.execute(sql`
      UPDATE green_service_records
      SET service_date = ${value(serviceDate, existing.service_date)}, service_type = ${value(serviceType, existing.service_type)},
          hours_at_service = ${value(hoursAtService, existing.hours_at_service)}, next_service_hours = ${value(nextServiceHours, existing.next_service_hours)},
          next_service_date = ${value(nextServiceDate, existing.next_service_date)}, work_performed = ${workPerformed === undefined ? existing.work_performed : workPerformed?.trim() ?? null},
          serviced_by = ${performer?.performedBy ?? null}, serviced_by_roster_id = ${performer?.staffRosterId ?? null}, cost_pence = ${value(costPence, existing.cost_pence)},
          notes = ${notes === undefined ? existing.notes : notes?.trim() ?? null}, updated_at = now()
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

router.post("/defects", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const { machineId, reportDate, reportedBy, reportedByRosterId, description, severity, outOfService, notes, photoUploadIds } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!description?.trim()) return res.status(400).json({ error: "description is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });
    const performer = await resolveStaffRoster(clientId, reportedByRosterId, reportedBy);
    if (reportedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });

    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "green_defect",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO green_defects (
          client_id, machine_id, report_date, reported_by, reported_by_roster_id, description, severity, out_of_service, notes
        ) VALUES (
          ${clientId}, ${machineId}, ${reportDate ?? new Date().toISOString().split("T")[0]},
          ${performer?.performedBy ?? reportedBy?.trim() ?? null}, ${performer?.staffRosterId ?? null}, ${description.trim()},
          ${severity ?? "minor"}, ${outOfService ?? false}, ${notes?.trim() ?? null}
        )
        RETURNING *
      `);
      return rows(result)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create defect report" });
  }
});

router.put("/defects/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { reportDate, reportedBy, reportedByRosterId, description, severity, outOfService, status, resolution, resolvedDate, notes } = req.body;
    const existing = (await db.execute(sql`SELECT * FROM green_defects WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
    if (!existing) return res.status(404).json({ error: "Defect not found" });
    const performer = await resolveStaffPerformerUpdate(clientId, reportedByRosterId, reportedBy, existing.reported_by_roster_id, existing.reported_by);
    if (reportedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const value = (input: any, stored: any) => input === undefined ? stored : input;
    const result = await db.execute(sql`
      UPDATE green_defects
      SET report_date = ${value(reportDate, existing.report_date)}, reported_by = ${performer?.performedBy ?? null}, reported_by_roster_id = ${performer?.staffRosterId ?? null},
          description = ${description === undefined ? existing.description : description?.trim() ?? null}, severity = ${value(severity, existing.severity)},
          out_of_service = ${value(outOfService, existing.out_of_service)}, status = ${value(status, existing.status)},
          resolution = ${resolution === undefined ? existing.resolution : resolution?.trim() ?? null}, resolved_date = ${value(resolvedDate, existing.resolved_date)},
          notes = ${notes === undefined ? existing.notes : notes?.trim() ?? null}, updated_at = now()
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
      inspectorName, inspectorRosterId, inspectorCompany, certRef, safeToOperate, defectsFound, notes,
    } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!inspectionDate) return res.status(400).json({ error: "inspectionDate is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });
    const performer = await resolveStaffRoster(clientId, inspectorRosterId, inspectorName);
    if (inspectorRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });

    const canonicalResult = safeToOperate === false ? "fail" : "pass";
    const result = await db.execute(sql`
      INSERT INTO green_puwer_inspections (
        client_id, machine_id, inspection_date, next_inspection_date, inspection_type,
        inspector_name, inspector_roster_id, inspector_company, cert_ref, safe_to_operate, defects_found, result, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${inspectionDate}, ${nextInspectionDate ?? null},
        ${inspectionType ?? "thorough_examination"},
        ${performer?.performedBy ?? inspectorName?.trim() ?? null}, ${performer?.staffRosterId ?? null}, ${inspectorCompany?.trim() ?? null},
        ${certRef?.trim() ?? null}, ${safeToOperate ?? true},
        ${defectsFound?.trim() ?? null}, ${canonicalResult}, ${notes?.trim() ?? null}
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
      inspectorName, inspectorRosterId, inspectorCompany, certRef, safeToOperate, defectsFound, notes,
    } = req.body;
    const existing = (await db.execute(sql`SELECT * FROM green_puwer_inspections WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
    if (!existing) return res.status(404).json({ error: "Inspection not found" });
    const performer = await resolveStaffPerformerUpdate(clientId, inspectorRosterId, inspectorName, existing.inspector_roster_id, existing.inspector_name);
    if (inspectorRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const mergedSafeToOperate = safeToOperate === undefined ? existing.safe_to_operate : safeToOperate;
    const canonicalResult = mergedSafeToOperate === false ? "fail" : "pass";
    const value = (input: any, stored: any) => input === undefined ? stored : input;
    const result = await db.execute(sql`
      UPDATE green_puwer_inspections
      SET inspection_date = ${value(inspectionDate, existing.inspection_date)}, next_inspection_date = ${value(nextInspectionDate, existing.next_inspection_date)},
          inspection_type = ${value(inspectionType, existing.inspection_type)},
          inspector_name = ${performer?.performedBy ?? null}, inspector_roster_id = ${performer?.staffRosterId ?? null}, inspector_company = ${inspectorCompany === undefined ? existing.inspector_company : inspectorCompany?.trim() ?? null},
          cert_ref = ${certRef === undefined ? existing.cert_ref : certRef?.trim() ?? null}, safe_to_operate = ${mergedSafeToOperate},
          defects_found = ${defectsFound === undefined ? existing.defects_found : defectsFound?.trim() ?? null}, result = ${canonicalResult},
          notes = ${notes === undefined ? existing.notes : notes?.trim() ?? null}, updated_at = now()
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

router.post("/fuel-logs", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { machineId, logDate, fuelType, quantityLitres, engineHours, costPence, filledBy, filledByRosterId, notes } = req.body;
    if (!machineId) return res.status(400).json({ error: "machineId is required" });

    const machineCheck = await db.execute(sql`
      SELECT id FROM green_machines WHERE id = ${machineId} AND client_id = ${clientId}
    `);
    if (!rows(machineCheck).length) return res.status(404).json({ error: "Machine not found" });
    const performer = await resolveStaffRoster(clientId, filledByRosterId, filledBy);
    if (filledByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });

    const result = await db.execute(sql`
      INSERT INTO green_fuel_logs (
        client_id, machine_id, log_date, fuel_type, quantity_litres, engine_hours, cost_pence, filled_by, filled_by_roster_id, notes
      ) VALUES (
        ${clientId}, ${machineId}, ${logDate ?? new Date().toISOString().split("T")[0]},
        ${fuelType ?? "diesel"}, ${quantityLitres ?? null}, ${engineHours ?? null},
        ${costPence ?? null}, ${performer?.performedBy ?? filledBy?.trim() ?? null}, ${performer?.staffRosterId ?? null}, ${notes?.trim() ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(rows(result)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create fuel log" });
  }
});

router.put("/fuel-logs/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { logDate, fuelType, quantityLitres, engineHours, costPence, filledBy, filledByRosterId, notes } = req.body;
    const existing = (await db.execute(sql`SELECT * FROM green_fuel_logs WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
    if (!existing) return res.status(404).json({ error: "Fuel log not found" });
    const performer = await resolveStaffPerformerUpdate(clientId, filledByRosterId, filledBy, existing.filled_by_roster_id, existing.filled_by);
    if (filledByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const value = (input: any, stored: any) => input === undefined ? stored : input;
    const result = await db.execute(sql`
      UPDATE green_fuel_logs
      SET log_date = ${value(logDate, existing.log_date)}, fuel_type = ${value(fuelType, existing.fuel_type)},
          quantity_litres = ${value(quantityLitres, existing.quantity_litres)}, engine_hours = ${value(engineHours, existing.engine_hours)},
          cost_pence = ${value(costPence, existing.cost_pence)}, filled_by = ${performer?.performedBy ?? null}, filled_by_roster_id = ${performer?.staffRosterId ?? null},
          notes = ${notes === undefined ? existing.notes : notes?.trim() ?? null}
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

router.put("/config", requireAuth, denyViewers, async (req, res) => {
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
