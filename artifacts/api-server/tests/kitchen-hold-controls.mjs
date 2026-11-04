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

  // ── Boundaries: limits are inclusive, whole numbers only, typing slips refused ──
  let count = (await actions()).length;
  const ok = async (section, row, why) => assert.equal((await append(section, row)).status, 201, why);
  const refused = async (section, row, why, pattern) => {
    const res = await append(section, row);
    assert.equal(res.status, 400, why);
    if (pattern) assert.match(res.data.error, pattern, why);
  };
  await ok('hotTemperature', { item: 'Chicken', coreTemp: '75', holdSeconds: '30' }, 'exactly 75°C for exactly 30 seconds passes');
  await refused('hotTemperature', { item: 'Chicken', coreTemp: '75', holdSeconds: '29' }, 'one second short needs an action', /holdSeconds \(29 seconds\)/);
  await refused('hotTemperature', { item: 'Chicken', coreTemp: '74.9', holdSeconds: '30' }, 'just under the core minimum needs an action');
  await refused('hotTemperature', { item: 'Chicken', coreTemp: '80', holdSeconds: '0' }, 'a zero hold is short');
  await ok('hotTemperature', { item: 'Rare beef', coreTemp: '60', holdSeconds: '600' }, "the item's own minimums are inclusive");
  await refused('hotTemperature', { item: 'Rare beef', coreTemp: '60', holdSeconds: '599' }, 'one second under the item hold');
  await ok('sousVide', { item: 'Salmon', coreTemp: '75', waterTemp: '75', holdMinutes: '60' }, 'exactly the sous vide hold passes');
  await refused('sousVide', { item: 'Salmon', coreTemp: '75', waterTemp: '75', holdMinutes: '59' }, 'one minute short', /holdMinutes \(59 minutes\)/);
  await ok('hotTemperature', { item: 'Chicken', coreTemp: '80', holdSeconds: '86400' }, 'a 24-hour hold is the longest accepted');
  await refused('hotTemperature', { item: 'Chicken', coreTemp: '80', holdSeconds: '86401' }, 'longer is a typing slip', /too long/);
  await refused('sousVide', { item: 'Salmon', coreTemp: '75', waterTemp: '75', holdMinutes: '4321' }, 'over 72 hours is a typing slip', /too long/);
  for (const holdSeconds of ['-5', '30.5', '1e3', '30 s']) {
    await refused('hotTemperature', { item: 'Chicken', coreTemp: '80', holdSeconds }, `"${holdSeconds}" is not a whole number of seconds`, /whole number of seconds/);
  }
  assert.equal((await actions()).length, count, 'passing and refused readings raise no actions');

  // ── Retries never duplicate a failure or its follow-up ──
  const retryId = randomUUID();
  const shortRow = { item: 'Chicken', coreTemp: '80', holdSeconds: '10', correctiveAction: 'Back in the oven for a full hold' };
  const firstTry = await staff.request('POST', `/food-safety/append?siteId=${site.id}`, { recordDate: date, section: 'hotTemperature', row: shortRow, entryId: retryId });
  assert.equal(firstTry.status, 201, JSON.stringify(firstTry.data));
  const rowsAfterFirst = (await owner.request('GET', `${path}&date=${date}`)).data.hotTemperature.length;
  const retry = await staff.request('POST', `/food-safety/append?siteId=${site.id}`, { recordDate: date, section: 'hotTemperature', row: shortRow, entryId: retryId });
  assert.ok([200, 201].includes(retry.status), `append retry → ${retry.status}`);
  assert.equal((await owner.request('GET', `${path}&date=${date}`)).data.hotTemperature.length, rowsAfterFirst, 'the retried row is stored once');
  assert.equal((await actions()).length, ++count, 'one action for a retried append');

  const current = (await owner.request('GET', `${path}&date=${date}`)).data;
  const deviceEntry = {
    mobileEntryId: randomUUID(), mobileRecordDate: date,
    mobileTemperatureLog: {
      coldFood: current.coldFood, expectedColdFood: current.coldFood,
      sousVide: { item: 'Duck breast', waterTemp: '58', coreTemp: '58', timeStarted: '09:00', timeFinished: '12:00', holdMinutes: '100' },
      correctives: 'Duck returned to the bath for the full 120 minutes', expectedCorrectives: current.correctives,
    },
  };
  const noAction = { ...deviceEntry, mobileEntryId: randomUUID(), mobileTemperatureLog: { ...deviceEntry.mobileTemperatureLog, correctives: undefined } };
  delete noAction.mobileTemperatureLog.correctives;
  assert.equal((await staff.request('PUT', `/food-safety/${current.id}`, noAction)).status, 400, 'a short sous vide hold from the phone needs an action');
  const sent = await staff.request('PUT', `/food-safety/${current.id}`, deviceEntry);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const resent = await staff.request('PUT', `/food-safety/${current.id}`, deviceEntry);
  assert.equal(resent.status, 200, 'the phone retrying the same entry is accepted');
  const duck = (await owner.request('GET', `${path}&date=${date}`)).data.sousVide.filter(row => row.holdMinutes === '100');
  assert.equal(duck.length, 1, 'the retried device reading is stored once');
  open = await actions();
  assert.equal(open.length, ++count, 'one action for a retried device entry');
  assert.ok(open.some(action => /Duck breast · holdMinutes: 100 minutes/.test(action.instruction) && /minimum 120; minutes/.test(action.instruction)));

  // A web save that re-sends the day unchanged raises nothing new, and a
  // recorded hold time cannot be cleared while the control applies.
  const day = (await owner.request('GET', `${path}&date=${date}`)).data;
  assert.equal((await owner.request('PUT', `/food-safety/${day.id}`, { hotTemperature: day.hotTemperature, sousVide: day.sousVide })).status, 200);
  assert.equal((await actions()).length, count, 'unchanged failed rows are not raised again');
  const cleared = day.hotTemperature.map(row => row.item === 'Chicken' && row.holdSeconds === '12' ? { ...row, holdSeconds: '' } : row);
  const clearing = await owner.request('PUT', `/food-safety/${day.id}`, { hotTemperature: cleared });
  assert.equal(clearing.status, 400, 'clearing a recorded hold time is refused');
  assert.match(clearing.data.error, /record how long/);
  assert.equal((await owner.request('GET', `${path}&date=${date}`)).data.hotTemperature.find(row => row.item === 'Chicken').holdSeconds, '12');

  // A site without hold controls accepts readings without a hold time.
  assert.equal((await staff.request('POST', `/food-safety?siteId=${plain.id}`, {
    recordDate: date, hotTemperature: [{ item: 'Chicken', coreTemp: '80' }],
  })).status, 201);

  // ── Controls are prospective: readings saved before a hold control was set
  // stay as recorded, and nothing is inferred from descriptive labels ──
  const plainConfig = `/food-safety/config?siteId=${plain.id}`;
  assert.equal((await owner.request('PUT', plainConfig, { food_cooking_limit: 'Above 75°C for 2 minutes' })).status, 200);
  assert.equal(JSON.parse((await owner.request('GET', plainConfig)).data.food_temperature_rules).cookingHoldSeconds, null,
    'a legacy label naming a time does not create a hold control');
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${plain.id}`, {
    recordDate: date, section: 'hotTemperature', row: { item: 'Pie', coreTemp: '80' }, entryId: randomUUID(),
  })).status, 201, 'no hold time is required from the label alone');
  const plainRules = JSON.parse((await owner.request('GET', plainConfig)).data.food_temperature_rules);
  assert.equal((await owner.request('PUT', plainConfig, { food_temperature_rules: JSON.stringify({ ...plainRules, cookingHoldSeconds: 30 }) })).status, 200);
  const plainPath = `/food-safety?siteId=${plain.id}&date=${date}`;
  const legacy = (await owner.request('GET', plainPath)).data;
  const relabel = await staff.request('PUT', `/food-safety/${legacy.id}`, { hotTemperature: legacy.hotTemperature, correctives: 'Probe cleaned between items' });
  assert.equal(relabel.status, 200, `older readings are not re-judged by a new control (${JSON.stringify(relabel.data)})`);
  const kept = (await owner.request('GET', plainPath)).data.hotTemperature;
  assert.ok(kept.every(row => row.holdSeconds === undefined), 'no hold time is filled in for older readings');
  assert.equal((await owner.request('GET', `/track-actions?module=kitchen&siteId=${plain.id}`)).data.length, 0);
  assert.equal((await staff.request('POST', `/food-safety/append?siteId=${plain.id}`, {
    recordDate: date, section: 'hotTemperature', row: { item: 'Pie', coreTemp: '80' }, entryId: randomUUID(),
  })).status, 400, 'new readings follow the new control');
  console.log('KitchenTrack hold-time controls, item rules, boundaries, retries, prospective controls, corrective actions and tenant/site scoping passed.');
} finally { await pool.end(); }
