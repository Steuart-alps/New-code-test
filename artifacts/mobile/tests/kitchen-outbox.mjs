import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../lib/kitchenOutboxCore.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { KitchenOutbox, kitchenOutboxKey } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const A = { clientId: 101, userId: 201 };
const B = { clientId: 101, userId: 202 };
const C = { clientId: 102, userId: 201 };
const memory = new Map();
const storage = {
  async getItem(key) { return memory.get(key) ?? null; },
  async setItem(key, value) { memory.set(key, value); },
};
const input = (entryId, siteId = 1, recordId = null) => ({
  entryId, siteId, recordId, recordDate: '2026-10-02',
  body: recordId === null
    ? { recordDate: '2026-10-02', coldFood: [{ unit: 'Fridge', tempAm: '3' }] }
    : { mobileTemperatureLog: { coldFood: [], expectedColdFood: [], expectedCorrectives: null,
        hotHolding: { item: 'Soup', coreTemp: '75', timeOfCheck: '12:00' } } },
});
const errorWithStatus = status => Object.assign(new Error(`HTTP ${status}`), { status });

// A failed device write must never dispatch HTTP or claim successful queuing.
let sends = 0;
const diskFailure = new KitchenOutbox({
  storage: { ...storage, async setItem() { throw new Error('Device storage full'); } },
  async send() { sends++; }, async onSent() {},
});
await diskFailure.activate(A, 'test-token-A');
await diskFailure.replay();
await assert.rejects(diskFailure.enqueue(input('disk-failure-0001')), /storage full/);
assert.equal(sends, 0);
assert.equal(diskFailure.getSnapshot().entries.length, 0);
diskFailure.suspend();

// Signal loss, close, next-day launch: the exact persisted request is replayed.
const attempts = [];
let invalidations = 0;
const offline = new KitchenOutbox({
  storage,
  async send(entry, token) {
    assert.ok(memory.get(kitchenOutboxKey(A)), 'persist before sending');
    attempts.push({ entry: structuredClone(entry), token });
    throw new TypeError('Network request failed');
  },
  async onSent() { invalidations++; },
});
await offline.activate(A, 'test-token-A');
await offline.replay();
await offline.enqueue(input('offline-reading-0001', 44));
await offline.replay();
assert.equal(offline.getSnapshot().entries[0].state, 'queued');
assert.equal(invalidations, 0);
const savedBody = structuredClone(offline.getSnapshot().entries[0].body);
assert.equal(savedBody.mobileEntryId, 'offline-reading-0001');
offline.suspend();
assert.deepEqual(offline.getSnapshot().entries, [], 'logout immediately hides saved data');
assert.ok(!memory.get(kitchenOutboxKey(A)).includes('test-token-A'), 'credentials never go to AsyncStorage');
const relaunched = new KitchenOutbox({
  storage,
  async send(entry, token) { attempts.push({ entry: structuredClone(entry), token }); },
  async onSent() { invalidations++; },
});
await relaunched.activate(B, 'test-token-B');
await relaunched.replay();
assert.deepEqual(relaunched.getSnapshot().entries, [], 'another user in the same client sees no entries');
await relaunched.activate(C, 'test-token-C');
await relaunched.replay();
assert.deepEqual(relaunched.getSnapshot().entries, [], 'another client sees no entries');
await relaunched.activate(A, 'new-test-token-A');
await relaunched.replay();
assert.equal(relaunched.getSnapshot().entries[0].state, 'sent');
assert.deepEqual(attempts.at(-1).entry.body, savedBody);
assert.equal(attempts.at(-1).entry.recordDate, '2026-10-02');
assert.equal(attempts.at(-1).entry.siteId, 44);
assert.equal(attempts.at(-1).token, 'new-test-token-A');
assert.equal(invalidations, 1);
const countAfterSend = attempts.length;
await relaunched.replay();
assert.equal(attempts.length, countAfterSend, 'confirmed entries are not replayed');
relaunched.suspend();

// A process killed during HTTP leaves a "sending" copy; restart reuses the ID.
let started;
const startedPromise = new Promise(resolve => { started = resolve; });
const killed = new KitchenOutbox({
  storage, async send() { started(); await new Promise(() => {}); }, async onSent() {},
});
await killed.activate(A, 'before-crash');
await killed.replay();
await killed.enqueue(input('crash-reading-0001', 45, 731));
await startedPromise;
assert.equal(JSON.parse(memory.get(kitchenOutboxKey(A))).find(e => e.entryId === 'crash-reading-0001').state, 'sending');
killed.suspend();
const recovered = new KitchenOutbox({
  storage,
  async send(entry) {
    assert.equal(entry.entryId, 'crash-reading-0001');
    assert.equal(entry.recordId, 731);
    assert.equal(entry.body.mobileRecordDate, entry.recordDate);
  }, async onSent() {},
});
await recovered.activate(A, 'after-crash');
await recovered.replay();
assert.equal(recovered.getSnapshot().entries.find(e => e.entryId === 'crash-reading-0001').state, 'sent');
recovered.suspend();

// Permanent conflicts retain the exact readings for explicit review/retry.
let reject = true;
let conflictAttempts = 0;
const conflicts = new KitchenOutbox({
  storage,
  async send() { conflictAttempts++; if (reject) throw errorWithStatus(409); },
  async onSent() {},
});
await conflicts.activate(A, 'test-A');
await conflicts.replay();
await conflicts.enqueue(input('conflict-reading-0001', 46, 732));
await conflicts.replay();
const failed = conflicts.getSnapshot().entries.find(e => e.entryId === 'conflict-reading-0001');
assert.equal(failed.state, 'failed');
assert.match(failed.error, /409/);
await conflicts.replay();
assert.equal(conflictAttempts, 1, 'permanent failures do not loop');
await assert.rejects(conflicts.enqueue(input('second-reading-0001', 46, 732)), /already has a saved device entry/);
reject = false;
await conflicts.retry(failed.entryId);
await conflicts.replay();
assert.equal(conflicts.getSnapshot().entries.find(e => e.entryId === failed.entryId).state, 'sent');
assert.deepEqual(conflicts.getSnapshot().entries.find(e => e.entryId === failed.entryId).body, failed.body);
conflicts.suspend();

// Account switch in flight: outgoing bearer remains A; completion cannot affect B.
let release;
let switchStarted;
const switchReady = new Promise(resolve => { switchStarted = resolve; });
const switchInvalidations = [];
const switching = new KitchenOutbox({
  storage,
  async send(entry, token) {
    assert.equal(entry.owner.userId, A.userId);
    assert.equal(token, 'switch-token-A');
    switchStarted();
    await new Promise(resolve => { release = resolve; });
  },
  async onSent() { switchInvalidations.push('sent'); },
});
await switching.activate(A, 'switch-token-A');
await switching.replay();
await switching.enqueue(input('switch-reading-0001', 47));
await switchReady;
switching.suspend();
await switching.activate(B, 'switch-token-B');
release();
await switching.replay();
assert.deepEqual(switching.getSnapshot().owner, B);
assert.deepEqual(switching.getSnapshot().entries, []);
assert.deepEqual(switchInvalidations, [], 'old completions do not invalidate a new account');
assert.equal(JSON.parse(memory.get(kitchenOutboxKey(A))).find(e => e.entryId === 'switch-reading-0001').state, 'sent');
switching.suspend();

// Serialize concurrent device writes and never lose a queued sibling.
const concurrent = new KitchenOutbox({
  storage, async send() { throw errorWithStatus(503); }, async onSent() {},
});
await concurrent.activate(B, 'test-B');
await concurrent.replay();
await Promise.all(Array.from({ length: 6 }, (_, i) =>
  concurrent.enqueue(input(`parallel-reading-000${i}`, 60 + i))));
await concurrent.replay();
assert.equal(JSON.parse(memory.get(kitchenOutboxKey(B))).length, 6);
concurrent.suspend();

// Corrupt or foreign disk data is never sent or silently replaced.
const corruptedOwner = { clientId: 103, userId: 203 };
memory.set(kitchenOutboxKey(corruptedOwner), JSON.stringify([{ ...input('foreign-reading-0001'), owner: A }]));
const originalCorrupt = memory.get(kitchenOutboxKey(corruptedOwner));
const corrupt = new KitchenOutbox({ storage, async send() { assert.fail('must not send'); }, async onSent() {} });
await corrupt.activate(corruptedOwner, 'test-corrupt');
await corrupt.replay();
assert.match(corrupt.getSnapshot().error, /could not be read/);
await assert.rejects(corrupt.enqueue(input('corrupt-reading-0001')), /could not be read/);
assert.equal(memory.get(kitchenOutboxKey(corruptedOwner)), originalCorrupt);
corrupt.suspend();

// Stricter controls on reconnect: a rejected entry can be turned back into a
// draft. The server is asked first; the original payload stays unchanged on
// the device, is never sent again, and no longer blocks a new entry.
let stricter = true;
let stricterSends = 0;
const restoring = new KitchenOutbox({
  storage,
  async send() { stricterSends++; if (stricter) throw errorWithStatus(422); },
  async onSent() {},
});
await restoring.activate(A, 'test-A');
await restoring.replay();
await restoring.enqueue(input('stricter-rules-0001', 61, null));
await restoring.replay();
const rejected = restoring.getSnapshot().entries.find(e => e.entryId === 'stricter-rules-0001');
assert.equal(rejected.state, 'failed');
const originalBody = JSON.parse(JSON.stringify(rejected.body));
await assert.rejects(restoring.restoreToDraft('no-such-entry-0001', async () => false), /Only a failed device entry/);
const asked = [];
const draftCopy = await restoring.restoreToDraft(rejected.entryId, async entry => { asked.push(entry.entryId); return false; });
assert.deepEqual(asked, ['stricter-rules-0001'], 'the server is asked before restoring');
assert.deepEqual(draftCopy.body, originalBody, 'the restored copy is the original payload');
const restoredRow = restoring.getSnapshot().entries.find(e => e.entryId === rejected.entryId);
assert.equal(restoredRow.state, 'restored');
assert.deepEqual(restoredRow.body, originalBody, 'the original payload stays unchanged on the device');
stricter = false;
await restoring.replay();
assert.equal(stricterSends, 1, 'a restored entry is never sent');
const corrected = await restoring.enqueue(input('stricter-rules-0002', 61, null));
assert.equal(corrected.entryId, 'stricter-rules-0002', 'the draft saves under a new entry identifier');
await restoring.replay();
assert.equal(restoring.getSnapshot().entries.find(e => e.entryId === 'stricter-rules-0002').state, 'sent');
await assert.rejects(restoring.restoreToDraft(rejected.entryId, async () => false), /Only a failed device entry/,
  'a restored entry cannot be restored twice');
restoring.suspend();

// Restart recovery: the restored state and the untouched payload survive.
const afterRestart = new KitchenOutbox({ storage, async send() { throw new Error('must not send'); }, async onSent() {} });
await afterRestart.activate(A, 'test-A');
await afterRestart.replay();
const survived = afterRestart.getSnapshot().entries.find(e => e.entryId === 'stricter-rules-0001');
assert.equal(survived.state, 'restored');
assert.deepEqual(survived.body, originalBody);
afterRestart.suspend();

// An entry the server already applied is never restored or rewritten.
stricter = true;
const receipted = new KitchenOutbox({
  storage,
  async send() { if (stricter) throw errorWithStatus(422); },
  async onSent() {},
});
await receipted.activate(A, 'test-A');
await receipted.replay();
await receipted.enqueue(input('already-applied-0001', 62, null));
await receipted.replay();
const appliedBody = JSON.parse(JSON.stringify(receipted.getSnapshot().entries.find(e => e.entryId === 'already-applied-0001').body));
await assert.rejects(receipted.restoreToDraft('already-applied-0001', async () => true), /already recorded these readings/);
const applied = receipted.getSnapshot().entries.find(e => e.entryId === 'already-applied-0001');
assert.equal(applied.state, 'sent', 'a receipted entry is recorded as sent');
assert.deepEqual(applied.body, appliedBody, 'its payload is unchanged');
// The receipt check failing (offline) changes nothing.
await receipted.enqueue(input('offline-check-0001', 63, null));
await receipted.replay();
await assert.rejects(receipted.restoreToDraft('offline-check-0001', async () => { throw new Error('Network request failed'); }), /Network/);
assert.equal(receipted.getSnapshot().entries.find(e => e.entryId === 'offline-check-0001').state, 'failed');
receipted.suspend();

// Account change during the receipt check: nothing is restored for the old account.
const restoreSwitch = new KitchenOutbox({ storage, async send() { throw errorWithStatus(422); }, async onSent() {} });
await restoreSwitch.activate(A, 'test-A');
await restoreSwitch.replay();
await restoreSwitch.enqueue(input('account-switch-0001', 64, null));
await restoreSwitch.replay();
await assert.rejects(restoreSwitch.restoreToDraft('account-switch-0001', async () => {
  await restoreSwitch.activate(B, 'test-B');
  return false;
}), /signed-in account changed/);
restoreSwitch.suspend();
await restoreSwitch.activate(A, 'test-A');
assert.equal(restoreSwitch.getSnapshot().entries.find(e => e.entryId === 'account-switch-0001').state, 'failed');
restoreSwitch.suspend();
await restoreSwitch.activate(B, 'test-B');
await assert.rejects(restoreSwitch.restoreToDraft('account-switch-0001', async () => false), /Only a failed device entry/,
  "another account cannot restore this account's entry");
restoreSwitch.suspend();

const form = await readFile(new URL('../components/KitchenTemperatureForm.tsx', import.meta.url), 'utf8');
const auth = await readFile(new URL('../lib/auth.tsx', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../lib/kitchenOutbox.ts', import.meta.url), 'utf8');
const ui = await readFile(new URL('../components/KitchenQueueStatus.tsx', import.meta.url), 'utf8');
assert.match(form, /<KitchenQueueStatus \/>/);
assert.match(form, /kitchenOutbox\.enqueue\(/);
assert.match(auth, /startKitchenReplay/);
assert.match(auth, /kitchenOutbox\.activate\(\{ clientId: user\.clientId, userId: user\.id \}/);
assert.match(runtime, /Authorization: `Bearer \$\{token\}`/);
assert.match(runtime, /AppState\.addEventListener/);
assert.match(runtime, /setInterval/);
for (const label of ['Queued', 'Sent', 'Failed', 'Restored for editing', 'Edit as new entry']) assert.ok(ui.includes(label));
assert.match(runtime, /\/api\/food-safety\/mobile-entries\//, 'restoring asks the server for a receipt first');
console.log('KitchenTrack durable storage, restart/reconnect, delivery states, and account-isolation regressions passed.');