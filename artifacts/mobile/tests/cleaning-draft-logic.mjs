import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/cleaning-draft-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildCleaningLogPayload,
  hydrateCleaningDraft,
  requestCleaningFrequencyChange,
  requestCleaningSiteChange,
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

console.log('Cleaning draft protection tests passed.');