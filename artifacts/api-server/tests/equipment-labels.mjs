import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// QR labels on equipment and the equipment list. A label's code opens the
// item only for someone in its business who can see its site and has its
// track; every other case gets the same "not available" answer. Fridges and
// freezers keep their label across a rename. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/equipment-labels.mjs

const today = isoDay();
const ok = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
};
const NOT_AVAILABLE = "This label isn't available to you";

try {
  const owner = await createTenant('equipment-labels');
  const other = await createTenant('equipment-labels-other');
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Clubhouse', seedStarterChecks: false }), 201);
  const siteB = ok(await owner.request('POST', '/sites', { name: 'Golf course', seedStarterChecks: false }), 201);
  const courseTeam = ok(await owner.request('POST', '/departments', { name: 'Greenkeeping', siteId: siteB.id }), 201);
  const staffA = await createUser(owner, { role: 'client_staff' });
  const courseStaff = await createUser(owner, { role: 'client_staff', departmentId: courseTeam.id });
  const viewer = await createUser(owner, { role: 'client_viewer' });

  // ── The equipment list ───────────────────────────────────────────────────
  const gasCheck = ok(await owner.request('POST', '/compliance-items', {
    title: 'Boiler gas safety', priority: 'high', siteId: siteA.id, dueDate: `${isoDay(200)}T00:00:00.000Z`,
  }), 201);
  const tank = ok(await owner.request('POST', '/equipment', {
    name: 'Cold water tank 1', type: 'cold_water_tank', siteId: siteA.id, location: 'Plant room',
  }), 201);
  assert.equal(tank.typeLabel, 'Cold water storage tank');
  assert.equal(tank.siteName, 'Clubhouse');
  const boiler = ok(await owner.request('POST', '/equipment', {
    name: 'Boiler', type: 'boiler', siteId: siteA.id, complianceItemIds: [gasCheck.id],
  }), 201);
  assert.deepEqual(boiler.complianceItems, [{ id: gasCheck.id, title: 'Boiler gas safety' }]);
  assert.equal((await owner.request('POST', '/equipment', { name: '', type: 'boiler' })).status, 400);
  assert.equal((await owner.request('POST', '/equipment', { name: 'Odd', type: 'spaceship' })).status, 400);
  assert.equal((await staffA.request('POST', '/equipment', { name: 'Staff item', type: 'other' })).status, 403);
  assert.equal((await viewer.request('POST', '/equipment', { name: 'Viewer item', type: 'other' })).status, 403);
  assert.equal((await other.request('POST', '/equipment', { name: 'Foreign', type: 'other', siteId: siteA.id })).status, 400,
    "another business cannot add to this site");
  assert.equal((await other.request('PUT', `/equipment/${tank.id}`, { name: 'Mine' })).status, 404);
  const foreignCheck = ok(await other.request('POST', '/compliance-items', { title: 'Their check', priority: 'low' }), 201);
  assert.equal((await owner.request('PUT', `/equipment/${boiler.id}`, { complianceItemIds: [foreignCheck.id] })).status, 400,
    "another business's Compliance Check cannot be linked");
  assert.deepEqual(ok(await owner.request('GET', `/equipment?siteId=${siteA.id}`)).map(i => i.name).sort(), ['Boiler', 'Cold water tank 1']);
  assert.deepEqual(ok(await other.request('GET', '/equipment')), []);
  assert.deepEqual(ok(await courseStaff.request('GET', '/equipment')), [], 'staff at another site do not see the clubhouse plant');
  console.log('ok - managers keep the equipment list per site; others cannot change or see it');

  // ── Water checks link to a tank of the right type at the right site ─────
  const tankCheck = (extra) => ({ checkType: 'cold_tank_temp', checkDate: today, result: 'pass', temperature: 12, siteId: siteA.id, equipmentId: tank.id, ...extra });
  assert.equal((await owner.request('POST', '/legionella', tankCheck({ checkType: 'calorifier_temp', temperature: 61 }))).status, 400,
    'a calorifier check cannot go against a cold water tank');
  assert.equal((await owner.request('POST', '/legionella', tankCheck({ siteId: siteB.id }))).status, 400, 'the tank is at another site');
  assert.equal((await other.request('POST', '/legionella', tankCheck({ siteId: null }))).status, 400, "another business's tank");
  const recorded = ok(await staffA.request('POST', '/legionella', tankCheck()), 201);
  assert.equal(recorded.equipmentId, tank.id);
  console.log('ok - water checks can be recorded against a tank');

  // ── Labels: list, print, scan ────────────────────────────────────────────
  const machine = ok(await owner.request('POST', '/green-track/machines', { name: 'Greens mower 1', type: 'ride_on_cylinder', siteId: siteB.id }), 201);
  const callPoint = ok(await owner.request('POST', '/fire-safety/call-points', { siteId: siteA.id, name: 'CP1 Front door' }), 201);
  const labelsA = ok(await owner.request('GET', `/equipment-labels?siteId=${siteA.id}`));
  const find = (list, kind, name) => list.find(l => l.kind === kind && l.name === name);
  for (const [kind, name] of [['equipment', 'Cold water tank 1'], ['equipment', 'Boiler'], ['fire_call_point', 'CP1 Front door'], ['cold_unit', 'Fridge 1']]) {
    const row = find(labelsA, kind, name);
    assert.ok(row, `${kind} ${name} can be labelled`);
    assert.equal(row.code, null, 'nothing has a code until it is printed');
  }
  assert.equal(find(labelsA, 'green_machine', 'Greens mower 1'), undefined, 'site filter applies');
  assert.equal((await staffA.request('GET', '/equipment-labels')).status, 403, 'staff do not print labels');

  const sheetItems = [find(labelsA, 'equipment', 'Cold water tank 1'), find(labelsA, 'cold_unit', 'Fridge 1'), find(labelsA, 'fire_call_point', 'CP1 Front door')]
    .map(({ kind, ref }) => ({ kind, ref }));
  const pdf = await owner.request('POST', '/equipment-labels/sheet', { items: sheetItems, size: 'standard' }, 'buffer');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  const large = await owner.request('POST', '/equipment-labels/sheet', { items: sheetItems, size: 'large' }, 'buffer');
  assert.equal(large.status, 200);
  assert.equal((await owner.request('POST', '/equipment-labels/sheet', { items: [{ kind: 'equipment', ref: '999999' }] })).status, 404);
  assert.equal((await other.request('POST', '/equipment-labels/sheet', { items: sheetItems })).status, 404,
    "another business cannot print this business's labels");
  const printed = ok(await owner.request('GET', `/equipment-labels?siteId=${siteA.id}`));
  const tankLabel = find(printed, 'equipment', 'Cold water tank 1');
  assert.match(tankLabel.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.ok(tankLabel.url.endsWith(`/q/${tankLabel.code}`));
  ok(await owner.request('POST', '/equipment-labels/sheet', { items: sheetItems }), 200);
  assert.equal(find(ok(await owner.request('GET', `/equipment-labels?siteId=${siteA.id}`)), 'equipment', 'Cold water tank 1').code, tankLabel.code,
    'printing again keeps the same code');
  console.log('ok - managers print label sheets; codes are made once');

  const scan = ok(await staffA.request('GET', `/equipment-labels/scan/${tankLabel.code.toLowerCase()}`));
  assert.equal(scan.name, 'Cold water tank 1');
  assert.equal(scan.siteName, 'Clubhouse');
  const monthly = scan.statuses.find(s => s.label === 'Monthly temperature');
  assert.equal(monthly.state, 'info', 'without an approved water plan the scan shows when it was last done');
  assert.match(monthly.note, /water plan/);
  assert.ok(scan.actions.some(a => a.href === `/legionella?equipment=${tank.id}&open=cold_tank_temp`));
  assert.ok(scan.history.some(h => h.text.includes('12°C')));

  const notAvailable = async (who, code) => {
    const result = await who.request('GET', `/equipment-labels/scan/${code}`);
    assert.equal(result.status, 404, JSON.stringify(result.data));
    assert.equal(result.data.error, NOT_AVAILABLE);
  };
  await notAvailable(other, tankLabel.code);
  await notAvailable(courseStaff, tankLabel.code);
  await notAvailable(owner, 'ZZZZZZ');
  await notAvailable(owner, 'not-a-code');
  assert.notEqual((await viewer.request('GET', `/equipment-labels/scan/${tankLabel.code}`)).status, 200, 'Viewers see nothing');
  console.log('ok - a scan shows the item only to people who can see it, and the same message to everyone else');

  // ── Linked Compliance Checks and the green machine ───────────────────────
  const [boilerLabel] = [...(await (async () => {
    ok(await owner.request('POST', '/equipment-labels/sheet', { items: [{ kind: 'equipment', ref: String(boiler.id) }] }));
    return ok(await owner.request('GET', `/equipment-labels?siteId=${siteA.id}`)).filter(l => l.kind === 'equipment' && l.name === 'Boiler');
  })())];
  const boilerScan = ok(await owner.request('GET', `/equipment-labels/scan/${boilerLabel.code}`));
  const gas = boilerScan.statuses.find(s => s.label === 'Boiler gas safety');
  assert.equal(gas.state, 'ok');
  assert.match(gas.text, /^In date until/);

  ok(await owner.request('POST', '/equipment-labels/sheet', { items: [{ kind: 'green_machine', ref: String(machine.id) }] }));
  const mowerLabel = find(ok(await owner.request('GET', `/equipment-labels?siteId=${siteB.id}`)), 'green_machine', 'Greens mower 1');
  let mower = ok(await courseStaff.request('GET', `/equipment-labels/scan/${mowerLabel.code}`));
  assert.equal(mower.statuses[0].text, 'Not done yet today');
  assert.equal(mower.actions[0].href, `/green-track?machine=${machine.id}&open=pre-use`);
  assert.equal(mower.actions.some(a => a.label === 'Record an inspection'), false, 'staff are not offered manager-only records');
  ok(await courseStaff.request('POST', '/green-track/pre-use-checks', {
    machineId: machine.id, checkDate: today, operator: 'Operator',
    checklistItems: [{ key: 'tyres', label: 'Tyres', section: 'General', status: 'ok' }],
  }), 201);
  mower = ok(await courseStaff.request('GET', `/equipment-labels/scan/${mowerLabel.code}`));
  assert.equal(mower.statuses[0].text, 'Done today');
  assert.ok(ok(await owner.request('GET', `/equipment-labels/scan/${mowerLabel.code}`)).actions.some(a => a.label === 'Record an inspection'));
  console.log('ok - scans show linked Compliance Checks and today\'s pre-use check');

  // ── Replacing a label retires its code ───────────────────────────────────
  assert.equal((await staffA.request('POST', '/equipment-labels/replace', { kind: 'equipment', ref: String(tank.id) })).status, 403);
  const replaced = ok(await owner.request('POST', '/equipment-labels/replace', { kind: 'equipment', ref: String(tank.id) }));
  assert.notEqual(replaced.code, tankLabel.code);
  await notAvailable(owner, tankLabel.code);
  ok(await owner.request('GET', `/equipment-labels/scan/${replaced.code}`));
  const { rows: labelRows } = await pool.query(
    `SELECT replaced_at IS NOT NULL AS replaced FROM equipment_labels WHERE client_id = $1 AND kind = 'equipment' AND target_ref = $2 ORDER BY id`,
    [owner.clientId, String(tank.id)]);
  assert.deepEqual(labelRows.map(r => r.replaced), [true, false], 'the old label is kept as history');
  console.log('ok - a replaced label stops working and the item gets a new code');

  // ── Fridges keep their label when renamed ────────────────────────────────
  const fridgeLabel = find(ok(await owner.request('GET', `/equipment-labels?siteId=${siteA.id}`)), 'cold_unit', 'Fridge 1');
  assert.ok(fridgeLabel.code);
  const config = ok(await owner.request('GET', `/food-safety/config?siteId=${siteA.id}`));
  assert.equal(config.food_cold_units, '', 'the site still uses the default fridges');
  ok(await owner.request('PUT', `/food-safety/config?siteId=${siteA.id}`, {
    food_cold_units: JSON.stringify([{ name: 'Fridge 1', type: 'fridge' }, { name: 'Freezer 1', type: 'freezer' }]),
  }));
  let units = JSON.parse(ok(await owner.request('GET', `/food-safety/config?siteId=${siteA.id}`)).food_cold_units);
  assert.equal(units[0].id, 'fridge-1', 'a saved list keeps the ids of the units it replaces');
  units[0].name = 'Walk-in fridge';
  units.push({ name: 'Bar fridge', type: 'fridge' });
  ok(await owner.request('PUT', `/food-safety/config?siteId=${siteA.id}`, { food_cold_units: JSON.stringify(units) }));
  units = JSON.parse(ok(await owner.request('GET', `/food-safety/config?siteId=${siteA.id}`)).food_cold_units);
  assert.equal(units[0].id, 'fridge-1');
  assert.match(units[2].id, /^u-[0-9a-f]{10}$/, 'a new unit gets its own id');
  const fridgeScan = ok(await staffA.request('GET', `/equipment-labels/scan/${fridgeLabel.code}`));
  assert.equal(fridgeScan.name, 'Walk-in fridge', 'the label follows the renamed fridge');
  assert.equal(fridgeScan.actions[0].href, `/kitchen?siteId=${siteA.id}&coldUnit=Walk-in+fridge`);
  console.log('ok - fridges and freezers keep their label across a rename');

  // ── FireTrack extinguishers onto the equipment list ──────────────────────
  ok(await owner.request('PUT', '/fire-safety/config', { fire_extinguisher_points: JSON.stringify(['Reception CO2', 'Kitchen wet chemical']) }));
  assert.deepEqual(ok(await owner.request('POST', '/equipment/import-extinguishers', { siteId: siteA.id })), { added: 2, alreadyListed: 0 });
  assert.deepEqual(ok(await owner.request('POST', '/equipment/import-extinguishers', { siteId: siteA.id })), { added: 0, alreadyListed: 2 });
  assert.equal((await staffA.request('POST', '/equipment/import-extinguishers', { siteId: siteA.id })).status, 403);
  const extinguishers = ok(await owner.request('GET', `/equipment?siteId=${siteA.id}`)).filter(i => i.type === 'fire_extinguisher');
  assert.deepEqual(extinguishers.map(i => i.name).sort(), ['Kitchen wet chemical', 'Reception CO2']);
  console.log('ok - FireTrack extinguisher points copy onto the equipment list once');

  // ── A department's manager cannot move plant to another department's site ─
  const courseManager = await createUser(owner, { role: 'client_manager', departmentId: courseTeam.id });
  const hoist = ok(await courseManager.request('POST', '/equipment', { name: 'Course hoist', type: 'hoist', siteId: siteB.id }), 201);
  const moved = await courseManager.request('PUT', `/equipment/${hoist.id}`, { siteId: siteA.id });
  assert.ok([400, 403, 404].includes(moved.status), JSON.stringify(moved.data));
  assert.equal(ok(await owner.request('GET', `/equipment?siteId=${siteB.id}`)).find(i => i.id === hoist.id)?.siteId, siteB.id);
  console.log("ok - " + "scoped manager cannot move equipment to another department's site");

  const archived = ok(await owner.request('PUT', `/equipment/${tank.id}`, { active: false }));
  assert.equal(archived.active, false);
  assert.equal(ok(await owner.request('GET', `/equipment?siteId=${siteA.id}`)).some(i => i.id === tank.id), false);
  assert.equal(ok(await owner.request('GET', `/equipment?siteId=${siteA.id}&includeArchived=true`)).some(i => i.id === tank.id), true);
  assert.equal((await owner.request('POST', '/legionella', tankCheck())).status, 400, 'an archived tank takes no new checks');
  const { rows: [kept] } = await pool.query('SELECT equipment_id FROM legionella_checks WHERE id = $1', [recorded.id]);
  assert.equal(kept.equipment_id, tank.id);
  const { rows: audit } = await pool.query(
    `SELECT action FROM audit_events WHERE client_id = $1 AND entity_type IN ('equipment_item', 'equipment_label') ORDER BY id`, [owner.clientId]);
  assert.ok(audit.length >= 5, 'equipment changes are in the audit trail');
  console.log('ok - archived equipment keeps its history');

  console.log('Equipment label tests passed.');
} finally {
  await pool.end();
}
