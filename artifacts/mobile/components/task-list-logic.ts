/**
 * "My tasks today" on the Today screen (API: GET /api/tasks, routes/tasks.ts).
 * Staff see their own tasks (scope=mine) and can mark them done; viewers see
 * the business's tasks for today (scope=all) read-only.
 *
 * Import-free so tests can load it directly with Node.
 */
export interface TaskItem {
  id: number;
  title: string;
  instruction: string | null;
  siteName: string | null;
  assigneeName: string | null;
  assigneeRole: string | null;
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly';
  active: boolean;
  occurrenceDate: string;
  dueOnDate: boolean;
  overdue: boolean;
  completion: { completedByName: string | null; completedAt: string; note: string | null } | null;
  canComplete: boolean;
}
export interface TasksResponse { date: string; today: string; canManage: boolean; tasks: TaskItem[] }

export const isViewer = (role: string | null | undefined) => role === 'client_viewer';

/** Viewers have no tasks of their own; they read the business's list. */
export const tasksPath = (role: string | null | undefined) =>
  `/api/tasks?scope=${isViewer(role) ? 'all' : 'mine'}`;

/** Today's active tasks: due today or an open overdue one-off; open ones first. */
export function todayTasks(response: TasksResponse | undefined): TaskItem[] {
  return (response?.tasks ?? [])
    .filter((task) => task.active && (task.dueOnDate || (task.overdue && !task.completion)))
    .sort((a, b) => Number(!!a.completion) - Number(!!b.completion)
      || Number(b.overdue) - Number(a.overdue)
      || a.title.localeCompare(b.title));
}

/** "Mark done" is offered only to non-viewers, on open tasks the API allows. */
export const canMarkDone = (task: TaskItem, role: string | null | undefined) =>
  !isViewer(role) && task.canComplete && !task.completion;

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function taskStatusLabel(task: TaskItem): string {
  if (task.completion) return `Done${task.completion.completedByName ? ` by ${task.completion.completedByName}` : ''}`;
  if (task.overdue) return `Overdue since ${shortDate(task.occurrenceDate)}`;
  return 'To do today';
}

export function taskDetail(task: TaskItem, showAssignee: boolean): string {
  const assignee = task.assigneeName
    ?? (task.assigneeRole === 'client_staff' ? 'All staff' : task.assigneeRole === 'managers' ? 'Managers' : null);
  return [task.siteName ?? 'All sites', showAssignee ? assignee : null].filter(Boolean).join(' · ');
}
