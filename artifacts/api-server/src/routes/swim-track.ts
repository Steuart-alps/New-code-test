import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sitesTable } from "@workspace/db/schema";
import { requireAuth, requireClientAdmin, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { resolveStaffPerformer as resolveStaffRoster, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import { createWithStagedPhotoReceipts, StagedPhotoReceiptError } from "../lib/stagedPhotoReceipts";

const router = Router();

// All routes require auth (service gate applied at index.ts level)
router.use(requireAuth);

// Helper: unwrap drizzle result rows
function rows(result: any): any[] {
  return result.rows;
}

async function checkSiteAccess(
  siteId: number | null,
  clientId: number,
  departmentId: number | null,
): Promise<"required" | "invalid" | "forbidden" | null> {
  if (siteId === null) return departmentId === null ? null : "required";
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return "invalid";

  const [site] = await db.select({ departmentId: sitesTable.departmentId })
    .from(sitesTable)
    .where(sql`${sitesTable.id} = ${siteId} AND ${sitesTable.clientId} = ${clientId}`)
    .limit(1);
  if (!site) return "invalid";
  if (departmentId !== null && site.departmentId !== null && site.departmentId !== departmentId) {
    return "forbidden";
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sessions", async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const { limit = "100" } = req.query as Record<string, string>;
    const rawSiteId = req.query.siteId;
    const hasSiteFilter = rawSiteId !== undefined && rawSiteId !== "";
    const requestedSiteId = hasSiteFilter ? Number(rawSiteId) : null;
    if (hasSiteFilter && (
      typeof rawSiteId !== "string"
      || !Number.isSafeInteger(requestedSiteId)
      || requestedSiteId! <= 0
    )) {
      return res.status(400).json({ error: "Invalid siteId" });
    }
    const departmentId = getActiveDepartmentId(req);
    const result = await db.execute(sql`
      SELECT s.*, si.name AS site_name
      FROM swim_sessions s
      LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ${clientId}
        ${hasSiteFilter ? sql`AND s.site_id = ${requestedSiteId}` : sql``}
        ${departmentId !== null ? sql`AND (s.site_id IS NULL OR s.site_id IN (
          SELECT id FROM sites WHERE client_id = ${clientId}
            AND (department_id IS NULL OR department_id = ${departmentId})
        ))` : sql``}
      ORDER BY s.session_date DESC, s.open_time DESC NULLS LAST
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

router.post("/sessions", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const {
       sessionDate, sessionType, lifeguardName, lifeguardRosterId, openTime, closeTime,
      maxBathers, batherCountPeak, preSessionResult, preSessionNotes,
       poolClosed, closureReason, notes, photoUploadIds,
    } = req.body;
    if (!sessionDate) return res.status(400).json({ error: "sessionDate is required" });
    const rawSiteId = req.body.siteId;
    const siteId = rawSiteId == null ? null : Number(rawSiteId);
    if (rawSiteId != null && (
      (typeof rawSiteId !== "number" && typeof rawSiteId !== "string")
      || !Number.isSafeInteger(siteId)
      || siteId! <= 0
    )) {
      return res.status(400).json({ error: "Invalid siteId" });
    }
    const siteAccess = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
    if (siteAccess === "required") return res.status(400).json({ error: "siteId is required" });
    if (siteAccess === "invalid") return res.status(400).json({ error: "Invalid site" });
    if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

    const performer = await resolveStaffRoster(clientId, lifeguardRosterId, lifeguardName);
    if (lifeguardRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const canonicalPreSessionResult = preSessionResult === "fail" ? "fail" : "pass";
    const canonicalResult = poolClosed === true ? "fail" : canonicalPreSessionResult;
    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "swim_session",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const dbResult = await tx.execute(sql`
        INSERT INTO swim_sessions (
          client_id, site_id, session_date, session_type, lifeguard_name, lifeguard_roster_id,
          open_time, close_time, max_bathers, bather_count_peak,
          pre_session_result, pre_session_notes, pool_closed, closure_reason, notes, result, created_by
        ) VALUES (
          ${clientId}, ${siteId ?? null}, ${sessionDate},
           ${sessionType ?? "public_swim"}, ${performer?.performedBy ?? lifeguardName?.trim() ?? null}, ${performer?.staffRosterId ?? null},
          ${openTime ?? null}, ${closeTime ?? null},
          ${maxBathers ?? null}, ${batherCountPeak ?? null},
          ${canonicalPreSessionResult}, ${preSessionNotes?.trim() ?? null},
          ${poolClosed ?? false}, ${closureReason?.trim() ?? null},
          ${notes?.trim() ?? null}, ${canonicalResult}, ${req.currentUser!.id}
        )
        RETURNING *
      `);
      return rows(dbResult)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.put("/sessions/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
       siteId, sessionDate, sessionType, lifeguardName, lifeguardRosterId, openTime, closeTime,
      maxBathers, batherCountPeak, preSessionResult, preSessionNotes,
      poolClosed, closureReason, notes,
    } = req.body;
    const existing = (await db.execute(sql`SELECT lifeguard_roster_id, lifeguard_name FROM swim_sessions WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
    if (!existing) return res.status(404).json({ error: "Session not found" });
    const performer = await resolveStaffPerformerUpdate(clientId, lifeguardRosterId, lifeguardName, existing.lifeguard_roster_id, existing.lifeguard_name);
    if (lifeguardRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const resultWasProvided = Object.prototype.hasOwnProperty.call(req.body, "result");
    const canonicalPreSessionResult = preSessionResult === "fail" ? "fail" : "pass";
    const canonicalResult = poolClosed === true ? "fail" : canonicalPreSessionResult;
    const dbResult = await db.execute(sql`
      UPDATE swim_sessions SET
        site_id = ${siteId ?? null}, session_date = ${sessionDate},
        session_type = ${sessionType ?? "public_swim"},
         lifeguard_name = ${performer?.performedBy},
         lifeguard_roster_id = ${performer?.staffRosterId ?? null},
        open_time = ${openTime ?? null}, close_time = ${closeTime ?? null},
        max_bathers = ${maxBathers ?? null}, bather_count_peak = ${batherCountPeak ?? null},
        pre_session_result = ${canonicalPreSessionResult},
        pre_session_notes = ${preSessionNotes?.trim() ?? null},
        pool_closed = ${poolClosed ?? false},
        closure_reason = ${closureReason?.trim() ?? null},
        notes = ${notes?.trim() ?? null},
        result = ${resultWasProvided ? canonicalResult : sql`result`},
        updated_at = now()
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(dbResult)[0];
    if (!row) return res.status(404).json({ error: "Session not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update session" });
  }
});

router.delete("/sessions/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`DELETE FROM swim_sessions WHERE id = ${req.params.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SURVEILLANCE CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/surveillance", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { siteId, sessionId, limit = "200" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT sc.*, si.name AS site_name
      FROM swim_surveillance_checks sc
      LEFT JOIN sites si ON si.id = sc.site_id
      WHERE sc.client_id = ${clientId}
        ${siteId ? sql`AND sc.site_id = ${siteId}` : sql``}
        ${sessionId ? sql`AND sc.session_id = ${sessionId}` : sql``}
      ORDER BY sc.check_date DESC, sc.check_time DESC NULLS LAST
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch surveillance checks" });
  }
});

router.post("/surveillance", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
     const { sessionId, siteId, checkDate, checkTime, batherCount, scanCompleted, observations, checkedBy, checkedByRosterId, photoUploadIds } = req.body;
     const performer = await resolveStaffRoster(clientId, checkedByRosterId, checkedBy);
     if (checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    if (!checkDate) return res.status(400).json({ error: "checkDate is required" });

    const canonicalResult = scanCompleted === false ? "fail" : "pass";
    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "swim_surveillance_check",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const dbResult = await tx.execute(sql`
        INSERT INTO swim_surveillance_checks (
          client_id, session_id, site_id, check_date, check_time,
           bather_count, scan_completed, observations, checked_by, checked_by_roster_id, result
        ) VALUES (
          ${clientId}, ${sessionId ?? null}, ${siteId ?? null}, ${checkDate},
          ${checkTime ?? null}, ${batherCount ?? null}, ${scanCompleted ?? true},
           ${observations?.trim() ?? null}, ${performer?.performedBy ?? checkedBy?.trim() ?? null}, ${performer?.staffRosterId ?? null}, ${canonicalResult}
        )
        RETURNING *
      `);
      return rows(dbResult)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create surveillance check" });
  }
});

router.put("/surveillance/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
     const { siteId, checkDate, checkTime, batherCount, scanCompleted, observations, checkedBy, checkedByRosterId } = req.body;
     const existing = (await db.execute(sql`SELECT checked_by_roster_id, checked_by FROM swim_surveillance_checks WHERE id=${req.params.id} AND client_id=${clientId}`)).rows[0] as any;
     if (!existing) return res.status(404).json({ error: "Check not found" });
     const performer = await resolveStaffPerformerUpdate(clientId, checkedByRosterId, checkedBy, existing.checked_by_roster_id, existing.checked_by);
     if (checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    const resultWasProvided = Object.prototype.hasOwnProperty.call(req.body, "result");
    const canonicalResult = scanCompleted === false ? "fail" : "pass";
    const dbResult = await db.execute(sql`
      UPDATE swim_surveillance_checks SET
        site_id = ${siteId ?? null}, check_date = ${checkDate},
        check_time = ${checkTime ?? null}, bather_count = ${batherCount ?? null},
        scan_completed = ${scanCompleted ?? true},
        observations = ${observations?.trim() ?? null},
         checked_by = ${performer?.performedBy},
         checked_by_roster_id = ${performer?.staffRosterId ?? null},
        result = ${resultWasProvided ? canonicalResult : sql`result`}
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(dbResult)[0];
    if (!row) return res.status(404).json({ error: "Check not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update surveillance check" });
  }
});

router.delete("/surveillance/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`DELETE FROM swim_surveillance_checks WHERE id = ${req.params.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete surveillance check" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIRST-AID / RESCUE EQUIPMENT READINESS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/first-aid", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { siteId, limit = "100" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT f.*, si.name AS site_name
      FROM swim_first_aid_checks f
      LEFT JOIN sites si ON si.id = f.site_id
      WHERE f.client_id = ${clientId}
        ${siteId ? sql`AND f.site_id = ${siteId}` : sql``}
      ORDER BY f.check_date DESC
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch first-aid checks" });
  }
});

router.post("/first-aid", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const {
      siteId, checkDate, aedOk, firstAidKitOk, rescuePoleOk,
      throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk,
       checkedBy, checkedByRosterId, defectsFound, notes, photoUploadIds,
    } = req.body;
     const performer = await resolveStaffRoster(clientId, checkedByRosterId, checkedBy);
     if (checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
    if (!checkDate) return res.status(400).json({ error: "checkDate is required" });

    const allOk = [aedOk, firstAidKitOk, rescuePoleOk, throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk]
      .every(v => v !== false);
    const result = allOk ? "pass" : "fail";

    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "swim_first_aid_check",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const dbResult = await tx.execute(sql`
        INSERT INTO swim_first_aid_checks (
          client_id, site_id, check_date, aed_ok, first_aid_kit_ok,
          rescue_pole_ok, throw_bag_ok, spine_board_ok, ring_buoy_ok, oxygen_kit_ok,
           checked_by, checked_by_roster_id, defects_found, notes, result
        ) VALUES (
          ${clientId}, ${siteId ?? null}, ${checkDate},
          ${aedOk ?? true}, ${firstAidKitOk ?? true},
          ${rescuePoleOk ?? true}, ${throwBagOk ?? true}, ${spineBoardOk ?? true},
          ${ringBuoyOk ?? true}, ${oxygenKitOk ?? true},
           ${performer?.performedBy ?? checkedBy?.trim() ?? null}, ${performer?.staffRosterId ?? null}, ${defectsFound?.trim() ?? null},
          ${notes?.trim() ?? null}, ${result}
        )
        RETURNING *
      `);
      return rows(dbResult)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create first-aid check" });
  }
});

router.put("/first-aid/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      siteId, checkDate, aedOk, firstAidKitOk, rescuePoleOk,
      throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk,
       checkedBy, checkedByRosterId, defectsFound, notes,
    } = req.body;
     const existing = (await db.execute(sql`
       SELECT *
       FROM swim_first_aid_checks
       WHERE id = ${req.params.id} AND client_id = ${clientId}
     `)).rows[0] as any;
     if (!existing) return res.status(404).json({ error: "Check not found" });
     const performer = await resolveStaffPerformerUpdate(
       clientId,
       checkedByRosterId,
       checkedBy,
       existing.checked_by_roster_id,
       existing.checked_by,
     );
     if (checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });

     const has = (key: string) => Object.prototype.hasOwnProperty.call(req.body, key);
     const mergedSiteId = has("siteId") ? siteId : existing.site_id;
     const mergedCheckDate = has("checkDate") ? checkDate : existing.check_date;
     const mergedAedOk = has("aedOk") ? (aedOk ?? true) : existing.aed_ok;
     const mergedFirstAidKitOk = has("firstAidKitOk") ? (firstAidKitOk ?? true) : existing.first_aid_kit_ok;
     const mergedRescuePoleOk = has("rescuePoleOk") ? (rescuePoleOk ?? true) : existing.rescue_pole_ok;
     const mergedThrowBagOk = has("throwBagOk") ? (throwBagOk ?? true) : existing.throw_bag_ok;
     const mergedSpineBoardOk = has("spineBoardOk") ? (spineBoardOk ?? true) : existing.spine_board_ok;
     const mergedRingBuoyOk = has("ringBuoyOk") ? (ringBuoyOk ?? true) : existing.ring_buoy_ok;
     const mergedOxygenKitOk = has("oxygenKitOk") ? (oxygenKitOk ?? true) : existing.oxygen_kit_ok;
     const mergedDefectsFound = has("defectsFound") ? (defectsFound?.trim() ?? null) : existing.defects_found;
     const mergedNotes = has("notes") ? (notes?.trim() ?? null) : existing.notes;
     const allOk = [
       mergedAedOk, mergedFirstAidKitOk, mergedRescuePoleOk, mergedThrowBagOk,
       mergedSpineBoardOk, mergedRingBuoyOk, mergedOxygenKitOk,
     ]
      .every(v => v !== false);
    const result = allOk ? "pass" : "fail";

    const dbResult = await db.execute(sql`
      UPDATE swim_first_aid_checks SET
         site_id = ${mergedSiteId ?? null}, check_date = ${mergedCheckDate},
         aed_ok = ${mergedAedOk}, first_aid_kit_ok = ${mergedFirstAidKitOk},
         rescue_pole_ok = ${mergedRescuePoleOk}, throw_bag_ok = ${mergedThrowBagOk},
         spine_board_ok = ${mergedSpineBoardOk}, ring_buoy_ok = ${mergedRingBuoyOk},
         oxygen_kit_ok = ${mergedOxygenKitOk},
        checked_by = ${performer?.performedBy ?? null},
        checked_by_roster_id = ${performer?.staffRosterId ?? null},
         defects_found = ${mergedDefectsFound},
         notes = ${mergedNotes}, result = ${result}, updated_at = now()
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(dbResult)[0];
    if (!row) return res.status(404).json({ error: "Check not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update first-aid check" });
  }
});

router.delete("/first-aid/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`DELETE FROM swim_first_aid_checks WHERE id = ${req.params.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete first-aid check" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/incidents", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { siteId, limit = "100" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT i.*, si.name AS site_name
      FROM swim_incidents i
      LEFT JOIN sites si ON si.id = i.site_id
      WHERE i.client_id = ${clientId}
        ${siteId ? sql`AND i.site_id = ${siteId}` : sql``}
      ORDER BY i.incident_date DESC, i.incident_time DESC NULLS LAST
      LIMIT ${parseInt(limit, 10)}
    `);
    res.json(rows(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

router.post("/incidents", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const {
      siteId, incidentDate, incidentTime, incidentType, severity,
      personsInvolved, description, actionTaken, reportedTo,
      reportedDate, outcome, notes, photoUploadIds,
    } = req.body;
    if (!incidentDate) return res.status(400).json({ error: "incidentDate is required" });
    if (!description?.trim()) return res.status(400).json({ error: "description is required" });

    const created = await createWithStagedPhotoReceipts({
      clientId,
      entityType: "swim_incident",
      actorId: req.currentUser!.id,
      photoUploadIds,
      requestBody: req.body,
    }, async (tx) => {
      const dbResult = await tx.execute(sql`
        INSERT INTO swim_incidents (
          client_id, site_id, incident_date, incident_time, incident_type, severity,
          persons_involved, description, action_taken, reported_to,
          reported_date, outcome, notes
        ) VALUES (
          ${clientId}, ${siteId ?? null}, ${incidentDate}, ${incidentTime ?? null},
          ${incidentType ?? "near_miss"}, ${severity ?? "low"},
          ${personsInvolved?.trim() ?? null}, ${description.trim()},
          ${actionTaken?.trim() ?? null}, ${reportedTo?.trim() ?? null},
          ${reportedDate ?? null}, ${outcome?.trim() ?? null}, ${notes?.trim() ?? null}
        )
        RETURNING *
      `);
      return rows(dbResult)[0];
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof StagedPhotoReceiptError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Failed to create incident" });
  }
});

router.put("/incidents/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      siteId, incidentDate, incidentTime, incidentType, severity,
      personsInvolved, description, actionTaken, reportedTo,
      reportedDate, outcome, notes,
    } = req.body;
    const dbResult = await db.execute(sql`
      UPDATE swim_incidents SET
        site_id = ${siteId ?? null}, incident_date = ${incidentDate},
        incident_time = ${incidentTime ?? null},
        incident_type = ${incidentType ?? "near_miss"}, severity = ${severity ?? "low"},
        persons_involved = ${personsInvolved?.trim() ?? null},
        description = ${description?.trim() ?? ""},
        action_taken = ${actionTaken?.trim() ?? null},
        reported_to = ${reportedTo?.trim() ?? null},
        reported_date = ${reportedDate ?? null},
        outcome = ${outcome?.trim() ?? null}, notes = ${notes?.trim() ?? null},
        updated_at = now()
      WHERE id = ${req.params.id} AND client_id = ${clientId}
      RETURNING *
    `);
    const row = rows(dbResult)[0];
    if (!row) return res.status(404).json({ error: "Incident not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update incident" });
  }
});

router.delete("/incidents/:id", requireClientAdmin, async (req, res) => {
  try {
    const clientId = getClientId(req);
    await db.execute(sql`DELETE FROM swim_incidents WHERE id = ${req.params.id} AND client_id = ${clientId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete incident" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/status", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const today = new Date().toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];

    const [sessionsResult, surveillanceResult, firstAidResult, incidentResult] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*) AS total_today, COUNT(*) FILTER (WHERE pool_closed) AS closed_today
        FROM swim_sessions WHERE client_id = ${clientId} AND session_date = ${today}
      `),
      db.execute(sql`
        SELECT COUNT(*) AS checks_today
        FROM swim_surveillance_checks WHERE client_id = ${clientId} AND check_date = ${today}
      `),
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE check_date >= ${thirtyDaysAgo}) AS checks_last_30d,
          MAX(check_date) AS last_check_date,
          COUNT(*) FILTER (
            WHERE result IN ('fail', 'action_required')
              AND check_date >= ${thirtyDaysAgo}
          ) AS action_required
        FROM swim_first_aid_checks WHERE client_id = ${clientId}
      `),
      db.execute(sql`
        SELECT COUNT(*) AS open_incidents
        FROM swim_incidents WHERE client_id = ${clientId} AND outcome IS NULL
      `),
    ]);

    const sess = rows(sessionsResult)[0] as any;
    const surv = rows(surveillanceResult)[0] as any;
    const fa = rows(firstAidResult)[0] as any;
    const inc = rows(incidentResult)[0] as any;

    res.json({
      sessionsToday:      Number(sess?.total_today ?? 0),
      poolsClosedToday:   Number(sess?.closed_today ?? 0),
      surveillanceToday:  Number(surv?.checks_today ?? 0),
      firstAidLast30d:    Number(fa?.checks_last_30d ?? 0),
      firstAidActionRequired: Number(fa?.action_required ?? 0),
      lastFirstAidCheck:  fa?.last_check_date ?? null,
      openIncidents:      Number(inc?.open_incidents ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

export default router;
