import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// FireTrack: weekly alarm tests name the call point tested (from the site's
// list, or typed in when there is none), drills record whether night staff
// took part, and call points are archived rather than deleted so past tests
// keep what they said. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/fire-call-points.mjs

const today = isoDay();
const alarm = (siteId, extra = {}) => ({ checkType: 'alarm', checkDate: today, result: 'pass', siteId, ...extra });

try {
  const owner = await createTenant('fire-call-points');
  const staff = await createUser(owner, { role: 'client_staff' });
  const viewer = await createUser(owner, { role: 'client_viewer' });
  const other = await createTenant('fire-call-points-other');
  const siteA = (await owner.request('POST', '/sites', { name: 'Call point site A', seedStarterChecks: false })).data;
  const siteB = (await owner.request('POST', '/sites', { name: 'Call point site B', seedStarterChecks: false })).data;
  assert.ok(siteA?.id && siteB?.id);

  // ── Alarm tests must say which call point was tested ─────────────────────
  const missing = await owner.request('POST', '/fire-safety', alarm(siteA.id));
  assert.equal(missing.status, 400, JSON.stringify(missing.data));
  assert.equal(missing.data.error, 'Say which call point was tested');
  const blank = await owner.request('POST', '/fire-safety', alarm(siteA.id, { callPoint: '   ' }));
  assert.equal(blank.status, 400);
  const typed = await owner.request('POST', '/fire-safety', alarm(siteA.id, { callPoint: ' Kitchen exit ' }));
  assert.equal(typed.status, 201, JSON.stringify(typed.data));
  assert.equal(typed.data.callPoint, 'Kitchen exit');
  assert.equal(typed.data.callPointId, null);
  console.log('ok - an alarm test without a call point is refused; a typed one is stored');

  // ── Managers keep a per-site list ───────────────────────────────────────
  assert.deepEqual((await owner.request('GET', `/fire-safety/call-points?siteId=${siteA.id}`)).data, []);
  const cp1 = await owner.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'CP1 – Reception' });
  assert.equal(cp1.status, 201, JSON.stringify(cp1.data));
  const cp2 = await owner.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'CP2 – Kitchen' });
  assert.equal(cp2.status, 201);
  const cpB = await owner.request('POST', '/fire-safety/call-points', { siteId: siteB.id, name: 'CP1 – Reception' });
  assert.equal(cpB.status, 201, 'the same name at another site is a different call point');
  const duplicate = await owner.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'cp1 – reception' });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
  assert.equal((await owner.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: ' ' })).status, 400);
  assert.equal((await staff.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'Staff CP' })).status, 403);
  assert.equal((await viewer.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'Viewer CP' })).status, 403);
  assert.equal((await staff.request('PUT', `/fire-safety/call-points/${cp1.data.id}`, { name: 'Renamed' })).status, 403);
  assert.equal((await other.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'Foreign' })).status, 400,
    "another business cannot add to this site");
  console.log('ok - managers list call points per site; staff and viewers cannot change the list');

  // ── Staff pick from the list; the list shows when each was last tested ──
  const picked = await staff.request('POST', '/fire-safety', alarm(siteA.id, { callPointId: cp1.data.id, callPoint: 'ignored' }));
  assert.equal(picked.status, 201, JSON.stringify(picked.data));
  assert.equal(picked.data.callPointId, cp1.data.id);
  assert.equal(picked.data.callPoint, 'CP1 – Reception', 'the name comes from the list');
  const list = (await staff.request('GET', `/fire-safety/call-points?siteId=${siteA.id}`)).data;
  assert.deepEqual(list.map(p => [p.name, p.lastTestedDate]), [['CP1 – Reception', today], ['CP2 – Kitchen', null]]);
  const wrongSite = await owner.request('POST', '/fire-safety', alarm(siteB.id, { callPointId: cp1.data.id }));
  assert.equal(wrongSite.status, 400);
  assert.equal(wrongSite.data.error, 'That call point is at a different site');
  const foreign = await other.request('POST', '/fire-safety', alarm(null, { callPointId: cp1.data.id }));
  assert.equal(foreign.status, 400, "another business cannot use this business's call point");
  assert.equal((await other.request('GET', `/fire-safety/call-points?siteId=${siteA.id}`)).status, 400);
  assert.equal((await other.request('PUT', `/fire-safety/call-points/${cp1.data.id}`, { name: 'Mine' })).status, 404);
  console.log('ok - a call point from the list is copied onto the test and must belong to its site');

  // ── Renaming and archiving keep history ─────────────────────────────────
  const renamed = await owner.request('PUT', `/fire-safety/call-points/${cp1.data.id}`, { name: 'CP1 – Main entrance' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.lastTestedDate, today);
  const { rows: [kept] } = await pool.query('SELECT call_point FROM fire_safety_checks WHERE id = $1', [picked.data.id]);
  assert.equal(kept.call_point, 'CP1 – Reception', 'a rename does not rewrite past tests');
  const archived = await owner.request('PUT', `/fire-safety/call-points/${cp2.data.id}`, { archived: true });
  assert.equal(archived.status, 200);
  assert.ok(archived.data.archivedAt);
  assert.deepEqual((await owner.request('GET', `/fire-safety/call-points?siteId=${siteA.id}`)).data.map(p => p.id), [cp1.data.id]);
  assert.equal((await owner.request('GET', `/fire-safety/call-points?siteId=${siteA.id}&includeArchived=true`)).data.length, 2);
  const archivedUse = await owner.request('POST', '/fire-safety', alarm(siteA.id, { callPointId: cp2.data.id }));
  assert.equal(archivedUse.status, 400, 'an archived call point is not offered for new tests');
  assert.equal((await owner.request('PUT', `/fire-safety/call-points/${cp2.data.id}`, { archived: false })).status, 200);
  assert.equal((await owner.request('POST', '/fire-safety', alarm(siteA.id, { callPointId: cp2.data.id }))).status, 201);
  const { rows: auditRows } = await pool.query(
    `SELECT action FROM audit_events WHERE client_id = $1 AND entity_type = 'fire_call_point' ORDER BY id`, [owner.clientId]);
  assert.equal(auditRows.length, 6, 'every call point change is in the audit trail');
  console.log('ok - renames and archives keep past tests as recorded, and are audited');

  // ── Edits: a recorded call point can change but not be removed ──────────
  const cleared = await owner.request('PUT', `/fire-safety/${picked.data.id}`, { callPointId: null, callPoint: '' });
  assert.equal(cleared.status, 400, JSON.stringify(cleared.data));
  const notesOnly = await owner.request('PUT', `/fire-safety/${picked.data.id}`, { notes: 'Bell heard everywhere' });
  assert.equal(notesOnly.status, 200);
  assert.equal(notesOnly.data.callPoint, 'CP1 – Reception', 'an edit that does not touch the call point keeps it');
  const moved = await owner.request('PUT', `/fire-safety/${picked.data.id}`, { siteId: siteB.id });
  assert.equal(moved.status, 400, 'a test cannot move to a site that its call point is not at');
  const { rows: [legacy] } = await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, location)
     VALUES ($1, $2, 'alarm', $3, 'pass', 'Old free-text call point') RETURNING id`, [owner.clientId, siteA.id, today]);
  const legacyEdit = await owner.request('PUT', `/fire-safety/${legacy.id}`, { notes: 'Older record' });
  assert.equal(legacyEdit.status, 200, 'records saved before call points existed can still be edited');
  assert.equal(legacyEdit.data.callPoint, null);
  assert.equal(legacyEdit.data.location, 'Old free-text call point');
  console.log('ok - edits keep recorded call points; older records stay editable');

  // ── Drills record whether night staff took part ─────────────────────────
  const drill = { checkType: 'fire_drill', checkDate: today, result: 'pass', siteId: siteA.id };
  const noAnswer = await owner.request('POST', '/fire-safety', drill);
  assert.equal(noAnswer.status, 400);
  assert.equal(noAnswer.data.error, 'Say whether night staff took part in the drill');
  assert.equal((await owner.request('POST', '/fire-safety', { ...drill, nightStaff: 'maybe' })).status, 400);
  const withNight = await staff.request('POST', '/fire-safety', { ...drill, nightStaff: 'not_included' });
  assert.equal(withNight.status, 201, JSON.stringify(withNight.data));
  assert.equal(withNight.data.nightStaff, 'not_included');
  const changed = await staff.request('PUT', `/fire-safety/${withNight.data.id}`, { nightStaff: 'included' });
  assert.equal(changed.data.nightStaff, 'included');
  assert.equal((await staff.request('PUT', `/fire-safety/${withNight.data.id}`, { nightStaff: null })).status, 400);
  console.log('ok - drills must say whether night staff took part');

  // ── Other check types store neither field ───────────────────────────────
  const lights = await owner.request('POST', '/fire-safety', {
    checkType: 'emergency_lights', checkDate: today, result: 'pass', siteId: siteA.id, callPoint: 'CP9', nightStaff: 'included',
  });
  assert.equal(lights.status, 201);
  assert.equal(lights.data.callPoint, null);
  assert.equal(lights.data.nightStaff, null);
  console.log('ok - other checks ignore call point and night staff');

  // ── A business without sites keeps one list ─────────────────────────────
  const noSites = await createTenant('fire-call-points-no-sites');
  assert.deepEqual((await noSites.request('GET', '/fire-safety/call-points?siteId=none')).data, []);
  const general = await noSites.request('POST', '/fire-safety/call-points', { siteId: null, name: 'Front door' });
  assert.equal(general.status, 201, JSON.stringify(general.data));
  assert.deepEqual((await noSites.request('GET', '/fire-safety/call-points?siteId=none')).data.map(p => p.name), ['Front door']);
  const generalTest = await noSites.request('POST', '/fire-safety', alarm(null, { callPointId: general.data.id }));
  assert.equal(generalTest.status, 201, JSON.stringify(generalTest.data));
  assert.equal(generalTest.data.callPoint, 'Front door');
  assert.equal((await noSites.request('GET', '/fire-safety/call-points?siteId=abc')).status, 400);
  console.log('ok - a business without sites lists call points without a site');

  console.log('FireTrack call point tests passed.');
} finally {
  await pool.end();
}
