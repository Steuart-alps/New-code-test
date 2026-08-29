import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { dailyChecklistSubmissionsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, inArray, gte, lte, desc } from "drizzle-orm";
import { requireAuth, getClientId, canAccessClient } from "../middleware/requireAuth";

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

  // Build where conditions
  const conditions = [
    eq(dailyChecklistSubmissionsTable.clientId, clientId),
    gte(dailyChecklistSubmissionsTable.checklistDate, from),
    lte(dailyChecklistSubmissionsTable.checklistDate, to),
  ];
  if (siteId) conditions.push(eq(dailyChecklistSubmissionsTable.siteId, siteId));
  if (type) conditions.push(eq(dailyChecklistSubmissionsTable.type, type));

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
    db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.clientId, clientId)),
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

  // Fetch all sites for this client
  const sites = await db
    .select({ id: sitesTable.id, name: sitesTable.name })
    .from(sitesTable)
    .where(eq(sitesTable.clientId, clientId))
    .orderBy(sitesTable.name);

  if (sites.length === 0) {
    res.json({ date, sites: [] });
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

  res.json({ date, sites: result });
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

  // Verify site belongs to this client
  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site || !canAccessClient(req, site.clientId)) {
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

router.post("/daily-checklists/:siteId/:date/pm/sign-off", requireAuth, async (req, res) => {
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

  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site || !canAccessClient(req, site.clientId)) {
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
    .where(eq(dailyChecklistSubmissionsTable.id, submission.id))
    .returning();

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

router.post("/daily-checklists/:siteId/:date/:type", requireAuth, async (req, res) => {
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

  const parsed = SubmitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid submission data" });
    return;
  }

  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site || !canAccessClient(req, site.clientId)) {
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
      .where(eq(dailyChecklistSubmissionsTable.id, existing.id))
      .returning();
  } else {
    [result] = await db
      .insert(dailyChecklistSubmissionsTable)
      .values([values])
      .returning();
  }

  res.status(201).json(result);
});

export default router;
