import assert from 'node:assert/strict';
import { createTenant, createUser, pool } from './approval-workflow-fixtures.mjs';

// One Owner login for several businesses (Nov 2026). An Owner of business B
// adds the Owner of business A by their sign-in email; A's Owner keeps one
// login, switches between A and B, and only ever sees the business they are
// working in. B's Owner gains nothing in A.
try {
  const ownerA = await createTenant('owner-a');
  const ownerB = await createTenant('owner-b');
  const meA = (await ownerA.request('GET', '/auth/me')).data.user;
  const meB = (await ownerB.request('GET', '/auth/me')).data.user;
  assert.equal(meA.businesses, undefined, 'one business: no business list');

  const siteA = await ownerA.request('POST', '/sites', { name: 'Paultons', seedStarterChecks: false });
  const siteB = await ownerB.request('POST', '/sites', { name: 'Bell Inn', seedStarterChecks: false });
  assert.equal(siteA.status, 201);
  assert.equal(siteB.status, 201);

  // Only an Owner can add an existing login; a Manager adding an Owner is refused.
  const managerB = await createUser(ownerB, { role: 'client_manager', allDepartments: true });
  const byManager = await managerB.request('POST', '/users', { name: meA.name, email: meA.email, role: 'client_admin' });
  assert.equal(byManager.status, 403, JSON.stringify(byManager.data));

  // A Staff login elsewhere is not linked: it stays one account per address.
  const staffA = await createUser(ownerA, { role: 'client_staff' });
  const staffRow = (await pool.query('SELECT email FROM users WHERE id = $1', [staffA.userId])).rows[0];
  const staffAsOwner = await ownerB.request('POST', '/users', { name: 'Staff', email: staffRow.email, role: 'client_admin' });
  assert.equal(staffAsOwner.status, 409, JSON.stringify(staffAsOwner.data));

  // B's Owner adds A's Owner (email typed in a different case).
  const added = await ownerB.request('POST', '/users', { name: meA.name, email: meA.email.toUpperCase(), role: 'client_admin' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.addedOwner, true);
  assert.equal(added.data.id, meA.id, 'the existing login is used, no new account');
  assert.equal(added.data.clientId, ownerB.clientId);
  const again = await ownerB.request('POST', '/users', { name: meA.name, email: meA.email, role: 'client_admin' });
  assert.equal(again.status, 409, 'adding twice is refused');

  // B's user list shows them, marked; their own business is unchanged.
  const listB = await ownerB.request('GET', '/users');
  const listed = listB.data.find(row => row.id === meA.id);
  assert.ok(listed, 'the added Owner is listed in B');
  assert.equal(listed.addedOwner, true);
  const ownRow = (await pool.query('SELECT client_id, role FROM users WHERE id = $1', [meA.id])).rows[0];
  assert.equal(ownRow.client_id, ownerA.clientId);
  assert.equal(ownRow.role, 'client_admin');

  // A's Owner now has both businesses and starts in their own.
  let me = (await ownerA.request('GET', '/auth/me')).data;
  assert.deepEqual(me.user.businesses.map(b => b.id), [ownerA.clientId, ownerB.clientId]);
  assert.equal(me.user.clientId, ownerA.clientId);
  assert.equal(me.client.id, ownerA.clientId);
  let sites = await ownerA.request('GET', '/sites');
  assert.deepEqual(sites.data.map(s => s.id), [siteA.data.id]);

  // Switch to B: every page is B's, and A's records are out of reach.
  const switched = await ownerA.request('PUT', '/users/me/active-business', { businessId: ownerB.clientId });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  me = (await ownerA.request('GET', '/auth/me')).data;
  assert.equal(me.user.clientId, ownerB.clientId);
  assert.equal(me.user.ownBusinessId, ownerA.clientId);
  assert.equal(me.client.id, ownerB.clientId);
  sites = await ownerA.request('GET', '/sites');
  assert.deepEqual(sites.data.map(s => s.id), [siteB.data.id]);
  assert.equal((await ownerA.request('GET', `/sites/${siteA.data.id}`)).status, 403, 'A is closed while working in B');
  const madeInB = await ownerA.request('POST', '/sites', { name: 'Newark', seedStarterChecks: false });
  assert.equal(madeInB.status, 201);
  assert.equal((await pool.query('SELECT client_id FROM sites WHERE id = $1', [madeInB.data.id])).rows[0].client_id, ownerB.clientId);

  // A business that isn't theirs can't be chosen.
  const stranger = await createTenant('owner-c');
  const refused = await ownerA.request('PUT', '/users/me/active-business', { businessId: stranger.clientId });
  assert.equal(refused.status, 404);
  assert.equal((await ownerA.request('GET', `/sites?clientId=${stranger.clientId}`)).status, 403);

  // B's Owner gains nothing in A, and can't edit A's Owner.
  assert.equal((await ownerB.request('GET', `/sites/${siteA.data.id}`)).status, 403);
  assert.equal((await ownerB.request('PUT', `/users/${meA.id}`, { name: 'Renamed' })).status, 403);
  assert.equal(meB.businesses, undefined);

  // Owners of B include the added Owner when B's Owners are emailed.
  const owners = await pool.query(
    `SELECT u.id FROM users u WHERE u.role = 'client_admin' AND (u.client_id = $1
       OR EXISTS (SELECT 1 FROM owner_businesses ob WHERE ob.user_id = u.id AND ob.client_id = $1)) ORDER BY u.id`,
    [ownerB.clientId],
  );
  assert.deepEqual(owners.rows.map(r => r.id).sort(), [meA.id, meB.id].sort());

  // Taking them off B removes only the link; they fall back to their own business.
  const removed = await ownerB.request('DELETE', `/users/${meA.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.removedFromBusiness, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [meA.id])).rows[0].n, 1);
  me = (await ownerA.request('GET', '/auth/me')).data;
  assert.equal(me.user.clientId, ownerA.clientId, 'back in their own business');
  assert.equal(me.user.businesses, undefined);
  sites = await ownerA.request('GET', '/sites');
  assert.deepEqual(sites.data.map(s => s.id), [siteA.data.id]);

  console.log('Owner of several businesses tests passed.');
} finally {
  await pool.end();
}
