// BikeTrack overdue-reminder cadence: endpoint-level role and validation checks.
// The cadence is client-wide, so only client admins and consultants with access
// to the client may change it; staff and viewers are refused.
// Run: pnpm --filter @workspace/api-server run test:biketrack-config-cadence
import assert from 'node:assert/strict';
import { createTenant, createUser, db, sql, pool } from './approval-workflow-fixtures.mjs';

const KEY = 'bike_overdue_repeat_interval_days';
const CONFIG = '/bike-track/config';

async function cadence(session, query = '') {
  const read = await session.request('GET', `${CONFIG}${query}`);
  assert.equal(read.status, 200, JSON.stringify(read.data));
  return read.data[KEY];
}

try {
  // Self-service sign-up owners are consultants linked to their own business.
  const owner = await createTenant('bike-cadence');
  const otherTenant = await createTenant('bike-cadence-other');
  const outsider = await createTenant('bike-cadence-outsider');
  const admin = await createUser(owner, { role: 'client_admin' });
  const staff = await createUser(owner, { role: 'client_staff' });
  const viewer = await createUser(owner, { role: 'client_viewer' });
  const ownerQuery = `?clientId=${owner.clientId}`;

  // A consultant from another account who is explicitly linked to this client.
  await db.execute(sql`
    INSERT INTO consultant_clients (user_id, client_id) VALUES (${otherTenant.userId}, ${owner.clientId})
  `);

  assert.equal(await cadence(admin), '0', 'cadence defaults to a one-time alert');

  // Client admins and authorized consultants can save every valid choice.
  for (const value of ['1', '3', '7', '14', '0']) {
    const saved = await admin.request('PUT', CONFIG, { [KEY]: value });
    assert.equal(saved.status, 200, `client admin saves ${value}: ${JSON.stringify(saved.data)}`);
    assert.equal(await cadence(admin), value, `config read returns admin choice ${value}`);
  }
  const ownerSave = await owner.request('PUT', CONFIG, { [KEY]: '7' });
  assert.equal(ownerSave.status, 200, `owning consultant saves cadence: ${JSON.stringify(ownerSave.data)}`);
  assert.equal(await cadence(staff), '7', 'staff read the client-wide choice');

  const linkedSave = await otherTenant.request('PUT', `${CONFIG}${ownerQuery}`, { [KEY]: '14' });
  assert.equal(linkedSave.status, 200, `linked consultant saves cadence: ${JSON.stringify(linkedSave.data)}`);
  assert.equal(await cadence(admin), '14', 'config read returns the linked consultant choice');
  assert.equal(await cadence(otherTenant, ownerQuery), '14', 'linked consultant reads the client choice');
  assert.equal(await cadence(otherTenant), '0', "the linked consultant's own business is unchanged");

  // Staff and viewers are forbidden, alone or combined with other settings.
  for (const [label, session] of [['client staff', staff], ['client viewer', viewer]]) {
    const denied = await session.request('PUT', CONFIG, { [KEY]: '1' });
    assert.equal(denied.status, 403, `${label} cannot change cadence: ${JSON.stringify(denied.data)}`);
    const bundled = await session.request('PUT', CONFIG, { bike_hire_duration_hours: '6', [KEY]: '3' });
    assert.equal(bundled.status, 403, `${label} cannot change cadence alongside other settings`);
  }
  const afterDenied = (await admin.request('GET', CONFIG)).data;
  assert.equal(afterDenied[KEY], '14', 'forbidden requests leave cadence unchanged');
  assert.equal(afterDenied.bike_hire_duration_hours, '', 'a refused request writes no other setting either');

  // A consultant without access to this client cannot change it.
  const outsiderSave = await outsider.request('PUT', `${CONFIG}${ownerQuery}`, { [KEY]: '1' });
  assert.equal(outsiderSave.status, 403, `unlinked consultant is refused: ${JSON.stringify(outsiderSave.data)}`);
  assert.equal(await cadence(outsider), '0', "unlinked consultant's own business is unchanged");
  assert.equal(await cadence(admin), '14', 'unlinked consultant does not change the client');

  // Unsupported values are rejected and never stored.
  for (const value of ['2', '7.0', ' 7', '-1', '', 'weekly', 7, null, true, ['7']]) {
    const rejected = await admin.request('PUT', CONFIG, { [KEY]: value });
    assert.equal(rejected.status, 400, `rejects ${JSON.stringify(value)}: ${JSON.stringify(rejected.data)}`);
  }
  assert.equal(await cadence(admin), '14', 'rejected values leave the saved choice intact');
  const stored = await db.execute(sql`
    SELECT value FROM app_settings WHERE client_id = ${owner.clientId} AND key = ${KEY}
  `);
  assert.deepEqual(stored.rows.map((row) => row.value), ['14'], 'exactly one valid stored setting');

  console.log('BikeTrack reminder cadence endpoint tests passed.');
} finally {
  await pool.end().catch(() => {});
}
