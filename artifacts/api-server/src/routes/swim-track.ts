import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, denyViewers } from "../middleware/requireAuth";

const router = Router();

// All routes require auth (service gate applied at index.ts level)
router.use(requireAuth);

// Helper: unwrap drizzle result rows
function rows(result: any): any[] {
  return [...result];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sessions", async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { siteId, limit = "100" } = req.query as Record<string, string>;
    const result = await db.execute(sql`
      SELECT s.*, si.name AS site_name
      FROM swim_sessions s
      LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ${clientId}
        ${siteId ? sql`AND s.site_id = ${siteId}` : sql``}
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
    const {
      siteId, sessionDate, sessionType, lifeguardName, openTime, closeTime,
      maxBathers, batherCountPeak, preSessionResult, preSessionNotes,
      poolClosed, closureReason, notes, result,
    } = req.body;
    if (!sessionDate) return res.status(400).json({ error: "sessionDate is required" });

    const dbResult = await db.execute(sql`
      INSERT INTO swim_sessions (
        client_id, site_id, session_date, session_type, lifeguard_name,
        open_time, close_time, max_bathers, bather_count_peak,
        pre_session_result, pre_session_notes, pool_closed, closure_reason, notes, result
      ) VALUES (
        ${clientId}, ${siteId ?? null}, ${sessionDate},
        ${sessionType ?? "public_swim"}, ${lifeguardName?.trim() ?? null},
        ${openTime ?? null}, ${closeTime ?? null},
        ${maxBathers ?? null}, ${batherCountPeak ?? null},
        ${preSessionResult ?? "pass"}, ${preSessionNotes?.trim() ?? null},
        ${poolClosed ?? false}, ${closureReason?.trim() ?? null},
        ${notes?.trim() ?? null}, ${result ?? "pass"}
      )
      RETURNING *
    `);
    res.status(201).json(rows(dbResult)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.put("/sessions/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      siteId, sessionDate, sessionType, lifeguardName, openTime, closeTime,
      maxBathers, batherCountPeak, preSessionResult, preSessionNotes,
      poolClosed, closureReason, notes, result,
    } = req.body;
    const dbResult = await db.execute(sql`
      UPDATE swim_sessions SET
        site_id = ${siteId ?? null}, session_date = ${sessionDate},
        session_type = ${sessionType ?? "public_swim"},
        lifeguard_name = ${lifeguardName?.trim() ?? null},
        open_time = ${openTime ?? null}, close_time = ${closeTime ?? null},
        max_bathers = ${maxBathers ?? null}, bather_count_peak = ${batherCountPeak ?? null},
        pre_session_result = ${preSessionResult ?? "pass"},
        pre_session_notes = ${preSessionNotes?.trim() ?? null},
        pool_closed = ${poolClosed ?? false},
        closure_reason = ${closureReason?.trim() ?? null},
        notes = ${notes?.trim() ?? null}, result = ${result ?? "pass"},
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
    const { sessionId, siteId, checkDate, checkTime, batherCount, scanCompleted, observations, checkedBy, result } = req.body;
    if (!checkDate) return res.status(400).json({ error: "checkDate is required" });

    const dbResult = await db.execute(sql`
      INSERT INTO swim_surveillance_checks (
        client_id, session_id, site_id, check_date, check_time,
        bather_count, scan_completed, observations, checked_by, result
      ) VALUES (
        ${clientId}, ${sessionId ?? null}, ${siteId ?? null}, ${checkDate},
        ${checkTime ?? null}, ${batherCount ?? null}, ${scanCompleted ?? true},
        ${observations?.trim() ?? null}, ${checkedBy?.trim() ?? null}, ${result ?? "pass"}
      )
      RETURNING *
    `);
    res.status(201).json(rows(dbResult)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create surveillance check" });
  }
});

router.put("/surveillance/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const { siteId, checkDate, checkTime, batherCount, scanCompleted, observations, checkedBy, result } = req.body;
    const dbResult = await db.execute(sql`
      UPDATE swim_surveillance_checks SET
        site_id = ${siteId ?? null}, check_date = ${checkDate},
        check_time = ${checkTime ?? null}, bather_count = ${batherCount ?? null},
        scan_completed = ${scanCompleted ?? true},
        observations = ${observations?.trim() ?? null},
        checked_by = ${checkedBy?.trim() ?? null}, result = ${result ?? "pass"}
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
    const {
      siteId, checkDate, aedOk, firstAidKitOk, rescuePoleOk,
      throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk,
      checkedBy, defectsFound, notes,
    } = req.body;
    if (!checkDate) return res.status(400).json({ error: "checkDate is required" });

    const allOk = [aedOk, firstAidKitOk, rescuePoleOk, throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk]
      .every(v => v !== false);
    const result = allOk ? "pass" : "action_required";

    const dbResult = await db.execute(sql`
      INSERT INTO swim_first_aid_checks (
        client_id, site_id, check_date, aed_ok, first_aid_kit_ok,
        rescue_pole_ok, throw_bag_ok, spine_board_ok, ring_buoy_ok, oxygen_kit_ok,
        checked_by, defects_found, notes, result
      ) VALUES (
        ${clientId}, ${siteId ?? null}, ${checkDate},
        ${aedOk ?? true}, ${firstAidKitOk ?? true},
        ${rescuePoleOk ?? true}, ${throwBagOk ?? true}, ${spineBoardOk ?? true},
        ${ringBuoyOk ?? true}, ${oxygenKitOk ?? true},
        ${checkedBy?.trim() ?? null}, ${defectsFound?.trim() ?? null},
        ${notes?.trim() ?? null}, ${result}
      )
      RETURNING *
    `);
    res.status(201).json(rows(dbResult)[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create first-aid check" });
  }
});

router.put("/first-aid/:id", denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const {
      siteId, checkDate, aedOk, firstAidKitOk, rescuePoleOk,
      throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk,
      checkedBy, defectsFound, notes,
    } = req.body;
    const allOk = [aedOk, firstAidKitOk, rescuePoleOk, throwBagOk, spineBoardOk, ringBuoyOk, oxygenKitOk]
      .every(v => v !== false);
    const result = allOk ? "pass" : "action_required";

    const dbResult = await db.execute(sql`
      UPDATE swim_first_aid_checks SET
        site_id = ${siteId ?? null}, check_date = ${checkDate},
        aed_ok = ${aedOk ?? true}, first_aid_kit_ok = ${firstAidKitOk ?? true},
        rescue_pole_ok = ${rescuePoleOk ?? true}, throw_bag_ok = ${throwBagOk ?? true},
        spine_board_ok = ${spineBoardOk ?? true}, ring_buoy_ok = ${ringBuoyOk ?? true},
        oxygen_kit_ok = ${oxygenKitOk ?? true},
        checked_by = ${checkedBy?.trim() ?? null},
        defects_found = ${defectsFound?.trim() ?? null},
        notes = ${notes?.trim() ?? null}, result = ${result}, updated_at = now()
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
    const {
      siteId, incidentDate, incidentTime, incidentType, severity,
      personsInvolved, description, actionTaken, reportedTo,
      reportedDate, outcome, notes,
    } = req.body;
    if (!incidentDate) return res.status(400).json({ error: "incidentDate is required" });
    if (!description?.trim()) return res.status(400).json({ error: "description is required" });

    const dbResult = await db.execute(sql`
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
    res.status(201).json(rows(dbResult)[0]);
  } catch (err) {
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
          COUNT(*) FILTER (WHERE result = 'action_required' AND check_date >= ${thirtyDaysAgo}) AS action_required
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
