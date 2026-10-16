import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// FireTrack's annual 3-hour emergency lighting discharge test and the
// ComplyTrack "Emergency Light Maintenance" task stay in step: a passed
// FireTrack record completes the task (which reopens for next year), and
// completing the task records the test in FireTrack. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/fire-discharge-task-link.mjs

const TYPE = 'emergency_lights_annual';
const today = isoDay();
const yesterday = isoDay(-1);
const lastMonth = isoDay(-30);
const nextYear = (day) => `${Number(day.slice(0, 4)) + 1}${day.slice(4)}`;

try {
  const owner = await createTenant('fire-discharge');
  const staff = await createUser(owner, { role: 'client_staff' });
  const other = await createTenant('fire-discharge-other');
  const siteA = (await owner.request('POST', '/sites', { name: 'Discharge site A', seedStarterChecks: false })).data;
  const siteB = (await owner.request('POST', '/sites', { name: 'Discharge site B', seedStarterChecks: false })).data;
  const siteC = (await owner.request('POST', '/sites', { name: 'Discharge site C', seedStarterChecks: false })).data;
  const task = async (who, siteId, title = 'Emergency Light Maintenance') => {
    const created = await who.request('POST', '/compliance-items', {
      title, priority: 'high', siteId, frequencyMonths: 12, dueDate: `${today}T00:00:00.000Z`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data;
  };
  const taskA = await task(owner, siteA.id);
  const taskB = await task(owner, siteB.id, ' emergency light maintenance ');
  const otherTask = await task(other, null);
  const unrelated = await task(owner, siteA.id, 'Fire Alarm Maintenance');
  const getTask = async (id, who = owner) => (await who.request('GET', `/compliance-items/${id}`)).data;
  const status = async (siteId) => (await owner.request('GET', `/fire-safety/status?siteId=${siteId}`)).data
    .find(row => row.checkType === TYPE);
  const fireRecords = async (siteId) => (await pool.query(
    `SELECT id, check_date::text AS day, result, notes FROM fire_safety_checks
     WHERE client_id = $1 AND check_type = $2 AND site_id IS NOT DISTINCT FROM $3 ORDER BY id`,
    [owner.clientId, TYPE, siteId])).rows;

  // ── The test is a FireTrack check, due every year ──────────────────────────
  const before = await status(siteA.id);
  assert.equal(before.status, 'never');
  assert.equal(before.frequencyDays, 365);
  console.log('ok - FireTrack lists the annual discharge test');

  // ── A failed test completes nothing ─────────────────────────────────────────
  const failed = await staff.request('POST', '/fire-safety', { checkType: TYPE, checkDate: today, result: 'fail', siteId: siteA.id });
  assert.equal(failed.status, 201, JSON.stringify(failed.data));
  assert.equal((await getTask(taskA.id)).completedAt, null);
  console.log('ok - a failed discharge test leaves the ComplyTrack task open');

  // ── A pass completes the task at that site, which reopens for next year ─────
  const passed = await staff.request('POST', '/fire-safety', { checkType: TYPE, checkDate: today, result: 'pass', siteId: siteA.id });
  assert.equal(passed.status, 201, JSON.stringify(passed.data));
  const afterA = await getTask(taskA.id);
  assert.equal(afterA.completedAt.slice(0, 10), today);
  assert.equal(afterA.status, 'pending');
  assert.equal(afterA.dueDate.slice(0, 10), nextYear(today));
  assert.equal((await getTask(taskB.id)).completedAt, null, "another site's task is not completed");
  assert.equal((await getTask(unrelated.id)).completedAt, null, 'other tasks are not touched');
  assert.equal((await getTask(otherTask.id, other)).completedAt, null, "another business's task is not touched");
  assert.equal((await fireRecords(siteA.id)).length, 2, 'completing the task from FireTrack adds no second record');
  const { rows: [audit] } = await pool.query(
    `SELECT action, metadata FROM audit_events WHERE client_id = $1 AND entity_type = 'compliance_item' AND entity_id = $2
     ORDER BY id DESC LIMIT 1`, [owner.clientId, taskA.id]);
  assert.equal(audit.action, 'status_changed');
  assert.equal(audit.metadata.fromFireSafetyCheck, passed.data.id);
  console.log('ok - a passed discharge test completes the task, reopened for next year, with an audit entry');

  // ── An older record does not move the task back ─────────────────────────────
  const older = await staff.request('POST', '/fire-safety', { checkType: TYPE, checkDate: yesterday, result: 'pass', siteId: siteA.id });
  assert.equal(older.status, 201, JSON.stringify(older.data));
  assert.equal((await getTask(taskA.id)).completedAt.slice(0, 10), today);
  console.log('ok - an older record leaves a later completion in place');

  // ── Completing the task records the test in FireTrack ───────────────────────
  const completed = await staff.request('PATCH', `/compliance-items/${taskB.id}/status`, { status: 'completed', completedAt: lastMonth });
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  const recordsB = await fireRecords(siteB.id);
  assert.equal(recordsB.length, 1);
  assert.equal(recordsB[0].day, lastMonth);
  assert.equal(recordsB[0].result, 'pass');
  assert.match(recordsB[0].notes, /ComplyTrack task/);
  const statusB = await status(siteB.id);
  assert.equal(statusB.lastDate, lastMonth);
  assert.equal(statusB.status, 'ok');
  // The FireTrack record the task made does not complete the task again.
  assert.equal((await getTask(taskB.id)).completedAt.slice(0, 10), lastMonth);
  console.log('ok - completing the task records a pass in FireTrack at its site');

  const again = await owner.request('PUT', `/compliance-items/${taskB.id}`, { status: 'completed', completedAt: lastMonth });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal((await fireRecords(siteB.id)).length, 1, 'the same completion date is recorded once');
  const viaEdit = await owner.request('PUT', `/compliance-items/${taskB.id}`, { status: 'completed', completedAt: today });
  assert.equal(viaEdit.status, 200, JSON.stringify(viaEdit.data));
  assert.deepEqual((await fireRecords(siteB.id)).map(r => r.day), [lastMonth, today]);
  assert.equal((await getTask(unrelated.id)).completedAt, null);
  const notLinked = await owner.request('PATCH', `/compliance-items/${unrelated.id}/status`, { status: 'completed' });
  assert.equal(notLinked.status, 200);
  const { rows: [{ count }] } = await pool.query(
    `SELECT count(*)::int AS count FROM fire_safety_checks WHERE client_id = $1 AND check_type = $2`, [owner.clientId, TYPE]);
  assert.equal(count, 5, 'other tasks add no FireTrack records');
  console.log('ok - each completion is recorded once, from either completion route');

  // ── Completions from before the link still count in FireTrack ───────────────
  const taskC = await task(owner, siteC.id);
  await pool.query(`UPDATE compliance_items SET completed_at = $2::date WHERE id = $1`, [taskC.id, lastMonth]);
  const statusC = await status(siteC.id);
  assert.equal(statusC.lastDate, lastMonth);
  assert.equal(statusC.lastResult, 'pass');
  assert.equal(statusC.status, 'ok');
  assert.equal((await fireRecords(siteC.id)).length, 0);
  console.log('ok - an earlier task completion shows as the last discharge test');

  // ── The business-wide starter task ──────────────────────────────────────────
  // Signup seeds "Emergency Light Maintenance" with no site. With several
  // sites, one site's test must not complete it (that would make every site
  // look tested); a record with no site does.
  const { rows: [starter] } = await pool.query(
    `SELECT id, completed_at FROM compliance_items WHERE client_id = $1 AND site_id IS NULL AND title = 'Emergency Light Maintenance'`,
    [owner.clientId]);
  assert.ok(starter, 'signup seeds the business-wide task');
  assert.equal(starter.completed_at, null, "site A's test did not complete the business-wide task");
  const businessWide = await owner.request('POST', '/fire-safety', { checkType: TYPE, checkDate: today, result: 'pass', siteId: null });
  assert.equal(businessWide.status, 201, JSON.stringify(businessWide.data));
  assert.equal((await getTask(starter.id)).completedAt.slice(0, 10), today);
  const single = await createTenant('fire-discharge-single');
  const onlySite = (await single.request('POST', '/sites', { name: 'Only site', seedStarterChecks: false })).data;
  const { rows: [singleStarter] } = await pool.query(
    `SELECT id FROM compliance_items WHERE client_id = $1 AND site_id IS NULL AND title = 'Emergency Light Maintenance'`, [single.clientId]);
  assert.equal((await single.request('POST', '/fire-safety', { checkType: TYPE, checkDate: today, result: 'pass', siteId: onlySite.id })).status, 201);
  assert.equal((await getTask(singleStarter.id, single)).completedAt.slice(0, 10), today,
    "at a business with one site, that site's test completes the business-wide task");
  console.log('ok - the business-wide task is completed by a business-wide test, or by the only site');

  console.log('FireTrack discharge test and ComplyTrack task link tests passed.');
} finally {
  await pool.end();
}
