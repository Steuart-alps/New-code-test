// KitchenTrack "This month" summary for Owners and Managers, end to end through the API.
// Run: pnpm --filter @workspace/api-server run test:kitchen-month-summary
import assert from 'node:assert/strict';
import { createTenant, createUser, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('kitchen-month');
  const other = await createTenant('other-kitchen-month');
  const siteA = (await owner.request('POST', '/sites', { name: 'Kitchen A', seedStarterChecks: false })).data;
  const siteB = (await owner.request('POST', '/sites', { name: 'Kitchen B', seedStarterChecks: false })).data;
  const foreign = (await other.request('POST', '/sites', { name: 'Foreign kitchen', seedStarterChecks: false })).data;
  const c = owner.clientId;

  // Site A starts its diary on 3 March 2025. Every day after is filed except
  // the 5th (missed), the 6th (draft only) and the 7th (marked closed).
  for (let day = 3; day <= 31; day++) {
    if (day === 5 || day === 7) continue;
    const date = `2025-03-${String(day).padStart(2, '0')}`;
    await pool.query(
      `INSERT INTO food_safety_records (client_id, site_id, record_date, submitted_at) VALUES ($1, $2, $3, ${day === 6 ? 'NULL' : 'now()'})`,
      [c, siteA.id, date],
    );
  }
  await pool.query(`INSERT INTO kitchen_closed_days (client_id, site_id, closed_date, reason) VALUES ($1, $2, '2025-03-07', 'Staff training day')`, [c, siteA.id]);
  // Site B started in February and has nothing in March, so every day is missed.
  await pool.query(`INSERT INTO food_safety_records (client_id, site_id, record_date, submitted_at) VALUES ($1, $2, '2025-02-20', now())`, [c, siteB.id]);
  // Another business's diary never counts.
  await pool.query(`INSERT INTO food_safety_records (client_id, site_id, record_date, submitted_at) VALUES ($1, $2, '2025-03-05', now())`, [other.clientId, foreign.id]);

  const action = (clientId, siteId, module, createdAt, extra = {}) => pool.query(
    `INSERT INTO track_actions (client_id, site_id, module, source_kind, title, severity, status, due_date, created_at,
       resolved_by, resolved_by_name, resolved_at)
     VALUES ($1, $2, $3, $4, 'Fixture action', 'action_required', $5, $6, $7,
       CASE WHEN $5 = 'resolved' THEN $8::int END, CASE WHEN $5 = 'resolved' THEN 'Fixture resolver' END, CASE WHEN $5 = 'resolved' THEN now() END)`,
    [clientId, siteId, module, extra.sourceKind ?? null, extra.status ?? 'open', extra.dueDate ?? null, createdAt, owner.userId],
  );
  await action(c, siteA.id, 'kitchen', '2025-03-10 09:00', { sourceKind: 'kitchen_temperature_fixture-1', dueDate: '2025-03-12' });
  await action(c, siteA.id, 'kitchen', '2025-03-11 09:00', { status: 'resolved' });
  await action(c, null, 'kitchen', '2025-03-20 09:00');
  await action(c, siteB.id, 'kitchen', '2025-04-02 09:00');
  await action(c, siteA.id, 'fire', '2025-03-10 09:00');
  await action(other.clientId, foreign.id, 'kitchen', '2025-03-10 09:00');

  const summary = async (session, query = '?month=2025-03') => {
    const response = await session.request('GET', `/food-safety/month-summary${query}`);
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.data;
  };

  const march = await summary(owner);
  assert.equal(march.month, '2025-03');
  assert.equal(march.through, '2025-03-31', 'a past month is counted to its last day');
  const [a, b] = march.sites;
  assert.equal(a.siteName, 'Kitchen A');
  assert.equal(a.startedOn, '2025-03-03', 'days before the first diary record are not counted');
  assert.deepEqual(
    { counted: a.daysCounted, recorded: a.recordedDays, draft: a.draftDays, closed: a.closedDays, missed: a.missedDates },
    { counted: 29, recorded: 26, draft: 1, closed: 1, missed: ['2025-03-05'] },
  );
  assert.deepEqual({ failed: a.failedReadings, raised: a.actionsRaised, open: a.actionsOpen }, { failed: 1, raised: 2, open: 1 });
  assert.equal(b.siteName, 'Kitchen B');
  assert.equal(b.missedDays, 31, 'a site with no March diary misses every day');
  assert.deepEqual({ raised: b.actionsRaised, open: b.actionsOpen }, { raised: 0, open: 1 }, 'an April action is open now but not raised in March');
  assert.deepEqual(march.totals, {
    daysCounted: 60, recordedDays: 26, draftDays: 1, closedDays: 1, missedDays: 32,
    failedReadings: 1, actionsRaised: 3, actionsResolved: 1, actionsOpen: 3, actionsOverdue: 1,
  }, 'fire actions and another business are left out; whole-business kitchen actions count for the Owner');

  // A month with no diary yet for either site.
  const before = await summary(owner, '?month=2025-01');
  assert.deepEqual(before.sites.map(site => site.daysCounted), [0, 0]);
  assert.equal(before.totals.missedDays, 0, 'nothing counts as missed before the diary started');

  // The current month by default, never counting today.
  const current = await summary(owner, '');
  assert.equal(current.month, current.today.slice(0, 7));
  assert.ok(current.through === null || current.through < current.today, 'today is still open');

  for (const bad of ['2025-13', '2025-3', 'March', '2025-03-01']) {
    assert.equal((await owner.request('GET', `/food-safety/month-summary?month=${bad}`)).status, 400, `month=${bad}`);
  }

  // Staff do not see the summary; a Manager sees only their own sites.
  const department = (await owner.request('POST', '/departments', { name: 'Kitchen A team' })).data;
  const otherDepartment = (await owner.request('POST', '/departments', { name: 'Kitchen B team' })).data;
  await pool.query('UPDATE sites SET department_id = $1 WHERE id = $2', [department.id, siteA.id]);
  await pool.query('UPDATE sites SET department_id = $1 WHERE id = $2', [otherDepartment.id, siteB.id]);
  const staff = await createUser(owner, { role: 'client_staff', departmentId: department.id });
  assert.equal((await staff.request('GET', '/food-safety/month-summary?month=2025-03')).status, 403);
  const manager = await createUser(owner, { role: 'client_manager', departmentId: department.id });
  const managed = await summary(manager);
  assert.deepEqual(managed.sites.map(site => site.siteName), ['Kitchen A']);
  assert.equal(managed.totals.actionsOpen, 1, "another department's and whole-business actions are left out");

  // Another business sees only its own kitchen.
  const theirs = await summary(other);
  assert.deepEqual(theirs.sites.map(site => site.siteName), ['Foreign kitchen']);
  assert.equal(theirs.totals.recordedDays, 1);
  assert.equal(theirs.totals.actionsRaised, 1);

  console.log('Kitchen month summary tests passed');
} finally {
  await pool.end();
}
