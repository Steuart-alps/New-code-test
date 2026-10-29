import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Departments sit under a site (departments.site_id). Staff in such a
// department see only that site and its records; a department with no site
// still spans every site, as all departments did before.
async function insertFireCheck(clientId, siteId) {
  const { rows } = await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result)
     VALUES ($1, $2, 'alarm', $3, 'pass') RETURNING id`,
    [clientId, siteId, isoDay()],
  );
  return rows[0].id;
}

async function insertComplianceItem(clientId, siteId, title) {
  const { rows } = await pool.query(
    'INSERT INTO compliance_items (client_id, site_id, title) VALUES ($1, $2, $3) RETURNING id',
    [clientId, siteId, title],
  );
  return rows[0].id;
}

const ids = rows => rows.map(row => row.id).sort((a, b) => a - b);

try {
  const owner = await createTenant('dept-sites');
  const makeSite = async name => {
    const site = await owner.request('POST', '/sites', { name, seedStarterChecks: false });
    assert.equal(site.status, 201, JSON.stringify(site.data));
    return site.data.id;
  };
  const siteA = await makeSite('Main Hotel');
  const siteB = await makeSite('Lodge');
  const makeDepartment = async body => {
    const created = await owner.request('POST', '/departments', body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data;
  };

  // The same name can sit under two sites; GET /departments names each site.
  const housekeepingA = await makeDepartment({ name: 'Housekeeping', siteId: siteA });
  const housekeepingB = await makeDepartment({ name: 'Housekeeping', siteId: siteB });
  const office = await makeDepartment({ name: 'Office' });
  assert.equal(housekeepingA.siteId, siteA);
  assert.equal(office.siteId, null, 'a department with no site spans every site');
  const listed = await owner.request('GET', '/departments');
  assert.equal(listed.status, 200);
  const byId = new Map(listed.data.map(row => [row.id, row]));
  assert.equal(byId.get(housekeepingA.id).siteName, 'Main Hotel');
  assert.equal(byId.get(housekeepingB.id).siteName, 'Lodge');
  assert.equal(byId.get(office.id).siteName, null);
  const atLodge = await owner.request('GET', `/departments?siteId=${siteB}`);
  assert.deepEqual(atLodge.data.map(row => row.id), [housekeepingB.id]);

  // Another business's site is refused.
  const other = await createTenant('dept-sites-other');
  const otherSite = await other.request('POST', '/sites', { name: 'Elsewhere', seedStarterChecks: false });
  assert.equal(otherSite.status, 201);
  const foreign = await owner.request('POST', '/departments', { name: 'Kitchen', siteId: otherSite.data.id });
  assert.equal(foreign.status, 400, JSON.stringify(foreign.data));
  const foreignMove = await owner.request('PUT', `/departments/${office.id}`, { siteId: otherSite.data.id });
  assert.equal(foreignMove.status, 400, JSON.stringify(foreignMove.data));

  const staffA = await createUser(owner, { role: 'client_staff', departmentId: housekeepingA.id });
  const officeStaff = await createUser(owner, { role: 'client_staff', departmentId: office.id });

  // Sites: a site-bound department sees only its site.
  let sites = await staffA.request('GET', '/sites');
  assert.equal(sites.status, 200);
  assert.deepEqual(ids(sites.data), [siteA]);
  assert.equal((await staffA.request('GET', `/sites/${siteB}`)).status, 403);
  assert.equal((await staffA.request('GET', `/sites/${siteA}`)).status, 200);
  sites = await officeStaff.request('GET', '/sites');
  assert.deepEqual(ids(sites.data), [siteA, siteB].sort((a, b) => a - b), 'a department with no site sees every site');

  // Records follow the site.
  const fireA = await insertFireCheck(owner.clientId, siteA);
  const fireB = await insertFireCheck(owner.clientId, siteB);
  let fire = await staffA.request('GET', '/fire-safety');
  assert.equal(fire.status, 200, JSON.stringify(fire.data));
  assert.deepEqual(ids(fire.data), [fireA]);
  fire = await officeStaff.request('GET', '/fire-safety');
  assert.deepEqual(ids(fire.data), [fireA, fireB]);
  const itemA = await insertComplianceItem(owner.clientId, siteA, 'Main Hotel check');
  const itemB = await insertComplianceItem(owner.clientId, siteB, 'Lodge check');
  const items = await staffA.request('GET', '/compliance-items');
  assert.equal(items.status, 200, JSON.stringify(items.data));
  const itemIds = items.data.map(row => row.id);
  assert.ok(itemIds.includes(itemA) && !itemIds.includes(itemB), JSON.stringify(itemIds));
  assert.equal((await staffA.request('GET', `/compliance-items/${itemB}`)).status, 403);

  // Writes at another site are refused.
  const drill = siteId => ({ checkType: 'fire_drill', checkDate: isoDay(), result: 'pass', siteId, nightStaff: 'included' });
  const wrongSite = await staffA.request('POST', '/fire-safety', drill(siteB));
  assert.equal(wrongSite.status, 403, JSON.stringify(wrongSite.data));
  const ownSite = await staffA.request('POST', '/fire-safety', drill(siteA));
  assert.equal(ownSite.status, 201, JSON.stringify(ownSite.data));

  // A site can be given only to a department that spans every site or sits under it.
  const mismatch = await owner.request('PATCH', `/sites/${siteA}`, { departmentId: housekeepingB.id });
  assert.equal(mismatch.status, 400, JSON.stringify(mismatch.data));
  const given = await owner.request('PATCH', `/sites/${siteB}`, { departmentId: office.id });
  assert.equal(given.status, 200, JSON.stringify(given.data));
  // ...and a department can't move under one site while it is given another.
  const blocked = await owner.request('PUT', `/departments/${office.id}`, { siteId: siteA });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.equal(blocked.data.code, 'DEPARTMENT_HAS_OTHER_SITES');
  assert.equal((await owner.request('PATCH', `/sites/${siteB}`, { departmentId: null })).status, 200);

  // Moving a department changes what its staff see straight away.
  const moved = await owner.request('PUT', `/departments/${office.id}`, { siteId: siteB });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.siteId, siteB);
  sites = await officeStaff.request('GET', '/sites');
  assert.deepEqual(ids(sites.data), [siteB]);
  fire = await officeStaff.request('GET', '/fire-safety');
  assert.deepEqual(ids(fire.data), [fireB]);
  assert.equal((await owner.request('PUT', `/departments/${office.id}`, { siteId: null })).status, 200);
  sites = await officeStaff.request('GET', '/sites');
  assert.equal(sites.data.length, 2);

  // A Manager with departments at both sites works at one site at a time.
  const manager = await createUser(owner, { role: 'client_manager', departmentIds: [housekeepingA.id, housekeepingB.id] });
  sites = await manager.request('GET', '/sites');
  assert.deepEqual(ids(sites.data), [siteA], 'starts in the main department');
  const switched = await manager.request('PUT', '/users/me/active-department', { departmentId: housekeepingB.id });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  sites = await manager.request('GET', '/sites');
  assert.deepEqual(ids(sites.data), [siteB]);
  fire = await manager.request('GET', '/fire-safety');
  assert.deepEqual(ids(fire.data), [fireB]);

  // The staff roster follows the site too: staff see the people at their own
  // site and those with no site; Viewers can't read the roster at all.
  const rosterEntry = async (name, siteId) => (await pool.query(
    'INSERT INTO staff_roster (client_id, site_id, name) VALUES ($1, $2, $3) RETURNING id',
    [owner.clientId, siteId, name],
  )).rows[0].id;
  const rosterA = await rosterEntry('Ann at the hotel', siteA);
  const rosterB = await rosterEntry('Ben at the lodge', siteB);
  const rosterAny = await rosterEntry('Cat with no site', null);
  const rosterIds = async (who, path = '/staff-roster') => {
    const listed = await who.request('GET', path);
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    return ids(listed.data);
  };
  const roster = [rosterA, rosterB, rosterAny];
  assert.deepEqual(await rosterIds(owner), roster, 'Owners see everyone');
  assert.deepEqual(await rosterIds(staffA), [rosterA, rosterAny], 'staff see their own site');
  assert.deepEqual(await rosterIds(staffA, '/staff'), [rosterA, rosterAny], 'the PIN roster list matches');
  assert.deepEqual(await rosterIds(manager), [rosterB, rosterAny], 'a Manager sees the site they are working at');
  assert.equal((await manager.request('PUT', '/users/me/active-department', { departmentId: housekeepingA.id })).status, 200);
  assert.deepEqual(await rosterIds(manager), [rosterA, rosterAny]);
  const viewer = await createUser(owner, { role: 'client_viewer', staffRosterId: rosterB });
  assert.equal((await viewer.request('GET', '/staff-roster')).status, 403, 'Viewers never see the roster');

  // Owners see everything.
  sites = await owner.request('GET', '/sites');
  assert.equal(sites.data.length, 2);

  // Removing a site removes the departments under it; their staff are unassigned.
  assert.equal((await owner.request('DELETE', `/sites/${siteB}`)).status, 204);
  const { rows: gone } = await pool.query('SELECT id FROM departments WHERE id = $1', [housekeepingB.id]);
  assert.equal(gone.length, 0);

  console.log('Departments under sites tests passed.');
} finally {
  await pool.end();
}
