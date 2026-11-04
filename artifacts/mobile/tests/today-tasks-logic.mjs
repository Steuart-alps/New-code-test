import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// "My tasks today" on the mobile Today screen. Responses mirror
// artifacts/api-server/src/routes/tasks.ts (GET /tasks, POST /tasks/:id/complete).
const source = await readFile(new URL('../components/task-list-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { canMarkDone, isViewer, taskDetail, taskStatusLabel, tasksPath, todayTasks } =
  await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const task = (id, overrides = {}) => ({
  id, title: `Task ${id}`, instruction: null, siteName: 'Harbour Hotel', assigneeName: null, assigneeRole: 'client_staff',
  recurrence: 'daily', active: true, occurrenceDate: '2026-10-13', dueOnDate: true, overdue: false, completion: null,
  canComplete: true, ...overrides,
});

// Staff read their own list; viewers (who have no tasks) read the business's.
assert.equal(tasksPath('client_staff'), '/api/tasks?scope=mine');
assert.equal(tasksPath('client_admin'), '/api/tasks?scope=mine');
assert.equal(tasksPath('client_viewer'), '/api/tasks?scope=all');
assert.equal(isViewer('client_viewer'), true);
assert.equal(isViewer('client_staff'), false);

// Today's list: due today or an open overdue one-off; inactive and other days drop off.
const list = todayTasks({ date: '2026-10-13', today: '2026-10-13', canManage: false, tasks: [
  task(1, { title: 'Zeta', completion: { completedByName: 'Sam', completedAt: '2026-10-13T08:00:00Z', note: null } }),
  task(2, { title: 'Beta' }),
  task(3, { title: 'Alpha', recurrence: 'once', occurrenceDate: '2026-10-10', dueOnDate: false, overdue: true }),
  task(4, { title: 'Weekly, not today', recurrence: 'weekly', dueOnDate: false }),
  task(5, { title: 'Paused', active: false }),
] });
assert.deepEqual(list.map((t) => t.id), [3, 2, 1], 'overdue first, then open, then done; inactive and not-due hidden');
assert.deepEqual(todayTasks(undefined), []);

// "Mark done": open tasks the API allows, never for viewers.
assert.equal(canMarkDone(task(1), 'client_staff'), true);
assert.equal(canMarkDone(task(1), 'client_viewer'), false, 'viewers are read-only');
assert.equal(canMarkDone(task(1, { canComplete: true }), 'client_viewer'), false, 'even if a response says otherwise');
assert.equal(canMarkDone(task(1, { canComplete: false }), 'client_staff'), false);
assert.equal(canMarkDone(task(1, { completion: { completedByName: 'Sam', completedAt: 'x', note: null } }), 'client_staff'), false);

assert.equal(taskStatusLabel(task(1)), 'To do today');
assert.equal(taskStatusLabel(task(1, { completion: { completedByName: 'Sam', completedAt: 'x', note: null } })), 'Done by Sam');
assert.match(taskStatusLabel(task(1, { overdue: true, occurrenceDate: '2026-10-10' })), /^Overdue since 10 Oct$/);
assert.equal(taskDetail(task(1), false), 'Harbour Hotel');
assert.equal(taskDetail(task(1, { siteName: null }), true), 'All sites · All staff');
assert.equal(taskDetail(task(1, { assigneeName: 'Jo', assigneeRole: null }), true), 'Harbour Hotel · Jo');

// The section is mounted on Today, completes the shown occurrence and gates
// the button on canMarkDone.
const component = await readFile(new URL('../components/TodayTasks.tsx', import.meta.url), 'utf8');
const today = await readFile(new URL('../app/(tabs)/index.tsx', import.meta.url), 'utf8');
assert.ok(today.includes('<TodayTasks />'), 'Today screen shows the tasks section');
assert.ok(component.includes('canMarkDone(task, user?.role) ?'), 'Mark done is gated');
assert.ok(component.includes('`/api/tasks/${task.id}/complete`'));
assert.ok(component.includes('JSON.stringify({ date: task.occurrenceDate })'), 'completes the occurrence shown');
assert.ok(!/clientId/.test(component.replace('user?.clientId', '')), 'no client id is sent');

console.log('today tasks logic: ok');
