import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Contractor jobs kept in two places stay in step: cleaning the cold water
// tanks (Water Safety) completes its ComplyTrack task when passed, and
// completing the task records it in the track. FireTrack's contractor services
// were linked this way until Oct 2026 and no longer are. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/track-task-links.mjs

const today = isoDay();
const lastMonth = isoDay(-30);
const LEGIONELLA_FREQUENCIES = {
  calorifier_temp: 7, hot_sentinel_temp: 30, hot_nonsent_temp: 90, cold_tank_temp: 30, cold_sentinel_temp: 30,
  cold_nonsent_temp: 90, cold_tank_inspection: 183, cold_tank_clean: 365, calorifier_inspection: 365,
  calorifier_clean: 365, shower_clean: 90, tmv_service: 365, outlet_flush: 7,
};

try {
  const owner = await createTenant('track-task-links');
  const staff = await createUser(owner, { role: 'client_staff' });
  const siteA = (await owner.request('POST', '/sites', { name: 'Links site A', seedStarterChecks: false })).data;
  const siteB = (await owner.request('POST', '/sites', { name: 'Links site B', seedStarterChecks: false })).data;
  const task = async (who, siteId, title, frequencyMonths) => {
    const created = await who.request('POST', '/compliance-items', {
      title, priority: 'high', siteId, frequencyMonths, dueDate: `${today}T00:00:00.000Z`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data;
  };
  const getTask = async (id, who = owner) => (await who.request('GET', `/compliance-items/${id}`)).data;
  const records = async (table, clientId, checkType, siteId) => (await pool.query(
    `SELECT id, check_date::text AS day, result, notes FROM ${table}
     WHERE client_id = $1 AND check_type = $2 AND site_id IS NOT DISTINCT FROM $3 ORDER BY id`,
    [clientId, checkType, siteId])).rows;
  // ── FireTrack's contractor services are no longer linked ─────────────────
  // They are kept only as their compliance checks, which FireTrack shows
  // (tests/fire-retired-checks.mjs): completing one records nothing in FireTrack.
  const alarmA = await task(owner, siteA.id, 'Fire Alarm Maintenance', 6);
  const doneAlarm = await staff.request('PATCH', `/compliance-items/${alarmA.id}/status`, { status: 'completed', completedAt: lastMonth });
  assert.equal(doneAlarm.status, 200, JSON.stringify(doneAlarm.data));
  assert.equal((await records('fire_safety_checks', owner.clientId, 'alarm_service', siteA.id)).length, 0);
  console.log('ok - completing "Fire Alarm Maintenance" adds no FireTrack record');

  // ── Water tanks ↔ "Clean & Disinfect Water Tanks" ──────────────────────────
  const plan = await owner.request('PUT', `/legionella/monitoring-plan?siteId=${siteA.id}`, {
    action: 'approve', riskAssessmentReference: 'LRA-1', writtenSchemeReference: 'WS-1', competentPerson: 'Water Co',
    frequencies: LEGIONELLA_FREQUENCIES,
  });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const tankAlert = async () => (await owner.request('GET', '/check-reminders')).data
    .find(alert => alert.module === 'legionella' && alert.siteId === siteA.id && alert.checkType === 'cold_tank_clean');
  assert.equal((await tankAlert())?.status, 'never');
  const tanksA = await task(owner, siteA.id, 'Clean & Disinfect Water Tanks', 12);
  const tanksB = await task(owner, siteB.id, 'Clean & Disinfect Water Tanks', 12);
  const doneTanks = await staff.request('PATCH', `/compliance-items/${tanksA.id}/status`, { status: 'completed', completedAt: lastMonth });
  assert.equal(doneTanks.status, 200, JSON.stringify(doneTanks.data));
  const tankRecords = await records('legionella_checks', owner.clientId, 'cold_tank_clean', siteA.id);
  assert.deepEqual(tankRecords.map(r => [r.day, r.result]), [[lastMonth, 'pass']]);
  assert.match(tankRecords[0].notes, /Clean & Disinfect Water Tanks/);
  assert.equal((await tankAlert()), undefined, 'the tank clean is no longer flagged');
  console.log('ok - completing "Clean & Disinfect Water Tanks" records the clean in Water Safety');

  const tankClean = await staff.request('POST', '/legionella', { checkType: 'cold_tank_clean', checkDate: today, result: 'pass', siteId: siteB.id });
  assert.equal(tankClean.status, 201, JSON.stringify(tankClean.data));
  assert.equal((await getTask(tanksB.id)).completedAt.slice(0, 10), today);
  assert.equal((await getTask(tanksA.id)).completedAt.slice(0, 10), lastMonth, "another site's task is untouched");
  assert.equal((await records('legionella_checks', owner.clientId, 'cold_tank_clean', siteB.id)).length, 1,
    'completing the task from Water Safety adds no second record');
  const { rows: [audit] } = await pool.query(
    `SELECT metadata FROM audit_events WHERE client_id = $1 AND entity_type = 'compliance_item' AND entity_id = $2
     ORDER BY id DESC LIMIT 1`, [owner.clientId, tanksB.id]);
  assert.equal(audit.metadata.fromLegionellaCheck, tankClean.data.id);
  const inspection = await staff.request('POST', '/legionella', { checkType: 'cold_tank_inspection', checkDate: today, result: 'pass', siteId: siteA.id });
  assert.equal(inspection.status, 201);
  assert.equal((await getTask(tanksA.id)).completedAt.slice(0, 10), lastMonth, 'other water checks do not complete the task');
  console.log('ok - a passed tank clean completes "Clean & Disinfect Water Tanks" at that site, with an audit entry');

  // Earlier completions count in the Water Safety status too.
  const tanksStatus = async (siteId) => (await owner.request('GET', `/legionella/status?siteId=${siteId}`)).data
    .find(row => row.checkType === 'cold_tank_clean');
  await pool.query(`DELETE FROM legionella_checks WHERE client_id = $1 AND site_id = $2`, [owner.clientId, siteA.id]);
  assert.equal((await tanksStatus(siteA.id)).lastDate, lastMonth);
  assert.equal((await tanksStatus(siteA.id)).status, 'ok');
  assert.equal((await tankAlert()), undefined, 'the safety-check reminders count it too');
  console.log('ok - an earlier task completion shows as the last tank clean');

  // ── Business-wide water task ───────────────────────────────────────────────
  // The water log is kept per site: a business-wide task is recorded only at
  // a business with one site, and with several sites it records nothing.
  const wide = await task(owner, null, 'Clean & Disinfect Water Tanks', 12);
  assert.equal((await owner.request('PATCH', `/compliance-items/${wide.id}/status`, { status: 'completed' })).status, 200);
  const { rows: [{ count: nullSite }] } = await pool.query(
    `SELECT count(*)::int AS count FROM legionella_checks WHERE client_id = $1 AND site_id IS NULL`, [owner.clientId]);
  assert.equal(nullSite, 0);
  const single = await createTenant('track-task-links-single');
  const onlySite = (await single.request('POST', '/sites', { name: 'Only site', seedStarterChecks: false })).data;
  const singleWide = await task(single, null, 'Clean & Disinfect Water Tanks', 12);
  assert.equal((await single.request('PATCH', `/compliance-items/${singleWide.id}/status`, { status: 'completed', completedAt: lastMonth })).status, 200);
  assert.deepEqual((await records('legionella_checks', single.clientId, 'cold_tank_clean', onlySite.id)).map(r => r.day), [lastMonth]);
  const singleTask = await task(single, null, 'Clean & Disinfect Water Tanks', 12);
  assert.equal((await single.request('POST', '/legionella', { checkType: 'cold_tank_clean', checkDate: today, result: 'pass', siteId: onlySite.id })).status, 201);
  assert.equal((await getTask(singleTask.id, single)).completedAt.slice(0, 10), today);
  console.log('ok - a business-wide water task is kept in step only at a business with one site');

  console.log('Track and ComplyTrack task link tests passed.');
} finally {
  await pool.end();
}
