// KitchenTrack status scoped to one site, end to end through the API.
// Run: pnpm --filter @workspace/api-server run test:kitchen-status-site-scope
import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('kitchen-status-scope');
  const other = await createTenant('other-status-scope');
  const siteA = (await owner.request('POST', '/sites', { name: 'Kitchen A', seedStarterChecks: false })).data;
  const siteB = (await owner.request('POST', '/sites', { name: 'Kitchen B', seedStarterChecks: false })).data;
  const foreign = (await other.request('POST', '/sites', { name: 'Foreign kitchen', seedStarterChecks: false })).data;

  const today = isoDay();
  const lastWeek = isoDay(-6);
  const c = owner.clientId;
  await pool.query('INSERT INTO food_safety_records (client_id, site_id, record_date) VALUES ($1, $2, $3)', [c, siteA.id, today]);
  await pool.query('INSERT INTO food_safety_records (client_id, site_id, record_date) VALUES ($1, NULL, $2)', [c, lastWeek]);
  await pool.query('INSERT INTO kitchen_weekly_records (client_id, site_id, week_commencing) VALUES ($1, NULL, $2)', [c, lastWeek]);
  await pool.query('INSERT INTO kitchen_weekly_records (client_id, site_id, week_commencing) VALUES ($1, $2, $3)', [c, siteA.id, today]);
  await pool.query(
    `INSERT INTO kitchen_cleaning_tasks (client_id, site_id, area, task, frequency)
     VALUES ($1, $2, 'Hob', 'Degrease', 'daily'), ($1, NULL, 'Walk-in', 'Deep clean', 'monthly')`,
    [c, siteA.id],
  );
  await pool.query(
    `INSERT INTO kitchen_cleaning_logs (client_id, site_id, log_date, frequency) VALUES ($1, $2, $3, 'daily')`,
    [c, siteA.id, today],
  );

  const status = async (session, query = '') => {
    const response = await session.request('GET', `/food-safety/status${query}`);
    assert.equal(response.status, 200, JSON.stringify(response));
    return Object.fromEntries(response.data.map(row => [row.checkType, row]));
  };

  // All sites: unchanged client-wide aggregation.
  const all = await status(owner);
  assert.deepEqual(Object.keys(all).sort(), ['cleaning_daily', 'cleaning_monthly', 'daily_diary', 'probe_check', 'weekly_review']);
  assert.equal(all.daily_diary.lastDate, today);
  assert.equal(all.weekly_review.lastDate, today);
  assert.equal(all.cleaning_daily.lastDate, today);
  assert.equal(all.probe_check.status, 'never');

  // Site A sees its own diary, review and cleaning.
  const a = await status(owner, `?siteId=${siteA.id}`);
  assert.equal(a.daily_diary.lastDate, today);
  assert.equal(a.weekly_review.lastDate, today);
  assert.equal(a.cleaning_daily.lastDate, today);
  assert.equal(a.cleaning_monthly.status, 'never', 'client-wide tasks apply to each site');

  // Site B: no diary of its own; the client-wide review still covers it; site A's
  // daily task and log do not leak across.
  const b = await status(owner, `?siteId=${siteB.id}`);
  assert.equal(b.daily_diary.status, 'never', 'the diary counts only the selected site');
  assert.equal(b.weekly_review.lastDate, lastWeek, 'client-wide weekly reviews cover every site');
  assert.equal(b.cleaning_daily, undefined, "another site's cleaning task is not counted");
  assert.ok(b.cleaning_monthly, 'client-wide cleaning tasks are counted');

  // Validation and tenant isolation.
  for (const bad of ['abc', '0', '-1', '1.5']) {
    assert.equal((await owner.request('GET', `/food-safety/status?siteId=${bad}`)).status, 400, `siteId=${bad}`);
  }
  assert.equal((await owner.request('GET', `/food-safety/status?siteId=${foreign.id}`)).status, 400, "another client's site is rejected");
  assert.equal((await other.request('GET', `/food-safety/status?siteId=${siteA.id}`)).status, 400, 'another tenant cannot read site status');

  // Department scoping: a user in one department cannot ask for another department's site.
  const department = (await owner.request('POST', '/departments', { name: 'Kitchen A team' })).data;
  const otherDepartment = (await owner.request('POST', '/departments', { name: 'Kitchen B team' })).data;
  await pool.query('UPDATE sites SET department_id = $1 WHERE id = $2', [department.id, siteA.id]);
  await pool.query('UPDATE sites SET department_id = $1 WHERE id = $2', [otherDepartment.id, siteB.id]);
  const staff = await createUser(owner, { role: 'client_staff', departmentId: department.id });
  assert.equal((await status(staff, `?siteId=${siteA.id}`)).daily_diary.lastDate, today);
  assert.equal((await staff.request('GET', `/food-safety/status?siteId=${siteB.id}`)).status, 400, "another department's site is rejected");

  console.log('Kitchen status site scope tests passed');
} finally {
  await pool.end();
}
