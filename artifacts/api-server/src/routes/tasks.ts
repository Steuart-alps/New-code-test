import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { appSettingsTable, consultantClientsTable, sitesTable, taskCompletionsTable, tasksTable, usersTable } from "@workspace/db/schema";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth } from "../middleware/requireAuth";
import { ACCOUNT_TIMEZONE_SETTING, normalizeAccountTimezone } from "../middleware/dailyEntryCutoff";
import { addDays, isCalendarDay, occursOn, todayIn } from "../lib/taskSchedule";

// Staff tasks: "My tasks today" for staff and task assignment for managers.
// Managers (consultants, client admins, department managers for their own
// department's sites) create, assign and edit; staff complete tasks assigned
// to them or their role group; viewers read only.
const router = Router();

/** Module keys a task can link to (service keys plus compliance checks). */
export const TASK_MODULES = [
  "compliance", "firetrack", "kitchentrack", "legionellatrack", "doctrack", "fixtrack", "traintrack",
  "hottubtrack", "treetrack", "biketrack", "aquatrack", "greentrack", "incidenttrack", "pattrack",
  "pesttrack", "premisestrack", "roomtrack", "dailytrack_am", "dailytrack_pm",
] as const;

const day = z.string().refine(isCalendarDay, "Use a YYYY-MM-DD date");
const taskFields = {
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().max(2000).nullable().optional(),
  module: z.enum(TASK_MODULES).nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  assigneeUserId: z.number().int().positive().nullable().optional(),
  assigneeRole: z.enum(["client_staff", "managers"]).nullable().optional(),
  recurrence: z.enum(["once", "daily", "weekly", "monthly"]),
  startsOn: day,
};
const createSchema = z.object(taskFields).strict();
const patchSchema = z.object({
  ...Object.fromEntries(Object.entries(taskFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  active: z.boolean().optional(),
}).strict();
const completeSchema = z.object({ date: day, note: z.string().trim().max(1000).nullable().optional() }).strict();

type Viewer = NonNullable<Request["currentUser"]>;

/** Department managers manage tasks for their own department's sites only. */
function managerScope(user: Viewer): "all" | number | null {
  if (user.role === "consultant" || user.role === "client_admin") return "all";
  if (user.role === "client_staff" && user.isDepartmentManager && user.departmentId != null) return user.departmentId;
  return null;
}

function inRoleGroup(user: Viewer, role: string | null): boolean {
  if (role === "client_staff") return user.role === "client_staff";
  if (role === "managers") return managerScope(user) !== null;
  return false;
}

async function accountToday(clientId: number): Promise<string> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, ACCOUNT_TIMEZONE_SETTING)));
  return todayIn(normalizeAccountTimezone(row?.value));
}

/** Tasks the user may see: business-wide ones plus sites in their department scope. */
async function visibleTasks(clientId: number, req: Request) {
  const departmentId = getActiveDepartmentId(req);
  const siteCondition = departmentId == null
    ? undefined
    : or(isNull(tasksTable.siteId), isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId));
  return db.select({
    task: tasksTable,
    siteName: sitesTable.name,
    siteDepartmentId: sitesTable.departmentId,
    assigneeName: usersTable.name,
  }).from(tasksTable)
    .leftJoin(sitesTable, eq(sitesTable.id, tasksTable.siteId))
    .leftJoin(usersTable, eq(usersTable.id, tasksTable.assigneeUserId))
    .where(and(eq(tasksTable.clientId, clientId), siteCondition))
    .orderBy(asc(tasksTable.title), asc(tasksTable.id));
}

type VisibleRow = Awaited<ReturnType<typeof visibleTasks>>[number];

function canManageRow(user: Viewer, row: { siteDepartmentId: number | null; task: { siteId: number | null } }): boolean {
  const scope = managerScope(user);
  if (scope === "all") return true;
  if (scope === null) return false;
  return row.task.siteId != null && row.siteDepartmentId === scope;
}

function isAssignedTo(user: Viewer, task: { assigneeUserId: number | null; assigneeRole: string | null }): boolean {
  return task.assigneeUserId === user.id || inRoleGroup(user, task.assigneeRole);
}

/** Validate site and assignee against this client and the manager's scope. */
async function validateScope(user: Viewer, clientId: number, value: { siteId: number | null; assigneeUserId: number | null; assigneeRole: string | null }) {
  if ((value.assigneeUserId == null) === (value.assigneeRole == null)) return "Assign the task to one person or to a role";
  const scope = managerScope(user);
  let siteDepartmentId: number | null = null;
  if (value.siteId != null) {
    const [site] = await db.select({ departmentId: sitesTable.departmentId }).from(sitesTable)
      .where(and(eq(sitesTable.id, value.siteId), eq(sitesTable.clientId, clientId)));
    if (!site) return "Site not found";
    siteDepartmentId = site.departmentId;
  }
  if (scope !== "all" && (value.siteId == null || siteDepartmentId !== scope)) return "Department managers can only set tasks for their department's sites";
  if (value.assigneeUserId != null) {
    const [assignee] = await db.select({ id: usersTable.id, role: usersTable.role, clientId: usersTable.clientId, departmentId: usersTable.departmentId, active: usersTable.active })
      .from(usersTable).where(eq(usersTable.id, value.assigneeUserId));
    let member = assignee?.clientId === clientId;
    if (assignee && !member && assignee.role === "consultant") {
      member = !!(await db.select({ userId: consultantClientsTable.userId }).from(consultantClientsTable)
        .where(and(eq(consultantClientsTable.userId, assignee.id), eq(consultantClientsTable.clientId, clientId))))[0];
    }
    if (!assignee || !member || !assignee.active || assignee.role === "client_viewer") return "Assignee must be an active member of this business";
    if (siteDepartmentId != null && (assignee.role === "client_staff") && assignee.departmentId !== siteDepartmentId) {
      return "That person's department cannot see this site";
    }
  }
  return null;
}

function present(row: VisibleRow, user: Viewer, date: string, completions: Map<string, typeof taskCompletionsTable.$inferSelect>, today: string) {
  const { task } = row;
  // An open one-off task stays on the list after its due date until done.
  const occurrenceDate = task.recurrence === "once" ? task.startsOn : date;
  const dueOnDate = occursOn(task, date);
  const completion = completions.get(`${task.id}:${occurrenceDate}`) ?? null;
  return {
    id: task.id,
    title: task.title,
    instruction: task.instruction,
    module: task.module,
    siteId: task.siteId,
    siteName: row.siteName ?? null,
    assigneeUserId: task.assigneeUserId,
    assigneeName: row.assigneeName ?? null,
    assigneeRole: task.assigneeRole,
    recurrence: task.recurrence,
    startsOn: task.startsOn,
    active: task.active,
    occurrenceDate,
    dueOnDate,
    overdue: task.recurrence === "once" && !completion && task.startsOn < today,
    completion: completion ? { completedByName: completion.completedByName, completedAt: completion.completedAt, note: completion.note } : null,
    assignedToMe: isAssignedTo(user, task),
    canManage: canManageRow(user, row),
    canComplete: user.role !== "client_viewer" && task.active && (isAssignedTo(user, task) || managerScope(user) !== null),
  };
}

async function completionsFor(taskIds: number[], dates: string[]) {
  const map = new Map<string, typeof taskCompletionsTable.$inferSelect>();
  if (!taskIds.length || !dates.length) return map;
  const rows = await db.select().from(taskCompletionsTable)
    .where(and(inArray(taskCompletionsTable.taskId, taskIds), inArray(taskCompletionsTable.occurrenceDate, [...new Set(dates)])));
  for (const row of rows) map.set(`${row.taskId}:${row.occurrenceDate}`, row);
  return map;
}

// GET /tasks?scope=mine|all&date=YYYY-MM-DD
// mine: the user's tasks due on the date (default today) plus open overdue
// one-off tasks. all: every task in the user's scope, for managers and viewers.
router.get("/tasks", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const query = z.object({ scope: z.enum(["mine", "all"]).default("mine"), date: day.optional() }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.flatten() });
  const today = await accountToday(clientId);
  const date = query.data.date ?? today;
  const canManage = managerScope(user) !== null;
  if (query.data.scope === "all" && !canManage && user.role !== "client_viewer") {
    return res.status(403).json({ error: "Only managers can see every task" });
  }

  let rows = await visibleTasks(clientId, req);
  if (query.data.scope === "mine") {
    rows = rows.filter((row) => row.task.active && isAssignedTo(user, row.task)
      && (occursOn(row.task, date) || (row.task.recurrence === "once" && row.task.startsOn < date)));
  }
  const completions = await completionsFor(rows.map((r) => r.task.id), [date, ...rows.filter((r) => r.task.recurrence === "once").map((r) => r.task.startsOn)]);
  let tasks = rows.map((row) => present(row, user, date, completions, today));
  // Overdue one-off tasks that were done before the date drop off "mine".
  if (query.data.scope === "mine") tasks = tasks.filter((t) => t.dueOnDate || !t.completion);
  res.json({ date, today, canManage, tasks });
});

// People a manager can assign tasks to (active, non-viewer members).
router.get("/tasks/assignees", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const scope = managerScope(user);
  if (scope === null) return res.status(403).json({ error: "Forbidden" });
  const linked = (await db.select({ userId: consultantClientsTable.userId }).from(consultantClientsTable)
    .where(eq(consultantClientsTable.clientId, clientId))).map((r) => r.userId);
  const rows = await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, departmentId: usersTable.departmentId })
    .from(usersTable)
    .where(and(
      eq(usersTable.active, true),
      linked.length ? or(eq(usersTable.clientId, clientId), inArray(usersTable.id, linked)) : eq(usersTable.clientId, clientId),
    ))
    .orderBy(asc(usersTable.name));
  res.json(rows.filter((r) => r.role !== "client_viewer" && (scope === "all" || r.role !== "client_staff" || r.departmentId === scope)));
});

router.post("/tasks", requireAuth, denyViewers, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (managerScope(user) === null) return res.status(403).json({ error: "Only managers can create tasks" });
  const { clientId: _ignored, ...body } = req.body ?? {};
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const value = { ...parsed.data, siteId: parsed.data.siteId ?? null, assigneeUserId: parsed.data.assigneeUserId ?? null, assigneeRole: parsed.data.assigneeRole ?? null };
  const invalid = await validateScope(user, clientId, value);
  if (invalid) return res.status(400).json({ error: invalid });
  const [created] = await db.insert(tasksTable).values({
    ...value, clientId, instruction: value.instruction ?? null, module: value.module ?? null, createdBy: user.id,
  }).returning();
  res.status(201).json(created);
});

router.patch("/tasks/:id", requireAuth, denyViewers, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid request" });
  const { clientId: _ignored, ...body } = req.body ?? {};
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || !Object.keys(parsed.data).length) return res.status(400).json({ error: parsed.success ? "No changes supplied" : parsed.error.flatten() });
  const row = (await visibleTasks(clientId, req)).find((r) => r.task.id === id);
  if (!row) return res.status(404).json({ error: "Task not found" });
  if (!canManageRow(user, row)) return res.status(403).json({ error: "Only managers can edit this task" });
  const changes = parsed.data as Partial<z.infer<typeof createSchema>> & { active?: boolean };
  const next = {
    siteId: "siteId" in changes ? changes.siteId ?? null : row.task.siteId,
    assigneeUserId: "assigneeUserId" in changes ? changes.assigneeUserId ?? null : row.task.assigneeUserId,
    assigneeRole: "assigneeRole" in changes ? changes.assigneeRole ?? null : row.task.assigneeRole,
  };
  const invalid = await validateScope(user, clientId, next);
  if (invalid) return res.status(400).json({ error: invalid });
  const [updated] = await db.update(tasksTable).set({ ...changes, ...next, updatedAt: new Date() })
    .where(and(eq(tasksTable.id, id), eq(tasksTable.clientId, clientId))).returning();
  res.json(updated);
});

// Tick one occurrence done. Staff: tasks assigned to them or their role, for
// today or yesterday (or an open overdue one-off task). Managers: any task in
// their scope, any past occurrence.
router.post("/tasks/:id/complete", requireAuth, denyViewers, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid request" });
  const { clientId: _ignored, ...body } = req.body ?? {};
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const row = (await visibleTasks(clientId, req)).find((r) => r.task.id === id);
  if (!row) return res.status(404).json({ error: "Task not found" });
  const isManager = managerScope(user) !== null;
  if (!isManager && !isAssignedTo(user, row.task)) return res.status(403).json({ error: "This task is not assigned to you" });
  if (!row.task.active) return res.status(409).json({ error: "This task has been archived" });
  const { date } = parsed.data;
  if (!occursOn(row.task, date)) return res.status(400).json({ error: "The task is not due on that date" });
  const today = await accountToday(clientId);
  if (date > today) return res.status(400).json({ error: "You cannot complete a task before its date" });
  if (!isManager && row.task.recurrence !== "once" && date < addDays(today, -1)) {
    return res.status(403).json({ error: "Only today's and yesterday's tasks can be completed. Ask a manager to record older ones." });
  }
  const [created] = await db.insert(taskCompletionsTable).values({
    clientId, taskId: id, occurrenceDate: date, completedBy: user.id, completedByName: user.name, note: parsed.data.note ?? null,
  }).onConflictDoNothing().returning();
  if (!created) return res.status(409).json({ error: "This task is already marked done" });
  res.status(201).json(created);
});

export default router;
