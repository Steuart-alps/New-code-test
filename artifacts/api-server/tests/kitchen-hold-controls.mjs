// KitchenTrack hold-time controls and per-item rules, end to end through the API.
// Run: pnpm --filter @workspace/api-server run test:kitchen-hold-controls
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('kitchen-holds');
  const other = await createTenant('other-holds');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = (await owner.request('POST', '/sites', { name: 'Hold kitchen', seedStarterChecks: false })).data;
  const plain = (await owner.request('POST', '/sites', { name: 'No hold kitchen', seedStarterChecks: false })).data;
  const configPath = `/food-safety/config?siteId=${site.id}`;
  const defaults = JSON.parse((await owner.request('GET', configPath)).data.food_temperature_rules);
  assert.equal(defaults.cookingHoldSeconds, null, 'no hold control unless a manager sets one');
  assert.deepEqual(defaults.items, { cooking: [], sousVide: [] });

  const rules = {
    ...defaults, cookingHoldSeconds: 30, sousVideHoldMinutes: 60,
    items: { cooking: [{ item: 'Rare beef', min: 60, holdSeconds: 600 }], sousVide: [{ item: 'Duck breast', min: 58, holdMinutes: 120 }] },
  };
  assert.equal((await staff.request('PUT', configPath, { food_temperature_rules: JSON.stringify(rules) })).status, 403, 'staff cannot change hold controls');
  const duplicate = { ...rules, items: { ...rules.items, cooking: [...rules.items.cooking, { item: 'rare beef', min: 70, holdSeconds: 10 }] } };
  assert.equal((await owner.request('PUT', configPath, { food_temperature_rules: JSON.stringify(duplicate) })).status, 400);
  assert.equal((await owner.request('PUT', configPath, { food_temperature_rules: JSON.stringify({ ...rules, cookingHoldSeconds: 2.5 }) })).status, 400);
  assert.equal((await owner.request('PUT', configPath, { food_temperature_rules: JSON.stringify(rules) })).status, 200);
  assert.deepEqual(JSON.parse((await owner.request('GET', configPath)).data.food_temperature_rules).items, rules.items, 'item rules round-trip');
  assert.equal(JSON.parse((await owner.request('GET', `/food-safety/config?siteId=${plain.id}`)).data.food_temperature_rules).cookingHoldSeconds, null,
    'a site rule does not leak to other sites');
  assert.equal((await other.request('GET', configPath)).status, 400, 'another tenant cannot read the site rules');

  const date = isoDay();
  const path = `/food-safety?siteId=${site.id}`;
  const actions = async () => (await owner.request('GET', `/track-actions?module=kitchen&siteId=${site.id}`)).data;
  const missingHold = await staff.request('POST', path, { recordDate: date, hotTemperature: [{ item: 'Chicken', coreTemp: '80' }] });
  assert.equal(missingHold.status, 400);
  assert.match(missingHold.data.error, /record how long .* at least 30 seconds/);
  const shortHold = { recordDate: date, hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '12' }] };
  assert.equal((await staff.request('POST', path, shortHold)).status, 400, 'a short hold needs a corrective action');
  assert.equal((await actions()).length, 0);
  const created = await staff.request('POST', path, { ...shortHold, correctives: 'Returned the chicken to the oven and re-probed' });
  assert.equal(created.status, 201, JSON.stringify(created));
  let open = await actions();
  assert.equal(open.length, 1);
  assert.match(open[0].instruction, /holdSeconds: 12 seconds/);
  assert.match(open[0].instruction, /minimum 30; seconds/);
  assert.equal(open[0].remedialAction, 'Returned the chicken to the oven and re-probed');

  const append = (section, row) => staff.request('POST', `/food-safety/append?siteId=${site.id}`, { recordDate: date, section, row, entryId: randomUUID() });
  assert.equal((await append('hotTemperature', { item: 'rare beef', coreTemp: '62', holdSeconds: '600' })).status, 201,
    'the item rule replaces the 75°C section minimum');
  assert.equal((await append('hotTemperature', { item: 'Rare beef', coreTemp: '62', holdSeconds: '120' })).status, 400,
    'and its 600-second hold');
  assert.equal((await append('sousVide', { item: 'Salmon', coreTemp: '76', waterTemp: '76' })).status, 400);
  assert.equal((await append('sousVide', { item: 'Duck breast', coreTemp: '58', waterTemp: '58', holdMinutes: '120' })).status, 201);
  assert.equal((await append('hotTemperature', { item: 'Chicken', coreTemp: '80', holdSeconds: 'half a minute' })).status, 400);
  assert.equal((await actions()).length, 1, 'passing and rejected rows raise no actions');

  // The device path: a cooking reading carried in mobileTemperatureLog.
  const before = (await owner.request('GET', `${path}&date=${date}`)).data;
  const mobile = (hotTemperature, correctives) => staff.request('PUT', `/food-safety/${before.id}`, {
    mobileEntryId: randomUUID(), mobileRecordDate: date,
    mobileTemperatureLog: {
      coldFood: before.coldFood, expectedColdFood: before.coldFood,
      hotTemperature, ...(correctives ? { correctives } : {}), expectedCorrectives: before.correctives,
    },
  });
  assert.equal((await mobile({ item: 'Lasagne', coreTemp: '78' })).status, 400, 'a device reading also needs its hold time');
  const saved = await mobile({ item: 'Lasagne', coreTemp: '78', holdSeconds: '5' }, 'Held the lasagne for a further minute before service');
  assert.equal(saved.status, 200, JSON.stringify(saved));
  open = await actions();
  assert.equal(open.length, 2);
  assert.ok(open.some(action => /Lasagne · holdSeconds: 5 seconds/.test(action.instruction)));

  // The earlier rows were saved under these controls and stay as recorded.
  const after = (await owner.request('GET', `${path}&date=${date}`)).data;
  assert.equal(after.hotTemperature.find(row => row.item === 'Chicken').holdSeconds, '12', 'the failed hold stays as historical evidence');

  // A site without hold controls accepts readings without a hold time.
  assert.equal((await staff.request('POST', `/food-safety?siteId=${plain.id}`, {
    recordDate: date, hotTemperature: [{ item: 'Chicken', coreTemp: '80' }],
  })).status, 201);
  console.log('KitchenTrack hold-time controls, item rules, corrective actions and tenant/site scoping passed.');
} finally { await pool.end(); }
