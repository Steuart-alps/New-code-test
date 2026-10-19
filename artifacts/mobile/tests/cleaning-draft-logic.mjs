import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/cleaning-draft-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildCleaningLogPayload,
  cleaningDraftKey,
  cleaningSyncStatus,
  discardCleaningDraft,
  hydrateCleaningDraft,
  loadCleaningDraft,
  parseCleaningDraft,
  pendingCleaningEntry,
  requestCleaningFrequencyChange,
  requestCleaningSiteChange,
  saveCleaningDraft,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

// Frequency switches with dirty work require confirmation; clean switches
// can proceed, and a save in progress cannot change scope underneath it.
assert.deepEqual(
  requestCleaningFrequencyChange('daily', 'weekly', true, false),
  { kind: 'confirm', frequency: 'weekly' },
);
assert.deepEqual(
  requestCleaningFrequencyChange('daily', 'weekly', false, false),
  { kind: 'switch', frequency: 'weekly' },
);
assert.deepEqual(
  requestCleaningFrequencyChange('daily', 'weekly', true, true),
  { kind: 'ignore' },
);
assert.deepEqual(
  requestCleaningSiteChange(null, 7, false, false),
  { kind: 'switch', siteId: 7 },
);
assert.deepEqual(
  requestCleaningSiteChange(7, 8, true, false),
  { kind: 'confirm', siteId: 8 },
);
assert.deepEqual(
  requestCleaningSiteChange(7, 8, true, true),
  { kind: 'ignore' },
);

const savedDraft = {
  signed_by: 'Alice',
  completions: [
    { taskId: 1, taskName: 'Mop floor', done: true, doneBy: 'Alice' },
  ],
};
const reopened = hydrateCleaningDraft(savedDraft, 'Bob', false);
assert.deepEqual(reopened, {
  checked: { 1: true },
  doneBy: { 1: 'Alice' },
  initials: 'Alice',
});

// A background refresh is ignored while the user has local edits.
assert.equal(hydrateCleaningDraft({
  signed_by: 'Server refresh',
  completions: [{ taskId: 1, taskName: 'Mop floor', done: false }],
}, 'Bob', true), null);

// Extending a reopened draft keeps the previous task's staff attribution and
// assigns the current staff member only to the newly completed task.
const extended = buildCleaningLogPayload({
  logDate: '2026-09-23',
  frequency: 'daily',
  siteId: 7,
  tasks: [
    { id: 1, area: 'Floor', task: 'Mop floor' },
    { id: 2, area: 'Bins', task: 'Empty bins' },
  ],
  checked: { 1: true, 2: true },
  doneBy: reopened.doneBy,
  staffName: 'Bob',
  submit: false,
});
assert.equal(extended.siteId, 7);
assert.deepEqual(extended.completions, [
  { taskId: 1, taskArea: 'Floor', taskName: 'Mop floor', done: true, doneBy: 'Alice' },
  { taskId: 2, taskArea: 'Bins', taskName: 'Empty bins', done: true, doneBy: 'Bob' },
]);

// Drafts remain reopenable; final sign-off carries a timestamp.
assert.equal(extended.submittedAt, null);
const signedOff = buildCleaningLogPayload({
  logDate: '2026-09-23',
  frequency: 'daily',
  tasks: [{ id: 1, area: 'Floor', task: 'Mop floor' }],
  checked: { 1: true },
  doneBy: { 1: 'Alice' },
  staffName: 'Bob',
  submit: true,
  submittedAt: '2026-09-23T12:34:56.000Z',
});
assert.equal(signedOff.submittedAt, '2026-09-23T12:34:56.000Z');
assert.equal(signedOff.signedBy, 'Bob');

// Device drafts: one per account and schedule (kitchen, frequency, period).
{
  const store = new Map();
  const storage = {
    async getItem(key) { return store.get(key) ?? null; },
    async setItem(key, value) { store.set(key, value); },
    async removeItem(key) { store.delete(key); },
  };
  const owner = { clientId: 3, userId: 9 };
  const scope = { siteId: 7, frequency: 'daily', logDate: '2026-10-15' };
  const draft = { version: 1, owner, ...scope, checked: { 1: true }, doneBy: { 1: 'Ann' }, initials: 'Ann', savedAt: '2026-10-15T09:00:00.000Z' };
  await saveCleaningDraft(storage, draft);
  assert.equal(cleaningDraftKey(owner, scope), 'complytrack:cleaning-draft:v1:3:9:7:daily:2026-10-15');
  assert.deepEqual(await loadCleaningDraft(storage, owner, scope), draft);
  // Another user, client, kitchen, frequency or period never sees it.
  assert.equal(await loadCleaningDraft(storage, { clientId: 3, userId: 10 }, scope), null);
  assert.equal(await loadCleaningDraft(storage, { clientId: 4, userId: 9 }, scope), null);
  assert.equal(await loadCleaningDraft(storage, owner, { ...scope, siteId: 8 }), null);
  assert.equal(await loadCleaningDraft(storage, owner, { ...scope, frequency: 'weekly' }), null);
  assert.equal(await loadCleaningDraft(storage, owner, { ...scope, logDate: '2026-10-16' }), null);
  // A copied or tampered value under the right key is ignored.
  assert.equal(parseCleaningDraft(JSON.stringify({ ...draft, owner: { clientId: 3, userId: 10 } }), owner, scope), null);
  assert.equal(parseCleaningDraft(JSON.stringify({ ...draft, siteId: 8 }), owner, scope), null);
  assert.equal(parseCleaningDraft(JSON.stringify({ ...draft, checked: { 1: 'yes' } }), owner, scope), null);
  assert.equal(parseCleaningDraft('not json', owner, scope), null);
  await discardCleaningDraft(storage, owner, scope);
  assert.equal(await loadCleaningDraft(storage, owner, scope), null);
}

// Device outbox entries for the schedule on screen, newest save first.
{
  const scope = { siteId: 7, frequency: 'daily', logDate: '2026-10-15' };
  const body = (extra) => ({ siteId: 7, frequency: 'daily', logDate: '2026-10-15', completions: [], submittedAt: null, ...extra });
  const entries = [
    { entryId: 'older-draft', kind: 'cleaning-log', state: 'queued', body: body(), createdAt: '2026-10-15T09:00:00.000Z' },
    { entryId: 'sign-off', kind: 'cleaning-log', state: 'sending', body: body({ submittedAt: '2026-10-15T09:05:00.000Z' }), createdAt: '2026-10-15T09:05:00.000Z' },
    { entryId: 'other-kitchen', kind: 'cleaning-log', state: 'queued', body: body({ siteId: 8 }), createdAt: '2026-10-15T09:06:00.000Z' },
    { entryId: 'other-kind', kind: 'pool-check', state: 'queued', body: body(), createdAt: '2026-10-15T09:07:00.000Z' },
    // Delivered entries are moved to the end of the outbox list.
    { entryId: 'earliest-sent', kind: 'cleaning-log', state: 'sent', body: body(), createdAt: '2026-10-15T08:00:00.000Z' },
  ];
  assert.equal(pendingCleaningEntry(entries, scope).entryId, 'sign-off');
  assert.equal(pendingCleaningEntry(entries, { ...scope, siteId: 9 }), null);
  assert.deepEqual(cleaningSyncStatus(entries, scope), { kind: 'sending', signOff: true, entryId: 'sign-off' });
  const delivered = entries.map((entry) => ({ ...entry, state: 'sent' }));
  assert.equal(pendingCleaningEntry(delivered, scope), null);
  assert.deepEqual(cleaningSyncStatus(delivered, scope), { kind: 'sent', signOff: true, entryId: 'sign-off' });
  const rejected = [{ ...entries[1], state: 'failed', error: 'Already signed off' }];
  assert.equal(pendingCleaningEntry(rejected, scope), null);
  assert.deepEqual(cleaningSyncStatus(rejected, scope), { kind: 'failed', signOff: true, entryId: 'sign-off', error: 'Already signed off' });
  assert.deepEqual(cleaningSyncStatus([], scope), { kind: 'none' });
}

console.log('Cleaning draft protection tests passed (including device drafts and outbox state).');