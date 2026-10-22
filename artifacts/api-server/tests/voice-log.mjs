// "Say it" voice logging, end to end through the API: a spoken fridge or
// freezer reading fills that unit's AM/PM reading in the day's diary (never
// overwriting one), failures still need the action taken and raise their
// follow-up, spoken core temperatures append with the words heard, and both
// leave an audit entry saying who logged it by voice.
// Run: pnpm --filter @workspace/api-server run test:voice-log
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('voice-log');
  const other = await createTenant('voice-log-other');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = (await owner.request('POST', '/sites', { name: 'Voice kitchen', seedStarterChecks: false })).data;
  assert.equal((await owner.request('PUT', `/food-safety/config?siteId=${site.id}`, {
    food_cold_units: JSON.stringify([{ name: 'Fridge 1', type: 'fridge' }, { name: 'Fridge 2', type: 'fridge' }, { name: 'Freezer 1', type: 'freezer' }]),
  })).status, 200);

  const date = isoDay();
  const reading = (who, body, siteId = site.id) => who.request('POST', `/food-safety/cold-reading?siteId=${siteId}`, { recordDate: date, ...body });
  const diary = async () => (await owner.request('GET', `/food-safety?siteId=${site.id}&date=${date}`)).data;
  const actions = async () => (await owner.request('GET', `/track-actions?module=kitchen&siteId=${site.id}`)).data;

  // A first spoken reading starts the day's diary with every unit on the list.
  const first = await reading(staff, { unit: 'fridge 1', slot: 'am', temperature: 4, spoken: 'fridge one is showing four degrees' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  let record = await diary();
  assert.deepEqual(record.coldFood.map((row) => row.unit), ['Fridge 1', 'Fridge 2', 'Freezer 1'], 'the other units are there to fill in');
  const fridge1 = record.coldFood[0];
  assert.equal(fridge1.tempAm, '4');
  assert.equal(fridge1.tempPm, '');
  assert.equal(fridge1._spokenAm, 'fridge one is showing four degrees', 'the words heard are kept with the reading');
  assert.equal(fridge1._spokenByAm, 'Approval fixture user');

  // Never overwrites a reading already recorded.
  const again = await reading(owner, { unit: 'Fridge 1', slot: 'am', temperature: 9 });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'READING_ALREADY_RECORDED');
  assert.match(again.data.error, /Fridge 1 already has an AM reading of 4°C/);
  assert.equal((await diary()).coldFood[0].tempAm, '4');

  // A failed reading needs the action taken, then raises one follow-up.
  const failed = await reading(staff, { unit: 'Freezer 1', slot: 'pm', temperature: -10, spoken: 'freezer one minus ten' });
  assert.equal(failed.status, 400);
  assert.equal(failed.data.code, 'KITCHEN_CORRECTIVE_ACTION_REQUIRED');
  assert.equal((await diary()).coldFood[2].tempPm, '', 'nothing is saved without the action');
  assert.equal((await actions()).length, 0);
  const actioned = await reading(staff, {
    unit: 'Freezer 1', slot: 'pm', temperature: -10, spoken: 'freezer one minus ten', correctiveAction: 'Moved stock to freezer 2, engineer called',
  });
  assert.equal(actioned.status, 201, JSON.stringify(actioned.data));
  const open = await actions();
  assert.equal(open.length, 1);
  assert.match(open[0].title, /Failed temperature: Freezer 1/);
  assert.equal(open[0].remedialAction, 'Moved stock to freezer 2, engineer called');
  assert.equal((await diary()).coldFood[2].correctiveAction, 'Moved stock to freezer 2, engineer called');

  // Only units on the list; checks the request itself.
  const unknown = await reading(staff, { unit: 'Fridge 9', slot: 'am', temperature: 3 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.code, 'UNKNOWN_COLD_UNIT');
  assert.equal((await reading(staff, { unit: 'Fridge 2', slot: 'noon', temperature: 3 })).status, 400);
  assert.equal((await reading(staff, { unit: 'Fridge 2', slot: 'am', temperature: '3' })).status, 400, 'temperature is a number');
  assert.equal((await reading(staff, { unit: 'Fridge 2', slot: 'am', temperature: 3, recordedAt: `${isoDay(-3)}T08:00:00+01:00` })).status, 400,
    'the reading time must be on the diary day');

  // Other businesses and viewers cannot write.
  assert.equal((await reading(other, { unit: 'Fridge 2', slot: 'am', temperature: 3 })).status, 400, "another business's site");
  const viewer = await createUser(owner, { role: 'client_viewer' });
  assert.equal((await reading(viewer, { unit: 'Fridge 2', slot: 'am', temperature: 3 })).status, 403);

  // A submitted diary is not changed.
  await pool.query('UPDATE food_safety_records SET submitted_at = now() WHERE id = $1', [record.id]);
  const late = await reading(staff, { unit: 'Fridge 2', slot: 'am', temperature: 3 });
  assert.equal(late.status, 409);
  assert.equal(late.data.code, 'DIARY_SUBMITTED');
  await pool.query('UPDATE food_safety_records SET submitted_at = NULL WHERE id = $1', [record.id]);

  // PM after AM on the same unit, and a unit without a row yet is added.
  assert.equal((await reading(staff, { unit: 'Fridge 1', slot: 'pm', temperature: 5 })).status, 201);
  await owner.request('PUT', `/food-safety/config?siteId=${site.id}`, {
    food_cold_units: JSON.stringify([{ name: 'Fridge 1', type: 'fridge' }, { name: 'Fridge 2', type: 'fridge' }, { name: 'Freezer 1', type: 'freezer' }, { name: 'Walk-in fridge', type: 'fridge' }]),
  });
  assert.equal((await reading(staff, { unit: 'Walk-in fridge', slot: 'am', temperature: 2 })).status, 201);
  record = await diary();
  assert.equal(record.coldFood[0].tempPm, '5');
  assert.equal(record.coldFood.at(-1).unit, 'Walk-in fridge');
  assert.equal(record.coldFood.length, 4);

  // A spoken core temperature appends with the words heard.
  const core = await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'hotTemperature', entryId: randomUUID(),
    row: { item: 'Chicken', coreTemp: '78', timeStart: '', timeFinish: '12:05' }, spoken: 'chicken core temp 78',
  });
  assert.equal(core.status, 201, JSON.stringify(core.data));
  const chicken = (await diary()).hotTemperature.find((row) => row.item === 'Chicken');
  assert.equal(chicken._spoken, 'chicken core temp 78');
  assert.equal(chicken._spokenBy, 'Approval fixture user');

  // The audit trail says who logged what by voice.
  const audit = await pool.query(
    `SELECT actor_id, metadata FROM audit_events WHERE client_id = $1 AND action = 'voice_reading' ORDER BY id`, [owner.clientId]);
  assert.equal(audit.rows.length, 3, 'two spoken fridge/freezer readings and one core temperature');
  assert.ok(audit.rows.every((row) => row.actor_id === staff.userId));
  assert.deepEqual(audit.rows.map((row) => row.metadata.spoken), ['fridge one is showing four degrees', 'freezer one minus ten', 'chicken core temp 78']);

  console.log('voice-log tests passed');
} finally {
  await pool.end();
}
