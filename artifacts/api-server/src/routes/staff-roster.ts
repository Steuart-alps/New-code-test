import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, requireRole, getActiveDepartmentId } from "../middleware/requireAuth";
import { visibleSiteIdsSql } from "../lib/departmentSites";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { digestBearerToken } from "../lib/bearerTokens";
import { makeLoginRateLimit } from "../lib/loginRateLimit";
import { getAccountToday } from "../lib/accountClock";
import { logger } from "../lib/logger";
import { ROSTER_CHECK_MODULE, ensureRosterChecksForClient, monthStart, rosterUpdateNote } from "../lib/rosterChecks";

const router = Router();

const pinSchema = z.string().regex(/^\d{4,6}$/, "PIN must contain 4-6 digits");
const kioskTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const kioskAction = { type: "start_shift", label: "Start shift" } as const;
// Enrollment links are capabilities, so quota valid links independently from
// malformed traffic at the source IP. This lets a user recover after another
// user (or device) has exhausted the IP's invalid-attempt quota.
const publicEnrollmentRateLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  namespace: "staff-pin-enrollment",
  key: req => {
    const token = req.body?.enrollment_token;
    return typeof token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(token)
      ? `token:${digestBearerToken(token).slice(0, 16)}`
      : `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
  },
});
// This endpoint is public only for staff holding an enrollment capability.
// Authenticated users must go through the normal role guard rather than
// consuming (or being blocked by) the public IP limiter.
const enrollmentRateLimit = (req: Request, res: Response, next: NextFunction) => {
  if (req.currentUser) {
    requireRole("client_admin", "consultant")(req, res, next);
    return;
  }
  publicEnrollmentRateLimit(req, res, next);
};
// Preserve the display name while keeping the legacy first/last columns useful.
const canonicalName = (value: string) => value.trim().replace(/\s+/g, " ");
const splitName = (value: string): [string, string | null] => {
  const name = canonicalName(value);
  const separator = name.indexOf(" ");
  return separator < 0 ? [name, null] : [name.slice(0, separator), name.slice(separator + 1) || null];
};

async function kioskClient(token: unknown): Promise<number | null> {
  const parsed = kioskTokenSchema.safeParse(token);
  if (!parsed.success) return null;
  const result = await db.execute(sql`SELECT id FROM clients WHERE staff_kiosk_token_hash=${digestBearerToken(parsed.data)} AND active=true LIMIT 1`);
  return (result.rows?.[0] as any)?.id ? Number((result.rows as any[])[0].id) : null;
}

// Who on the roster the signed-in person may see. Owners and consultants (and
// Managers over every department) see everyone. Anyone else sees the staff at
// the sites their department can see, plus staff with no site, the same rule
// as the tracks, so a business's sites stay apart unless an Owner gives
// someone a department at another site. (Viewers never reach the roster.)
function rosterScopeSql(req: Request, clientId: number) {
  const departmentId = getActiveDepartmentId(req);
  if (departmentId === null) return sql``;
  return sql`AND (sr.site_id IS NULL OR sr.site_id IN (${visibleSiteIdsSql(clientId, departmentId)}))`;
}

// PIN roster compatibility API.  These endpoints intentionally use staff_roster
// rather than a second table, preserving existing document/training references.
router.get("/staff", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  const includeInactive = req.query.includeInactive === "true";
  const result = await db.execute(sql`
    SELECT sr.id, sr.client_id, sr.name, sr.role, sr.active, sr.created_at,
           (sr.pin_hash IS NOT NULL) AS has_pin
    FROM staff_roster sr
    WHERE sr.client_id = ${clientId}
      ${includeInactive ? sql`` : sql`AND sr.active = true`}
      ${rosterScopeSql(req, clientId)}
    ORDER BY sr.name ASC
  `);
  res.json(result.rows ?? []);
});

// Public kiosk discovery is deliberately token-bound. A client slug or numeric
// client id is not sufficient to enumerate another tenant's staff.
router.get("/staff/public", async (req, res) => {
  const clientId = await kioskClient(req.header("x-kiosk-token"));
  if (!clientId) { res.status(401).json({ error: "Invalid kiosk token" }); return; }
  const result = await db.execute(sql`SELECT id, name, role, active, (pin_hash IS NOT NULL) AS has_pin
    FROM staff_roster WHERE client_id=${clientId} AND active=true ORDER BY name ASC`);
  res.json(result.rows ?? []);
});

router.post("/staff/kiosk-token", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  const token = randomBytes(32).toString("base64url");
  await db.execute(sql`UPDATE clients SET staff_kiosk_token_hash=${digestBearerToken(token)}, updated_at=now() WHERE id=${clientId}`);
  res.status(201).json({ kiosk_token: token });
});

router.post("/staff", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  const parsed = z.object({
    name: z.string().trim().min(1).max(300),
    role: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() }); return; }
  const displayName = canonicalName(parsed.data.name);
  const [firstName, lastName] = splitName(displayName);
  const result = await db.execute(sql`
    INSERT INTO staff_roster (client_id, name, first_name, last_name, role, active)
    VALUES (${clientId}, ${displayName}, ${firstName}, ${lastName}, ${parsed.data.role ?? null}, ${parsed.data.active ?? true})
    RETURNING id, client_id, name, role, active, created_at
  `);
  res.status(201).json((result.rows ?? [])[0]);
});

router.put("/staff/:id", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({
    name: z.string().trim().min(1).max(300).optional(),
    role: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) { res.status(400).json({ error: "Invalid data" }); return; }
  const nameChanged = parsed.data.name !== undefined;
  const [firstName, lastName] = nameChanged ? splitName(parsed.data.name!) : [null, null];
  const result = await db.execute(sql`
    UPDATE staff_roster SET
      name = COALESCE(${nameChanged ? canonicalName(parsed.data.name!) : null}, name),
      first_name = CASE WHEN ${nameChanged}::boolean THEN ${firstName} ELSE first_name END,
      last_name = CASE WHEN ${nameChanged}::boolean THEN ${lastName} ELSE last_name END,
      role = CASE WHEN ${parsed.data.role !== undefined}::boolean THEN ${parsed.data.role ?? null} ELSE role END,
      active = CASE WHEN ${parsed.data.active !== undefined}::boolean THEN ${parsed.data.active ?? true} ELSE active END,
      updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING id, client_id, name, role, active, created_at
  `);
  const row = (result.rows ?? [])[0];
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/staff/:id", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const result = await db.execute(sql`
    UPDATE staff_roster SET active = false, updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId} RETURNING id
  `);
  if (!(result.rows ?? [])[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).end();
});

async function issueEnrollment(clientId: number, id: number) {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM staff_roster WHERE id=${id} AND client_id=${clientId} AND active=true FOR UPDATE`);
    await tx.execute(sql`UPDATE staff_pin_enrollment_tokens SET consumed_at=now()
      WHERE client_id=${clientId} AND staff_member_id=${id} AND consumed_at IS NULL AND expires_at > now()`);
    await tx.execute(sql`INSERT INTO staff_pin_enrollment_tokens (client_id, staff_member_id, token_hash, expires_at)
      VALUES (${clientId}, ${id}, ${digestBearerToken(token)}, now() + interval '15 minutes')`);
  });
  return token;
}

router.post("/staff/:id/pin-enrollment", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req), id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id)) { res.status(400).json({ error: "Invalid staff member" }); return; }
  const found = await db.execute(sql`SELECT id FROM staff_roster WHERE id=${id} AND client_id=${clientId} AND active=true`);
  if (!(found.rows ?? [])[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.status(201).json({ enrollment_token: await issueEnrollment(clientId, id), expiresInSeconds: 900 });
});

router.post("/staff/:id/reset-pin", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req), id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id)) { res.status(400).json({ error: "Invalid staff member" }); return; }
  const result = await db.transaction(async tx => {
    const locked = await tx.execute(sql`SELECT id FROM staff_roster WHERE id=${id} AND client_id=${clientId} AND active=true FOR UPDATE`);
    if (!(locked.rows ?? [])[0]) return null;
    const row = await tx.execute(sql`UPDATE staff_roster SET pin_hash=NULL, pin_attempts=0, pin_locked_until=NULL,
      pin_setup_attempts=0, pin_setup_locked_until=NULL, updated_at=now()
      WHERE id=${id} AND client_id=${clientId} AND active=true RETURNING id`);
    if (!(row.rows ?? [])[0]) return null;
    await tx.execute(sql`UPDATE staff_pin_enrollment_tokens SET consumed_at=now()
      WHERE client_id=${clientId} AND staff_member_id=${id} AND consumed_at IS NULL AND expires_at > now()`);
    const token = randomBytes(32).toString("base64url");
    await tx.execute(sql`INSERT INTO staff_pin_enrollment_tokens (client_id, staff_member_id, token_hash, expires_at)
      VALUES (${clientId}, ${id}, ${digestBearerToken(token)}, now() + interval '15 minutes')`);
    return token;
  });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  res.status(201).json({ enrollment_token: result, expiresInSeconds: 900 });
});

router.post("/staff/:id/set-pin", enrollmentRateLimit, async (req, res) => {
  const enrollmentToken = req.body?.enrollment_token;
  const parsedToken = kioskTokenSchema.safeParse(enrollmentToken);
  const id = Number(req.params.id);
  const parsed = z.object({ pin: z.unknown().optional() }).safeParse(req.body);
  if (!parsedToken.success || !Number.isInteger(id) || id <= 0 || !parsed.success) { res.status(401).json({ error: "Valid enrollment token required" }); return; }
  const pin = typeof parsed.data.pin === "string" ? parsed.data.pin : "";
  const validPin = pinSchema.safeParse(pin).success;
  const tokenHash = digestBearerToken(parsedToken.data);
  // Do not spend bcrypt work until the capability has passed all cheap,
  // tenant/member-bound checks. The transaction below repeats these checks
  // under a row lock to preserve one-use semantics under concurrent requests.
  const preflight = await db.execute(sql`SELECT e.id
    FROM staff_roster s
    JOIN staff_pin_enrollment_tokens e ON e.staff_member_id=s.id AND e.client_id=s.client_id
    WHERE s.id=${id} AND e.token_hash=${tokenHash} AND e.consumed_at IS NULL
      AND e.expires_at > now() AND s.active=true
    LIMIT 1`);
  if (!(preflight.rows ?? [])[0] || !validPin) {
    if (!(preflight.rows ?? [])[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.status(400).json({ error: "PIN must contain 4-6 digits" }); return;
  }
  const hash = await bcrypt.hash(pin, 12);
  const outcome = await db.transaction(async tx => {
    const found = await tx.execute(sql`SELECT s.id, s.client_id, s.pin_hash, s.pin_setup_attempts, s.pin_setup_locked_until, e.id AS enrollment_id
      FROM staff_roster s JOIN staff_pin_enrollment_tokens e ON e.staff_member_id=s.id AND e.client_id=s.client_id
      WHERE s.id=${id} AND e.token_hash=${tokenHash} AND e.consumed_at IS NULL
        AND e.expires_at > now() AND s.active=true FOR UPDATE`);
    const row = (found.rows ?? [])[0] as any;
    if (!row) {
      const consumed = await tx.execute(sql`SELECT s.pin_hash FROM staff_roster s
        JOIN staff_pin_enrollment_tokens e ON e.staff_member_id=s.id AND e.client_id=s.client_id
        WHERE s.id=${id} AND e.token_hash=${tokenHash} AND e.consumed_at IS NOT NULL
        FOR UPDATE`);
      if ((consumed.rows ?? [])[0]?.pin_hash) return "conflict" as const;
      return "missing" as const;
    }
    if (row.pin_setup_locked_until && new Date(row.pin_setup_locked_until).getTime() > Date.now()) return "locked" as const;
    if (row.pin_hash || !validPin) {
      const attempts = Number(row.pin_setup_attempts ?? 0) + 1;
      if (attempts >= 5) {
        await tx.execute(sql`UPDATE staff_roster SET pin_setup_attempts=0, pin_setup_locked_until=now() + interval '15 minutes' WHERE id=${id} AND client_id=${row.client_id}`);
        return "locked" as const;
      }
      await tx.execute(sql`UPDATE staff_roster SET pin_setup_attempts=${attempts} WHERE id=${id} AND client_id=${row.client_id}`);
      return row.pin_hash ? "conflict" as const : "invalid" as const;
    }
    await tx.execute(sql`UPDATE staff_roster SET pin_hash=${hash}, pin_setup_attempts=0, pin_setup_locked_until=NULL, updated_at=now()
      WHERE id=${id} AND client_id=${row.client_id} AND pin_hash IS NULL`);
    await tx.execute(sql`UPDATE staff_pin_enrollment_tokens SET consumed_at=now()
      WHERE id=${row.enrollment_id} AND consumed_at IS NULL`);
    return "ok" as const;
  });
  if (outcome === "missing") { res.status(404).json({ error: "Not found" }); return; }
  if (outcome === "locked") { res.status(429).json({ error: "PIN setup locked", retryAfterMinutes: 15 }); return; }
  if (outcome === "conflict") { res.status(409).json({ error: "PIN already set" }); return; }
  if (outcome === "invalid") { res.status(400).json({ error: "PIN must contain 4-6 digits" }); return; }
  res.status(204).end();
});

router.post("/staff/verify-pin", async (req, res) => {
  const parsed = z.object({ staff_member_id: z.coerce.number().int().positive(), pin: pinSchema.optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid staff member, client, or PIN" }); return; }
  const { staff_member_id: id, pin } = parsed.data;
  const clientId = await kioskClient(req.header("x-kiosk-token"));
  if (!clientId) { res.status(401).json({ error: "Valid kiosk token required" }); return; }
  const capability = randomBytes(32).toString("base64url");
  const outcome = await db.transaction(async tx => {
    const result = await tx.execute(sql`SELECT id, name, pin_hash, pin_attempts, pin_locked_until
      FROM staff_roster WHERE id=${id} AND client_id=${clientId} AND active=true FOR UPDATE`);
    const row = (result.rows ?? [])[0] as any;
    if (!row) return { kind: "missing" as const };
    if (row.pin_locked_until && new Date(row.pin_locked_until).getTime() > Date.now()) return { kind: "locked" as const, until: row.pin_locked_until };
    if (!row.pin_hash) return { kind: "needs_pin" as const };
    if (!pin || !(await bcrypt.compare(pin, row.pin_hash))) {
      const attempts = Number(row.pin_attempts ?? 0) + 1;
      if (attempts >= 5) {
        await tx.execute(sql`UPDATE staff_roster SET pin_attempts=0, pin_locked_until=now() + interval '15 minutes' WHERE id=${id} AND client_id=${clientId}`);
        return { kind: "locked" as const, until: "15 minutes" };
      }
      await tx.execute(sql`UPDATE staff_roster SET pin_attempts=${attempts} WHERE id=${id} AND client_id=${clientId}`);
      return { kind: "invalid" as const, remaining: 5 - attempts };
    }
    await tx.execute(sql`UPDATE staff_roster SET pin_attempts=0, pin_locked_until=NULL WHERE id=${id} AND client_id=${clientId}`);
    await tx.execute(sql`INSERT INTO staff_kiosk_capabilities (client_id, staff_member_id, token_hash, action_type, expires_at)
      VALUES (${clientId}, ${id}, ${digestBearerToken(capability)}, ${kioskAction.type}, now() + interval '10 minutes')`);
    return { kind: "ok" as const, pinRequired: true };
  });
  if (outcome.kind === "missing") { res.status(404).json({ error: "Not found" }); return; }
  if (outcome.kind === "locked") { res.status(429).json({ error: "PIN locked", retryAfter: outcome.until }); return; }
  if (outcome.kind === "invalid") { res.status(401).json({ error: "Invalid PIN", attemptsRemaining: outcome.remaining }); return; }
  if (outcome.kind === "needs_pin") { res.json({ staff_member_id: id, verified: false, needs_pin: true }); return; }
  res.json({ staff_member_id: id, verified: true, pinRequired: outcome.pinRequired, capability, capabilityExpiresInSeconds: 600, action: kioskAction });
});

router.post("/staff/kiosk-action", async (req, res) => {
  const parsed = z.object({
    capability: kioskTokenSchema,
    action_type: z.string().trim().min(1).max(100),
    payload: z.record(z.string(), z.unknown()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid kiosk action" }); return; }
  const result = await db.transaction(async tx => {
    const found = await tx.execute(sql`SELECT id, client_id, staff_member_id, action_type, target FROM staff_kiosk_capabilities
      WHERE token_hash=${digestBearerToken(parsed.data.capability)} AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`);
    const capability = (found.rows ?? [])[0] as any;
    if (!capability) return null;
    if (capability.action_type !== parsed.data.action_type || capability.target !== "staff_shift_check_ins") return "wrong_action" as const;
    await tx.execute(sql`UPDATE staff_kiosk_capabilities SET consumed_at=now() WHERE id=${capability.id}`);
    const action = await tx.execute(sql`INSERT INTO staff_shift_check_ins (client_id, staff_member_id)
      VALUES (${capability.client_id}, ${capability.staff_member_id})
      RETURNING id, client_id, staff_member_id, checked_in_at`);
    return (action.rows ?? [])[0];
  });
  if (result === "wrong_action") { res.status(403).json({ error: "Action is not allowed for this capability" }); return; }
  if (!result) { res.status(401).json({ error: "Capability expired or already used" }); return; }
  res.status(201).json(result);
});

const staffCreate = z.object({
  name: z.string().min(1).max(300),
  externalPayrollId: z.string().trim().min(1).max(200).nullable().optional(),
  jobTitle: z.string().max(300).nullable().optional(),
  department: z.string().max(300).nullable().optional(),
  email: z.string().email().max(300).nullable().optional().or(z.literal("").transform(() => null)),
  siteId: z.number().int().nullable().optional(),
  active: z.boolean().optional(),
});

const staffUpdate = staffCreate.partial();
// A payroll ID is recommended (it keeps people matched when names change)
// but rosters from small businesses often have none.
const rosterRow = staffCreate.extend({
  externalPayrollId: z.string().trim().max(200).nullable().optional().transform(value => value || null),
  active: z.boolean().optional(),
});
const reconcileBody = z.object({
  rows: z.array(rosterRow).min(1).max(1000),
  siteId: z.number().int().positive().nullable().optional(),
  preview: z.boolean().default(true),
  /** Answer Yes to this month's roster check (lib/rosterChecks.ts) with this upload. */
  rosterCheck: z.object({
    taskId: z.number().int().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict().optional(),
}).strict();
const normalizeIdentifier = (value: string) => value.trim().toUpperCase();
const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const normalizeEmail = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() || null;

// Columns returned for roster rows. PIN hashes and lockout counters are
// never sent to the browser.
const ROSTER_COLUMNS = sql.raw(`sr.id, sr.client_id, sr.site_id, sr.name, sr.first_name, sr.last_name,
  sr.external_payroll_id, sr.last_reconciled_at, sr.job_title, sr.department, sr.email, sr.active,
  sr.created_at, sr.updated_at`);

async function loadRosterRow(id: number, clientId: number) {
  const result = await db.execute(sql`
    SELECT ${ROSTER_COLUMNS}, s.name AS site_name
    FROM staff_roster sr
    LEFT JOIN sites s ON s.id = sr.site_id AND s.client_id = sr.client_id
    WHERE sr.id = ${id} AND sr.client_id = ${clientId}
    LIMIT 1
  `);
  return (result.rows ?? [])[0];
}

/** A roster entry may only be placed on one of the business's own sites. */
async function siteBelongsToClient(siteId: number | null | undefined, clientId: number): Promise<boolean> {
  if (siteId == null) return true;
  const result = await db.execute(sql`SELECT id FROM sites WHERE id = ${siteId} AND client_id = ${clientId} LIMIT 1`);
  return (result.rows ?? []).length > 0;
}

// ── List staff ────────────────────────────────────────────────────────────────

router.get("/staff-roster", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { includeInactive, siteId } = req.query as any;

  const result = await db.execute(sql`
    SELECT sr.id, sr.client_id, sr.site_id, sr.name, sr.external_payroll_id, sr.last_reconciled_at, sr.job_title, sr.department,
           sr.email, sr.active, sr.created_at, sr.updated_at,
           s.name AS site_name
    FROM staff_roster sr
    LEFT JOIN sites s ON s.id = sr.site_id AND s.client_id = sr.client_id
    WHERE sr.client_id = ${clientId}
      ${includeInactive !== "true" ? sql`AND sr.active = true` : sql``}
      ${rosterScopeSql(req, clientId)}
    ORDER BY sr.name ASC
  `);

  let rows = (result.rows ?? []) as any[];
  if (siteId) rows = rows.filter((r: any) => r.site_id === Number(siteId));

  res.json(rows);
});

// ── Create staff member ───────────────────────────────────────────────────────

// Payroll IDs are unique per business (UQ_staff_roster_client_payroll_id).
function isDuplicatePayrollId(err: any) {
  const pgErr = err?.code ? err : err?.cause;
  return pgErr?.code === "23505" && pgErr?.constraint === "UQ_staff_roster_client_payroll_id";
}
const DUPLICATE_PAYROLL_ID_ERROR = "Payroll ID already in use";

router.post("/staff-roster", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = staffCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { name, externalPayrollId, jobTitle, department, email, siteId, active } = parsed.data;
  if (!await siteBelongsToClient(siteId, clientId)) {
    return res.status(403).json({ error: "Selected site does not belong to this client" });
  }
  const displayName = canonicalName(name);
  const [firstName, lastName] = splitName(displayName);

  let result;
  try {
    result = await db.execute(sql`
      INSERT INTO staff_roster AS sr (client_id, site_id, name, first_name, last_name, external_payroll_id, job_title, department, email, active)
      VALUES (${clientId}, ${siteId ?? null}, ${displayName}, ${firstName}, ${lastName}, ${externalPayrollId ? normalizeIdentifier(externalPayrollId) : null}, ${jobTitle ?? null},
              ${department ?? null}, ${email ?? null}, ${active ?? true})
      RETURNING ${ROSTER_COLUMNS}
    `);
  } catch (err) {
    if (isDuplicatePayrollId(err)) return res.status(409).json({ error: DUPLICATE_PAYROLL_ID_ERROR });
    throw err;
  }

  // The first person on a roster starts the monthly roster checks.
  void ensureRosterChecksForClient(clientId).catch(err => logger.warn({ err, clientId }, "Roster checks: could not create the monthly roster check"));
  res.status(201).json((result.rows ?? [])[0]);
});

router.post("/staff-roster/bulk", requireRole("client_admin", "consultant"), (_req, res) => {
  res.status(410).json({ error: "Bulk insertion has been replaced by previewed roster reconciliation" });
});

// Replace a site's (or the whole business's) roster with an uploaded one.
// Owners and consultants for any site or the whole business; Managers for one
// of their own sites, which is how they answer Yes to the monthly roster
// check (lib/rosterChecks.ts, `rosterCheck` in the body). People are matched
// by payroll ID, else by one unambiguous email or name match; nobody is ever
// deleted: anyone missing from the upload is marked as left (inactive), so
// their training, sign-offs and records stay. The preview lists by name who
// is new, who has left and who has come back.
router.post("/staff-roster/reconcile", requireRole("client_admin", "consultant", "client_manager"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = reconcileBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid roster data", details: parsed.error.flatten() });
  const { preview } = parsed.data;
  const scopeSiteId = parsed.data.siteId ?? null;
  const departmentId = getActiveDepartmentId(req);
  if (req.currentUser!.role === "client_manager") {
    if (scopeSiteId == null) return res.status(403).json({ error: "Choose your site: Managers update one site's roster at a time" });
    if (departmentId !== null) {
      const visible = await db.execute(sql`SELECT 1 FROM sites WHERE id = ${scopeSiteId} AND id IN (${visibleSiteIdsSql(clientId, departmentId)})`);
      if (!visible.rows?.length) return res.status(403).json({ error: "You can only update the roster for your own sites" });
    }
  }
  const identifiers = parsed.data.rows.map(row => row.externalPayrollId ? normalizeIdentifier(row.externalPayrollId) : null);
  const given = identifiers.filter((id): id is string => id != null);
  const duplicateIdentifiers = [...new Set(given.filter((id, index) => given.indexOf(id) !== index))];
  if (duplicateIdentifiers.length) return res.status(409).json({ error: "Duplicate payroll identifiers in upload", identifiers: duplicateIdentifiers });

  const result = await db.transaction(async tx => {
    if (scopeSiteId != null) {
      const site = await tx.execute(sql`SELECT id FROM sites WHERE id = ${scopeSiteId} AND client_id = ${clientId} LIMIT 1`);
      if (!site.rows?.[0]) return { error: "Selected site does not belong to this client", status: 403 as const };
    }
    let rosterCheck: { taskId: number; date: string } | null = null;
    if (parsed.data.rosterCheck) {
      const { taskId, date } = parsed.data.rosterCheck;
      const found = await tx.execute(sql`
        SELECT id, site_id, starts_on::text AS starts_on FROM tasks
        WHERE id = ${taskId} AND client_id = ${clientId} AND module = ${ROSTER_CHECK_MODULE} AND active = true
      `);
      const task = (found.rows ?? [])[0] as { id: number; site_id: number | null; starts_on: string } | undefined;
      if (!task) return { error: "Roster check not found", status: 404 as const };
      if ((task.site_id == null ? null : Number(task.site_id)) !== scopeSiteId) return { error: "The roster check is for a different site", status: 400 as const };
      const today = await getAccountToday(clientId);
      if (date !== monthStart(date) || date < monthStart(String(task.starts_on)) || date > today) {
        return { error: "That month's roster check is not open", status: 400 as const };
      }
      rosterCheck = { taskId: Number(task.id), date };
    }
    const currentResult = await tx.execute(sql`
      SELECT sr.id, sr.site_id, sr.name, sr.external_payroll_id, sr.job_title, sr.department, sr.email, sr.active,
        EXISTS (SELECT 1 FROM users u WHERE u.client_id = sr.client_id AND u.staff_roster_id = sr.id AND u.active = true) AS has_account
      FROM staff_roster sr
      WHERE sr.client_id = ${clientId}
        ${scopeSiteId == null ? sql`` : sql`AND sr.site_id = ${scopeSiteId}`}
      ORDER BY sr.id
      FOR UPDATE OF sr
    `);
    const current = (currentResult.rows ?? []) as any[];
    // Payroll IDs are unique across the business: one held by someone at
    // another site cannot be taken by a row in this site's upload.
    const elsewhere = scopeSiteId == null || !given.length ? new Map<string, string>() : new Map(((await tx.execute(sql`
      SELECT external_payroll_id, name FROM staff_roster
      WHERE client_id = ${clientId} AND site_id IS DISTINCT FROM ${scopeSiteId}
        AND external_payroll_id IN (${sql.join(given.map(id => sql`${id}`), sql`, `)})
    `)).rows ?? []).map((row: any) => [String(row.external_payroll_id), String(row.name)]));
    const claimed = new Set<number>();
    const plans: Array<{ row: typeof parsed.data.rows[number]; identifier: string | null; id: number | null; kind: "created" | "updated" | "reactivated" | "unchanged"; match: "identifier" | "email" | "name" | "new" }> = [];
    const errors: Array<{ row: number; identifier: string | null; error: string }> = [];
    // Two rows with the same name and no payroll ID or email cannot be told apart.
    const unidentified = parsed.data.rows.filter(row => !row.externalPayrollId && !normalizeEmail(row.email)).map(row => normalizeName(row.name));

    for (const [index, input] of parsed.data.rows.entries()) {
      const identifier = identifiers[index] ?? null;
      const rowSiteId = scopeSiteId ?? input.siteId ?? null;
      if (scopeSiteId != null && input.siteId != null && input.siteId !== scopeSiteId) {
        errors.push({ row: index + 2, identifier, error: "Row site does not match the selected reconciliation site" });
        continue;
      }
      if (rowSiteId != null) {
        const site = await tx.execute(sql`SELECT id FROM sites WHERE id = ${rowSiteId} AND client_id = ${clientId} LIMIT 1`);
        if (!site.rows?.[0]) {
          errors.push({ row: index + 2, identifier, error: "Site does not belong to this client" });
          continue;
        }
      }
      if (identifier && elsewhere.has(identifier)) {
        errors.push({ row: index + 2, identifier, error: `Payroll ID ${identifier} belongs to ${elsewhere.get(identifier)} at another site` });
        continue;
      }
      if (!identifier && !normalizeEmail(input.email) && unidentified.filter(name => name === normalizeName(input.name)).length > 1) {
        errors.push({ row: index + 2, identifier, error: `More than one ${canonicalName(input.name)} in the upload; add a payroll ID or email to tell them apart` });
        continue;
      }
      // With a payroll ID: that ID, else adopt one legacy row (no ID) by
      // email or name. Without one: one unclaimed row by email, else by name
      // at the same site, keeping the ID the row already has.
      const open = (item: any) => !claimed.has(Number(item.id)) && (!identifier || !item.external_payroll_id);
      let matches = identifier ? current.filter(item => item.external_payroll_id === identifier) : [];
      let match: "identifier" | "email" | "name" | "new" = "identifier";
      if (!matches.length && normalizeEmail(input.email)) {
        matches = current.filter(item => open(item) && normalizeEmail(item.email) === normalizeEmail(input.email));
        match = "email";
      }
      if (!matches.length) {
        matches = current.filter(item => open(item) && normalizeName(item.name) === normalizeName(input.name) && Number(item.site_id ?? 0) === Number(rowSiteId ?? 0));
        match = "name";
      }
      if (matches.length > 1) {
        errors.push({ row: index + 2, identifier, error: `Ambiguous ${match} match for ${canonicalName(input.name)}; update the existing roster before importing` });
        continue;
      }
      const existing = matches[0];
      const displayName = canonicalName(input.name);
      if (!existing) {
        plans.push({ row: { ...input, siteId: rowSiteId }, identifier, id: null, kind: "created", match: "new" });
        continue;
      }
      claimed.add(Number(existing.id));
      const keptIdentifier = identifier ?? existing.external_payroll_id ?? null;
      const changed = existing.name !== displayName
        || existing.external_payroll_id !== keptIdentifier
        || (existing.job_title ?? null) !== (input.jobTitle ?? null)
        || (existing.department ?? null) !== (input.department ?? null)
        || normalizeEmail(existing.email) !== normalizeEmail(input.email)
        || Number(existing.site_id ?? 0) !== Number(rowSiteId ?? 0);
      plans.push({ row: { ...input, siteId: rowSiteId }, identifier: keptIdentifier, id: Number(existing.id), kind: !existing.active ? "reactivated" : changed ? "updated" : "unchanged", match });
    }
    if (errors.length) return { error: "Roster contains rows that cannot be reconciled safely", status: 409 as const, errors };
    const leavers = current.filter(item => item.active && !claimed.has(Number(item.id)));
    const deactivatedIds = leavers.map(item => Number(item.id));
    const summary = {
      total: plans.length,
      created: plans.filter(plan => plan.kind === "created").length,
      updated: plans.filter(plan => plan.kind === "updated").length,
      reactivated: plans.filter(plan => plan.kind === "reactivated").length,
      unchanged: plans.filter(plan => plan.kind === "unchanged").length,
      deactivated: deactivatedIds.length,
      matchedByEmail: plans.filter(plan => plan.match === "email").length,
      matchedByName: plans.filter(plan => plan.match === "name").length,
    };
    // Who is new, who has left (and whether they still have a login to
    // remove) and who has come back, by name, so the upload can be checked.
    const people = {
      created: plans.filter(plan => plan.kind === "created").map(plan => ({ name: canonicalName(plan.row.name), jobTitle: plan.row.jobTitle ?? null })),
      reactivated: plans.filter(plan => plan.kind === "reactivated").map(plan => ({ id: plan.id!, name: canonicalName(plan.row.name) })),
      updated: plans.filter(plan => plan.kind === "updated").map(plan => ({ id: plan.id!, name: canonicalName(plan.row.name) })),
      deactivated: leavers.map(item => ({ id: Number(item.id), name: String(item.name), hasAccount: item.has_account === true })),
    };
    if (preview) return { status: 200 as const, preview: true, summary, people };
    const newStarters: Array<{ id: number; name: string }> = [];
    for (const plan of plans) {
      const identifier = plan.identifier;
      const displayName = canonicalName(plan.row.name);
      const [firstName, lastName] = splitName(displayName);
      if (plan.id == null) {
        const inserted = await tx.execute(sql`INSERT INTO staff_roster (client_id, site_id, name, first_name, last_name, external_payroll_id, job_title, department, email, active, last_reconciled_at)
          VALUES (${clientId}, ${plan.row.siteId ?? null}, ${displayName}, ${firstName}, ${lastName}, ${identifier}, ${plan.row.jobTitle ?? null}, ${plan.row.department ?? null}, ${plan.row.email ?? null}, true, now())
          RETURNING id`);
        newStarters.push({ id: Number((inserted.rows as any[])[0].id), name: displayName });
      } else {
        await tx.execute(sql`UPDATE staff_roster SET site_id = ${plan.row.siteId ?? null}, name = ${displayName}, first_name = ${firstName}, last_name = ${lastName}, external_payroll_id = ${identifier},
          job_title = ${plan.row.jobTitle ?? null}, department = ${plan.row.department ?? null}, email = ${plan.row.email ?? null},
          active = true, last_reconciled_at = now(), updated_at = now()
          WHERE id = ${plan.id} AND client_id = ${clientId}`);
      }
    }
    if (deactivatedIds.length) await tx.execute(sql`UPDATE staff_roster SET active = false, last_reconciled_at = now(), updated_at = now()
      WHERE client_id = ${clientId} AND id IN (${sql.join(deactivatedIds.map(id => sql`${id}`), sql`, `)})`);
    // The training new starters need: the certificates already held at the
    // site (the TrainTrack training matrix's columns, where they now show as
    // Missing until their certificates are added).
    const training = newStarters.length ? ((await tx.execute(sql`
      SELECT DISTINCT COALESCE(NULLIF(trim(training_type), ''), 'Other') AS training_type
      FROM train_track_records
      WHERE client_id = ${clientId} AND record_type = 'certificate'
        ${scopeSiteId == null ? sql`` : sql`AND site_id = ${scopeSiteId}`}
      ORDER BY 1
    `)).rows ?? []).map((row: any) => String(row.training_type)) : [];
    let rosterCheckNote: string | null = null;
    let rosterCheckRecorded = false;
    if (rosterCheck) {
      const user = req.currentUser!;
      rosterCheckNote = rosterUpdateNote({
        created: people.created.map(person => person.name),
        reactivated: people.reactivated.map(person => person.name),
        deactivated: people.deactivated.map(person => person.name),
      });
      const inserted = await tx.execute(sql`
        INSERT INTO task_completions (client_id, task_id, occurrence_date, completed_by, completed_by_name, note)
        VALUES (${clientId}, ${rosterCheck.taskId}, ${rosterCheck.date}::date, ${user.id}, ${user.name}, ${rosterCheckNote})
        ON CONFLICT (task_id, occurrence_date) DO NOTHING
        RETURNING id
      `);
      rosterCheckRecorded = (inserted.rows ?? []).length > 0;
    }
    return {
      status: 200 as const, preview: false, summary, people, newStarters, trainingNeeded: training,
      ...(rosterCheck ? { rosterCheck: { recorded: rosterCheckRecorded, note: rosterCheckNote } } : {}),
    };
  });
  if ("error" in result) return res.status(result.status).json(result);
  if (!result.preview) {
    void ensureRosterChecksForClient(clientId).catch(err => logger.warn({ err, clientId }, "Roster checks: could not create the monthly roster check"));
  }
  res.status(result.status).json(result);
});

// ── Update staff member ───────────────────────────────────────────────────────

router.patch("/staff-roster/:id", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = staffUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { name, externalPayrollId, jobTitle, department, email, siteId, active } = parsed.data;
  if (!await siteBelongsToClient(siteId, clientId)) {
    return res.status(403).json({ error: "Selected site does not belong to this client" });
  }
  const nameChanged = name !== undefined;
  const [firstName, lastName] = nameChanged ? splitName(name!) : [null, null];
  const hasJobTitle  = jobTitle  !== undefined;
  const hasDept      = department !== undefined;
  const hasEmail     = email     !== undefined;
  const hasSite      = siteId    !== undefined;
  const hasActive    = active    !== undefined;
  const hasExternalId = externalPayrollId !== undefined;

  try {
    await db.execute(sql`
      UPDATE staff_roster
      SET name       = COALESCE(${nameChanged ? canonicalName(name!) : null}, name),
          first_name = CASE WHEN ${nameChanged}::boolean THEN ${firstName} ELSE first_name END,
          last_name  = CASE WHEN ${nameChanged}::boolean THEN ${lastName} ELSE last_name END,
          job_title  = CASE WHEN ${hasJobTitle}::boolean  THEN ${jobTitle ?? null}   ELSE job_title  END,
          department = CASE WHEN ${hasDept}::boolean       THEN ${department ?? null} ELSE department END,
          email      = CASE WHEN ${hasEmail}::boolean      THEN ${email ?? null}      ELSE email      END,
          site_id    = CASE WHEN ${hasSite}::boolean       THEN ${siteId ?? null}     ELSE site_id    END,
          active     = CASE WHEN ${hasActive}::boolean     THEN ${active ?? true}     ELSE active     END,
          external_payroll_id = CASE WHEN ${hasExternalId}::boolean THEN ${externalPayrollId ? normalizeIdentifier(externalPayrollId) : null} ELSE external_payroll_id END,
          updated_at = now()
      WHERE id = ${id} AND client_id = ${clientId}
    `);
  } catch (err) {
    if (isDuplicatePayrollId(err)) return res.status(409).json({ error: DUPLICATE_PAYROLL_ID_ERROR });
    throw err;
  }

  const row = await loadRosterRow(id, clientId);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Remove from current roster without deleting compliance history ───────────

router.delete("/staff-roster/:id", requireRole("client_admin", "consultant"), async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  await db.execute(sql`
    UPDATE staff_roster
    SET active = false, updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

export default router;
