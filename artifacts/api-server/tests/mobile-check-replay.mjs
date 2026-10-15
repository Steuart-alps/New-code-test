import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { base, createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

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
  // Service records and PUWER inspections are admin-only: the "another user"
  // check there uses a second admin.
  const secondAdmin = await createUser(owner, { role: 'client_admin' });
  const site = await owner.request('POST', '/sites', { name: 'Replay site', seedStarterChecks: false });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  const siteId = site.data.id;
  const appliance = await owner.request('POST', '/pat-track/appliances', { name: 'Kettle', siteId });
  assert.equal(appliance.status, 201, JSON.stringify(appliance.data));
  const machine = await owner.request('POST', '/green-track/machines', { name: 'Ride-on mower', type: 'ride_on_rotary', siteId });
  assert.equal(machine.status, 201, JSON.stringify(machine.data));
  const serviceBike = await owner.request('POST', '/bike-track/bikes', { ref: 'SVC-01', type: 'hybrid', siteId });
  assert.equal(serviceBike.status, 201, JSON.stringify(serviceBike.data));
  const day = isoDay(-1);

  const cases = [
    {
      name: 'fire', path: '/fire-safety', table: 'fire_safety_checks',
      body: { checkType: 'alarm', checkDate: day, result: 'pass', siteId, notes: 'Bell tested' },
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
    {
      name: 'premises inspection', path: '/premises-track', table: 'premises_inspections',
      body: {
        inspectionDate: day, inspectionType: 'hazard', area: 'Stairwell', findings: 'Loose stair nosing',
        hazardDetails: 'Trip hazard', actionRequired: 'Refix the nosing', status: 'open', inspectedBy: 'Inspector', siteId,
      },
      changed: { findings: 'Different findings' },
    },
    {
      // A failed inspection raises a track action (database trigger on
      // insert): a replay must not raise a second one (checked after the loop).
      name: 'TreeTrack', path: '/tree-track', table: 'tree_inspections',
      body: {
        checkType: 'visual_assessment', checkDate: day, result: 'fail', actionSeverity: 'action_required',
        treeRef: 'T1', location: 'North boundary', inspector: 'Arborist', followUpDate: isoDay(30), siteId, notes: null,
      },
      changed: { actionSeverity: 'urgent_action' },
    },
    {
      name: 'pest activity', path: '/pest-track/activity', table: 'pest_activity',
      body: {
        recordedDate: day, pestType: 'rodent', evidenceType: 'droppings', severity: 'high',
        location: 'Bin store', recordedBy: 'Porter', resolved: false, siteId,
      },
      changed: { severity: 'low' },
    },
    {
      name: 'pest visit', path: '/pest-track/visits', table: 'pest_visits',
      body: {
        visitDate: day, contractorName: 'J Smith', contractorCompany: 'ABC Pest Control',
        findings: 'No activity', nextVisitDate: isoDay(90), signedOffBy: 'Manager', siteId,
      },
      changed: { findings: 'Droppings in cellar' },
    },
    {
      name: 'swim surveillance', path: '/swim-track/surveillance', table: 'swim_surveillance_checks',
      body: {
        checkDate: day, checkTime: '10:15', batherCount: 12, scanCompleted: true, observations: 'Clear',
        checkedBy: 'Lifeguard', result: 'pass', siteId,
      },
      changed: { batherCount: 20 },
      photoReplay: true,
    },
    {
      // A kit item not ready fails the check and raises a track action
      // (database trigger on insert): checked after the loop.
      name: 'swim first aid', path: '/swim-track/first-aid', table: 'swim_first_aid_checks',
      body: {
        checkDate: day, aedOk: true, firstAidKitOk: false, rescuePoleOk: true, throwBagOk: true,
        spineBoardOk: true, ringBuoyOk: true, oxygenKitOk: true, checkedBy: 'Lifeguard',
        defectsFound: 'Kit missing plasters', notes: null, siteId,
      },
      changed: { defectsFound: 'Ring buoy line frayed' },
      photoReplay: true,
    },
    {
      name: 'swim incident', path: '/swim-track/incidents', table: 'swim_incidents',
      body: {
        incidentDate: day, incidentTime: '14:30', incidentType: 'minor_injury', severity: 'medium',
        personsInvolved: '1 adult bather', description: 'Grazed knee on pool steps', actionTaken: 'First aid given',
        reportedTo: null, reportedDate: null, outcome: null, notes: null, siteId,
      },
      changed: { severity: 'high' },
      photoReplay: true,
    },
    {
      name: 'GreenTrack defect', path: '/green-track/defects', table: 'green_defects',
      body: {
        machineId: machine.data.id, reportDate: day, reportedBy: 'Operator', description: 'Cracked guard',
        severity: 'major', outOfService: true, notes: null,
      },
      changed: { severity: 'critical' },
      photoReplay: true,
    },
    {
      name: 'GreenTrack fuel log', path: '/green-track/fuel-logs', table: 'green_fuel_logs',
      body: {
        machineId: machine.data.id, logDate: day, fuelType: 'diesel', quantityLitres: 25.5, engineHours: 512,
        costPence: 3150, filledBy: 'Operator', notes: null,
      },
      changed: { quantityLitres: 30 },
    },
    {
      name: 'GreenTrack service record', path: '/green-track/service-records', table: 'green_service_records',
      body: {
        machineId: machine.data.id, serviceDate: day, serviceType: 'scheduled', hoursAtService: 450, nextServiceHours: 550,
        nextServiceDate: isoDay(180), workPerformed: 'Oil and filter change', servicedBy: 'Mechanic', costPence: 12000, notes: null,
      },
      changed: { workPerformed: 'Blade sharpening' },
      photoReplay: true,
      otherUser: secondAdmin,
    },
    {
      // A failed inspection raises a Compliance Hub action (database trigger
      // on insert): a replay must not raise a second one (checked after the loop).
      name: 'GreenTrack PUWER inspection', path: '/green-track/puwer-inspections', table: 'green_puwer_inspections',
      body: {
        machineId: machine.data.id, inspectionDate: day, nextInspectionDate: isoDay(365), inspectionType: 'thorough_examination',
        inspectorName: 'Inspector', inspectorCompany: 'Safe Co', certRef: 'PUWER-1', safeToOperate: false,
        defectsFound: 'Worn brake pads', result: 'fail', notes: null,
      },
      changed: { certRef: 'PUWER-2' },
      otherUser: secondAdmin,
    },
    {
      name: 'bike service', path: '/bike-track/services', table: 'bike_services',
      body: {
        bikeId: serviceBike.data.id, serviceDate: day, serviceType: 'annual', servicedBy: 'Cycle Co',
        nextServiceDate: isoDay(364), costPence: 4500,
      },
      changed: { costPence: 5000 },
    },
  ];

  for (const { name, path, table, body, changed, photoReplay, otherUser = staff } of cases) {
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
    assert.equal((await otherUser.request('POST', path, sent)).status, 409, `${name}: the entry belongs to the user who sent it`);
    if (otherUser !== staff) {
      assert.equal((await staff.request('POST', path, sent)).status, 403, `${name}: stays a manager-only record`);
    }
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

  // TreeTrack: one track action per stored failed inspection, none per replay.
  const treeActions = Number((await pool.query(
    "SELECT count(*) FROM track_actions WHERE client_id = $1 AND source_kind = 'tree_inspections'", [owner.clientId],
  )).rows[0].count);
  assert.equal(treeActions, await count('tree_inspections', owner.clientId), 'TreeTrack: replays raise no second track action');
  const firstAidActions = Number((await pool.query(
    "SELECT count(*) FROM track_actions WHERE client_id = $1 AND source_kind = 'swim_first_aid_checks'", [owner.clientId],
  )).rows[0].count);
  assert.equal(firstAidActions, await count('swim_first_aid_checks', owner.clientId), 'first aid: replays raise no second track action');

  // Swim records only reference this client's own sites and sessions.
  for (const [path, body] of [
    ['/swim-track/surveillance', { checkDate: day, siteId }],
    ['/swim-track/first-aid', { checkDate: day, siteId }],
    ['/swim-track/incidents', { incidentDate: day, description: 'Slip', siteId }],
  ]) {
    const foreign = await other.request('POST', path, { ...body, clientEntryId: entryId() });
    assert.equal(foreign.status, 400, `${path}: another client's site is refused (${JSON.stringify(foreign.data)})`);
  }
  const ownSession = (await pool.query('SELECT id FROM swim_sessions WHERE client_id = $1 LIMIT 1', [owner.clientId])).rows[0].id;
  assert.equal((await other.request('POST', '/swim-track/surveillance', { checkDate: day, sessionId: ownSession })).status, 400,
    "surveillance: another client's swim session is refused");

  const puwerActions = Number((await pool.query(
    "SELECT count(*) FROM track_actions WHERE client_id = $1 AND source_kind = 'green_puwer_inspections'", [owner.clientId],
  )).rows[0].count);
  assert.equal(puwerActions, await count('green_puwer_inspections', owner.clientId), 'PUWER: replays raise no second track action');

  // RoomTrack room checks: one check per room and day, so each step uses its
  // own room; a second check for a room and day stays a plain 409.
  {
    const name = 'room check';
    const newRoom = async (roomNumber) => {
      const room = await owner.request('POST', '/room-track/rooms', { roomNumber, siteId });
      assert.equal(room.status, 201, JSON.stringify(room.data));
      return room.data.id;
    };
    const roomBody = (roomId) => ({ roomId, siteId, checkDate: day, clean: true, tidy: true, toStandard: false, notes: 'Bin full', checkedBy: 'Housekeeper' });
    const before = await count('room_track_checks', owner.clientId);
    const sent = { ...roomBody(await newRoom('101')), clientEntryId: entryId() };
    const first = await owner.request('POST', '/room-track/checks', sent);
    assert.equal(first.status, 201, `${name}: first send creates (${JSON.stringify(first.data)})`);
    const replay = await owner.request('POST', '/room-track/checks', sent);
    assert.equal(replay.status, 200, `${name}: a lost-response replay is recognised (${JSON.stringify(replay.data)})`);
    assert.equal(replay.data.id, first.data.id, `${name}: replay returns the stored record`);
    const reordered = Object.fromEntries(Object.entries(sent).reverse());
    assert.equal((await owner.request('POST', '/room-track/checks', reordered)).status, 200, `${name}: same payload in another key order`);
    const conflict = await owner.request('POST', '/room-track/checks', { ...sent, toStandard: true });
    assert.equal(conflict.status, 409, `${name}: an entry ID cannot hide a changed payload`);
    assert.equal(conflict.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal((await staff.request('POST', '/room-track/checks', sent)).status, 409, `${name}: the entry belongs to the user who sent it`);
    const sameDay = await owner.request('POST', '/room-track/checks', { ...sent, clientEntryId: entryId() });
    assert.equal(sameDay.status, 409, `${name}: a new entry for a room already checked that day is refused`);
    assert.notEqual(sameDay.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal(await count('room_track_checks', owner.clientId), before + 1, `${name}: exactly one record was created`);

    // A resend still gets the stored check after the room is archived.
    assert.equal((await owner.request('DELETE', `/room-track/rooms/${sent.roomId}`)).status, 200);
    assert.equal((await owner.request('POST', '/room-track/checks', sent)).status, 200, `${name}: replay after the room was archived`);

    const racing = { ...roomBody(await newRoom('102')), clientEntryId: entryId() };
    const both = await Promise.all([owner.request('POST', '/room-track/checks', racing), owner.request('POST', '/room-track/checks', racing)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], `${name}: ${JSON.stringify(both.map((r) => r.data))}`);
    assert.equal(both[0].data.id, both[1].data.id);
    assert.equal(await count('room_track_checks', owner.clientId), before + 2);

    // Web submissions without an entry ID behave as before.
    const webRoom = await newRoom('103');
    assert.equal((await owner.request('POST', '/room-track/checks', roomBody(webRoom))).status, 201);
    assert.equal((await owner.request('POST', '/room-track/checks', roomBody(webRoom))).status, 409, `${name}: web keeps one check per room and day`);
    assert.equal((await owner.request('POST', '/room-track/checks', { ...roomBody(await newRoom('104')), clientEntryId: 'short' })).status, 400, `${name}: entry IDs are validated`);
    assert.equal(await count('room_track_checks', owner.clientId), before + 3);

    // Updates never accept or overwrite the device entry ID.
    assert.equal((await owner.request('PUT', `/room-track/checks/${both[0].data.id}`, { notes: 'Edited', clientEntryId: entryId() })).status, 200);
    assert.equal((await pool.query('SELECT client_entry_id FROM room_track_checks WHERE id = $1', [both[0].data.id])).rows[0].client_entry_id,
      racing.clientEntryId, `${name}: an edit keeps the original entry ID`);
    console.log('RoomTrack room check mobile replays: idempotent per user and payload, concurrent-safe, one check per room and day kept.');
  }

  // KitchenTrack probe calibrations and weekly reviews: one record per date
  // (whole business, as the website records them), so each step uses its own
  // date; a second record for a date stays a plain 409.
  const kitchenCases = [
    {
      name: 'kitchen probe', path: '/kitchen-weekly/probe', table: 'kitchen_probe_checks', dateField: 'checkDate',
      body: (date) => ({
        checkDate: date, probes: [{ name: 'Probe 1', iceTemp: '0.3', boilingTemp: '99.8', accurateIce: true, accurateBoiling: true, notes: '' }],
        overallResult: 'pass', checkedBy: 'Chef', checkedByRosterId: null, signature: 'Manager', notes: null,
        submittedAt: `${date}T09:00:00.000Z`,
      }),
      changed: { overallResult: 'fail' },
    },
    {
      name: 'kitchen weekly', path: '/kitchen-weekly/weekly', table: 'kitchen_weekly_records', dateField: 'weekCommencing',
      body: (date) => ({
        weekCommencing: date, checks: { training: 'yes', cleaning: 'no' }, deviations: [{ rule: 'Cleaning', action: 'Re-briefed' }],
        additional: { issuesThreeTimes: 'no' }, managerSignature: 'Manager', submittedAt: `${date}T09:00:00.000Z`,
      }),
      changed: { managerSignature: 'Someone else' },
    },
  ];
  for (const { name, path, table, dateField, body, changed } of kitchenCases) {
    const before = await count(table, owner.clientId);
    const sent = { ...body(day), clientEntryId: entryId() };
    const first = await owner.request('POST', path, sent);
    assert.equal(first.status, 201, `${name}: first send creates (${JSON.stringify(first.data)})`);
    assert.equal(Number(first.data.created_by), owner.userId, `${name}: the creator is recorded`);
    const replay = await owner.request('POST', path, sent);
    assert.equal(replay.status, 200, `${name}: a lost-response replay is recognised (${JSON.stringify(replay.data)})`);
    assert.equal(replay.data.id, first.data.id, `${name}: replay returns the stored record`);
    const reordered = Object.fromEntries(Object.entries(sent).reverse());
    assert.equal((await owner.request('POST', path, reordered)).status, 200, `${name}: same payload in another key order`);
    const conflict = await owner.request('POST', path, { ...sent, ...changed });
    assert.equal(conflict.status, 409, `${name}: an entry ID cannot hide a changed payload`);
    assert.equal(conflict.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal((await staff.request('POST', path, sent)).status, 409, `${name}: the entry belongs to the user who sent it`);
    const sameDate = await owner.request('POST', path, { ...sent, clientEntryId: entryId() });
    assert.equal(sameDate.status, 409, `${name}: a new entry for a date already recorded is refused`);
    assert.notEqual(sameDate.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal(sameDate.data.id, first.data.id);
    assert.equal(await count(table, owner.clientId), before + 1, `${name}: exactly one record was created`);

    const racing = { ...body(isoDay(0)), clientEntryId: entryId() };
    const both = await Promise.all([owner.request('POST', path, racing), owner.request('POST', path, racing)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], `${name}: ${JSON.stringify(both.map((r) => r.data))}`);
    assert.equal(both[0].data.id, both[1].data.id);
    assert.equal(await count(table, owner.clientId), before + 2);

    // Web submissions without an entry ID behave as before.
    const webDate = isoDay(-5);
    assert.equal((await owner.request('POST', path, body(webDate))).status, 201);
    assert.equal((await owner.request('POST', path, body(webDate))).status, 409, `${name}: web keeps one record per date`);
    assert.equal((await owner.request('POST', path, { ...body(isoDay(-6)), clientEntryId: 'short' })).status, 400, `${name}: entry IDs are validated`);
    assert.equal(await count(table, owner.clientId), before + 3);

    // Updates never accept or overwrite the device entry ID.
    const updated = await owner.request('PUT', `${path}/${both[0].data.id}`, { [dateField]: isoDay(0), clientEntryId: entryId() });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal((await pool.query(`SELECT client_entry_id FROM ${table} WHERE id = $1`, [both[0].data.id])).rows[0].client_entry_id,
      racing.clientEntryId, `${name}: an edit keeps the original entry ID`);
  }
  console.log('KitchenTrack probe and weekly mobile replays: idempotent per user and payload, concurrent-safe, one record per date kept.');

  // BikeTrack hires: one hire per bike at a time, created with its pre-ride
  // check. A resend gets the stored hire and check back even though the bike
  // is now on hire; nothing is written twice and no second action is opened.
  {
    const name = 'bike hire';
    const newBike = async (ref) => {
      const bike = await owner.request('POST', '/bike-track/bikes', { ref, type: 'hybrid', siteId });
      assert.equal(bike.status, 201, JSON.stringify(bike.data));
      return bike.data.id;
    };
    const bikeStatus = async (id) => (await pool.query('SELECT status FROM bikes WHERE id = $1', [id])).rows[0].status;
    const hireBody = (bikeId) => ({
      bikeId, guestName: 'Alex Guest', hireDate: day, returnDateExpected: isoDay(1), depositPence: 2000, siteId,
      preHireCheck: {
        brakesFront: 'pass', brakesRear: 'pass', tyreFront: 'fail', performedBy: 'Porter', staffRosterId: null,
        checkDate: day, overallResult: 'fail', checkNotes: 'Soft tyre',
      },
    });
    const bikeActions = async () => Number((await pool.query(
      "SELECT count(*) FROM track_actions WHERE client_id = $1 AND module = 'bike'", [owner.clientId],
    )).rows[0].count);
    const hiresBefore = await count('bike_hire_records', owner.clientId);
    const checksBefore = await count('bike_checks', owner.clientId);
    const actionsBefore = await bikeActions();

    const sent = { ...hireBody(await newBike('BIKE-01')), clientEntryId: entryId() };
    const first = await owner.request('POST', '/bike-track/hires', sent);
    assert.equal(first.status, 201, `${name}: first send creates (${JSON.stringify(first.data)})`);
    assert.ok(first.data.hire.id && first.data.preCheck.id, `${name}: hire and pre-ride check`);
    assert.equal(await bikeStatus(sent.bikeId), 'hired');
    assert.equal(await bikeActions(), actionsBefore + 1, `${name}: the failed pre-ride check opened one action`);
    const replay = await owner.request('POST', '/bike-track/hires', sent);
    assert.equal(replay.status, 200, `${name}: a lost-response replay is recognised although the bike is on hire (${JSON.stringify(replay.data)})`);
    assert.equal(replay.data.hire.id, first.data.hire.id, `${name}: replay returns the stored hire`);
    assert.equal(replay.data.preCheck.id, first.data.preCheck.id, `${name}: and its stored pre-ride check`);
    const reordered = Object.fromEntries(Object.entries(sent).reverse());
    assert.equal((await owner.request('POST', '/bike-track/hires', reordered)).status, 200, `${name}: same payload in another key order`);
    const conflict = await owner.request('POST', '/bike-track/hires', { ...sent, guestName: 'Someone Else' });
    assert.equal(conflict.status, 409, `${name}: an entry ID cannot hide a changed payload`);
    assert.equal(conflict.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal((await staff.request('POST', '/bike-track/hires', sent)).status, 409, `${name}: the entry belongs to the user who sent it`);
    const again = await owner.request('POST', '/bike-track/hires', { ...sent, clientEntryId: entryId() });
    assert.equal(again.status, 409, `${name}: a new hire of a bike already on hire is refused`);
    assert.notEqual(again.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal(await count('bike_hire_records', owner.clientId), hiresBefore + 1, `${name}: exactly one hire was created`);
    assert.equal(await count('bike_checks', owner.clientId), checksBefore + 1, `${name}: exactly one pre-ride check was created`);
    assert.equal(await bikeActions(), actionsBefore + 1, `${name}: replays add no follow-up actions`);

    // Still recognised after the bike came back (the return is a plain update).
    const returned = await owner.request('POST', `/bike-track/hires/${first.data.hire.id}/return`, { returnDateActual: day });
    assert.equal(returned.status, 200, JSON.stringify(returned.data));
    assert.equal((await owner.request('POST', `/bike-track/hires/${first.data.hire.id}/return`, { returnDateActual: day })).status, 409,
      `${name}: a second return is refused`);
    assert.equal((await owner.request('POST', '/bike-track/hires', sent)).status, 200, `${name}: replay after the return`);
    assert.equal(await bikeStatus(sent.bikeId), 'available', `${name}: a replay does not put the bike back on hire`);

    const racing = { ...hireBody(await newBike('BIKE-02')), clientEntryId: entryId() };
    const both = await Promise.all([owner.request('POST', '/bike-track/hires', racing), owner.request('POST', '/bike-track/hires', racing)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], `${name}: ${JSON.stringify(both.map((r) => r.data))}`);
    assert.equal(both[0].data.hire.id, both[1].data.hire.id);
    assert.equal(await count('bike_hire_records', owner.clientId), hiresBefore + 2);
    assert.equal(await count('bike_checks', owner.clientId), checksBefore + 2, `${name}: the losing racer wrote no check`);
    // Two different hires of one bike at once (two phones syncing): one wins.
    const contested = await newBike('BIKE-07');
    const rivals = await Promise.all([
      owner.request('POST', '/bike-track/hires', { ...hireBody(contested), clientEntryId: entryId() }),
      owner.request('POST', '/bike-track/hires', { ...hireBody(contested), guestName: 'Sam Rival', clientEntryId: entryId() }),
    ]);
    assert.deepEqual(rivals.map((r) => r.status).sort(), [201, 409], `${name}: ${JSON.stringify(rivals.map((r) => r.data))}`);
    assert.equal(await count('bike_hire_records', owner.clientId), hiresBefore + 3);
    assert.equal(await count('bike_checks', owner.clientId), checksBefore + 3, `${name}: the refused rival wrote no check`);
    // The phone reads the active hires list as raw rows (snake_case) and the
    // fleet as Drizzle rows (camelCase); see mobile components/bike-track-logic.ts.
    const listed = (await owner.request('GET', '/bike-track/hires?status=active')).data.find((row) => row.id === both[0].data.hire.id);
    assert.equal(listed?.bike_ref, 'BIKE-02', JSON.stringify(listed));
    assert.equal(listed.guest_name, 'Alex Guest');
    assert.equal(listed.pre_result, 'fail');
    assert.equal(String(listed.hire_date).slice(0, 10), day);
    const fleet = (await owner.request('GET', '/bike-track/bikes')).data.find((row) => row.id === racing.bikeId);
    assert.equal(fleet?.siteId, siteId, JSON.stringify(fleet));
    assert.equal(fleet.status, 'hired');

    // Nothing is written when the hire is refused part-way.
    const refusedBike = await newBike('BIKE-03');
    const badRoster = await owner.request('POST', '/bike-track/hires', {
      ...hireBody(refusedBike), preHireCheck: { ...hireBody(refusedBike).preHireCheck, staffRosterId: 999999 }, clientEntryId: entryId(),
    });
    assert.equal(badRoster.status, 400, JSON.stringify(badRoster.data));
    const foreignSite = await other.request('POST', '/sites', { name: 'Other business site', seedStarterChecks: false });
    assert.equal(foreignSite.status, 201, JSON.stringify(foreignSite.data));
    const crossTenant = await owner.request('POST', '/bike-track/hires', { ...hireBody(refusedBike), siteId: foreignSite.data.id });
    assert.equal(crossTenant.status, 400, `${name}: another business's site is refused (${JSON.stringify(crossTenant.data)})`);
    assert.equal(await bikeStatus(refusedBike), 'available', `${name}: a refused hire leaves the bike available`);
    assert.equal(await count('bike_hire_records', owner.clientId), hiresBefore + 3);

    // Web hires without an entry ID behave as before.
    const webBike = await newBike('BIKE-04');
    assert.equal((await owner.request('POST', '/bike-track/hires', hireBody(webBike))).status, 201);
    assert.equal((await owner.request('POST', '/bike-track/hires', hireBody(webBike))).status, 409, `${name}: web keeps one hire per bike`);
    assert.equal((await owner.request('POST', '/bike-track/hires', { ...hireBody(await newBike('BIKE-05')), clientEntryId: 'short' })).status, 400,
      `${name}: entry IDs are validated`);
    assert.equal(await count('bike_hire_records', owner.clientId), hiresBefore + 4);

    // Updates never accept or overwrite the device entry ID.
    assert.equal((await owner.request('PUT', `/bike-track/hires/${both[0].data.hire.id}`, { notes: 'Edited', clientEntryId: entryId() })).status, 200);
    assert.equal((await pool.query('SELECT client_entry_id FROM bike_hire_records WHERE id = $1', [both[0].data.hire.id])).rows[0].client_entry_id,
      racing.clientEntryId, `${name}: an edit keeps the original entry ID`);

    // The phone signs in with a bearer token (no web session): hires and
    // services record that user, so the phone's own resend is recognised.
    const phoneEmail = `bike-phone-${randomUUID()}@test.local`;
    const phonePassword = `phone-fixture-${randomUUID()}`;
    const phoneUser = await owner.request('POST', '/users', {
      name: 'Phone staff', email: phoneEmail, password: phonePassword, clientId: owner.clientId, role: 'client_staff',
    });
    assert.equal(phoneUser.status, 201, JSON.stringify(phoneUser.data));
    const phoneLogin = await fetch(`${base}/auth/mobile-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: phoneEmail, password: phonePassword }),
    });
    const phoneSession = await phoneLogin.json();
    assert.equal(phoneLogin.status, 200, JSON.stringify(phoneSession));
    assert.equal(typeof phoneSession.token, 'string', JSON.stringify(phoneSession));
    const phone = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${phoneSession.token}` }, body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json().catch(() => null) };
    };
    const phoneHire = { ...hireBody(await newBike('BIKE-06')), clientEntryId: entryId() };
    const phoneFirst = await phone('/bike-track/hires', phoneHire);
    assert.equal(phoneFirst.status, 201, JSON.stringify(phoneFirst.data));
    assert.equal(phoneFirst.data.hire.createdBy, phoneUser.data.id, `${name}: a phone hire records its user`);
    assert.equal((await phone('/bike-track/hires', phoneHire)).status, 200, `${name}: the phone's resend is recognised`);
    const phoneService = { bikeId: serviceBike.data.id, serviceDate: day, serviceType: 'adhoc', clientEntryId: entryId() };
    const serviceFirst = await phone('/bike-track/services', phoneService);
    assert.equal(serviceFirst.status, 201, JSON.stringify(serviceFirst.data));
    assert.equal(serviceFirst.data.created_by, phoneUser.data.id, 'a phone service records its user');
    assert.equal((await phone('/bike-track/services', phoneService)).status, 200, "the phone's service resend is recognised");
    console.log('BikeTrack hire and service mobile replays: idempotent per user and payload, concurrent-safe, no partial hires, bearer sessions attributed.');
  }

  // Updates never accept or overwrite the device entry ID.
  const fire = await owner.request('POST', '/fire-safety', {
    checkType: 'fire_doors', checkDate: day, result: 'pass', siteId, clientEntryId: entryId(),
  });
  const stored = (await pool.query('SELECT client_entry_id FROM fire_safety_checks WHERE id = $1', [fire.data.id])).rows[0];
  assert.equal((await owner.request('PUT', `/fire-safety/${fire.data.id}`, { notes: 'Edited', clientEntryId: entryId() })).status, 200);
  assert.equal((await pool.query('SELECT client_entry_id FROM fire_safety_checks WHERE id = $1', [fire.data.id])).rows[0].client_entry_id,
    stored.client_entry_id, 'an edit keeps the original entry ID');

  // KitchenTrack cleaning schedules are one log per kitchen, period and
  // frequency that each save updates (draft saves, then the sign-off). Device
  // entry IDs are kept as receipts, so a resend is recognised even after later
  // saves, and a stale device save never reopens a signed-off schedule.
  {
    const logs = async () => count('kitchen_cleaning_logs', owner.clientId);
    const receipts = async () => count('kitchen_cleaning_log_entries', owner.clientId);
    const completions = [{ taskId: 1, taskArea: 'Kitchen', taskName: 'Wipe surfaces', done: true, doneBy: 'Cook' }];
    const draft = { logDate: day, frequency: 'daily', siteId, completions, signedBy: 'Cook', submittedAt: null, clientEntryId: entryId() };

    const first = await owner.request('POST', '/kitchen-cleaning/logs', draft);
    assert.equal(first.status, 201, `cleaning: first draft creates the log (${JSON.stringify(first.data)})`);
    const replay = await owner.request('POST', '/kitchen-cleaning/logs', Object.fromEntries(Object.entries(draft).reverse()));
    assert.equal(replay.status, 200, `cleaning: a lost-response replay is recognised (${JSON.stringify(replay.data)})`);
    assert.equal(replay.data.id, first.data.id);
    assert.equal(replay.data.receipt_hash, undefined, 'cleaning: receipt internals are not returned');
    const changed = await owner.request('POST', '/kitchen-cleaning/logs', { ...draft, signedBy: 'Someone else' });
    assert.equal(changed.status, 409);
    assert.equal(changed.data.code, 'CLIENT_ENTRY_CONFLICT');
    assert.equal((await staff.request('POST', '/kitchen-cleaning/logs', draft)).status, 409, 'cleaning: the entry belongs to its sender');
    assert.equal(await logs(), 1);
    assert.equal(await receipts(), 1);

    // The sign-off updates the same log; its replay and a late replay of the
    // earlier draft both change nothing.
    const signOff = { ...draft, completions: [{ ...completions[0] }], submittedAt: new Date().toISOString(), clientEntryId: entryId() };
    const signed = await owner.request('POST', '/kitchen-cleaning/logs', signOff);
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.id, first.data.id);
    assert.ok(signed.data.submitted_at);
    assert.equal((await owner.request('POST', '/kitchen-cleaning/logs', signOff)).status, 200, 'cleaning: sign-off replay');
    assert.equal((await owner.request('POST', '/kitchen-cleaning/logs', draft)).status, 200, 'cleaning: late draft replay is recognised');
    const stillSigned = (await pool.query('SELECT submitted_at FROM kitchen_cleaning_logs WHERE id = $1', [first.data.id])).rows[0];
    assert.ok(stillSigned.submitted_at, 'cleaning: a replayed draft never reopens the signed-off log');

    // A different device save made before the sign-off reached the server.
    const stale = await staff.request('POST', '/kitchen-cleaning/logs', { ...draft, clientEntryId: entryId() });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(stale.data.code, 'CLEANING_LOG_SIGNED_OFF');
    assert.ok((await pool.query('SELECT submitted_at FROM kitchen_cleaning_logs WHERE id = $1', [first.data.id])).rows[0].submitted_at);
    assert.equal(await logs(), 1);
    assert.equal(await receipts(), 2);

    // Concurrent attempts of one entry, for a kitchen and for the account-wide
    // (no kitchen) schedule: one applies, the other replays.
    for (const [frequency, raceSite] of [['weekly', siteId], ['monthly', null]]) {
      const racing = { ...draft, frequency, siteId: raceSite, clientEntryId: entryId() };
      const both = await Promise.all([
        owner.request('POST', '/kitchen-cleaning/logs', racing),
        owner.request('POST', '/kitchen-cleaning/logs', racing),
      ]);
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], `cleaning ${frequency}: ${JSON.stringify(both.map((r) => r.data))}`);
      assert.equal(both[0].data.id, both[1].data.id);
    }
    assert.equal(await logs(), 3);

    // Web saves (no entry ID) keep upserting as before, including after sign-off.
    const web = await owner.request('POST', '/kitchen-cleaning/logs', { ...signOff, clientEntryId: undefined, signedBy: 'Manager' });
    assert.equal(web.status, 200, JSON.stringify(web.data));
    assert.equal(web.data.signed_by, 'Manager');
    assert.equal(await receipts(), 4);

    // Entry IDs are per client; malformed ones are rejected.
    const foreign = await other.request('POST', '/kitchen-cleaning/logs', { ...draft, siteId: null });
    assert.equal(foreign.status, 201, `cleaning: another client's identical ID is independent (${JSON.stringify(foreign.data)})`);
    assert.equal((await owner.request('POST', '/kitchen-cleaning/logs', { ...draft, clientEntryId: 'short' })).status, 400);
  }

  console.log('Fire, legionella, hot tub, PAT, incident, pool, PremisesTrack, TreeTrack, PestTrack, BikeTrack service, GreenTrack (pre-use checks, defects, fuel logs, service records, PUWER inspections), swim session, surveillance, first-aid and pool incident mobile replays: idempotent per user and payload, concurrent-safe, per-client, web unaffected.');
} finally { await pool.end(); }
