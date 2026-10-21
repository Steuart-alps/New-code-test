// The dashboard's "Today by department" card (GET /dashboard/today-by-department):
//  - each site lists a bar per department plus Whole site, with today's checks
//    done / not done yet / failed and what is outstanding;
//  - records count for the department recorded at submission;
//  - Owners see every department, a Manager only theirs, a maintenance
//    manager their own; Staff only when the Owner turns them on;
//  - the Owner's role choice is validated and enforced.
// Run: pnpm --filter @workspace/api-server run test:today-by-department
import assert from 'node:assert/strict';
import { createTenant, createUser, pool } from './approval-workflow-fixtures.mjs';

const ok = (response, expected = [200, 201]) => {
  assert.ok(expected.includes(response.status), JSON.stringify(response));
  return response.data;
};
const card = async (session, query = '') => ok(await session.request('GET', `/dashboard/today-by-department${query}`), [200]);
const group = (data, siteId) => data.groups.find(g => g.siteId === siteId);
const row = (g, name) => g?.rows.find(r => r.name === name);

try {
  const owner = await createTenant('today-by-dept');
  const c = owner.clientId;
  const siteA = ok(await owner.request('POST', '/sites', { name: 'A Hotel', seedStarterChecks: false })).id;
  const siteB = ok(await owner.request('POST', '/sites', { name: 'B Golf Club', seedStarterChecks: false })).id;
  const dept = async body => ok(await owner.request('POST', '/departments', body));
  const kitchen = await dept({ name: 'Kitchen', siteId: siteA });
  const housekeeping = await dept({ name: 'Housekeeping', siteId: siteA });
  const bar = await dept({ name: 'Bar', siteId: siteB });
  const office = await dept({ name: 'Office' });

  const kitchenStaff = await createUser(owner, { role: 'client_staff', departmentId: kitchen.id });
  const housekeepingStaff = await createUser(owner, { role: 'client_staff', departmentId: housekeeping.id });
  const barManager = await createUser(owner, { role: 'client_manager', departmentId: bar.id });
  const maintenance = await createUser(owner, { role: 'client_staff', departmentId: kitchen.id, isMaintenanceManager: true });

  // A new business: every department has a bar, nothing failed.
  const fresh = await card(owner);
  const today = fresh.date;
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(fresh.groups.map(g => g.siteName), ['A Hotel', 'B Golf Club']);
  assert.deepEqual(group(fresh, siteA).rows.filter(r => r.kind === 'department').map(r => r.name),
    ['Housekeeping', 'Kitchen', 'Office'], 'site A shows its own departments and the every-site one');
  assert.deepEqual(group(fresh, siteB).rows.filter(r => r.kind === 'department').map(r => r.name), ['Bar', 'Office']);
  assert.equal(row(group(fresh, siteA), 'Kitchen').done + row(group(fresh, siteA), 'Kitchen').todo, 0);

  // Today's work. The submitter's department comes from the database trigger.
  await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, created_by)
     VALUES ($1, $2, 'alarm', $3, 'fail', $4), ($1, $2, 'extinguisher', $3, 'pass', $5)`,
    [c, siteA, today, kitchenStaff.userId, housekeepingStaff.userId]);
  await pool.query(
    `INSERT INTO daily_checklists (client_id, site_id, checklist_type, check_date, items, submitted_at, created_by)
     VALUES ($1, $2, 'kitchen_opening', $3, $4::jsonb, now(), $5)`,
    [c, siteA, today, JSON.stringify([
      { label: 'Fridges below 8C', checked: false, result: 'fail', notes: 'Fridge 2 at 9C' },
      { label: 'Surfaces clean', checked: true, result: 'pass' },
    ]), kitchenStaff.userId]);
  await pool.query(
    `INSERT INTO compliance_items (client_id, site_id, department_id, title, status, due_date)
     VALUES ($1, $2, $3, 'Cellar gas check', 'pending', $4::date - 2),
            ($1, $2, $3, 'Next year check', 'pending', $4::date + 300)`,
    [c, siteB, bar.id, today]);
  const task = ok(await owner.request('POST', '/tasks', {
    title: 'Restock linen', siteId: siteA, assigneeUserId: housekeepingStaff.userId, recurrence: 'daily', startsOn: today,
  }));
  ok(await owner.request('POST', '/tasks', {
    title: 'Walk the site', siteId: siteB, assigneeRole: 'managers', recurrence: 'once', startsOn: today,
  }));

  const full = await card(owner);
  const a = group(full, siteA);
  const b = group(full, siteB);
  const wholeA = row(a, 'Whole site');
  assert.ok(wholeA, 'daily checklists appear under Whole site');
  assert.equal(wholeA.failed, 1, 'a submitted checklist with a failed item counts as failed');
  assert.ok(wholeA.items.some(i => i.status === 'failed' && i.label === 'Kitchen opening checks'));
  assert.ok(wholeA.todo >= 1, 'checklists not submitted yet are outstanding');
  assert.equal(wholeA.items[0].status, 'failed', 'failed items are listed first');
  assert.deepEqual(
    { done: row(a, 'Kitchen').done, failed: row(a, 'Kitchen').failed, todo: row(a, 'Kitchen').todo },
    { done: 0, failed: 1, todo: 0 }, 'the failed fire check counts for the submitter\'s department');
  assert.equal(row(a, 'Kitchen').items[0].path, '/fire-safety');
  assert.deepEqual(
    { done: row(a, 'Housekeeping').done, todo: row(a, 'Housekeeping').todo },
    { done: 1, todo: 1 }, 'a passed check is done; the task due today is outstanding');
  assert.equal(row(a, 'Housekeeping').items[0].label, 'Restock linen');
  assert.equal(row(b, 'Bar').todo, 1, 'an overdue check given to the department is outstanding; a future one is not');
  assert.match(row(b, 'Bar').items[0].detail, /^Overdue since /);
  assert.ok(row(b, 'Whole site').items.some(i => i.label === 'Walk the site'), 'role-group tasks belong to the whole site');

  // Completing the task moves it to done.
  ok(await housekeepingStaff.request('POST', `/tasks/${task.id}/complete`, { date: today }));
  assert.deepEqual(
    { done: row(group(await card(owner), siteA), 'Housekeeping').done, todo: row(group(await card(owner), siteA), 'Housekeeping').todo },
    { done: 2, todo: 0 });

  // The site filter shows one site.
  const onlyB = await card(owner, `?siteId=${siteB}`);
  assert.deepEqual(onlyB.groups.map(g => g.siteId), [siteB]);

  // A Head of Department sees only their departments (and their sites).
  const managerView = await card(barManager);
  assert.deepEqual(managerView.groups.map(g => g.siteId), [siteB], 'the Bar manager sees only the Bar\'s site');
  assert.deepEqual(managerView.groups[0].rows.map(r => r.name), ['Whole site', 'Bar']);
  assert.deepEqual((await card(barManager, `?siteId=${siteA}`)).groups, [], 'another department\'s site comes back empty');

  // A maintenance manager sees their own department.
  const maintenanceView = await card(maintenance);
  assert.deepEqual(maintenanceView.groups.map(g => g.siteId), [siteA]);
  assert.deepEqual(maintenanceView.groups[0].rows.filter(r => r.kind === 'department').map(r => r.name), ['Kitchen']);
  assert.equal(row(maintenanceView.groups[0], 'Kitchen').failed, 1);

  // Staff don't see the card unless the Owner turns them on.
  const hidden = await housekeepingStaff.request('GET', '/dashboard/today-by-department');
  assert.equal(hidden.status, 403, JSON.stringify(hidden));
  assert.equal(hidden.data.code, 'TODAY_BY_DEPARTMENT_HIDDEN');

  // The Owner's choice: validated, then enforced.
  for (const bad of ['{"managers":"yes"}', '{"everyone":true}', 'not json', '[]']) {
    const refused = await owner.request('PUT', '/settings', { todayByDepartmentRoles: bad });
    assert.equal(refused.status, 400, `${bad}: ${JSON.stringify(refused)}`);
  }
  const saved = ok(await owner.request('PUT', '/settings', {
    todayByDepartmentRoles: JSON.stringify({ managers: false, maintenance: true, staff: true }),
  }));
  assert.deepEqual(JSON.parse(saved.todayByDepartmentRoles), { managers: false, maintenance: true, staff: true });
  assert.equal((await barManager.request('GET', '/dashboard/today-by-department')).status, 403, 'managers turned off');
  const staffView = await card(housekeepingStaff);
  assert.deepEqual(staffView.groups[0].rows.filter(r => r.kind === 'department').map(r => r.name), ['Housekeeping'],
    'staff see only their own department');
  assert.equal((await maintenance.request('GET', '/dashboard/today-by-department')).status, 200);
  // Staff can't change it.
  assert.equal((await housekeepingStaff.request('PUT', '/settings', { todayByDepartmentRoles: '{"staff":false}' })).status, 403);
  // The Owner always sees it.
  assert.equal((await owner.request('GET', '/dashboard/today-by-department')).status, 200);

  // Another business sees none of this.
  const other = await createTenant('today-by-dept-other');
  assert.deepEqual((await card(other)).groups, []);

  console.log('Today by department: bars, attribution, role access and the Owner\'s setting pass.');
} finally {
  await pool.end();
}
