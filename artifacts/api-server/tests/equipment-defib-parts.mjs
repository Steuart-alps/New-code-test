import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// A defibrillator on the equipment list: its pads, battery and child pads
// expiry dates are each a Compliance Check due on that date (dashboard,
// reminders to the person responsible, QR scan). Marking one replaced asks
// for the new part's expiry date. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/equipment-defib-parts.mjs

const ok = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
};

try {
  const owner = await createTenant('defib-parts');
  const other = await createTenant('defib-parts-other');
  const site = ok(await owner.request('POST', '/sites', { name: 'Clubhouse', seedStarterChecks: false }), 201);
  const manager = await createUser(owner, { role: 'client_manager' });
  const staff = await createUser(owner, { role: 'client_staff' });
  const people = ok(await owner.request('GET', `/assignees?siteId=${site.id}`));
  const managerPerson = people.find(p => p.id === manager.userId) ?? people[0];
  assert.ok(managerPerson, 'someone can be assigned');

  const padsDue = isoDay(20);
  const batteryDue = isoDay(400);
  const defib = ok(await owner.request('POST', '/equipment', {
    name: 'Clubhouse AED', type: 'defibrillator', siteId: site.id, location: 'Reception',
    partExpiryDates: { defib_pads: padsDue, defib_battery: batteryDue, defib_child_pads: null },
    partsAssigneeUserId: managerPerson.id,
  }), 201);
  assert.equal(defib.typeLabel, 'Defibrillator (AED)');
  assert.deepEqual(defib.parts.map(p => [p.part, p.expiryDate]), [['defib_pads', padsDue], ['defib_battery', batteryDue]]);
  assert.equal(defib.partsAssigneeUserId, managerPerson.id);
  const pads = defib.parts.find(p => p.part === 'defib_pads');

  const padsCheck = ok(await owner.request('GET', `/compliance-items/${pads.checkId}`));
  assert.equal(padsCheck.title, 'Replace defibrillator pads — Clubhouse AED');
  assert.equal(padsCheck.equipmentPart, 'defib_pads');
  assert.equal(padsCheck.equipmentId, defib.id);
  assert.equal(padsCheck.siteId, site.id);
  assert.equal(padsCheck.assigneeUserId, managerPerson.id);
  assert.equal(String(padsCheck.dueDate).slice(0, 10), padsDue);
  console.log('ok - a defibrillator\'s pads and battery dates become Compliance Checks due on those dates');

  const stats = ok(await owner.request('GET', '/dashboard/stats'));
  assert.ok(stats.dueSoon >= 1, 'pads due in 20 days count as due soon on the dashboard');

  // Renaming the item renames its part checks; ticked checks never unlink them.
  ok(await owner.request('PUT', `/equipment/${defib.id}`, { name: 'Bar AED', complianceItemIds: [] }));
  const renamed = ok(await owner.request('GET', `/compliance-items/${pads.checkId}`));
  assert.equal(renamed.title, 'Replace defibrillator pads — Bar AED');
  assert.equal(renamed.equipmentId, defib.id, 'part checks stay linked');

  // Adding child pads later; correcting a date moves the due date.
  const corrected = isoDay(25);
  const updated = ok(await owner.request('PUT', `/equipment/${defib.id}`, {
    partExpiryDates: { defib_pads: corrected, defib_child_pads: isoDay(300) },
  }));
  assert.deepEqual(updated.parts.map(p => p.part), ['defib_pads', 'defib_battery', 'defib_child_pads']);
  assert.equal(updated.parts.find(p => p.part === 'defib_pads').expiryDate, corrected);
  assert.equal(updated.parts.find(p => p.part === 'defib_child_pads').checkId !== pads.checkId, true);
  // Clearing a part never done removes its check.
  const childCheckId = updated.parts.find(p => p.part === 'defib_child_pads').checkId;
  const cleared = ok(await owner.request('PUT', `/equipment/${defib.id}`, { partExpiryDates: { defib_child_pads: null } }));
  assert.equal(cleared.parts.some(p => p.part === 'defib_child_pads'), false);
  assert.equal((await owner.request('GET', `/compliance-items/${childCheckId}`)).status, 404);
  console.log('ok - dates can be added, corrected and cleared; names follow the item');

  // Bad input.
  assert.equal((await owner.request('PUT', `/equipment/${defib.id}`, { partExpiryDates: { defib_pads: '2026-02-30' } })).status, 400);
  assert.equal((await owner.request('PUT', `/equipment/${defib.id}`, { partExpiryDates: { wheels: isoDay(5) } })).status, 400);
  assert.equal((await staff.request('PUT', `/equipment/${defib.id}`, { partExpiryDates: { defib_pads: isoDay(5) } })).status, 403);
  assert.equal((await other.request('PUT', `/equipment/${defib.id}`, { partExpiryDates: { defib_pads: isoDay(5) } })).status, 404);
  const otherPerson = ok(await other.request('GET', '/assignees'))[0];
  if (otherPerson) {
    assert.equal((await owner.request('PUT', `/equipment/${defib.id}`, { partsAssigneeUserId: otherPerson.id })).status, 400,
      "another business's member cannot be assigned");
  }
  console.log('ok - invalid dates, unknown parts, staff and other businesses are refused');

  // Replacing the pads: the check stays open, due on the new pads' expiry date.
  const newExpiry = isoDay(900);
  const tooEarly = await staff.request('PATCH', `/compliance-items/${pads.checkId}/status`, {
    status: 'completed', completedAt: isoDay(), nextDueDate: isoDay(),
  });
  assert.equal(tooEarly.status, 400);
  const replaced = ok(await staff.request('PATCH', `/compliance-items/${pads.checkId}/status`, {
    status: 'completed', completedAt: isoDay(), nextDueDate: newExpiry, completedInHouseBy: 'Sam Patel',
  }));
  assert.equal(replaced.status, 'pending');
  assert.equal(String(replaced.dueDate).slice(0, 10), newExpiry);
  assert.equal(String(replaced.completedAt).slice(0, 10), isoDay());
  assert.equal(replaced.needsAction, false, 'no contractor certificate is chased for a part replacement');
  const afterReplace = ok(await owner.request('GET', `/equipment?siteId=${site.id}`)).find(i => i.id === defib.id);
  const padsNow = afterReplace.parts.find(p => p.part === 'defib_pads');
  assert.equal(padsNow.expiryDate, newExpiry);
  assert.equal(padsNow.lastReplaced, isoDay());

  // nextDueDate is only for part checks.
  const plain = ok(await owner.request('POST', '/compliance-items', { title: 'Plain check', priority: 'low', siteId: site.id }), 201);
  assert.equal((await owner.request('PATCH', `/compliance-items/${plain.id}/status`, { status: 'completed', nextDueDate: isoDay(30) })).status, 400);
  console.log('ok - marking pads replaced records the new expiry date as the next due date');

  // The QR scan of the defibrillator shows its part dates.
  const labels = ok(await owner.request('GET', `/equipment-labels?siteId=${site.id}`));
  const row = labels.find(l => l.kind === 'equipment' && l.ref === String(defib.id));
  ok(await owner.request('POST', '/equipment-labels/sheet', { items: [{ kind: row.kind, ref: row.ref }] }, 'buffer'));
  const code = ok(await owner.request('GET', `/equipment-labels?siteId=${site.id}`)).find(l => l.ref === String(defib.id)).code;
  const scan = ok(await staff.request('GET', `/equipment-labels/scan/${code}`));
  assert.ok(scan.statuses.some(s => s.label === 'Replace defibrillator pads — Bar AED'), JSON.stringify(scan.statuses));
  console.log('ok - scanning the defibrillator label shows its pads and battery');
} finally {
  await pool.end();
}
