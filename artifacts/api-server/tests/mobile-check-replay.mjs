import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Mobile outbox replays for fire, legionella, hot tub, PAT, incident and pool
// records, GreenTrack pre-use checks and swim sessions (lib/clientEntryReplay.ts): a resend of an applied submission by
// the same user with the same payload returns the stored row (200) and
// creates nothing; a changed payload, another user or a concurrent duplicate
// never creates a second record. Records without an entry ID are unchanged.
const entryId = () => `mobile-${randomUUID()}`;
const count = async (table, clientId) =>
  Number((await pool.query(`SELECT count(*) FROM ${table} WHERE client_id = $1`, [clientId])).rows[0].count);

try {
  const owner = await createTenant('mobile-replay');
  const other = await createTenant('mobile-replay-other');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = await owner.request('POST', '/sites', { name: 'Replay site', seedStarterChecks: false });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  const siteId = site.data.id;
  const appliance = await owner.request('POST', '/pat-track/appliances', { name: 'Kettle', siteId });
  assert.equal(appliance.status, 201, JSON.stringify(appliance.data));
  const machine = await owner.request('POST', '/green-track/machines', { name: 'Ride-on mower', type: 'ride_on_rotary', siteId });
  assert.equal(machine.status, 201, JSON.stringify(machine.data));
  const day = isoDay(-1);

  const cases = [
    {
      name: 'fire', path: '/fire-safety', table: 'fire_safety_checks',
      body: { checkType: 'alarm', callPoint: 'CP1', checkDate: day, result: 'pass', siteId, notes: 'Bell tested' },
      changed: { notes: 'Different notes' },
    },
    {
      // A failed reading also opens a remediation action: a replay must not
      // open a second one.
      name: 'legionella', path: '/legionella', table: 'legionella_checks',
      body: { checkType: 'hot_sentinel_temp', checkDate: day, result: 'fail', temperature: 41.5, siteId },
      changed: { temperature: 42 },
    },
    {
      name: 'hot tub', path: '/hot-tub', table: 'hot_tub_checks',
      body: { checkType: 'water_chemistry', checkDate: day, result: 'pass', phValue: 7.4, sanitiserLevel: 4, siteId },
      changed: { phValue: 7.6 },
    },
    {
      name: 'PAT', path: '/pat-track/tests', table: 'pat_tests',
      body: { applianceId: appliance.data.id, testDate: day, result: 'pass', nextTestDate: isoDay(364), testedBy: 'Tester' },
      changed: { result: 'fail' },
    },
    {
      name: 'incident', path: '/incidents', table: 'incidents',
      body: {
        incidentType: 'accident', incidentDate: day, location: 'Kitchen', description: 'Slipped on wet floor',
        involvedName: 'A Person', reportedBy: 'Manager', riddorReportable: false, reportedToHse: false,
        riddorRationale: 'Minor slip, no injury', siteId,
      },
      changed: { description: 'Tripped on a step' },
    },
    {
      name: 'pool', path: '/pool-track', table: 'pool_checks',
      body: { checkType: 'routine', checkDate: day, phLevel: 7.4, freeChlorine: 1.5, siteId },
      changed: { phLevel: 7.8 },
    },
    {
      name: 'GreenTrack', path: '/green-track/pre-use-checks', table: 'green_pre_use_checks',
      body: {
        machineId: machine.data.id, checkDate: day, operator: 'Operator',
        checklistItems: [{ key: 'tyres', label: 'Tyres', section: 'General', status: 'ok' }],
      },
      changed: { notes: 'Different notes' },
      // Photo receipts are single-use, so a resend may carry new ones.
      photoReplay: true,
    },
    {
      name: 'swim session', path: '/swim-track/sessions', table: 'swim_sessions',
      body: { sessionDate: day, sessionType: 'public_swim', lifeguardName: 'Lifeguard', preSessionResult: 'pass', siteId },
      changed: { notes: 'Different notes' },
      photoReplay: true,
    },
  ];

  for (const { name, path, table, body, changed, photoReplay } of cases) {
    const before = await count(table, owner.clientId);
    const actionsBefore = await count('compliance_actions', owner.clientId);
    const sent = { ...body, clientEntryId: entryId() };

    const first = await owner.request('POST', path, sent);
    assert.equal(first.status, 201, `${name}: first send creates (${JSON.stringify(first.data)})`);
    const actionsAfterFirst = await count('compliance_actions', owner.clientId);

    const replay = await owner.request('POST', path, sent);
    assert.equal(replay.status, 200, `${name}: a lost-response replay is recognised (${JSON.stringify(replay.data)})`);
    assert.equal(replay.data.id, first.data.id, `${name}: replay returns the stored record`);
    // Key order is not part of the payload identity.
    const reordered = Object.fromEntries(Object.entries(sent).reverse());
    assert.equal((await owner.request('POST', path, reordered)).status, 200, `${name}: same payload in another key order`);
    if (photoReplay) {
      const resent = await owner.request('POST', path, { ...sent, photoUploadIds: [] });
      assert.equal(resent.status, 200, `${name}: photo receipts are not part of the payload identity (${JSON.stringify(resent.data)})`);
      assert.equal(resent.data.id, first.data.id);
    }

    const conflict = await owner.request('POST', path, { ...sent, ...changed });
    assert.equal(conflict.status, 409, `${name}: an entry ID cannot hide a changed payload`);
    assert.equal(conflict.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal((await staff.request('POST', path, sent)).status, 409, `${name}: the entry belongs to the user who sent it`);
    assert.equal(await count(table, owner.clientId), before + 1, `${name}: exactly one record was created`);
    assert.equal(await count('compliance_actions', owner.clientId), actionsAfterFirst, `${name}: replays add no follow-up actions`);
    if (name === 'legionella') assert.equal(actionsAfterFirst, actionsBefore + 1, 'the failed reading opened one action');

    // Concurrent duplicates (two in-flight attempts): one creates, one replays.
    const racing = { ...body, clientEntryId: entryId() };
    const both = await Promise.all([owner.request('POST', path, racing), owner.request('POST', path, racing)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], `${name}: ${JSON.stringify(both.map((r) => r.data))}`);
    assert.equal(both[0].data.id, both[1].data.id);
    assert.equal(await count(table, owner.clientId), before + 2);

    // Web submissions without an entry ID keep creating a record each time.
    assert.equal((await owner.request('POST', path, body)).status, 201);
    assert.equal((await owner.request('POST', path, body)).status, 201);
    assert.equal(await count(table, owner.clientId), before + 4, `${name}: records without an entry ID are not deduplicated`);

    // Entry IDs are per client: another business reusing one is unaffected,
    // and nothing about this client's record is revealed.
    if (name === 'fire') {
      const foreign = await other.request('POST', path, { ...sent, siteId: null });
      assert.equal(foreign.status, 201, `${name}: another client's identical ID is independent`);
      assert.notEqual(foreign.data.id, first.data.id);
    }
    assert.equal((await owner.request('POST', path, { ...body, clientEntryId: 'short' })).status, 400, `${name}: entry IDs are validated`);
  }

  // Updates never accept or overwrite the device entry ID.
  const fire = await owner.request('POST', '/fire-safety', {
    checkType: 'fire_doors', checkDate: day, result: 'pass', siteId, clientEntryId: entryId(),
  });
  const stored = (await pool.query('SELECT client_entry_id FROM fire_safety_checks WHERE id = $1', [fire.data.id])).rows[0];
  assert.equal((await owner.request('PUT', `/fire-safety/${fire.data.id}`, { notes: 'Edited', clientEntryId: entryId() })).status, 200);
  assert.equal((await pool.query('SELECT client_entry_id FROM fire_safety_checks WHERE id = $1', [fire.data.id])).rows[0].client_entry_id,
    stored.client_entry_id, 'an edit keeps the original entry ID');

  console.log('Fire, legionella, hot tub, PAT, incident, pool, GreenTrack and swim session mobile replays: idempotent per user and payload, concurrent-safe, per-client, web unaffected.');
} finally { await pool.end(); }
