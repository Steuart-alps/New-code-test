import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Entry IDs for direct-send forms (components/client-entry-logic.ts): a
// resend of unchanged answers reuses the ID (the server returns the stored
// record), changed answers get a new one, and photo receipts never matter.
const source = await readFile(new URL('../components/client-entry-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { attemptFromSavedBody, entryPayloadKey, nextEntryAttempt } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

let counter = 0;
const newId = () => `green-test-${String(++counter).padStart(6, '0')}`;
const answers = { machineId: 4, checkDate: '2026-10-15', checklistItems: [{ key: 'tyres', status: 'ok' }], notes: '' };

const first = nextEntryAttempt(null, { ...answers, photoUploadIds: ['a'] }, newId);
assert.equal(first.id, 'green-test-000001');
const resend = nextEntryAttempt(first, { ...answers, photoUploadIds: ['b', 'c'] }, newId);
assert.equal(resend.id, first.id, 'new photo receipts keep the same entry');
const reordered = Object.fromEntries(Object.entries(answers).reverse());
assert.equal(nextEntryAttempt(first, reordered, newId).id, first.id, 'key order is not part of the answers');
assert.equal(nextEntryAttempt(first, { ...answers, clientEntryId: 'other-id-000000' }, newId).id, first.id);
const edited = nextEntryAttempt(first, { ...answers, notes: 'Blade chipped' }, newId);
assert.notEqual(edited.id, first.id, 'changed answers are a new record');
const editedItem = nextEntryAttempt(first, { ...answers, checklistItems: [{ key: 'tyres', status: 'fail' }] }, newId);
assert.notEqual(editedItem.id, first.id);

// A device copy saved after a failed send restores the attempt it was sent under.
const saved = { ...answers, clientEntryId: first.id };
const restored = attemptFromSavedBody(saved);
assert.deepEqual(restored, { key: entryPayloadKey(answers), id: first.id });
assert.equal(nextEntryAttempt(restored, { ...answers, photoUploadIds: ['d'] }, newId).id, first.id,
  'resending a restored copy with re-added photos is recognised by the server');
assert.equal(attemptFromSavedBody(answers), null, 'copies saved by older versions carry no entry ID');
assert.equal(attemptFromSavedBody({ ...answers, clientEntryId: 'bad id' }), null);

console.log('Direct-send entry IDs: reused for unchanged answers, new for edits, photos and key order ignored.');
