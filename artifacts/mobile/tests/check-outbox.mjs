import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Device outbox for daily checklists (lib/checkOutboxCore.ts): persisted
// before sending, identical replay after signal loss, owner isolation, and
// classification of retryable versus rejected submissions.
const source = await readFile(new URL('../lib/checkOutboxCore.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { CheckOutbox, checkOutboxKey, isRetryableStatus, RECORD_KINDS, RECORD_PATHS, deliveredQueryKeys } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const A = { clientId: 301, userId: 401 };
const B = { clientId: 301, userId: 402 };
const memory = new Map();
const storage = {
  async getItem(key) { return memory.get(key) ?? null; },
  async setItem(key, value) { memory.set(key, value); },
};
const daily = (entryId, siteId = 7, type = 'am') => ({
  entryId,
  kind: 'daily-checklist',
  path: `/api/daily-checklists/${siteId}/2026-10-12/${type}`,
  scopeKey: `daily:${siteId}:2026-10-12:${type}`,
  label: `${type.toUpperCase()} checklist`,
  body: { answers: [{ question: 'Exits clear', checked: true }] },
});
const errorWithStatus = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

// A device write failure never dispatches HTTP.
{
  let sends = 0;
  const outbox = new CheckOutbox({
    storage: { ...storage, async setItem() { throw new Error('Device storage full'); } },
    async send() { sends++; }, async onSent() {},
  });
  await outbox.activate(A, 'token-A');
  await assert.rejects(outbox.enqueue(daily('daily-disk-failure-01')), /storage full/);
  assert.equal(sends, 0);
  outbox.suspend();
}

// Offline: persisted first, kept queued, then the identical body is replayed
// with the original session token once the connection returns.
const attempts = [];
let online = false;
let sentCallbacks = 0;
const outbox = new CheckOutbox({
  storage,
  async send(entry, token) {
    assert.ok(memory.get(checkOutboxKey(A)), 'persist before sending');
    attempts.push({ body: structuredClone(entry.body), path: entry.path, token });
    if (!online) throw new TypeError('Network request failed');
  },
  async onSent() { sentCallbacks++; },
});
await outbox.activate(A, 'token-A');
const queued = await outbox.enqueue(daily('daily-offline-0001'));
await outbox.replay();
assert.equal(outbox.getSnapshot().entries[0].state, 'queued');
assert.equal(queued.body.clientEntryId, 'daily-offline-0001', 'the device entry ID travels in the body');
assert.equal(sentCallbacks, 0);

// One unsent entry per checklist scope; a different scope is allowed.
await assert.rejects(outbox.enqueue(daily('daily-offline-0002')), /already has a saved device entry/);
await outbox.enqueue(daily('daily-offline-0003', 7, 'pm'));
// The same ID cannot be reused for a different check.
await assert.rejects(
  outbox.enqueue({ ...daily('daily-offline-0001'), body: { answers: [{ question: 'Exits clear', checked: false }] } }),
  /cannot be reused/,
);
// Paths are allowlisted: storage cannot be used to make arbitrary requests.
await assert.rejects(outbox.enqueue({ ...daily('daily-bad-path-0001', 9), path: '/api/auth/mobile-logout' }), /cannot be saved/);

// Account switch hides A's entries; B sees nothing of A's.
outbox.suspend();
assert.deepEqual(outbox.getSnapshot().entries, []);
await outbox.activate(B, 'token-B');
assert.deepEqual(outbox.getSnapshot().entries, []);
outbox.suspend();

// Back online with A: both entries are sent unchanged with A's token.
online = true;
await outbox.activate(A, 'token-A');
await outbox.replay();
const states = outbox.getSnapshot().entries.map((entry) => entry.state);
assert.deepEqual(states, ['sent', 'sent']);
assert.equal(sentCallbacks, 2);
const replays = attempts.filter((attempt) => attempt.body.clientEntryId === 'daily-offline-0001');
assert.ok(replays.length >= 2, 'the queued entry was attempted offline and replayed online');
assert.ok(replays.every((attempt) => JSON.stringify(attempt.body) === JSON.stringify(replays[0].body)), 'replays send the identical body');
assert.ok(attempts.every((attempt) => attempt.token === 'token-A'), 'never sent with another account token');
outbox.suspend();

// A rejected submission (e.g. 409 someone else submitted) becomes failed and
// can be retried or removed; 5xx/408/429/401 stay queued.
assert.equal(isRetryableStatus(0), true);
assert.equal(isRetryableStatus(401), true);
assert.equal(isRetryableStatus(503), true);
assert.equal(isRetryableStatus(429), true);
assert.equal(isRetryableStatus(409), false);
assert.equal(isRetryableStatus(400), false);
{
  const store = new Map();
  let status = 409;
  const rejecting = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send() { if (status) throw Object.assign(errorWithStatus(status), { message: 'Checklist already submitted for this date' }); },
    async onSent() {},
  });
  await rejecting.activate(A, 'token-A');
  await rejecting.enqueue(daily('daily-rejected-0001', 8));
  await rejecting.replay();
  let entry = rejecting.getSnapshot().entries[0];
  assert.equal(entry.state, 'failed');
  assert.equal(entry.error, 'Checklist already submitted for this date');
  status = 500;
  await rejecting.retry(entry.entryId);
  await rejecting.replay();
  assert.equal(rejecting.getSnapshot().entries[0].state, 'queued', 'server errors stay queued');
  status = 0;
  await rejecting.replay();
  assert.equal(rejecting.getSnapshot().entries[0].state, 'sent');
  // removeFailed only removes failed entries.
  await rejecting.removeFailed('daily-rejected-0001');
  assert.equal(rejecting.getSnapshot().entries.length, 1);
  rejecting.suspend();
}

// Corrupt or tampered device data is reported and never silently dropped.
{
  const store = new Map([[checkOutboxKey(A), JSON.stringify([{ ...daily('daily-tampered-001'), owner: A, state: 'queued', createdAt: 'x', path: 'https://evil.test/' }])]]);
  let sends = 0;
  const tampered = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send() { sends++; }, async onSent() {},
  });
  await tampered.activate(A, 'token-A');
  assert.match(tampered.getSnapshot().error, /could not be read/);
  assert.equal(sends, 0);
  assert.ok(store.get(checkOutboxKey(A)).includes('evil.test'), 'device copy is kept');
}

// Record forms (fire, legionella, hot tub, PAT, incident): each record is its
// own scope, so several can wait offline; every retry (automatic or manual)
// resends the identical body with the same entry ID; only the allowlisted
// create path per kind is accepted; the server response is handed to the
// screen once.
{
  const store = new Map();
  const sent = [];
  let online = false;
  const records = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push(structuredClone(entry.body));
      if (!online) throw new TypeError('Network request failed');
      return { id: 9, result: 'fail' };
    },
    async onSent() {},
  });
  await records.activate(A, 'token-A');
  const record = (kind, entryId, body) => ({
    entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label: kind, body,
  });
  for (const kind of RECORD_KINDS) assert.ok(RECORD_PATHS[kind], `${kind} has a create path`);
  await records.enqueue(record('fire-check', 'fire-entry-00001', { checkType: 'alarm', checkDate: '2026-10-12', result: 'pass' }));
  await records.enqueue(record('fire-check', 'fire-entry-00002', { checkType: 'alarm', checkDate: '2026-10-12', result: 'pass' }));
  await records.enqueue(record('incident', 'incident-entry-01', { location: 'Kitchen' }));
  await records.replay();
  assert.deepEqual(records.getSnapshot().entries.map((entry) => entry.state), ['queued', 'queued', 'queued'],
    'several records of one kind can wait offline');
  await assert.rejects(records.enqueue({ ...record('pat-test', 'pat-entry-000001', {}), path: '/api/pat-track/appliances' }), /cannot be saved/);
  await assert.rejects(records.enqueue({ ...record('incident', 'incident-entry-02', {}), path: '/api/incidents/5' }), /cannot be saved/);
  await assert.rejects(records.enqueue({ ...record('pool-check', 'pool-entry-000001', {}), path: '/api/pool-track/5' }), /cannot be saved/);
  await assert.rejects(records.enqueue({ ...record('tree-inspection', 'tree-entry-000001', {}), path: '/api/tree-track/5' }), /cannot be saved/);
  await assert.rejects(records.enqueue({ ...record('tree-inspection', 'tree-entry-000002', {}), path: '/api/tree-track/status' }), /cannot be saved/);
  await assert.rejects(records.enqueue({ ...record('room-check', 'room-entry-000001', {}), path: '/api/room-track/rooms' }), /cannot be saved/);
  await assert.rejects(records.enqueue({ ...record('room-check', 'room-entry-000002', {}), path: '/api/room-track/checks/5' }), /cannot be saved/);
  online = true;
  await records.replay();
  assert.deepEqual(records.getSnapshot().entries.map((entry) => entry.state), ['sent', 'sent', 'sent']);
  const fireAttempts = sent.filter((body) => body.clientEntryId === 'fire-entry-00001');
  assert.ok(fireAttempts.length >= 2, 'offline attempts then automatic resend');
  for (const attempt of fireAttempts) assert.deepEqual(attempt, fireAttempts[0], 'every resend is identical, with the same entry ID');
  assert.deepEqual(records.takeResponse('fire-entry-00001'), { id: 9, result: 'fail' }, 'the server outcome reaches the screen');
  assert.equal(records.takeResponse('fire-entry-00001'), undefined, 'and is handed over once');
  records.suspend();
  assert.equal(records.takeResponse('incident-entry-01'), undefined, 'responses are dropped when the account changes');
}
assert.deepEqual(deliveredQueryKeys('pat-test'), [['pat-tests'], ['pat-appliances'], ['dashboard-summary']]);
assert.deepEqual(deliveredQueryKeys('daily-checklist'), [['daily-checklist'], ['daily-overview']]);
assert.equal(RECORD_PATHS['pool-check'], '/api/pool-track');
assert.deepEqual(deliveredQueryKeys('pool-check'), [['pool-checks'], ['track-controls'], ['dashboard-summary']]);
assert.ok(RECORD_KINDS.includes('tree-inspection'), 'TreeTrack inspections are independent records');
assert.equal(RECORD_PATHS['tree-inspection'], '/api/tree-track');
assert.deepEqual(deliveredQueryKeys('tree-inspection'), [['tree-inspections'], ['tree-status'], ['dashboard-summary']]);

// PremisesTrack inspections: saved offline, resent unchanged under one entry
// ID, and only the create path is accepted.
{
  const store = new Map();
  const sent = [];
  let online = false;
  const records = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push({ path: entry.path, body: structuredClone(entry.body) });
      if (!online) throw new TypeError('Network request failed');
      return { id: 21, status: 'open' };
    },
    async onSent() {},
  });
  await records.activate(A, 'token-A');
  assert.ok(RECORD_KINDS.includes('premises-inspection'));
  assert.equal(RECORD_PATHS['premises-inspection'], '/api/premises-track');
  const premises = (entryId, path = RECORD_PATHS['premises-inspection']) => ({
    entryId, kind: 'premises-inspection', path, scopeKey: `premises-inspection:${entryId}`, label: 'Premises inspection',
    body: { inspectionDate: '2026-10-12', inspectionType: 'hazard', area: 'Stairwell', findings: 'Loose nosing', status: 'open', siteId: 7 },
  });
  await records.enqueue(premises('premises-entry-0001'));
  await records.replay();
  assert.deepEqual(records.getSnapshot().entries.map((entry) => entry.state), ['queued'], 'saved on the device while offline');
  await assert.rejects(records.enqueue(premises('premises-entry-0002', '/api/premises-track/5')), /cannot be saved/);
  await assert.rejects(records.enqueue(premises('premises-entry-0003', '/api/premises-track/summary')), /cannot be saved/);
  online = true;
  await records.replay();
  assert.deepEqual(records.getSnapshot().entries.map((entry) => entry.state), ['sent']);
  assert.ok(sent.length >= 2, 'offline attempt then automatic resend');
  for (const attempt of sent) {
    assert.equal(attempt.path, '/api/premises-track');
    assert.deepEqual(attempt.body, { ...premises('premises-entry-0001').body, clientEntryId: 'premises-entry-0001' },
      'every resend is identical, with the same entry ID');
  }
  assert.deepEqual(records.takeResponse('premises-entry-0001'), { id: 21, status: 'open' });
  records.suspend();
}
assert.deepEqual(deliveredQueryKeys('premises-inspection'), [['premises-inspections'], ['dashboard-summary']]);
assert.equal(RECORD_PATHS['room-check'], '/api/room-track/checks');
assert.ok(RECORD_KINDS.includes('room-check'));
assert.deepEqual(deliveredQueryKeys('room-check'), [['room-track-checks'], ['dashboard-summary']]);
// RoomTrack room checks wait offline and resend the identical body.
{
  const store = new Map();
  const sent = [];
  let online = false;
  const rooms = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push({ path: entry.path, body: structuredClone(entry.body) });
      if (!online) throw new TypeError('Network request failed');
      return { id: 31, roomId: 4 };
    },
    async onSent() {},
  });
  await rooms.activate(A, 'token-A');
  const body = { roomId: 4, siteId: 7, checkDate: '2026-10-12', clean: true, tidy: true, toStandard: false, checkedBy: 'Housekeeper' };
  await rooms.enqueue({ entryId: 'room-entry-000003', kind: 'room-check', path: RECORD_PATHS['room-check'], scopeKey: 'room-check:room-entry-000003', label: 'Room 4', body });
  await rooms.replay();
  assert.equal(rooms.getSnapshot().entries[0].state, 'queued', 'a room check waits on the device while offline');
  online = true;
  await rooms.replay();
  assert.equal(rooms.getSnapshot().entries[0].state, 'sent');
  assert.ok(sent.length >= 2);
  for (const attempt of sent) assert.deepEqual(attempt, { path: '/api/room-track/checks', body: { ...body, clientEntryId: 'room-entry-000003' } });
  assert.deepEqual(rooms.takeResponse('room-entry-000003'), { id: 31, roomId: 4 });
  rooms.suspend();
}

// PestTrack sightings and contractor visits: saved offline, resent unchanged,
// and only the two create paths can be stored (no edits, deletes or config).
{
  const store = new Map();
  const sent = [];
  let online = false;
  const pest = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push({ path: entry.path, body: structuredClone(entry.body) });
      if (!online) throw new TypeError('Network request failed');
      return { id: 11 };
    },
    async onSent() {},
  });
  await pest.activate(A, 'token-A');
  const record = (kind, entryId, body) => ({
    entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label: kind, body,
  });
  assert.ok(RECORD_KINDS.includes('pest-activity') && RECORD_KINDS.includes('pest-visit'));
  assert.equal(RECORD_PATHS['pest-activity'], '/api/pest-track/activity');
  assert.equal(RECORD_PATHS['pest-visit'], '/api/pest-track/visits');
  await pest.enqueue(record('pest-activity', 'pest-activity-00001', {
    recordedDate: '2026-10-12', pestType: 'rodent', evidenceType: 'droppings', severity: 'high', siteId: 7,
  }));
  await pest.enqueue(record('pest-visit', 'pest-visit-0000001', { visitDate: '2026-10-12', contractorName: 'J Smith', siteId: 7 }));
  for (const path of ['/api/pest-track/activity/5', '/api/pest-track/visits/5', '/api/pest-track/config']) {
    await assert.rejects(pest.enqueue({ ...record('pest-activity', 'pest-activity-00002', {}), path }), /cannot be saved/, path);
    await assert.rejects(pest.enqueue({ ...record('pest-visit', 'pest-visit-0000002', {}), path }), /cannot be saved/, path);
  }
  await assert.rejects(pest.enqueue({ ...record('pest-visit', 'pest-visit-0000003', {}), path: RECORD_PATHS['pest-activity'] }), /cannot be saved/,
    'a visit cannot be posted to the activity log');
  await pest.replay();
  assert.deepEqual(pest.getSnapshot().entries.map((entry) => entry.state), ['queued', 'queued'], 'both wait on the device offline');
  online = true;
  await pest.replay();
  assert.deepEqual(pest.getSnapshot().entries.map((entry) => entry.state), ['sent', 'sent']);
  const activityAttempts = sent.filter((attempt) => attempt.body.clientEntryId === 'pest-activity-00001');
  assert.ok(activityAttempts.length >= 2, 'offline attempt then automatic resend');
  for (const attempt of activityAttempts) assert.deepEqual(attempt, activityAttempts[0], 'every resend is identical, with the same entry ID');
  assert.ok(sent.every((attempt) => attempt.path === (attempt.body.clientEntryId.startsWith('pest-visit') ? '/api/pest-track/visits' : '/api/pest-track/activity')));
  pest.suspend();
}
assert.deepEqual(deliveredQueryKeys('pest-activity'), [['pest-activity'], ['dashboard-summary']]);
assert.deepEqual(deliveredQueryKeys('pest-visit'), [['pest-visits'], ['dashboard-summary']]);

// AquaTrack surveillance checks, first-aid checks and pool incidents: saved
// offline, resent unchanged, a server rejection (e.g. photos now required)
// kept on the device with its reason, and only the three create paths stored.
{
  const store = new Map();
  const sent = [];
  let online = false;
  let rejectIncidents = false;
  const swim = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push({ path: entry.path, body: structuredClone(entry.body) });
      if (!online) throw new TypeError('Network request failed');
      if (rejectIncidents && entry.kind === 'swim-incident') {
        throw Object.assign(new Error('At least 1 verified photo(s) are required'), { status: 422 });
      }
      return { id: 21 };
    },
    async onSent() {},
  });
  await swim.activate(A, 'token-A');
  const record = (kind, entryId, body) => ({
    entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label: kind, body,
  });
  const kinds = { 'swim-surveillance': 'surveillance', 'swim-first-aid': 'first-aid', 'swim-incident': 'incidents' };
  for (const [kind, segment] of Object.entries(kinds)) {
    assert.ok(RECORD_KINDS.includes(kind), kind);
    assert.equal(RECORD_PATHS[kind], `/api/swim-track/${segment}`);
  }
  await swim.enqueue(record('swim-surveillance', 'swim-surveillance-001', { checkDate: '2026-10-12', scanCompleted: true, siteId: 7 }));
  await swim.enqueue(record('swim-first-aid', 'swim-first-aid-00001', { checkDate: '2026-10-12', aedOk: false, siteId: 7 }));
  await swim.enqueue(record('swim-incident', 'swim-incident-000001', { incidentDate: '2026-10-12', description: 'Slip', siteId: 7 }));
  for (const path of [
    '/api/swim-track/surveillance/5', '/api/swim-track/first-aid/5', '/api/swim-track/incidents/5',
    '/api/swim-track/sessions', '/api/swim-track/status', '/api/photos/staged',
  ]) {
    for (const kind of Object.keys(kinds)) {
      await assert.rejects(swim.enqueue({ ...record(kind, `${kind}-0000099`, {}), path }), /cannot be saved/, `${kind} ${path}`);
    }
  }
  await assert.rejects(swim.enqueue({ ...record('swim-incident', 'swim-incident-000002', {}), path: RECORD_PATHS['swim-first-aid'] }), /cannot be saved/,
    'an incident cannot be posted as a first-aid check');
  await swim.replay();
  assert.deepEqual(swim.getSnapshot().entries.map((entry) => entry.state), ['queued', 'queued', 'queued'], 'all wait on the device offline');
  online = true;
  rejectIncidents = true;
  await swim.replay();
  const states = Object.fromEntries(swim.getSnapshot().entries.map((entry) => [entry.kind, entry]));
  assert.equal(states['swim-surveillance'].state, 'sent');
  assert.equal(states['swim-first-aid'].state, 'sent');
  assert.equal(states['swim-incident'].state, 'failed', 'a rejected incident stays on the device');
  assert.match(states['swim-incident'].error, /photo/, 'with the server reason shown');
  for (const id of ['swim-surveillance-001', 'swim-first-aid-00001', 'swim-incident-000001']) {
    const attempts = sent.filter((attempt) => attempt.body.clientEntryId === id);
    // A pass stops at the first network failure, so only the oldest entry was tried offline.
    assert.ok(attempts.length >= (id === 'swim-surveillance-001' ? 2 : 1), `${id}: offline attempt then automatic resend`);
    for (const attempt of attempts) assert.deepEqual(attempt, attempts[0], `${id}: every resend is identical, with the same entry ID`);
  }
  swim.suspend();
}
assert.deepEqual(deliveredQueryKeys('swim-surveillance'), [['swim-surveillance'], ['track-controls'], ['dashboard-summary']]);
assert.deepEqual(deliveredQueryKeys('swim-first-aid'), [['swim-first-aid'], ['track-controls'], ['dashboard-summary']]);
assert.deepEqual(deliveredQueryKeys('swim-incident'), [['swim-incidents'], ['dashboard-summary']]);
// GreenTrack machine records (defects, fuel logs, service records, PUWER
// inspections): saved offline, resent unchanged, create paths only (no
// machine, edit, delete or config paths).
{
  const store = new Map();
  const sent = [];
  let online = false;
  const green = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push({ path: entry.path, body: structuredClone(entry.body) });
      if (!online) throw new TypeError('Network request failed');
      return { id: 21 };
    },
    async onSent() {},
  });
  await green.activate(A, 'token-A');
  const record = (kind, entryId, body) => ({
    entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label: kind, body,
  });
  const kinds = {
    'green-defect': '/api/green-track/defects',
    'green-fuel': '/api/green-track/fuel-logs',
    'green-service': '/api/green-track/service-records',
    'green-puwer': '/api/green-track/puwer-inspections',
  };
  for (const [kind, path] of Object.entries(kinds)) {
    assert.ok(RECORD_KINDS.includes(kind), kind);
    assert.equal(RECORD_PATHS[kind], path);
    await green.enqueue(record(kind, `${kind}-000001`, { machineId: 4, notes: kind }));
  }
  for (const path of ['/api/green-track/defects/5', '/api/green-track/fuel-logs/5', '/api/green-track/machines',
    '/api/green-track/machines/5', '/api/green-track/config', '/api/green-track/pre-use-checks']) {
    for (const kind of Object.keys(kinds)) {
      await assert.rejects(green.enqueue({ ...record(kind, `${kind}-000002`, {}), path }), /cannot be saved/, `${kind} ${path}`);
    }
  }
  await assert.rejects(green.enqueue({ ...record('green-fuel', 'green-fuel-000003', {}), path: kinds['green-puwer'] }), /cannot be saved/,
    'a fuel log cannot be posted as a PUWER inspection');
  await green.replay();
  assert.deepEqual(green.getSnapshot().entries.map((entry) => entry.state), ['queued', 'queued', 'queued', 'queued'], 'all wait on the device offline');
  online = true;
  await green.replay();
  assert.deepEqual(green.getSnapshot().entries.map((entry) => entry.state), ['sent', 'sent', 'sent', 'sent']);
  for (const [kind, path] of Object.entries(kinds)) {
    const attempts = sent.filter((attempt) => attempt.body.clientEntryId === `${kind}-000001`);
    // A replay stops at the first network failure, so only the oldest entry
    // was tried while offline.
    assert.ok(attempts.length >= (kind === 'green-defect' ? 2 : 1), `${kind}: sent once back online`);
    for (const attempt of attempts) assert.deepEqual(attempt, { path, body: { machineId: 4, notes: kind, clientEntryId: `${kind}-000001` } });
  }
  green.suspend();
}
for (const [kind, tab] of [['green-defect', 'defect'], ['green-fuel', 'fuel'], ['green-service', 'service'], ['green-puwer', 'puwer']]) {
  assert.deepEqual(deliveredQueryKeys(kind), [['green-records', tab], ['dashboard-summary']]);
}
// KitchenTrack probe calibrations and weekly reviews: saved offline, resent
// unchanged, and only the two create paths can be stored (no edits by id).
// A review the server refuses (one per week already exists) needs the user.
{
  const store = new Map();
  const sent = [];
  let online = false;
  let refuseWeekly = false;
  const kitchen = new CheckOutbox({
    storage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, v); } },
    async send(entry) {
      sent.push({ path: entry.path, body: structuredClone(entry.body) });
      if (!online) throw new TypeError('Network request failed');
      if (refuseWeekly && entry.kind === 'kitchen-weekly') {
        throw Object.assign(new Error('Record already exists for this week'), { status: 409 });
      }
      return { id: 21 };
    },
    async onSent() {},
  });
  await kitchen.activate(A, 'token-A');
  const record = (kind, entryId, body) => ({
    entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label: kind, body,
  });
  assert.ok(RECORD_KINDS.includes('kitchen-probe') && RECORD_KINDS.includes('kitchen-weekly'));
  assert.equal(RECORD_PATHS['kitchen-probe'], '/api/kitchen-weekly/probe');
  assert.equal(RECORD_PATHS['kitchen-weekly'], '/api/kitchen-weekly/weekly');
  await kitchen.enqueue(record('kitchen-probe', 'kitchen-probe-00001', {
    checkDate: '2026-10-14', probes: [{ name: 'Probe 1', iceTemp: '0.2', accurateIce: true }], overallResult: 'pass',
    signature: 'Manager', submittedAt: '2026-10-14T09:00:00.000Z',
  }));
  await kitchen.enqueue(record('kitchen-weekly', 'kitchen-weekly-0001', {
    weekCommencing: '2026-10-12', checks: { training: 'yes' }, managerSignature: 'Manager', submittedAt: '2026-10-14T09:00:00.000Z',
  }));
  for (const path of ['/api/kitchen-weekly/probe/5', '/api/kitchen-weekly/weekly/5', '/api/kitchen-weekly/probe/by-date/2026-10-14']) {
    await assert.rejects(kitchen.enqueue({ ...record('kitchen-probe', 'kitchen-probe-00002', {}), path }), /cannot be saved/, path);
    await assert.rejects(kitchen.enqueue({ ...record('kitchen-weekly', 'kitchen-weekly-0002', {}), path }), /cannot be saved/, path);
  }
  await assert.rejects(kitchen.enqueue({ ...record('kitchen-weekly', 'kitchen-weekly-0003', {}), path: RECORD_PATHS['kitchen-probe'] }), /cannot be saved/,
    'a weekly review cannot be posted as a probe check');
  await kitchen.replay();
  assert.deepEqual(kitchen.getSnapshot().entries.map((entry) => entry.state), ['queued', 'queued'], 'both wait on the device offline');
  online = true;
  refuseWeekly = true;
  await kitchen.replay();
  const stateOf = (kind) => kitchen.getSnapshot().entries.find((entry) => entry.kind === kind);
  assert.equal(stateOf('kitchen-probe').state, 'sent');
  assert.equal(stateOf('kitchen-weekly').state, 'failed', 'a refused review is kept on the device for the user');
  assert.match(stateOf('kitchen-weekly').error ?? '', /already exists/);
  const probeAttempts = sent.filter((attempt) => attempt.body.clientEntryId === 'kitchen-probe-00001');
  assert.ok(probeAttempts.length >= 2, 'offline attempt then automatic resend');
  for (const attempt of probeAttempts) assert.deepEqual(attempt, probeAttempts[0], 'every resend is identical, with the same entry ID');
  assert.ok(sent.every((attempt) => attempt.path === (attempt.body.clientEntryId.startsWith('kitchen-weekly') ? '/api/kitchen-weekly/weekly' : '/api/kitchen-weekly/probe')));
  kitchen.suspend();
}
assert.deepEqual(deliveredQueryKeys('kitchen-probe'), [['kitchen-probe-checks'], ['dashboard-summary']]);
assert.deepEqual(deliveredQueryKeys('kitchen-weekly'), [['kitchen-weekly-reviews'], ['dashboard-summary']]);

console.log('Check outbox tests passed: persist-before-send, offline replay of identical body, scope/ID guards, path allowlist, owner isolation, retry classification, tamper detection, record-form kinds.');
