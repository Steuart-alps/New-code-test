import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// FireTrack no longer records its own alarm panel check (the panel is on the
// premises opening and closing checks) or its contractor services (the fire
// alarm and extinguisher services and the annual 3-hour emergency lighting
// test), which are their compliance checks, shown on FireTrack. Older records
// stay and can still be edited. A compliance check can be done in house by a
// competent person, and no contractor certificate is then due. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/fire-retired-checks.mjs

const RETIRED = ['alarm_panel', 'alarm_service', 'extinguisher_service', 'emergency_lights_annual'];
const today = isoDay();
const lastMonth = isoDay(-30);

try {
  const owner = await createTenant('fire-retired');
  const staff = await createUser(owner, { role: 'client_staff' });
  // Sleeping accommodation, so the escape route sign-off (fire_walk) applies.
  const site = (await owner.request('POST', '/sites', { name: 'Retired checks site', seedStarterChecks: false, sleepingAccommodation: true })).data;

  // ── Not in the FireTrack status, so never due or overdue ───────────────────
  const status = (await owner.request('GET', `/fire-safety/status?siteId=${site.id}`)).data;
  assert.deepEqual(status.filter(row => RETIRED.includes(row.checkType)), []);
  for (const kept of ['alarm', 'emergency_lights', 'extinguishers', 'fire_doors', 'fire_drill', 'fire_walk']) {
    assert.ok(status.some(row => row.checkType === kept), `${kept} is still kept`);
  }
  const alerts = (await owner.request('GET', '/check-reminders')).data;
  assert.deepEqual(alerts.filter(alert => alert.module === 'fire' && RETIRED.includes(alert.checkType)), []);
  console.log('ok - the alarm panel check and the contractor services are not in the FireTrack status or reminders');

  // ── No new records ──────────────────────────────────────────────────────────
  for (const checkType of RETIRED) {
    const refused = await staff.request('POST', '/fire-safety', { checkType, checkDate: today, result: 'pass', siteId: site.id });
    assert.equal(refused.status, 400, `${checkType}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.data.code, 'FIRE_CHECK_TYPE_RETIRED');
  }
  console.log('ok - FireTrack refuses new records of the retired checks, saying where they are kept now');

  // ── Older records stay, editable, and make nothing due ─────────────────────
  // (Dated today so the edit is inside the daily-record lock window.)
  const { rows: [older] } = await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, notes)
     VALUES ($1, $2, 'alarm_panel', $3, 'pass', 'Panel normal') RETURNING id`, [owner.clientId, site.id, today]);
  const listed = (await owner.request('GET', `/fire-safety?checkType=alarm_panel&siteId=${site.id}`)).data;
  assert.deepEqual(listed.map(row => row.id), [older.id]);
  const edited = await owner.request('PUT', `/fire-safety/${older.id}`, { notes: 'Panel normal, zone 2 checked' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.notes, 'Panel normal, zone 2 checked');
  const after = (await owner.request('GET', `/fire-safety/status?siteId=${site.id}`)).data;
  assert.equal(after.some(row => row.checkType === 'alarm_panel'), false);
  console.log('ok - an older alarm panel record stays in the history and can be edited');

  // ── Completing a contractor service records nothing in FireTrack ───────────
  const check = async (title, extra = {}) => {
    const created = await owner.request('POST', '/compliance-items', {
      title, priority: 'high', siteId: site.id, frequencyMonths: 12, dueDate: `${today}T00:00:00.000Z`, ...extra,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data;
  };
  const lights = await check('Emergency Light Maintenance');
  const done = await staff.request('PATCH', `/compliance-items/${lights.id}/status`, { status: 'completed', completedAt: lastMonth });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const { rows: [{ count }] } = await pool.query(
    `SELECT count(*)::int AS count FROM fire_safety_checks WHERE client_id = $1 AND check_type <> 'alarm_panel'`, [owner.clientId]);
  assert.equal(count, 0);
  const visits = (await owner.request('GET', '/contractor-visits')).data;
  for (const key of ['fire:alarm_service', 'fire:extinguisher_service', 'fire:emergency_lights_annual']) {
    assert.equal(visits.types.find(type => type.key === key)?.dueFrom, 'check', `${key} keeps its own due date`);
  }
  console.log('ok - the compliance check is the one record of each contractor service, with its own due date');

  // ── Done in house by a competent person ────────────────────────────────────
  const contractor = (await owner.request('POST', '/contractors', { name: 'Bright Sparks', email: 'lights@contractor.test' })).data;
  const withContractor = await check('Emergency Light Maintenance', { contractorId: contractor.id });
  const outstanding = async () => (await owner.request('GET', '/certificates-outstanding')).data.certificates
    .some(row => row.itemId === withContractor.id);
  const inHouse = await staff.request('PATCH', `/compliance-items/${withContractor.id}/status`,
    { status: 'completed', completedAt: lastMonth, completedInHouseBy: '  Sam Patel  ' });
  assert.equal(inHouse.status, 200, JSON.stringify(inHouse.data));
  assert.equal(inHouse.data.completedInHouseBy, 'Sam Patel');
  assert.equal(inHouse.data.needsAction, false, 'no contractor certificate is due');
  assert.equal(await outstanding(), false, 'nor chased');
  assert.equal((await owner.request('GET', `/compliance-items/${withContractor.id}`)).data.completedInHouseBy, 'Sam Patel');
  const { rows: [audit] } = await pool.query(
    `SELECT after FROM audit_events WHERE client_id = $1 AND entity_type = 'compliance_item' AND entity_id = $2
     ORDER BY id DESC LIMIT 1`, [owner.clientId, withContractor.id]);
  assert.equal(audit.after.completedInHouseBy, 'Sam Patel', 'the audit trail names the competent person');
  console.log('ok - a check done in house names the competent person and needs no contractor certificate');

  const byContractor = await staff.request('PATCH', `/compliance-items/${withContractor.id}/status`, { status: 'completed', completedAt: today });
  assert.equal(byContractor.status, 200, JSON.stringify(byContractor.data));
  assert.equal(byContractor.data.completedInHouseBy, null);
  assert.equal(byContractor.data.needsAction, true);
  assert.equal(byContractor.data.needsActionReason, 'certificate_outstanding');
  console.log('ok - the next completion, by the contractor, needs its certificate again');

  for (const [body, why] of [
    [{ status: 'completed', completedInHouseBy: '   ' }, 'a blank name'],
    [{ status: 'pending', completedInHouseBy: 'Sam Patel' }, 'a name without completing'],
  ]) {
    const refused = await staff.request('PATCH', `/compliance-items/${withContractor.id}/status`, body);
    assert.equal(refused.status, 400, `${why}: ${JSON.stringify(refused.data)}`);
  }
  console.log('ok - the competent person is named, and only when completing');

  // ── Saved premises opening and closing lists got the panel item once ───────
  const { rows: [marker] } = await pool.query(
    `SELECT name FROM runtime_migration_progress WHERE name = 'premises_checks_fire_alarm_panel_v1'`);
  assert.ok(marker, 'the one-off addition to saved lists has run');
  console.log('ok - the alarm panel item was added to saved premises lists once');

  console.log('FireTrack retired checks and in-house completion tests passed.');
} finally {
  await pool.end();
}
