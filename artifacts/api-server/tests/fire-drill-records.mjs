import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// FireTrack drills: a new drill must give the time of the drill, the time
// taken to evacuate and the improvements required (notes); the staff present
// are ticked from the roster, and each roster member's latest drill shows who
// has not taken part in one in the last 12 months. Older drills saved before
// these fields stay editable blank. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/fire-drill-records.mjs

const today = isoDay();
// Records older than the day after need an Owner's reason to change.
const reason = { 'X-Override-Reason': encodeURIComponent('Adding details from the paper drill log') };

try {
  const owner = await createTenant('fire-drill-records');
  const other = await createTenant('fire-drill-records-other');
  const makeSite = async name => {
    const site = await owner.request('POST', '/sites', { name, seedStarterChecks: false });
    assert.equal(site.status, 201, JSON.stringify(site.data));
    return site.data.id;
  };
  const siteA = await makeSite('Drill site A');
  const siteB = await makeSite('Drill site B');
  const addStaff = async (session, name, siteId = null) => {
    const created = await session.request('POST', '/staff-roster', { name, siteId });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  };
  const ann = await addStaff(owner, 'Ann Able', siteA);
  const bob = await addStaff(owner, 'Bob Brown', siteA);
  const cat = await addStaff(owner, 'Cat Cole');
  const dan = await addStaff(owner, 'Dan Dale', siteB);
  const outsider = await addStaff(other, 'Not Ours');

  const drill = {
    checkType: 'fire_drill', checkDate: today, result: 'pass', siteId: siteA, nightStaff: 'included',
    drillTime: '14:30', evacuationSeconds: 155, notes: 'Fire door on the first floor slow to close',
  };

  // ── Each new field is required on a new drill ──────────────────────────
  for (const [field, error] of [
    ['drillTime', 'Give the time of the drill'],
    ['evacuationSeconds', 'Give the time taken to evacuate'],
    ['notes', 'Write the improvements required, or notes, for the drill'],
  ]) {
    const { [field]: _left, ...without } = drill;
    const refused = await owner.request('POST', '/fire-safety', without);
    assert.equal(refused.status, 400, `${field}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.data.error, error);
  }
  assert.equal((await owner.request('POST', '/fire-safety', { ...drill, notes: '   ' })).status, 400, 'blank notes are refused');
  for (const bad of [{ drillTime: '25:00' }, { drillTime: '2pm' }, { evacuationSeconds: 0 }, { evacuationSeconds: 90.5 }]) {
    assert.equal((await owner.request('POST', '/fire-safety', { ...drill, ...bad })).status, 400, JSON.stringify(bad));
  }
  console.log('ok - a new drill needs the time of the drill, the evacuation time and the improvements required');

  // ── Staff present are ticked from this business's roster ───────────────
  assert.equal((await owner.request('POST', '/fire-safety', { ...drill, staffPresentIds: [ann, outsider] })).status, 400,
    "another business's roster member is refused");
  const created = await owner.request('POST', '/fire-safety', { ...drill, staffPresentIds: [bob, ann, ann] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.drillTime, '14:30');
  assert.equal(created.data.evacuationSeconds, 155);
  assert.deepEqual(created.data.staffPresent, [{ staffRosterId: ann, name: 'Ann Able' }, { staffRosterId: bob, name: 'Bob Brown' }]);
  const listed = await owner.request('GET', '/fire-safety?checkType=fire_drill');
  assert.deepEqual(listed.data.find(row => row.id === created.data.id).staffPresent.map(p => p.name), ['Ann Able', 'Bob Brown']);
  console.log('ok - staff present are stored with their names and listed with the drill');

  // ── Edits replace the ticks; leaving them out keeps them ───────────────
  const timeOnly = await owner.request('PUT', `/fire-safety/${created.data.id}`, { drillTime: '15:05' });
  assert.equal(timeOnly.status, 200, JSON.stringify(timeOnly.data));
  assert.equal(timeOnly.data.staffPresent.length, 2, 'an edit without the list keeps who was present');
  const renamed = await owner.request('PATCH', `/staff-roster/${ann}`, { name: 'Ann Able-Smith' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  const reticked = await owner.request('PUT', `/fire-safety/${created.data.id}`, { staffPresentIds: [ann, cat] });
  assert.equal(reticked.status, 200, JSON.stringify(reticked.data));
  assert.deepEqual(reticked.data.staffPresent, [{ staffRosterId: ann, name: 'Ann Able' }, { staffRosterId: cat, name: 'Cat Cole' }],
    'a renamed person keeps the name recorded at the drill');
  for (const cleared of [{ drillTime: null }, { evacuationSeconds: null }, { notes: '' }]) {
    assert.equal((await owner.request('PUT', `/fire-safety/${created.data.id}`, cleared)).status, 400, JSON.stringify(cleared));
  }
  console.log('ok - edits change who was present; recorded answers cannot be removed');

  // ── Older drills stay editable blank ───────────────────────────────────
  const { rows: [legacy] } = await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, night_staff)
     VALUES ($1, $2, 'fire_drill', $3, 'pass', 'included') RETURNING id`, [owner.clientId, siteA, isoDay(-400)]);
  const legacyEdit = await owner.request('PUT', `/fire-safety/${legacy.id}`, { result: 'fail' }, 'json', reason);
  assert.equal(legacyEdit.status, 200, JSON.stringify(legacyEdit.data));
  assert.deepEqual([legacyEdit.data.drillTime, legacyEdit.data.evacuationSeconds, legacyEdit.data.notes], [null, null, null]);
  const legacyTicks = await owner.request('PUT', `/fire-safety/${legacy.id}`, { staffPresentIds: [dan] }, 'json', reason);
  assert.equal(legacyTicks.status, 200, JSON.stringify(legacyTicks.data));
  console.log('ok - drills saved before these fields can still be edited');

  // ── Who has not taken part in a drill in the last 12 months ────────────
  const attendance = await owner.request('GET', '/fire-safety/drill-attendance');
  assert.equal(attendance.status, 200, JSON.stringify(attendance.data));
  assert.equal(attendance.data.periodMonths, 12);
  const byName = new Map(attendance.data.staff.map(person => [person.name, person]));
  assert.deepEqual([...byName.keys()], ['Ann Able-Smith', 'Bob Brown', 'Cat Cole', 'Dan Dale']);
  assert.deepEqual([byName.get('Ann Able-Smith').lastDrillDate, byName.get('Ann Able-Smith').due], [today, false]);
  assert.deepEqual([byName.get('Bob Brown').lastDrillDate, byName.get('Bob Brown').due], [null, true], 'unticked from the only drill');
  assert.deepEqual([byName.get('Cat Cole').lastDrillDate, byName.get('Cat Cole').due], [today, false]);
  assert.deepEqual([byName.get('Dan Dale').lastDrillDate, byName.get('Dan Dale').due], [isoDay(-400), true],
    'a drill more than 12 months ago is due again');
  const atSiteB = await owner.request('GET', `/fire-safety/drill-attendance?siteId=${siteB}`);
  assert.deepEqual(atSiteB.data.staff.map(p => p.name), ['Cat Cole', 'Dan Dale'], 'a site shows its staff and staff with no site');
  assert.equal((await owner.request('GET', '/fire-safety/drill-attendance?siteId=abc')).status, 400);
  const viewer = await createUser(owner, { role: 'client_viewer' });
  assert.equal((await viewer.request('GET', '/fire-safety/drill-attendance')).status, 403);
  assert.deepEqual((await other.request('GET', '/fire-safety/drill-attendance')).data.staff.map(p => p.name), ['Not Ours']);
  console.log('ok - drill attendance shows who has not been in a drill in the last 12 months');

  // ── Department scoping ─────────────────────────────────────────────────
  const deptB = await owner.request('POST', '/departments', { name: 'Lodge team', siteId: siteB });
  assert.equal(deptB.status, 201, JSON.stringify(deptB.data));
  const staffB = await createUser(owner, { role: 'client_staff', departmentId: deptB.data.id });
  assert.deepEqual((await staffB.request('GET', '/fire-safety/drill-attendance')).data.staff.map(p => p.name), ['Cat Cole', 'Dan Dale']);
  const drillB = { ...drill, siteId: siteB };
  assert.equal((await staffB.request('POST', '/fire-safety', { ...drillB, staffPresentIds: [ann] })).status, 400,
    'staff at a site the department cannot see cannot be ticked');
  const byStaffB = await staffB.request('POST', '/fire-safety', { ...drillB, staffPresentIds: [dan, cat] });
  assert.equal(byStaffB.status, 201, JSON.stringify(byStaffB.data));
  console.log('ok - department staff tick only the staff they can see');

  // ── Deleting a drill removes its ticks; other checks have none ─────────
  assert.equal((await owner.request('DELETE', `/fire-safety/${created.data.id}`)).status, 204);
  const { rows: left } = await pool.query('SELECT 1 FROM fire_drill_attendance WHERE fire_check_id = $1', [created.data.id]);
  assert.equal(left.length, 0);
  const lights = await owner.request('POST', '/fire-safety', {
    checkType: 'emergency_lights', checkDate: today, result: 'pass', siteId: siteA, drillTime: '10:00', evacuationSeconds: 60, staffPresentIds: [ann],
  });
  assert.equal(lights.status, 201, JSON.stringify(lights.data));
  assert.deepEqual([lights.data.drillTime, lights.data.evacuationSeconds, lights.data.staffPresent], [null, null, []]);
  console.log('ok - other checks store no drill details');

  console.log('FireTrack drill record tests passed.');
} finally {
  await pool.end();
}
