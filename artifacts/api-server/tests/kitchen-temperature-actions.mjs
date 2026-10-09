import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('kitchen-controls');
  const other = await createTenant('other-controls');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = (await owner.request('POST', '/sites', { name: 'Controlled kitchen', seedStarterChecks: false })).data;
  const config = (await owner.request('GET', `/food-safety/config?siteId=${site.id}`)).data;
  const rules = JSON.parse(config.food_temperature_rules);
  rules.fridge.max = 4;
  assert.equal((await staff.request('PUT', '/food-safety/config', { food_temperature_rules: JSON.stringify(rules) })).status, 403);
  assert.equal((await owner.request('PUT', `/food-safety/config?siteId=${site.id}`, { food_temperature_rules: JSON.stringify(rules) })).status, 200);
  const invalid = { ...rules, fridge: { min: 8, max: 2 } };
  assert.equal((await owner.request('PUT', '/food-safety/config', { food_temperature_rules: JSON.stringify(invalid) })).status, 400);
  assert.equal((await other.request('GET', `/food-safety/config?siteId=${site.id}`)).status, 400);
  assert.equal(JSON.parse((await owner.request('GET', '/food-safety/config')).data.food_temperature_rules).fridge.max, 5);
  const date = isoDay();
  const path = `/food-safety?siteId=${site.id}`;
  assert.equal((await staff.request('POST', path, { recordDate: date, coldFood: [{ unit: 'Fridge', tempAm: '6' }] })).status, 400);
  const created = await staff.request('POST', path, { recordDate: date, coldFood: [{ unit: 'Fridge', tempAm: '4', correctiveAction: '' }] });
  assert.equal(created.status, 201, JSON.stringify(created));
  const id = created.data.id;
  const read = async () => (await owner.request('GET', `${path}&date=${date}`)).data;
  const list = async () => (await owner.request('GET', `/track-actions?module=kitchen&siteId=${site.id}`)).data;
  let before = await read();
  const failure = {
    mobileEntryId: randomUUID(), mobileRecordDate: date,
    mobileTemperatureLog: {
      coldFood: [{ ...before.coldFood[0], tempAm: '6', correctiveAction: 'Transferred food to a working fridge and arranged a repair' }],
      expectedColdFood: before.coldFood, expectedCorrectives: before.correctives,
    },
  };
  const noAction = { ...failure, mobileTemperatureLog: { ...failure.mobileTemperatureLog, coldFood: [{ unit: 'Fridge', tempAm: '6' }] } };
  assert.equal((await staff.request('PUT', `/food-safety/${id}`, noAction)).status, 400);
  assert.equal((await read()).coldFood[0].tempAm, '4', 'a rejected write is rolled back');
  assert.equal((await list()).length, 0);
  const saved = await staff.request('PUT', `/food-safety/${id}`, failure);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal((await staff.request('PUT', `/food-safety/${id}`, failure)).status, 200);
  const actions = await list();
  assert.equal(actions.length, 1, 'receipted replay cannot duplicate corrective actions');
  const action = actions[0];
  assert.equal(action.siteId, site.id);
  assert.equal(action.sourceRecordId, id);
  assert.match(action.instruction, /maximum 4/);
  assert.equal((await staff.request('PATCH', `/track-actions/${action.id}`, { ownerName: 'Chef' })).status, 403);
  assert.equal((await other.request('PATCH', `/track-actions/${action.id}`, { ownerName: 'Chef' })).status, 404);
  assert.equal((await owner.request('PATCH', `/track-actions/${action.id}`, { ownerName: 'Kitchen manager', status: 'in_progress' })).status, 200);
  assert.equal((await owner.request('PATCH', `/track-actions/${action.id}`, { instruction: 'Hide the failure' })).status, 409);
  assert.equal((await owner.request('POST', `/track-actions/${action.id}/fix-track`, { create: true })).status, 409);
  const resolution = { status: 'resolved', remedialAction: 'Food transferred and fridge repaired', evidenceReference: 'Recheck record attached', resolutionNotes: 'Checked the corrective work and confirmed the control is restored', resolverSignature: 'data:image/png;base64,AAAA' };
  assert.equal((await owner.request('PATCH', `/track-actions/${action.id}`, resolution)).status, 400);
  const requirements = await owner.request('GET', `/track-evidence/requirements?module=kitchen&actionId=${action.id}`);
  assert.equal(requirements.status, 200);
  const evidence = await staff.request('POST', '/track-evidence', {
    module: 'kitchen', siteId: site.id, actionId: action.id,
    requirementKey: 'temperature_control_restored', evidenceType: 'verification',
    title: 'Fridge recheck', details: 'Rechecked at 3°C after the repair; affected food was transferred during the outage.',
  });
  assert.equal(evidence.status, 201, JSON.stringify(evidence));
  const resolved = await owner.request('PATCH', `/track-actions/${action.id}`, resolution);
  assert.equal(resolved.status, 200, JSON.stringify(resolved));
  assert.ok(resolved.data.resolvedBy);
  assert.ok(resolved.data.resolvedByName);
  assert.ok(resolved.data.resolvedAt);
  assert.equal((await owner.request('POST', `/track-evidence/${evidence.data.id}/review`, { status: 'rejected', reviewNotes: 'Changed after completion' })).status, 409);
  assert.equal((await owner.request('PATCH', `/track-actions/${action.id}`, { status: 'open' })).status, 409);
  assert.equal((await read()).coldFood[0].tempAm, '6', 'manager sign-off never rewrites the failed reading');
  const audit = await owner.request('GET', `/audit-events?entityType=track_action&entityId=${action.id}`);
  assert.equal(audit.status, 200);
  assert.ok(audit.data.some(e => e.action === 'temperature_failure_created' && e.metadata.failure.limit.max === 4));
  assert.ok(audit.data.some(e => e.action === 'manager_verified_and_resolved'));
  // Generic web updates and append writes enforce the same server rules.
  before = await read();
  const web = await staff.request('PUT', `/food-safety/${id}`, {
    expectedUpdatedAt: before.updatedAt, hotHolding: [{ item: 'Soup', coreTemp: '50' }],
  });
  assert.equal(web.status, 400);
  assert.equal((await read()).hotHolding.length, 0);
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'hotHolding', row: { item: 'Soup', coreTemp: '50' }, entryId: randomUUID(),
  })).status, 400);
  const append = await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'hotHolding', row: { item: 'Soup', coreTemp: '50', correctiveAction: 'Discarded the soup' }, entryId: randomUUID(),
  });
  assert.equal(append.status, 201, JSON.stringify(append));
  assert.equal((await list()).length, 2);
  const cooling = { item: 'Rice', coreTemp: '8', timeStart: '23:00', timeFinish: '00:30' };
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'cooling', row: cooling, entryId: randomUUID(),
  })).status, 201, 'inclusive cooling duration and temperature limits work across midnight');
  assert.equal((await list()).length, 2);
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'cooling', row: { ...cooling, timeFinish: '00:31' }, entryId: randomUUID(),
  })).status, 400);
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'coldFood', row: { unit: 'Freezer', tempAm: '-18' }, entryId: randomUUID(),
  })).status, 201);
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${site.id}`, {
    recordDate: date, section: 'hotHolding', row: { item: 'Unmeasured', coreTemp: 'not a number' }, entryId: randomUUID(),
  })).status, 400);
  assert.equal((await owner.request('POST', '/track-evidence', {
    module: 'kitchen', actionId: action.id, evidenceType: 'verification',
    title: 'Added after sign-off', details: 'Must not alter the signed evidence set',
  })).status, 409);
  const englishSite = (await owner.request('POST', '/sites', { name: 'English kitchen', seedStarterChecks: false })).data;
  assert.equal((await owner.request('PUT', `/food-safety/config?siteId=${englishSite.id}`, {
    food_jurisdiction: 'england_wales',
  })).status, 200);
  assert.equal(JSON.parse((await owner.request('GET', `/food-safety/config?siteId=${englishSite.id}`)).data.food_temperature_rules).reheating.min, 75);
  assert.equal((await staff.request('POST', `/food-safety?siteId=${englishSite.id}`, {
    recordDate: date, reheating: [{ item: 'Soup', coreTemp: '75' }],
  })).status, 201, 'numeric fallback agrees with the existing jurisdiction default');
  console.log('KitchenTrack numeric site rules, mandatory corrective actions, atomic writes, replay, manager verification, immutable evidence and audit tests passed.');
} finally { await pool.end(); }