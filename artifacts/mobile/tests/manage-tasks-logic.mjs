import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Manager tasks on the phone (app/manage/tasks.tsx). Responses mirror
// artifacts/api-server/src/routes/tasks.ts (GET /tasks?scope=all, POST /tasks,
// PATCH /tasks/:id); wording and defaults mirror compliance-tracker pages/tasks.tsx.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}
const {
  ALL_TASKS_PATH, ASSIGNEES_PATH, DEFAULT_FILTERS, assigneeFilterOptions, assigneeLabel, buildTaskPayload, describeRecurrence,
  draftFromTask, filterTasks, formatDay, moduleLabel, moduleOptions, newTaskDraft, nextDueDate, occursOn, taskCreateLabel,
  taskDetailLine, taskStatus,
} = await load('../components/manage-tasks-logic.ts');
const { MANAGE_ITEMS, visibleManageItems } = await load('../components/manage-items.ts');
const { CheckOutbox, RECORD_KINDS, RECORD_PATHS, deliveredQueryKeys } = await load('../lib/checkOutboxCore.ts');

const today = '2026-10-15'; // a Thursday
const task = (id, overrides = {}) => ({
  id, title: `Task ${id}`, instruction: null, module: null, siteId: 1, siteName: 'Harbour Hotel',
  assigneeUserId: null, assigneeName: null, assigneeRole: 'client_staff', recurrence: 'daily', startsOn: '2026-10-01',
  active: true, occurrenceDate: today, dueOnDate: true, overdue: false, completion: null, canManage: true, ...overrides,
});

assert.equal(ALL_TASKS_PATH, '/api/tasks?scope=all');
assert.equal(ASSIGNEES_PATH, '/api/tasks/assignees');

// Hub: managers (client admins and consultants) only, as on the website.
const item = MANAGE_ITEMS.find((i) => i.id === 'tasks');
assert.equal(item.route, '/manage/tasks');
assert.ok(visibleManageItems(MANAGE_ITEMS, 'client_admin', () => true).includes(item));
assert.ok(visibleManageItems(MANAGE_ITEMS, 'consultant', () => true).includes(item));
assert.ok(!visibleManageItems(MANAGE_ITEMS, 'client_staff', () => true).includes(item));
assert.ok(!visibleManageItems(MANAGE_ITEMS, 'client_viewer', () => true).includes(item));

// Website wording.
assert.equal(describeRecurrence({ recurrence: 'daily', startsOn: today }), 'Every day');
assert.equal(describeRecurrence({ recurrence: 'weekly', startsOn: today }), 'Every Thursday');
assert.equal(describeRecurrence({ recurrence: 'monthly', startsOn: '2026-10-22' }), 'Monthly on the 22nd');
assert.equal(describeRecurrence({ recurrence: 'monthly', startsOn: '2026-10-11' }), 'Monthly on the 11th');
assert.equal(describeRecurrence({ recurrence: 'once', startsOn: '2026-10-02' }), 'Once, due 2 Oct 2026');
assert.equal(formatDay('2026-01-31'), '31 Jan 2026');
assert.equal(assigneeLabel({ assigneeName: 'Sam', assigneeRole: null }), 'Sam');
assert.equal(assigneeLabel({ assigneeName: null, assigneeRole: 'managers' }), 'All managers');
assert.equal(assigneeLabel({ assigneeName: null, assigneeRole: 'client_staff' }), 'All staff');
assert.equal(taskDetailLine(task(1, { module: 'firetrack' })), 'All staff · Harbour Hotel · Every day · FireTrack');
assert.equal(taskDetailLine(task(1, { siteId: null, siteName: null })), 'All staff · All sites · Every day');
assert.equal(moduleLabel('hottubtrack'), 'TubTrack');
assert.deepEqual(taskStatus(task(1)), { label: 'Due today', tone: 'due' });
assert.deepEqual(taskStatus(task(1, { dueOnDate: false })), { label: 'Not due today', tone: 'muted' });
assert.deepEqual(taskStatus(task(1, { recurrence: 'once', overdue: true, dueOnDate: false })), { label: 'Overdue', tone: 'overdue' });
assert.equal(taskStatus(task(1, { completion: { completedByName: 'Sam', completedAt: 'x', note: null, automatic: false } })).label, 'Done by Sam');
assert.equal(taskStatus(task(1, { completion: { completedByName: 'Jo', completedAt: 'x', note: 'Done automatically: AM checklist submitted', automatic: true } })).label,
  'Done automatically: AM checklist submitted (Jo)');
assert.deepEqual(moduleOptions((key) => key === 'firetrack').map((m) => m.key), ['compliance', 'firetrack'],
  'Compliance Checks always, other modules only when the account has them');

// Occurrences match the API (lib/taskSchedule.ts).
assert.equal(occursOn({ recurrence: 'monthly', startsOn: '2026-01-31' }, '2026-04-30'), true, 'monthly on the 31st falls on 30 April');
assert.equal(occursOn({ recurrence: 'weekly', startsOn: '2026-10-01' }, '2026-10-08'), true);
assert.equal(occursOn({ recurrence: 'weekly', startsOn: '2026-10-01' }, '2026-10-09'), false);
assert.equal(nextDueDate({ recurrence: 'once', startsOn: '2026-10-01' }, today), '2026-10-01', 'a one-off is due on its date, even when past');
assert.equal(nextDueDate({ recurrence: 'weekly', startsOn: '2026-10-02' }, today), '2026-10-16');
assert.equal(nextDueDate({ recurrence: 'daily', startsOn: '2026-11-01' }, today), '2026-11-01', 'not before it starts');
assert.equal(nextDueDate({ recurrence: 'monthly', startsOn: '2026-09-30' }, today), '2026-10-30');

// Filters: assignee, site, status and due.
const list = [
  task(1, { assigneeUserId: 7, assigneeName: 'Sam', assigneeRole: null }),
  task(2, { assigneeRole: 'managers', siteId: null, siteName: null }),
  task(3, { recurrence: 'once', startsOn: '2026-10-10', overdue: true, dueOnDate: false }),
  task(4, { completion: { completedByName: 'Sam', completedAt: 'x', note: null } }),
  task(5, { active: false }),
  task(6, { recurrence: 'once', startsOn: '2026-10-19', dueOnDate: false, siteId: 2, siteName: 'Beach Cafe' }),
  task(7, { recurrence: 'monthly', startsOn: '2026-09-30', dueOnDate: false }),
];
const ids = (filters) => filterTasks(list, { ...DEFAULT_FILTERS, ...filters }, today).map((t) => t.id);
assert.deepEqual(ids({}), [1, 2, 3, 4, 6, 7], 'archived tasks are hidden by default, as on the website');
assert.deepEqual(ids({ status: 'archived' }), [5]);
assert.deepEqual(ids({ status: 'open' }), [1, 2, 3], 'still to do: due today or overdue, not done');
assert.deepEqual(ids({ status: 'overdue' }), [3]);
assert.deepEqual(ids({ status: 'done' }), [4]);
assert.deepEqual(ids({ assignee: 'user:7' }), [1]);
assert.deepEqual(ids({ assignee: 'role:managers' }), [2]);
assert.deepEqual(ids({ assignee: 'role:client_staff' }), [3, 4, 6, 7], 'a role filter skips tasks for one person');
assert.deepEqual(ids({ site: 'none' }), [2], 'business-wide tasks');
assert.deepEqual(ids({ site: '2' }), [6]);
assert.deepEqual(ids({ due: 'today' }), [1, 2, 3, 4]);
assert.deepEqual(ids({ due: 'week' }), [1, 2, 4, 6]);
assert.deepEqual(ids({ due: 'later' }), [7]);
assert.deepEqual(assigneeFilterOptions(list, [{ id: 9, name: 'Alex', role: 'client_staff' }]).map((o) => o.value),
  ['all', 'role:client_staff', 'role:managers', 'user:9', 'user:7'], 'roles, then people by name');

// Form: website defaults and save body.
assert.deepEqual(newTaskDraft(today, [{ id: 4, name: 'Only site' }]),
  { title: '', instruction: '', module: '', siteId: '4', assignee: 'role:client_staff', recurrence: 'daily', startsOn: today });
assert.equal(newTaskDraft(today, [{ id: 4, name: 'A' }, { id: 5, name: 'B' }]).siteId, '');
const built = buildTaskPayload({ ...newTaskDraft(today, []), title: '  Fire exits  ', instruction: ' ', assignee: 'user:7', siteId: '2', module: 'firetrack' });
assert.deepEqual(built, { ok: true, payload: {
  title: 'Fire exits', instruction: null, module: 'firetrack', siteId: 2, recurrence: 'daily', startsOn: today, assigneeUserId: 7, assigneeRole: null,
} });
assert.deepEqual(buildTaskPayload({ ...newTaskDraft(today, []), title: 'X', assignee: 'role:managers' }).payload,
  { title: 'X', instruction: null, module: null, siteId: null, recurrence: 'daily', startsOn: today, assigneeUserId: null, assigneeRole: 'managers' });
assert.equal(buildTaskPayload({ ...newTaskDraft(today, []), title: ' ' }).ok, false, 'title required');
assert.equal(buildTaskPayload({ ...newTaskDraft(today, []), title: 'x'.repeat(201) }).ok, false, 'API title limit');
assert.equal(buildTaskPayload({ ...newTaskDraft(today, []), title: 'X', instruction: 'x'.repeat(2001) }).ok, false, 'API instruction limit');
assert.equal(buildTaskPayload({ ...newTaskDraft(today, []), title: 'X', startsOn: '2026-02-30' }).ok, false, 'real dates only');
assert.equal(buildTaskPayload({ ...newTaskDraft(today, []), title: 'X', assignee: 'role:client_viewer' }).ok, false, 'no viewer role group');
const editing = draftFromTask(task(1, { assigneeUserId: 7, assigneeRole: null, siteId: null, instruction: 'Do it' }));
assert.deepEqual(editing, { id: 1, title: 'Task 1', instruction: 'Do it', module: '', siteId: '', assignee: 'user:7', recurrence: 'daily', startsOn: '2026-10-01' });
assert.equal(draftFromTask(task(2, { assigneeRole: 'managers' })).assignee, 'role:managers');
assert.equal(taskCreateLabel(built.payload), 'New task · Fire exits · Every day');

// Outbox: a new task is a record kind POSTed to /api/tasks; edits are not queueable.
assert.ok(RECORD_KINDS.includes('task-create'));
assert.equal(RECORD_PATHS['task-create'], '/api/tasks');
assert.deepEqual(deliveredQueryKeys('task-create'), [['tasks']]);
{
  const store = new Map();
  const sent = [];
  let online = false;
  const outbox = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push(structuredClone(entry.body));
      if (!online) throw new TypeError('Network request failed');
      return { id: 41 };
    },
    async onSent() {},
  });
  await outbox.activate({ clientId: 3, userId: 8 }, 'token');
  const entry = (entryId, path = '/api/tasks') => ({ entryId, kind: 'task-create', path, scopeKey: `task-create:${entryId}`, label: 'New task', body: built.payload });
  await outbox.enqueue(entry('task-create-0001'));
  await outbox.enqueue(entry('task-create-0002'));
  await outbox.replay();
  assert.deepEqual(outbox.getSnapshot().entries.map((e) => e.state), ['queued', 'queued'], 'several new tasks can wait offline');
  await assert.rejects(outbox.enqueue(entry('task-create-0003', '/api/tasks/5')), /cannot be saved/, 'an edit path is never queued');
  online = true;
  await outbox.replay();
  assert.deepEqual(outbox.getSnapshot().entries.map((e) => e.state), ['sent', 'sent']);
  assert.equal(sent.at(-1).clientEntryId, 'task-create-0002', 'every attempt carries its entry ID');
  assert.deepEqual(sent.filter((b) => b.clientEntryId === 'task-create-0001').map(({ clientEntryId, ...rest }) => rest).at(-1), built.payload,
    'the resend is the identical body');
}

console.log('manage tasks: hub, website wording, filters, form payloads and offline create ok');
