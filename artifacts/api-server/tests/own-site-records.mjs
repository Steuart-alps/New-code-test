import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// One site can't create records for another (Steuart, 4 Nov 2026). Staff and
// Managers whose department sits under a site save records to that site only,
// on every track: another site's id is refused, and a new record sent without
// a site is saved to theirs. Owners and people in a department that spans
// every site are not limited.
const legionella = siteId => ({ siteId, checkType: 'calorifier_inspection', checkDate: isoDay(), result: 'pass' });

async function siteOf(table, id) {
  const { rows } = await pool.query(`SELECT site_id FROM ${table} WHERE id = $1`, [id]);
  return rows[0]?.site_id ?? null;
}

try {
  const owner = await createTenant('own-site');
  const makeSite = async name => {
    const site = await owner.request('POST', '/sites', { name, seedStarterChecks: false });
    assert.equal(site.status, 201, JSON.stringify(site.data));
    return site.data.id;
  };
  const siteA = await makeSite('Main Hotel');
  const siteB = await makeSite('Lodge');
  const department = async body => {
    const created = await owner.request('POST', '/departments', body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.id;
  };
  const kitchenA = await department({ name: 'Kitchen', siteId: siteA });
  const office = await department({ name: 'Office' });
  const staffA = await createUser(owner, { role: 'client_staff', departmentId: kitchenA });
  const managerA = await createUser(owner, { role: 'client_manager', departmentId: kitchenA });
  const officeStaff = await createUser(owner, { role: 'client_staff', departmentId: office });

  // LegionellaTrack: another site is refused, the user's own site is saved.
  for (const user of [staffA, managerA]) {
    const other = await user.request('POST', '/legionella', legionella(siteB));
    assert.equal(other.status, 403, JSON.stringify(other.data));
    assert.equal(other.data.code, 'other_site');
    const own = await user.request('POST', '/legionella', legionella(siteA));
    assert.equal(own.status, 201, JSON.stringify(own.data));
    assert.equal(await siteOf('legionella_checks', own.data.id), siteA);
  }

  // A new record without a site goes to the user's own site, not to every site.
  const blank = await staffA.request('POST', '/legionella', legionella(null));
  assert.equal(blank.status, 201, JSON.stringify(blank.data));
  assert.equal(await siteOf('legionella_checks', blank.data.id), siteA);

  // An edit can't move a record to another site.
  const move = await staffA.request('PUT', `/legionella/${blank.data.id}`, { siteId: siteB });
  assert.equal(move.status, 403, JSON.stringify(move.data));
  assert.equal(await siteOf('legionella_checks', blank.data.id), siteA);

  // The same rule on another track (FixTrack).
  const issue = { title: 'Dripping tap', location: 'Kitchen', reportedBy: 'Sam', reportedDate: isoDay() };
  const issueOther = await staffA.request('POST', '/fix-track/issues', { ...issue, siteId: siteB });
  assert.equal(issueOther.status, 403, JSON.stringify(issueOther.data));
  const issueBlank = await staffA.request('POST', '/fix-track/issues', { ...issue, siteId: null });
  assert.ok([200, 201].includes(issueBlank.status), JSON.stringify(issueBlank.data));
  assert.equal(await siteOf('fix_track_issues', issueBlank.data.id), siteA);

  // Owners, and staff in a department that spans every site, can record anywhere.
  const ownerB = await owner.request('POST', '/legionella', legionella(siteB));
  assert.equal(ownerB.status, 201, JSON.stringify(ownerB.data));
  const officeB = await officeStaff.request('POST', '/legionella', legionella(siteB));
  assert.equal(officeB.status, 201, JSON.stringify(officeB.data));
  const ownerBlank = await owner.request('POST', '/legionella', legionella(null));
  assert.equal(ownerBlank.status, 201, JSON.stringify(ownerBlank.data));
  assert.equal(await siteOf('legionella_checks', ownerBlank.data.id), null, 'an Owner can still record for no particular site');

  console.log('Own-site records checks passed: site staff and Managers save only to their own site; Owners and every-site departments are unchanged.');
} finally {
  await pool.end();
}
