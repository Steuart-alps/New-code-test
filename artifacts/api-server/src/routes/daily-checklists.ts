import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { dailyChecklistSubmissionsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, gte, lte, desc } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEntitledServices, isEntitled, requireAnyEntitlement, SERVICES } from "../lib/services";

const router = Router();

// ── Default questions ─────────────────────────────────────────────────────────

const AM_QUESTIONS = [
  "Premises are clean and tidy",
  "Emergency exits are clear and unobstructed",
  "Fire extinguishers are in place and accessible",
  "First aid kit is fully stocked and accessible",
  "All hazards identified and reported",
  "All equipment checked and operational",
  "All staff signed in",
  "External areas are safe and hazard-free",
];

const PM_QUESTIONS = [
  "Premises have been cleaned and secured",
  "All windows and doors are locked",
  "Electrical equipment switched off (except fridges/freezers)",
  "Fire hazards checked",
  "Waste bins emptied and secured",
  "Any incidents logged and reported",
  "All staff signed out",
  "Alarm / security system armed",
];

function defaultAnswers(type: "am" | "pm") {
  const questions = type === "am" ? AM_QUESTIONS : PM_QUESTIONS;
  return questions.map((q) => ({ question: q, checked: false }));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(date: string): boolean {
  return dateRegex.test(date);
}

function dailyService(type: "am" | "pm") {
  return type === "am" ? "dailytrack_am" : "dailytrack_pm";
}

function serviceDenied(res: Parameters<typeof requireAuth>[1], type: "am" | "pm") {
  const service = dailyService(type);
  res.status(403).json({
    error: `${SERVICES[service].label} is not enabled for this account`,
    code: "SERVICE_NOT_ENABLED",
    service,
  });
}

async function requireDailyService(
  res: Parameters<typeof requireAuth>[1],
  clientId: number,
  type: "am" | "pm",
): Promise<boolean> {
  if (await requireAnyEntitlement(clientId, dailyService(type))) return true;
  serviceDenied(res, type);
  return false;
}

function departmentSiteCondition(clientId: number, departmentId: number | null) {
  const conditions = [eq(sitesTable.clientId, clientId)];
  if (departmentId !== null) {
    conditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId)) as any);
  }
  return and(...conditions);
}

async function findAccessibleSite(
  clientId: number,
  siteId: number,
  departmentId: number | null,
) {
  if (!Number.isInteger(siteId) || siteId <= 0) return null;
  const [site] = await db
    .select()
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), departmentSiteCondition(clientId, departmentId)))
    .limit(1);
  return site ?? null;
}

// ── GET /api/daily-checklists/history ────────────────────────────────────────
// Paginated list of past submissions with optional filters.

router.get("/daily-checklists/history", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const from = (req.query.from as string) || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  const to = (req.query.to as string) || today;
  const siteId = req.query.siteId ? Number(req.query.siteId) : null;
  const type = req.query.type as "am" | "pm" | undefined;
  const offset = Number(req.query.offset ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  if (type && !["am", "pm"].includes(type)) {
    res.status(400).json({ error: "type must be 'am' or 'pm'" });
    return;
  }
  const services = await getEntitledServices(clientId);
  const allowedTypes = (["am", "pm"] as const).filter((candidate) => isEntitled(services, dailyService(candidate)));
  if (allowedTypes.length === 0) {
    serviceDenied(res, "am");
    return;
  }
  if (type && !allowedTypes.includes(type)) {
    serviceDenied(res, type);
    return;
  }

  const departmentId = getActiveDepartmentId(req);
  const accessibleSites = await db
    .select({ id: sitesTable.id, name: sitesTable.name })
    .from(sitesTable)
    .where(departmentSiteCondition(clientId, departmentId));
  const accessibleSiteIds = accessibleSites.map((site) => site.id);
  if (accessibleSiteIds.length === 0) {
    res.json({ submissions: [], total: 0 });
    return;
  }

  // Build where conditions
  const conditions = [
    eq(dailyChecklistSubmissionsTable.clientId, clientId),
    inArray(dailyChecklistSubmissionsTable.siteId, accessibleSiteIds),
    gte(dailyChecklistSubmissionsTable.checklistDate, from),
    lte(dailyChecklistSubmissionsTable.checklistDate, to),
  ];
  if (siteId) conditions.push(eq(dailyChecklistSubmissionsTable.siteId, siteId));
  if (type) conditions.push(eq(dailyChecklistSubmissionsTable.type, type));
  else conditions.push(inArray(dailyChecklistSubmissionsTable.type, allowedTypes));

  const whereClause = and(...conditions);

  const [rows, countRows, sites] = await Promise.all([
    db
      .select()
      .from(dailyChecklistSubmissionsTable)
      .where(whereClause)
      .orderBy(desc(dailyChecklistSubmissionsTable.checklistDate), desc(dailyChecklistSubmissionsTable.submittedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: dailyChecklistSubmissionsTable.id })
      .from(dailyChecklistSubmissionsTable)
      .where(whereClause),
    Promise.resolve(accessibleSites),
  ]);

  const siteMap = new Map(sites.map(s => [s.id, s.name]));
  const submissions = rows.map(r => ({ ...r, siteName: siteMap.get(r.siteId) ?? null }));

  res.json({ submissions, total: countRows.length });
});

// ── GET /api/daily-checklists/overview?date=YYYY-MM-DD ────────────────────────
// Manager view: all sites × AM/PM status for a given date.

router.get("/daily-checklists/overview", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  if (!validateDate(date)) {
    res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
    return;
  }

  const services = await getEntitledServices(clientId);
  const allowedTypes = (["am", "pm"] as const).filter((type) => isEntitled(services, dailyService(type)));
  if (allowedTypes.length === 0) {
    serviceDenied(res, "am");
    return;
  }

  // Fetch only sites visible in the user's active department.
  const departmentId = getActiveDepartmentId(req);
  const sites = await db
    .select({ id: sitesTable.id, name: sitesTable.name })
    .from(sitesTable)
    .where(departmentSiteCondition(clientId, departmentId))
    .orderBy(sitesTable.name);

  if (sites.length === 0) {
    res.json({ date, enabledTypes: allowedTypes, enabledPeriods: allowedTypes, sites: [] });
    return;
  }

  const siteIds = sites.map((s) => s.id);

  // Fetch all submissions for those sites on this date
  const submissions = await db
    .select()
    .from(dailyChecklistSubmissionsTable)
    .where(
      and(
        eq(dailyChecklistSubmissionsTable.clientId, clientId),
        eq(dailyChecklistSubmissionsTable.checklistDate, date),
        inArray(dailyChecklistSubmissionsTable.siteId, siteIds),
        inArray(dailyChecklistSubmissionsTable.type, allowedTypes),
      ),
    );

  const byKey = new Map<string, typeof submissions[number]>();
  for (const sub of submissions) {
    byKey.set(`${sub.siteId}:${sub.type}`, sub);
  }

  const result = sites.map((site) => {
    const am = byKey.get(`${site.id}:am`) ?? null;
    const pm = byKey.get(`${site.id}:pm`) ?? null;
    return {
      siteId: site.id,
      siteName: site.name,
      am: am
        ? {
            submitted: true,
            submittedAt: am.submittedAt,
            submittedByName: am.submittedByName,
            checkedCount: (am.answers as any[]).filter((a) => a.checked).length,
            totalCount: (am.answers as any[]).length,
          }
        : null,
      pm: pm
        ? {
            submitted: true,
            submittedAt: pm.submittedAt,
            submittedByName: pm.submittedByName,
            checkedCount: (pm.answers as any[]).filter((a) => a.checked).length,
            totalCount: (pm.answers as any[]).length,
            signedOff: pm.signedOffAt !== null,
            signedOffAt: pm.signedOffAt,
            signedOffByName: pm.signedOffByName,
          }
        : null,
    };
  });

  // `enabledTypes` is deliberately returned even when a period has no
  // submission. Clients must not treat an unavailable paid period as missing.
  // `enabledPeriods` is retained as a descriptive alias for dashboard clients.
  res.json({ date, enabledTypes: allowedTypes, enabledPeriods: allowedTypes, sites: result });
});

// ── GET /api/daily-checklists/:siteId/:date/am|pm ────────────────────────────

router.get("/daily-checklists/:siteId/:date/:type", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const siteId = Number(req.params.siteId);
  const date = req.params.date as string;
  const type = req.params.type as "am" | "pm";

  if (!["am", "pm"].includes(type)) {
    res.status(400).json({ error: "type must be 'am' or 'pm'" });
    return;
  }
  if (!validateDate(date)) {
    res.status(400).json({ error: "Invalid date format" });
    return;
  }

  if (!(await requireDailyService(res, clientId, type))) return;

  const site = await findAccessibleSite(clientId, siteId, getActiveDepartmentId(req));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const [submission] = await db
    .select()
    .from(dailyChecklistSubmissionsTable)
    .where(
      and(
        eq(dailyChecklistSubmissionsTable.clientId, clientId),
        eq(dailyChecklistSubmissionsTable.siteId, siteId),
        eq(dailyChecklistSubmissionsTable.checklistDate, date),
        eq(dailyChecklistSubmissionsTable.type, type),
      ),
    );

  res.json({
    submission: submission ?? null,
    defaultQuestions: defaultAnswers(type),
  });
});

// ── POST /api/daily-checklists/:siteId/:date/pm/sign-off ─────────────────────

router.post("/daily-checklists/:siteId/:date/pm/sign-off", requireAuth, denyViewers, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  // Only admins/consultants can sign off
  if (!["consultant", "client_admin"].includes(user.role)) {
    res.status(403).json({ error: "Only managers can sign off checklists" });
    return;
  }

  const siteId = Number(req.params.siteId);
  const date = req.params.date as string;

  if (!validateDate(date)) {
    res.status(400).json({ error: "Invalid date format" });
    return;
  }

  if (!(await requireDailyService(res, clientId, "pm"))) return;

  const site = await findAccessibleSite(clientId, siteId, getActiveDepartmentId(req));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const [submission] = await db
    .select()
    .from(dailyChecklistSubmissionsTable)
    .where(
      and(
        eq(dailyChecklistSubmissionsTable.clientId, clientId),
        eq(dailyChecklistSubmissionsTable.siteId, siteId),
        eq(dailyChecklistSubmissionsTable.checklistDate, date),
        eq(dailyChecklistSubmissionsTable.type, "pm"),
      ),
    );

  if (!submission) {
    res.status(404).json({ error: "No PM submission found for this date" });
    return;
  }

  if (submission.signedOffAt) {
    res.status(409).json({ error: "Already signed off" });
    return;
  }

  const notes = typeof req.body.notes === "string" ? req.body.notes : null;

  const [updated] = await db
    .update(dailyChecklistSubmissionsTable)
    .set({
      signedOffById: user.id,
      signedOffByName: user.name,
      signedOffAt: new Date(),
      signOffNotes: notes,
      updatedAt: new Date(),
    })
    .where(and(
      eq(dailyChecklistSubmissionsTable.id, submission.id),
      isNull(dailyChecklistSubmissionsTable.signedOffAt),
    ))
    .returning();

  if (!updated) {
    res.status(409).json({ error: "Already signed off" });
    return;
  }
  res.json(updated);
});

// ── POST /api/daily-checklists/:siteId/:date/am|pm ──────────────────────────
// Create or update a submission. Once submitted it cannot be changed.

const AnswerSchema = z.object({
  question: z.string().min(1),
  checked: z.boolean(),
  notes: z.string().optional(),
});

const SubmitBody = z.object({
  answers: z.array(AnswerSchema).min(1),
});

router.post("/daily-checklists/:siteId/:date/:type", requireAuth, denyViewers, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const siteId = Number(req.params.siteId);
  const date = req.params.date as string;
  const type = req.params.type as "am" | "pm";

  if (!["am", "pm"].includes(type)) {
    res.status(400).json({ error: "type must be 'am' or 'pm'" });
    return;
  }
  if (!validateDate(date)) {
    res.status(400).json({ error: "Invalid date format" });
    return;
  }
  if (!(await requireDailyService(res, clientId, type))) return;

  const parsed = SubmitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid submission data" });
    return;
  }

  const site = await findAccessibleSite(clientId, siteId, getActiveDepartmentId(req));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(dailyChecklistSubmissionsTable)
    .where(
      and(
        eq(dailyChecklistSubmissionsTable.clientId, clientId),
        eq(dailyChecklistSubmissionsTable.siteId, siteId),
        eq(dailyChecklistSubmissionsTable.checklistDate, date),
        eq(dailyChecklistSubmissionsTable.type, type),
      ),
    );

  // Once submitted, it's locked — sign-off is the only allowed subsequent action (PM only).
  if (existing?.submittedAt) {
    res.status(409).json({ error: "Checklist already submitted for this date" });
    return;
  }

  const values = {
    clientId,
    siteId,
    checklistDate: date as string,
    type,
    answers: parsed.data.answers,
    submittedById: user.id,
    submittedByName: user.name,
    submittedAt: new Date(),
    updatedAt: new Date(),
  };

  let result;
  if (existing) {
    [result] = await db
      .update(dailyChecklistSubmissionsTable)
      .set(values)
      .where(and(
        eq(dailyChecklistSubmissionsTable.id, existing.id),
        isNull(dailyChecklistSubmissionsTable.submittedAt),
      ))
      .returning();
    if (!result) {
      res.status(409).json({ error: "Checklist already submitted for this date" });
      return;
    }
  } else {
    [result] = await db
      .insert(dailyChecklistSubmissionsTable)
      .values([values])
      .onConflictDoNothing({
        target: [
          dailyChecklistSubmissionsTable.clientId,
          dailyChecklistSubmissionsTable.siteId,
          dailyChecklistSubmissionsTable.checklistDate,
          dailyChecklistSubmissionsTable.type,
        ],
      })
      .returning();
    if (!result) {
      res.status(409).json({ error: "Checklist already submitted for this date" });
      return;
    }
  }

  res.status(201).json(result);
});

export default router;
