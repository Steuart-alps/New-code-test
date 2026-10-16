/**
 * Manager task screen (app/manage/tasks.tsx): the website's "All tasks" tab
 * (compliance-tracker src/pages/tasks.tsx) on the phone. API: routes/tasks.ts
 * GET /tasks?scope=all, GET /tasks/assignees, POST /tasks (may be queued
 * offline: a genuine create, replayed by clientEntryId), PATCH /tasks/:id
 * (edit, reassign, archive and restore: internet-only).
 *
 * Import-free so tests can load it directly with Node.
 */
export type TaskRecurrence = 'once' | 'daily' | 'weekly' | 'monthly';
export type TaskAssigneeRole = 'client_staff' | 'managers';

export interface ManagedTask {
  id: number;
  title: string;
  instruction: string | null;
  module: string | null;
  siteId: number | null;
  siteName: string | null;
  assigneeUserId: number | null;
  assigneeName: string | null;
  assigneeRole: TaskAssigneeRole | null;
  recurrence: TaskRecurrence;
  startsOn: string;
  active: boolean;
  occurrenceDate: string;
  dueOnDate: boolean;
  overdue: boolean;
  completion: { completedByName: string | null; completedAt: string; note: string | null; automatic?: boolean } | null;
  canManage: boolean;
}
export interface ManagedTasksResponse { date: string; today: string; canManage: boolean; tasks: ManagedTask[] }
export interface TaskAssignee { id: number; name: string; role: string }
export interface TaskSite { id: number; name: string }

/** The list the website's "All tasks" tab reads, for today. */
export const ALL_TASKS_PATH = '/api/tasks?scope=all';
export const ASSIGNEES_PATH = '/api/tasks/assignees';

/** Module links offered on the website's task form (MODULE_INFO in compliance-tracker lib/onboarding.ts). */
export const TASK_MODULES: { key: string; label: string }[] = [
  { key: 'compliance', label: 'Compliance Checks' },
  { key: 'firetrack', label: 'FireTrack' },
  { key: 'kitchentrack', label: 'KitchenTrack' },
  { key: 'legionellatrack', label: 'LegionellaTrack' },
  { key: 'doctrack', label: 'DocTrack' },
  { key: 'fixtrack', label: 'FixTrack' },
  { key: 'traintrack', label: 'TrainTrack' },
  { key: 'hottubtrack', label: 'TubTrack' },
  { key: 'treetrack', label: 'TreeTrack' },
  { key: 'biketrack', label: 'BikeTrack' },
  { key: 'aquatrack', label: 'AquaTrack' },
  { key: 'greentrack', label: 'GreenTrack' },
  { key: 'incidenttrack', label: 'IncidentTrack' },
  { key: 'pattrack', label: 'PATtrack' },
  { key: 'pesttrack', label: 'PestTrack' },
  { key: 'premisestrack', label: 'PremisesTrack' },
  { key: 'roomtrack', label: 'RoomTrack' },
  { key: 'dailytrack_am', label: 'DailyTrack AM' },
  { key: 'dailytrack_pm', label: 'DailyTrack PM' },
];

/** As on the website: Compliance Checks always, other modules the account has. */
export function moduleOptions(hasService: (key: string) => boolean) {
  return TASK_MODULES.filter((m) => m.key === 'compliance' || hasService(m.key));
}

export function moduleLabel(key: string | null | undefined): string | null {
  return key ? TASK_MODULES.find((m) => m.key === key)?.label ?? key : null;
}

export const RECURRENCE_OPTIONS: { value: TaskRecurrence; label: string }[] = [
  { value: 'once', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "12 Oct 2026" from a YYYY-MM-DD day (no time zone shift), as on the website. */
export function formatDay(day: string): string {
  if (!isCalendarDay(day)) return day;
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/** The website's describeRecurrence (components/task-item.tsx). */
export function describeRecurrence(task: { recurrence: TaskRecurrence; startsOn: string }): string {
  const start = new Date(`${task.startsOn}T00:00:00Z`);
  switch (task.recurrence) {
    case 'daily': return 'Every day';
    case 'weekly': return `Every ${WEEKDAYS[start.getUTCDay()]}`;
    case 'monthly': return `Monthly on the ${ordinal(start.getUTCDate())}`;
    default: return `Once, due ${formatDay(task.startsOn)}`;
  }
}

export function assigneeLabel(task: Pick<ManagedTask, 'assigneeName' | 'assigneeRole'>): string {
  if (task.assigneeName) return task.assigneeName;
  if (task.assigneeRole === 'client_staff') return 'All staff';
  if (task.assigneeRole === 'managers') return 'All managers';
  return 'Unassigned';
}

/** The website's detail line: assignee · site · recurrence · module. */
export function taskDetailLine(task: ManagedTask): string {
  return [assigneeLabel(task), task.siteName ?? 'All sites', describeRecurrence(task), moduleLabel(task.module)]
    .filter(Boolean).join(' · ');
}

export type TaskStatusTone = 'done' | 'overdue' | 'due' | 'muted';
/** Status for today, worded as on the website. */
export function taskStatus(task: ManagedTask): { label: string; tone: TaskStatusTone } {
  if (task.completion) {
    const who = task.completion.completedByName ?? '';
    return {
      label: task.completion.automatic ? `${task.completion.note ?? 'Done automatically'} (${who})` : `Done by ${who}`,
      tone: 'done',
    };
  }
  if (task.overdue) return { label: 'Overdue', tone: 'overdue' };
  if (task.dueOnDate) return { label: 'Due today', tone: 'due' };
  return { label: 'Not due today', tone: 'muted' };
}

/** Same occurrence rules as the API (lib/taskSchedule.ts). */
export function occursOn(task: { recurrence: TaskRecurrence; startsOn: string }, day: string): boolean {
  if (day < task.startsOn) return false;
  switch (task.recurrence) {
    case 'once': return day === task.startsOn;
    case 'daily': return true;
    case 'weekly': return new Date(`${day}T00:00:00Z`).getUTCDay() === new Date(`${task.startsOn}T00:00:00Z`).getUTCDay();
    case 'monthly': {
      const [, , sd] = task.startsOn.split('-').map(Number);
      const [cy, cm, cd] = day.split('-').map(Number);
      return cd === Math.min(sd, new Date(Date.UTC(cy, cm, 0)).getUTCDate());
    }
    default: return false;
  }
}

/**
 * The date the task is next due on or after today. A one-off task is due on
 * its date (in the past when overdue); a recurring task on its next
 * occurrence. Null when it has none in the next 31 days (cannot happen for a
 * valid recurrence).
 */
export function nextDueDate(task: { recurrence: TaskRecurrence; startsOn: string }, today: string): string | null {
  if (task.recurrence === 'once') return task.startsOn;
  let day = task.startsOn > today ? task.startsOn : today;
  for (let i = 0; i < 32; i += 1, day = addDays(day, 1)) if (occursOn(task, day)) return day;
  return null;
}

export type StatusFilter = 'active' | 'open' | 'overdue' | 'done' | 'archived';
export type DueFilter = 'any' | 'today' | 'week' | 'later';
export interface TaskFilters {
  /** 'all', 'role:client_staff', 'role:managers' or 'user:<id>'. */
  assignee: string;
  /** 'all', 'none' (business-wide tasks) or a site ID. */
  site: string;
  status: StatusFilter;
  due: DueFilter;
}
export const DEFAULT_FILTERS: TaskFilters = { assignee: 'all', site: 'all', status: 'active', due: 'any' };

export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'All active' },
  { value: 'open', label: 'Still to do' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'done', label: 'Done today' },
  { value: 'archived', label: 'Archived' },
];
export const DUE_FILTERS: { value: DueFilter; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today or overdue' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'later', label: 'Later' },
];

function matchesStatus(task: ManagedTask, status: StatusFilter): boolean {
  if (status === 'archived') return !task.active;
  if (!task.active) return false;
  switch (status) {
    case 'open': return !task.completion && (task.dueOnDate || task.overdue);
    case 'overdue': return task.overdue;
    case 'done': return !!task.completion;
    default: return true;
  }
}

function matchesDue(task: ManagedTask, due: DueFilter, today: string): boolean {
  if (due === 'any') return true;
  const next = nextDueDate(task, today);
  if (!next) return false;
  // A one-off task already done drops off the upcoming views.
  if (task.recurrence === 'once' && task.completion && due !== 'today') return false;
  if (due === 'today') return next <= today;
  if (due === 'week') return next >= today && next <= addDays(today, 6);
  return next > addDays(today, 6);
}

export function filterTasks(tasks: readonly ManagedTask[], filters: TaskFilters, today: string): ManagedTask[] {
  return tasks.filter((task) => {
    if (filters.assignee !== 'all') {
      const [kind, value] = filters.assignee.split(':');
      if (kind === 'user' ? task.assigneeUserId !== Number(value) : task.assigneeRole !== value || task.assigneeUserId != null) return false;
    }
    if (filters.site === 'none' ? task.siteId != null : filters.site !== 'all' && task.siteId !== Number(filters.site)) return false;
    return matchesStatus(task, filters.status) && matchesDue(task, filters.due, today);
  });
}

/** Assignee filter choices: the role groups, then everyone the list or the staff list names. */
export function assigneeFilterOptions(tasks: readonly ManagedTask[], assignees: readonly TaskAssignee[]) {
  const people = new Map<number, string>();
  for (const a of assignees) people.set(a.id, a.name);
  for (const t of tasks) if (t.assigneeUserId != null && !people.has(t.assigneeUserId)) people.set(t.assigneeUserId, t.assigneeName ?? `User ${t.assigneeUserId}`);
  return [
    { value: 'all', label: 'Everyone' },
    { value: 'role:client_staff', label: 'All staff' },
    { value: 'role:managers', label: 'All managers' },
    ...[...people].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ value: `user:${id}`, label: name })),
  ];
}

export interface TaskDraft {
  id?: number;
  title: string;
  instruction: string;
  module: string;
  /** '' = All sites. */
  siteId: string;
  /** 'role:client_staff', 'role:managers' or 'user:<id>'. */
  assignee: string;
  recurrence: TaskRecurrence;
  startsOn: string;
}

/** The website's "New task" defaults: all staff, every day, from today; the only site when there is one. */
export function newTaskDraft(today: string, sites: readonly TaskSite[] | undefined): TaskDraft {
  return {
    title: '', instruction: '', module: '', siteId: sites?.length === 1 ? String(sites[0].id) : '',
    assignee: 'role:client_staff', recurrence: 'daily', startsOn: today,
  };
}

export function draftFromTask(task: ManagedTask): TaskDraft {
  return {
    id: task.id, title: task.title, instruction: task.instruction ?? '', module: task.module ?? '',
    siteId: task.siteId ? String(task.siteId) : '',
    assignee: task.assigneeUserId ? `user:${task.assigneeUserId}` : `role:${task.assigneeRole ?? 'client_staff'}`,
    recurrence: task.recurrence, startsOn: task.startsOn,
  };
}

export type TaskPayload = {
  title: string; instruction: string | null; module: string | null; siteId: number | null;
  recurrence: TaskRecurrence; startsOn: string; assigneeUserId: number | null; assigneeRole: TaskAssigneeRole | null;
};
export type BuiltTask = { ok: true; payload: TaskPayload } | { ok: false; title: string; message: string };

/** The website's save body, with the API's limits checked before sending. */
export function buildTaskPayload(draft: TaskDraft): BuiltTask {
  const title = draft.title.trim();
  if (!title) return { ok: false, title: 'Task needed', message: 'Enter what needs doing, e.g. Kitchen opening checklist.' };
  if (title.length > 200) return { ok: false, title: 'Task too long', message: 'Keep the task to 200 characters; put details in the instructions.' };
  const instruction = draft.instruction.trim();
  if (instruction.length > 2000) return { ok: false, title: 'Instructions too long', message: 'Keep the instructions to 2,000 characters.' };
  const startsOn = draft.startsOn.trim();
  if (!isCalendarDay(startsOn)) {
    return { ok: false, title: 'Check the date', message: `Enter the ${draft.recurrence === 'once' ? 'due date' : 'start date'} as YYYY-MM-DD.` };
  }
  const [kind, value] = draft.assignee.split(':');
  const userId = kind === 'user' ? Number(value) : NaN;
  const role = kind === 'role' && (value === 'client_staff' || value === 'managers') ? value : null;
  if (!(Number.isInteger(userId) && userId > 0) && !role) return { ok: false, title: 'Choose who', message: 'Assign the task to one person or to a role.' };
  const siteId = draft.siteId ? Number(draft.siteId) : null;
  return {
    ok: true,
    payload: {
      title, instruction: instruction || null, module: draft.module || null,
      siteId: siteId != null && Number.isInteger(siteId) && siteId > 0 ? siteId : null,
      recurrence: draft.recurrence, startsOn,
      assigneeUserId: role ? null : userId, assigneeRole: role,
    },
  };
}

/** Outbox label for a queued new task. */
export function taskCreateLabel(payload: TaskPayload): string {
  return `New task · ${payload.title.slice(0, 60)} · ${describeRecurrence(payload)}`;
}
