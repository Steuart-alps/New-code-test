import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('kitchen-replay');
  const other = await createTenant('kitchen-replay-other');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = await owner.request('POST', '/sites', { name: 'Replay kitchen', seedStarterChecks: false });
  assert.equal(site.status, 201);
  const path = `/food-safety?siteId=${site.data.id}`;
  const date = isoDay();
  const createBody = {
    recordDate: date,
    mobileEntryId: randomUUID(),
    coldFood: [{ unit: 'Fridge', tempAm: '3', tempPm: '', correctiveAction: '' }],
    deliveries: [{ supplier: 'Fresh supplier', tempChilled: '3' }],
  };
  const creates = await Promise.all([owner.request('POST', path, createBody), owner.request('POST', path, createBody)]);
  assert.deepEqual(creates.map(r => r.status).sort(), [200, 201], JSON.stringify(creates));
  const id = creates[0].data.id;
  assert.equal(creates[1].data.id, id);
  const updatePath = `/food-safety/${id}`;
  const readPath = `/food-safety?date=${date}&siteId=${site.data.id}`;
  const initial = (await owner.request('GET', readPath)).data;
  assert.equal(initial.deliveries.length, 1);
  assert.equal((await owner.request('POST', path, createBody)).status, 200, 'lost create response is recoverable');
  assert.equal((await owner.request('POST', path, { ...createBody, coldFood: [] })).status, 409, 'an ID cannot hide changed payloads');
  assert.equal((await staff.request('POST', path, createBody)).status, 409, 'receipt belongs to the authenticated user');
  const updateBody = {
    mobileEntryId: randomUUID(), mobileRecordDate: date,
    mobileTemperatureLog: {
      expectedColdFood: initial.coldFood, coldFood: [{ ...initial.coldFood[0], tempPm: '4' }],
      expectedCorrectives: initial.correctives,
      hotHolding: { item: 'Soup', coreTemp: '75', timeOfCheck: '12:00' },
      delivery: { supplier: 'Second supplier', tempChilled: '4' },
    },
  };
  const updates = await Promise.all([
    owner.request('PUT', updatePath, updateBody), owner.request('PUT', updatePath, updateBody),
  ]);
  assert.deepEqual(updates.map(r => r.status), [200, 200], JSON.stringify(updates));
  let saved = (await owner.request('GET', readPath)).data;
  assert.equal(saved.hotHolding.length, 1, 'ambiguous-response replay does not append twice');
  assert.equal(saved.deliveries.length, 2);
  assert.equal(saved.coldFood[0].tempPm, '4');
  assert.equal(saved.mobileSubmissionReceipts.length, 2);
  const timestamp = saved.updatedAt;
  assert.equal((await owner.request('PUT', updatePath, updateBody)).status, 200);
  saved = (await owner.request('GET', readPath)).data;
  assert.equal(saved.updatedAt, timestamp, 'a replay does not mutate audit timestamps');
  assert.equal((await owner.request('PUT', updatePath, { ...updateBody, mobileRecordDate: isoDay(-1) })).status, 409);
  assert.equal((await owner.request('PUT', updatePath, {
    ...updateBody, mobileTemperatureLog: { ...updateBody.mobileTemperatureLog, hotHolding: { item: 'Changed soup' } },
  })).status, 409);
  assert.equal((await staff.request('PUT', updatePath, updateBody)).status, 409, 'another staff identity cannot claim the receipt');
  assert.equal((await other.request('PUT', updatePath, updateBody)).status, 404);
  assert.equal((await owner.request('PUT', updatePath, { ...updateBody, mobileEntryId: randomUUID() })).status, 409,
    'a genuinely stale new edit still conflicts');
  const newer = {
    mobileEntryId: randomUUID(), mobileRecordDate: date,
    mobileTemperatureLog: {
      coldFood: [{ ...saved.coldFood[0], tempPm: '5' }], expectedColdFood: saved.coldFood,
      expectedCorrectives: saved.correctives,
    },
  };
  assert.equal((await owner.request('PUT', updatePath, newer)).status, 200);
  assert.equal((await owner.request('PUT', updatePath, updateBody)).status, 200);
  saved = (await owner.request('GET', readPath)).data;
  assert.equal(saved.coldFood[0].tempPm, '5', 'old acknowledged replay never overwrites a later edit');
  assert.equal(saved.hotHolding.length, 1);
  assert.equal(saved.deliveries.length, 2);
  console.log('KitchenTrack POST/PUT replay, concurrent deduplication, payload integrity, dates and authenticated-owner boundaries passed.');
} finally { await pool.end(); }