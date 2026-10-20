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

console.log('Check outbox tests passed: persist-before-send, offline replay of identical body, scope/ID guards, path allowlist, owner isolation, retry classification, tamper detection, record-form kinds.');
