import { Router } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, categoriesTable, clientsTable, complianceItemsTable, sitesTable, usersTable } from "@workspace/db/schema";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";
import { STARTER_CHECK_NOTE, starterChecksFor, starterItemValues } from "../lib/seedStarterContent";
import { ADDON_KEYS, getEntitledServices } from "../lib/services";
import { addMonthsToDay, isCalendarDay } from "../lib/taskSchedule";
import { getAiStatus } from "../lib/aiAllowance";
import { escapeHtml, getPublicAppUrl, sendSystemEmail } from "../lib/email";
import { BUSINESS_TYPES } from "./auth";

// First-run setup wizard (web /setup): business type and nation, first site
// (created through POST /sites), the team (people added through POST /users),
// modules to start with, and which starter compliance checks apply with their
// last service dates. Every step but the team is optional: records should be
// in the names of the people who do them, so setup can't finish until the
// business has a Manager or Staff login, or the Owner says only Owners record
// for now. clients.setup_completed_at hides the wizard once finished.
const router = Router();

const NATIONS = ["england", "wales", "scotland", "northern_ireland", "multi_nation"] as const;
const PICKED_MODULES_SETTING = "setup_modules";
const DEFERRED_SETTING = "setup_deferred_at";
const TEAM_ALONE_SETTING = "setup_team_alone_at";
const ASSIST_SETTING = "setup_assist_requested";
// Superseded service keys are not offered as starting modules.
const LEGACY_MODULES = new Set(["pooltrack", "swimtrack", "safetrack"]);

/** Starter checks ticked by default: the legal core every premises should
 *  review. Business-type specific checks are also ticked by default. Titles
 *  must match lib/seedStarterContent.ts (covered by test:setup-tasks). */
export const LEGAL_CORE_STARTER_TITLES = new Set([
  "Fire Risk Assessment Review",
  "Fire Alarm Maintenance",
  "Emergency Light Maintenance",
  "Fire Extinguishers Maintenance",
  "Electrical Installation Condition Report (EICR)",
  "Legionella Risk Assessment",
  "Asbestos Management Survey & Register Review",
  "Employers' Liability Insurance Certificate",
  "Waste Transfer Note — Annual Renewal",
  "Waste Carrier Registration Check",
]);

const ukDate = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
  .format(new Date(`${value}T00:00:00Z`));

const day = z.string().refine(isCalendarDay, "Use a YYYY-MM-DD date");

/** Starter checks seeded at signup that nobody has edited yet (claimable). */
type Executor = Pick<typeof db, "select">;

function untouchedStarterRows(clientId: number, titles: string[], siteId: number | null, executor: Executor = db) {
  if (!titles.length) return Promise.resolve([] as { id: number; title: string; siteId: number | null }[]);
  return executor.select({ id: complianceItemsTable.id, title: complianceItemsTable.title, siteId: complianceItemsTable.siteId })
    .from(complianceItemsTable)
    .where(and(
      eq(complianceItemsTable.clientId, clientId),
      siteId == null ? isNull(complianceItemsTable.siteId) : or(isNull(complianceItemsTable.siteId), eq(complianceItemsTable.siteId, siteId)),
      inArray(complianceItemsTable.title, titles),
      eq(complianceItemsTable.notes, STARTER_CHECK_NOTE),
      sql`${complianceItemsTable.updatedAt} = ${complianceItemsTable.createdAt}`,
    ));
}

async function setting(clientId: number, key: string): Promise<string | null> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
  return row?.value ?? null;
}

async function saveSetting(clientId: number, key: string, value: string) {
  await db.insert(appSettingsTable).values({ clientId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [appSettingsTable.clientId, appSettingsTable.key], set: { value, updatedAt: new Date() } });
}

async function availableModules(clientId: number): Promise<string[]> {
  const entitled = await getEntitledServices(clientId);
  const keys = entitled === "all" ? [...ADDON_KEYS] : entitled.filter((k) => k !== "core");
  return keys.filter((k) => !LEGACY_MODULES.has(k));
}

function parsePicked(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The team step: Managers and Staff are the people who record checks (Viewers
 * only sign their own training), so one of them, or the Owner saying only
 * Owners record for now, is what lets records start.
 */
async function teamState(clientId: number) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable)
    .where(and(eq(usersTable.clientId, clientId), eq(usersTable.active, true), inArray(usersTable.role, ["client_manager", "client_staff"])));
  const recorders = row?.count ?? 0;
  const aloneAt = await setting(clientId, TEAM_ALONE_SETTING);
  return { recorders, aloneAt, ready: recorders > 0 || aloneAt != null };
}

type AssistRequest = { requestedAt: string; requestedBy: string };

function parseAssist(raw: string | null): AssistRequest | null {
  try {
    const value = JSON.parse(raw ?? "null");
    return value && typeof value.requestedAt === "string" ? { requestedAt: value.requestedAt, requestedBy: String(value.requestedBy ?? "") } : null;
  } catch {
    return null;
  }
}

/** Modules picked in the setup wizard; empty when none were picked. */
export async function getPickedModules(clientId: number): Promise<string[]> {
  return parsePicked(await setting(clientId, PICKED_MODULES_SETTING));
}

router.get("/setup/state", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const role = req.currentUser!.role;
  const [client] = await db.select({
    businessType: clientsTable.businessType,
    setupCompletedAt: clientsTable.setupCompletedAt,
    trialEndsAt: clientsTable.trialEndsAt,
    stripeSubscriptionId: clientsTable.stripeSubscriptionId,
  }).from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) return res.status(404).json({ error: "Client not found" });
  const canManage = role === "consultant" || role === "client_admin";
  const base = { setupCompletedAt: client.setupCompletedAt, needsSetup: client.setupCompletedAt == null, canManage, businessType: client.businessType };
  if (!canManage) return res.json(base);

  const profile = await db.execute(sql`SELECT nation FROM compliance_profiles WHERE client_id = ${clientId} LIMIT 1`);
  const sites = await db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable)
    .where(eq(sitesTable.clientId, clientId)).orderBy(asc(sitesTable.id));
  const catalogue = starterChecksFor(client.businessType).flatMap((cat) => cat.checks.map((check) => ({ category: cat.name, check })));
  const titles = catalogue.map((c) => c.check.title);
  const untouched = new Set((await untouchedStarterRows(clientId, titles, null)).map((r) => r.title));
  const present = new Set(titles.length ? (await db.select({ title: complianceItemsTable.title }).from(complianceItemsTable)
    .where(and(eq(complianceItemsTable.clientId, clientId), inArray(complianceItemsTable.title, titles)))).map((r) => r.title) : []);
  const values = (check: (typeof catalogue)[number]["check"]) => starterItemValues(check, client.businessType);
  const team = await teamState(clientId);
  // The getting-started page says what AI can read for them; never block setup on it.
  const ai = await getAiStatus(clientId).then((s) => ({ configured: s.configured, active: s.active }))
    .catch(() => ({ configured: false, active: false }));
  res.json({
    ...base,
    deferredAt: await setting(clientId, DEFERRED_SETTING),
    ai,
    assistRequest: parseAssist(await setting(clientId, ASSIST_SETTING)),
    // A finished setup never blocks records again.
    team: client.setupCompletedAt ? { ...team, ready: true } : team,
    // No trial end and no subscription: every site and module is free (see
    // GET /billing/config), so the wizard doesn't talk about per-site prices.
    complimentary: client.trialEndsAt === null && !client.stripeSubscriptionId,
    nation: ((profile.rows as Array<{ nation: string }>)[0]?.nation) ?? null,
    businessTypes: BUSINESS_TYPES,
    sites,
    modules: { available: await availableModules(clientId), picked: parsePicked(await setting(clientId, PICKED_MODULES_SETTING)) },
    starterChecks: catalogue.map(({ category, check }) => ({
      title: check.title,
      category,
      description: check.description,
      frequencyMonths: values(check).frequencyMonths,
      core: LEGAL_CORE_STARTER_TITLES.has(check.title) || !!check.businessTypes,
      // untouched: still as seeded; customised: already edited; missing: not on the list.
      state: untouched.has(check.title) ? "untouched" : present.has(check.title) ? "customised" : "missing",
    })),
  });
});

// Business type (also offered in Settings for existing businesses) and the
// Compliance Hub nation. A business without a hub profile gets one with
// editable defaults, because the profile is where the nation lives.
router.put("/setup/business", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { clientId: _ignored, ...body } = req.body ?? {};
  const parsed = z.object({
    businessType: z.enum(BUSINESS_TYPES).nullable().optional(),
    nation: z.enum(NATIONS).optional(),
  }).strict().safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessType, nation } = parsed.data;
  if (businessType !== undefined) {
    await db.update(clientsTable).set({ businessType, updatedAt: new Date() }).where(eq(clientsTable.id, clientId));
  }
  if (nation) {
    const user = req.currentUser!;
    await db.execute(sql`
      INSERT INTO compliance_profiles (
        client_id, nation, operation_type, responsible_person_name, responsible_person_role,
        review_cadence, next_review_date, updated_by, updated_at
      ) VALUES (
        ${clientId}, ${nation}, 'Not yet described', ${user.name}, 'Business owner or manager',
        'Annual and after significant change', (CURRENT_DATE + INTERVAL '12 months')::date, ${user.id}, now()
      )
      ON CONFLICT (client_id) DO UPDATE SET nation = EXCLUDED.nation, updated_by = EXCLUDED.updated_by, updated_at = now()
    `);
  }
  res.json({ ok: true });
});

router.put("/setup/modules", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = z.object({ modules: z.array(z.string()).max(40) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const available = new Set(await availableModules(clientId));
  const picked = [...new Set(parsed.data.modules)];
  if (picked.some((m) => !available.has(m))) return res.status(400).json({ error: "Pick from the modules available to this business" });
  await saveSetting(clientId, PICKED_MODULES_SETTING, JSON.stringify(picked));
  res.json({ picked });
});

// Apply the starter-check selection: ticked checks get the first site and a
// due date from the last service date (or a next due date); checks missing
// from the list are added; with removeUnticked, unticked starter checks that
// are still exactly as seeded are taken off the list. Edited checks are never
// changed or removed here. `custom` adds the business's own checks ("Add
// check" under a heading) with the repeat interval it chose; one already on
// the list with the same title at the same site is not added twice.
router.post("/setup/starter-checks", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { clientId: _ignored, ...body } = req.body ?? {};
  const parsed = z.object({
    siteId: z.number().int().positive().nullable().optional(),
    checks: z.array(z.object({ title: z.string().min(1).max(300), lastDone: day.nullable().optional(), nextDue: day.nullable().optional() }).strict()).max(100),
    removeUnticked: z.boolean().default(false),
    custom: z.array(z.object({
      category: z.string().trim().min(1).max(100),
      title: z.string().trim().min(1).max(300),
      frequencyMonths: z.number().int().min(1).max(120),
      lastDone: day.nullable().optional(),
    }).strict()).max(50).default([]),
  }).strict().safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const siteId = parsed.data.siteId ?? null;
  if (siteId != null && !(await db.select({ id: sitesTable.id }).from(sitesTable).where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))))[0]) {
    return res.status(400).json({ error: "Site not found" });
  }
  const [client] = await db.select({ businessType: clientsTable.businessType }).from(clientsTable).where(eq(clientsTable.id, clientId));
  const categories = starterChecksFor(client?.businessType);
  const catalogue = new Map(categories.flatMap((cat) => cat.checks.map((check) => [check.title, { category: cat, check }] as const)));
  const ticked = new Map(parsed.data.checks.map((c) => [c.title, c]));
  if ([...ticked.keys()].some((title) => !catalogue.has(title))) return res.status(400).json({ error: "Unknown starter check" });

  const result = await db.transaction(async (tx) => {
    const counts = { updated: 0, created: 0, removed: 0, kept: 0 };
    const allTitles = [...catalogue.keys()];
    const untouched = await untouchedStarterRows(clientId, allTitles, siteId, tx);
    const untouchedByTitle = new Map<string, number>();
    for (const row of untouched) if (!untouchedByTitle.has(row.title) || row.siteId === siteId) untouchedByTitle.set(row.title, row.id);
    const presentTitles = new Set((await tx.select({ title: complianceItemsTable.title }).from(complianceItemsTable)
      .where(and(eq(complianceItemsTable.clientId, clientId), inArray(complianceItemsTable.title, allTitles.length ? allTitles : [""])))).map((r) => r.title));
    const existingCategories = await tx.select().from(categoriesTable).where(eq(categoriesTable.clientId, clientId));
    const categoryByName = new Map(existingCategories.map((c) => [c.name.toLowerCase(), c.id]));

    for (const [title, choice] of ticked) {
      const { category, check } = catalogue.get(title)!;
      const values = starterItemValues(check, client?.businessType);
      const lastDone = choice.lastDone ?? null;
      const dueDay = lastDone && values.frequencyMonths ? addMonthsToDay(lastDone, values.frequencyMonths) : choice.nextDue ?? null;
      const dated = dueDay != null;
      const fields = {
        ...(siteId != null ? { siteId } : {}),
        ...(dated ? { dueDate: new Date(`${dueDay}T00:00:00Z`) } : {}),
        ...(lastDone && values.frequencyMonths ? { completedAt: new Date(`${lastDone}T00:00:00Z`) } : {}),
        ...(dated ? { notes: lastDone ? `Last service or inspection ${ukDate(lastDone)}, entered during setup.` : "Next due date entered during setup." } : {}),
      };
      const existingId = untouchedByTitle.get(title);
      if (existingId != null) {
        if (Object.keys(fields).length === 0) { counts.kept++; continue; }
        await tx.update(complianceItemsTable).set({ ...fields, updatedAt: new Date() })
          .where(and(eq(complianceItemsTable.id, existingId), eq(complianceItemsTable.clientId, clientId)));
        counts.updated++;
      } else if (presentTitles.has(title)) {
        counts.kept++;
      } else {
        let categoryId = categoryByName.get(category.name.toLowerCase());
        if (categoryId == null) {
          const [inserted] = await tx.insert(categoriesTable).values({ clientId, name: category.name, color: category.color }).returning();
          categoryId = inserted.id;
          categoryByName.set(category.name.toLowerCase(), categoryId);
        }
        await tx.insert(complianceItemsTable).values({ clientId, categoryId, siteId, ...values, ...fields });
        counts.created++;
      }
    }

    for (const custom of parsed.data.custom) {
      const [duplicate] = await tx.select({ id: complianceItemsTable.id }).from(complianceItemsTable)
        .where(and(
          eq(complianceItemsTable.clientId, clientId),
          sql`lower(${complianceItemsTable.title}) = lower(${custom.title})`,
          siteId == null ? isNull(complianceItemsTable.siteId) : eq(complianceItemsTable.siteId, siteId),
        )).limit(1);
      if (duplicate) { counts.kept++; continue; }
      let categoryId = categoryByName.get(custom.category.toLowerCase());
      if (categoryId == null) {
        const starter = categories.find((cat) => cat.name.toLowerCase() === custom.category.toLowerCase());
        const [inserted] = await tx.insert(categoriesTable)
          .values({ clientId, name: starter?.name ?? custom.category, color: starter?.color ?? "#6366f1" }).returning();
        categoryId = inserted.id;
        categoryByName.set(custom.category.toLowerCase(), categoryId);
      }
      const lastDone = custom.lastDone ?? null;
      await tx.insert(complianceItemsTable).values({
        clientId, categoryId, siteId,
        title: custom.title,
        status: "pending",
        priority: "high",
        leadTimeDays: 30,
        frequencyMonths: custom.frequencyMonths,
        dueDate: lastDone ? new Date(`${addMonthsToDay(lastDone, custom.frequencyMonths)}T00:00:00Z`) : null,
        completedAt: lastDone ? new Date(`${lastDone}T00:00:00Z`) : null,
        notes: lastDone ? `Added during setup. Last service or inspection ${ukDate(lastDone)}.` : "Added during setup. Set the due date from your last service or inspection.",
      });
      counts.created++;
    }

    if (parsed.data.removeUnticked) {
      const removable = untouched.filter((row) => !ticked.has(row.title)).map((row) => row.id);
      if (removable.length) {
        const removed = await tx.delete(complianceItemsTable)
          .where(and(eq(complianceItemsTable.clientId, clientId), inArray(complianceItemsTable.id, removable),
            eq(complianceItemsTable.notes, STARTER_CHECK_NOTE), sql`${complianceItemsTable.updatedAt} = ${complianceItemsTable.createdAt}`))
          .returning({ id: complianceItemsTable.id });
        counts.removed = removed.length;
      }
    }
    return counts;
  });
  res.json(result);
});

// "Finish later": keep the dashboard banner but stop sending the admin to /setup.
router.post("/setup/defer", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  await saveSetting(clientId, DEFERRED_SETTING, new Date().toISOString());
  res.json({ ok: true });
});

// "Only Owners record for now": the business has nobody else signing in yet,
// so records can start in the Owners' names. Adding Staff later still works.
router.post("/setup/team-alone", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const aloneAt = new Date().toISOString();
  await saveSetting(clientId, TEAM_ALONE_SETTING, aloneAt);
  res.json({ aloneAt });
});

// "Ask ALPS to set it up for you": the getting-started page's offer of a
// paid setup service. It only emails ALPS (ADMIN_EMAIL), who agree the price
// and invoice it themselves; nothing is charged here. One request per
// business: asking again returns the first request without a second email.
router.post("/setup/assist-request", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { clientId: _ignored, ...body } = req.body ?? {};
  const parsed = z.object({
    phone: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
  }).strict().safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: "Please check the phone number and notes, then try again." });

  const existing = parseAssist(await setting(clientId, ASSIST_SETTING));
  if (existing) return res.json({ ...existing, emailed: false });

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    req.log.warn({ clientId }, "ADMIN_EMAIL not configured — setup service request not sent");
    return res.status(503).json({ error: "The setup service can't take requests right now. Please use the Feedback button to ask ALPS instead.", code: "SETUP_SERVICE_UNAVAILABLE" });
  }

  const user = req.currentUser!;
  const [client] = await db.select({ name: clientsTable.name, businessType: clientsTable.businessType })
    .from(clientsTable).where(eq(clientsTable.id, clientId));
  const [siteCount] = await db.select({ count: sql<number>`count(*)::int` }).from(sitesTable).where(eq(sitesTable.clientId, clientId));
  const ai = await getAiStatus(clientId).catch(() => null);
  const { phone, notes } = parsed.data;
  const businessName = client?.name ?? `Business ${clientId}`;
  const rows: Array<[string, string]> = [
    ["Business", businessName],
    ["Business type", client?.businessType ?? "Not given yet"],
    ["Asked by", `${user.name} (${user.email})`],
    ["Phone", phone || "Not given"],
    ["Sites added so far", String(siteCount?.count ?? 0)],
    ["AI features", ai?.active ? "On" : "Off"],
  ];
  const appUrl = getPublicAppUrl().replace(/\/+$/, "");
  try {
    await sendSystemEmail({
      to: adminEmail,
      subject: `Setup service request: ${businessName}`,
      html: `
        <h2>Setup service request</h2>
        <p>This business would like ALPS to enter its initial data for it. Agree the price with them before starting; nothing has been charged.</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          ${rows.map(([label, value]) => `<tr><td style="padding: 4px 16px 4px 0; color: #64748b;">${label}</td><td style="padding: 4px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`).join("")}
        </table>
        ${notes ? `<h3>Their notes</h3><p style="white-space:pre-wrap">${escapeHtml(notes)}</p>` : ""}
        <p>The business is listed under Clients in <a href="${escapeHtml(appUrl)}">ComplyTrack</a>.</p>
      `,
      text: `Setup service request\n\nThis business would like ALPS to enter its initial data for it. Agree the price with them before starting; nothing has been charged.\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}${notes ? `\n\nTheir notes:\n${notes}` : ""}\n\nThe business is listed under Clients in ComplyTrack: ${appUrl}`,
      idempotencyKey: `setup-assist-${clientId}`,
    });
  } catch (err) {
    req.log.error({ err, clientId }, "Setup service request email failed");
    return res.status(502).json({ error: "Your request didn't reach ALPS. Please try again in a minute.", code: "SETUP_SERVICE_EMAIL_FAILED" });
  }
  const request: AssistRequest = { requestedAt: new Date().toISOString(), requestedBy: user.name };
  await saveSetting(clientId, ASSIST_SETTING, JSON.stringify(request));
  res.json({ ...request, emailed: true });
});

router.post("/setup/complete", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const [client] = await db.select({ setupCompletedAt: clientsTable.setupCompletedAt }).from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client?.setupCompletedAt && !(await teamState(clientId)).ready) {
    return res.status(409).json({
      error: "Add the people who will record checks (Managers or Staff) before finishing setup, or confirm that only Owners record for now.",
      code: "TEAM_NOT_SET_UP",
    });
  }
  const [updated] = await db.update(clientsTable).set({ setupCompletedAt: new Date() })
    .where(and(eq(clientsTable.id, clientId), isNull(clientsTable.setupCompletedAt)))
    .returning({ setupCompletedAt: clientsTable.setupCompletedAt });
  res.json({ setupCompletedAt: updated?.setupCompletedAt ?? null });
});

export default router;
