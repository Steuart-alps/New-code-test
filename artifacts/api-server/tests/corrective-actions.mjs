import assert from 'node:assert/strict';
import { base, createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// A fail on any track must say what was done about it. A recorded check saved
// from the web app with something failed is answered 428
// CORRECTIVE_ACTION_REQUIRED listing each fail; the same save sent again with
// an answer for each (X-Corrective-Actions) is then signed and saved, and each
// answer goes on the action the fail opened on its track. A pass is not asked,
// a form that already says what was done is not asked again, and the phone
// app (bearer) is not asked yet.
// Usage: pnpm --filter @workspace/api-server run test:corrective-actions

const today = isoDay();
const SIGNATURE = [[10, 50, 60, 80, 120, 40, 180, 90], [200, 60, 260, 120]];
const answersHeader = answers => ({ 'x-corrective-actions': encodeURIComponent(JSON.stringify(answers)) });

/** Saves as the web app does: corrective actions first, then a signature. */
async function save(session, method, path, body, answers) {
  const headers = answers ? answersHeader(answers) : {};
  const first = await session.request(method, path, body, 'json', headers);
  if (first.status !== 428 || first.data.code !== 'SIGNATURE_REQUIRED') return first;
  const signature = await session.request('POST', '/record-signatures', { strokes: SIGNATURE });
  assert.equal(signature.status, 201, JSON.stringify(signature.data));
  return session.request(method, path, body, 'json', { ...headers, 'x-record-signature': signature.data.token });
}

async function actionFor(clientId, sourceKind, recordId) {
  return (await pool.query(
    `SELECT module, title, instruction, remedial_action, status, site_id FROM track_actions
     WHERE client_id = $1 AND source_kind = $2 AND source_record_id = $3`, [clientId, sourceKind, recordId])).rows[0];
}

try {
  const owner = await createTenant('corrective-actions');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = (await owner.request('POST', '/sites', { name: 'Corrective site', seedStarterChecks: false })).data;
  const me = (await owner.request('GET', '/auth/me')).data;
  const ownerName = (me.user ?? me).name;

  // ── A fail is refused until it says what was done ───────────────────────
  const failed = { checkType: 'fire_doors', checkDate: today, result: 'fail', siteId: site.id, notes: 'Door 3 wedged open' };
  const asked = await owner.request('POST', '/fire-safety', failed);
  assert.equal(asked.status, 428, JSON.stringify(asked.data));
  assert.equal(asked.data.code, 'CORRECTIVE_ACTION_REQUIRED');
  assert.equal(asked.data.failures.length, 1);
  assert.equal(asked.data.failures[0].key, 'check');
  assert.match(asked.data.failures[0].label, /failed$/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fire_safety_checks WHERE client_id = $1', [owner.clientId])).rows[0].n, 0,
    'nothing is saved without a corrective action');
  console.log('ok - a failed check is refused with 428 CORRECTIVE_ACTION_REQUIRED, listing what failed, and nothing is saved');

  for (const answers of [{}, { check: '' }, { check: 'ok' }, { other: 'Wedge removed' }, { check: 'x'.repeat(1001) }]) {
    const refused = await owner.request('POST', '/fire-safety', failed, 'json', answersHeader(answers));
    assert.equal(refused.status, 428, JSON.stringify(answers));
    assert.equal(refused.data.code, 'CORRECTIVE_ACTION_REQUIRED');
  }
  const garbled = await owner.request('POST', '/fire-safety', failed, 'json', { 'x-corrective-actions': '%E0%A4%A' });
  assert.equal(garbled.data.code, 'CORRECTIVE_ACTION_REQUIRED');
  console.log('ok - a blank, too short, too long, wrong or garbled answer is asked again');

  // ── A pass goes straight to the signature ───────────────────────────────
  const passed = await owner.request('POST', '/fire-safety', { ...failed, result: 'pass' });
  assert.equal(passed.status, 428);
  assert.equal(passed.data.code, 'SIGNATURE_REQUIRED', 'a pass is not asked for a corrective action');
  console.log('ok - a pass is not asked for a corrective action');

  // ── The answer goes on the action the fail opened ───────────────────────
  const saved = await save(owner, 'POST', '/fire-safety', failed, { check: 'Wedge removed, door closes on its own; staff reminded' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const fireAction = await actionFor(owner.clientId, 'fire_safety_checks', saved.data.id);
  assert.ok(fireAction, 'the fail opened an action on FireTrack');
  assert.equal(fireAction.module, 'fire');
  assert.equal(fireAction.status, 'open', 'the action stays open to be followed up and signed off');
  assert.equal(fireAction.remedial_action, 'Wedge removed, door closes on its own; staff reminded');
  assert.match(fireAction.instruction, new RegExp(`Corrective action recorded by ${ownerName} when the check was saved`));
  assert.equal((await pool.query('SELECT result FROM fire_safety_checks WHERE id = $1', [saved.data.id])).rows[0].result, 'fail',
    'the failed observation is kept as it was');
  const audit = (await pool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE client_id = $1 AND action = 'corrective_action_recorded'`, [owner.clientId])).rows[0].n;
  assert.equal(audit, 1);
  console.log('ok - the corrective action is kept on the open FireTrack action, the fail is unchanged and the change is audited');

  // ── Each failed checklist item gets its own answer ──────────────────────
  const items = [
    { label: 'Fire exits clear', checked: false, result: 'fail', notes: 'Boxes in corridor' },
    { label: 'Lights working', checked: true, result: 'pass' },
    { label: 'First aid kit stocked', checked: false, result: 'fail', notes: 'No plasters' },
  ];
  const checklist = { checklistType: 'premises_opening', checkDate: today, siteId: site.id, items, submittedAt: new Date().toISOString() };
  const checklistAsked = await staff.request('POST', '/daily-track-am', checklist);
  assert.equal(checklistAsked.status, 428, JSON.stringify(checklistAsked.data));
  assert.deepEqual(checklistAsked.data.failures, [
    { key: 'item:0', label: 'Fire exits clear' }, { key: 'item:2', label: 'First aid kit stocked' },
  ]);
  const halfAnswered = await staff.request('POST', '/daily-track-am', checklist, 'json', answersHeader({ 'item:0': 'Boxes moved to store' }));
  assert.deepEqual(halfAnswered.data.failures, [{ key: 'item:2', label: 'First aid kit stocked' }], 'only the unanswered fail is asked again');
  const checklistSaved = await save(staff, 'POST', '/daily-track-am', checklist, { 'item:0': 'Boxes moved to store', 'item:2': 'Plasters ordered' });
  assert.equal(checklistSaved.status, 201, JSON.stringify(checklistSaved.data));
  assert.equal((await actionFor(owner.clientId, 'daily_checklist_item:0', checklistSaved.data.id)).remedial_action, 'Boxes moved to store');
  assert.equal((await actionFor(owner.clientId, 'daily_checklist_item:2', checklistSaved.data.id)).remedial_action, 'Plasters ordered');
  console.log('ok - each failed checklist item is asked about and its answer goes on its own action');

  // ── A draft is asked when it is submitted ───────────────────────────────
  const otherSite = (await owner.request('POST', '/sites', { name: 'Second site', seedStarterChecks: false })).data;
  const draft = await staff.request('POST', '/daily-track-am', { ...checklist, siteId: otherSite.id, submittedAt: undefined });
  assert.equal(draft.status, 201, `a draft with a fail saves without being asked: ${JSON.stringify(draft.data)}`);
  const submit = { submittedAt: new Date().toISOString() };
  const submitAsked = await staff.request('PUT', `/daily-track-am/${draft.data.id}`, submit);
  assert.equal(submitAsked.data.code, 'CORRECTIVE_ACTION_REQUIRED', 'the stored fails are asked about on submit');
  assert.equal(submitAsked.data.failures.length, 2);
  const submitted = await save(staff, 'PUT', `/daily-track-am/${draft.data.id}`, submit, { 'item:0': 'Cleared', 'item:2': 'Restocked' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal((await actionFor(owner.clientId, 'daily_checklist_item:2', draft.data.id)).remedial_action, 'Restocked');
  console.log('ok - a draft checklist with fails is asked when it is submitted');

  // ── A track with no automatic action gets one opened ────────────────────
  const room = await owner.request('POST', '/room-track/rooms', { roomNumber: '101', siteId: site.id });
  assert.equal(room.status, 201, JSON.stringify(room.data));
  const roomCheck = { roomId: room.data.id, siteId: site.id, checkDate: today, clean: true, tidy: false, toStandard: false };
  const roomAsked = await staff.request('POST', '/room-track/checks', roomCheck);
  assert.deepEqual(roomAsked.data.failures.map(f => f.key), ['tidy', 'toStandard']);
  const roomSaved = await save(staff, 'POST', '/room-track/checks', roomCheck, { tidy: 'Tidied by housekeeping', toStandard: 'Re-made the bed' });
  assert.equal(roomSaved.status, 201, JSON.stringify(roomSaved.data));
  const roomAction = await actionFor(owner.clientId, 'room_track_checks', roomSaved.data.id);
  assert.equal(roomAction.module, 'room');
  assert.equal(roomAction.site_id, site.id);
  assert.equal(roomAction.status, 'open');
  assert.equal(roomAction.remedial_action, 'Room tidy: Tidied by housekeeping\nRoom to standard: Re-made the bed');
  console.log('ok - a RoomTrack fail opens an action of its own carrying each answer');

  // ── A fail the server finds is asked about too ──────────────────────────
  const hot = { checkType: 'hot_sentinel_temp', checkDate: today, result: 'pass', temperature: 41, siteId: site.id, location: 'Kitchen sink' };
  const hotAsked = await owner.request('POST', '/legionella', hot);
  assert.equal(hotAsked.data.code, 'CORRECTIVE_ACTION_REQUIRED', 'a reading outside the limit is a fail');
  assert.match(hotAsked.data.failures[0].label, /41°C \(should be at least 50°C\)/);
  const hotSaved = await save(owner, 'POST', '/legionella', hot, { check: 'Flushed for 5 minutes, retested at 52°C' });
  assert.equal(hotSaved.status, 201, JSON.stringify(hotSaved.data));
  assert.equal((await actionFor(owner.clientId, 'legionella_checks', hotSaved.data.id)).remedial_action, 'Flushed for 5 minutes, retested at 52°C');
  console.log('ok - a LegionellaTrack reading outside its limit is asked about although it was marked pass');

  // ── A form that already says what was done is not asked again ───────────
  const pool_ = { checkDate: today, siteId: site.id, result: 'fail', phLevel: 8.4, actionsTaken: 'Dosed acid and closed pool for 1 hour' };
  const poolSaved = await save(owner, 'POST', '/pool-track', pool_);
  assert.equal(poolSaved.status, 201, JSON.stringify(poolSaved.data));
  assert.equal((await actionFor(owner.clientId, 'pool_checks', poolSaved.data.id)).remedial_action, 'Dosed acid and closed pool for 1 hour');
  console.log("ok - a PoolTrack fail with its 'Actions taken' filled in is not asked again, and that answer is kept on the action");

  // ── The phone app (bearer) is not asked yet ─────────────────────────────
  const staffEmail = (await pool.query('SELECT email FROM users WHERE id = $1', [staff.userId])).rows[0].email;
  const mobile = await fetch(`${base}/auth/mobile-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: staffEmail, password: 'private-approval-fixture-123' }),
  }).then(r => r.json());
  assert.equal(typeof mobile.token, 'string', JSON.stringify(mobile));
  const phoneSave = await fetch(`${base}/fire-safety`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mobile.token}` },
    body: JSON.stringify(failed),
  });
  assert.equal(phoneSave.status, 201, await phoneSave.text());
  console.log('ok - phone-app saves are not asked yet');
} finally {
  await pool.end();
}
