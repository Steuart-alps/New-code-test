// Unfinished KitchenTrack forms: per-account, per-diary device drafts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/kitchen-form-drafts.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  diaryFingerprint, discardKitchenDraft, formValuesFromEntryBody, kitchenFormDraftKey, listKitchenDrafts,
  loadKitchenDraft, mergeColdReadings, reviewKitchenDraft, saveKitchenDraft,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const memory = new Map();
const storage = {
  async getItem(key) { return memory.get(key) ?? null; },
  async setItem(key, value) { memory.set(key, value); },
  async removeItem(key) { memory.delete(key); },
  async getAllKeys() { return [...memory.keys()]; },
};
const A = { clientId: 101, userId: 201 };
const B = { clientId: 101, userId: 202 };
const otherClient = { clientId: 102, userId: 201 };
const TODAY = '2026-10-09';
const values = {
  coldFood: [{ unit: 'Fridge 1', tempAm: '4', tempPm: '', correctiveAction: '' },
    { unit: 'Retired fridge', tempAm: '9', tempPm: '', correctiveAction: 'moved stock' }],
  delivery: { supplier: 'Dairy Co', items: 'Milk', tempChilled: '3', tempFrozen: '', correctiveActions: '' },
  hotHolding: { item: 'Soup', coreTemp: '66', timeOfCheck: '12:00' },
  cooking: {}, cooling: {}, reheating: {}, correctives: 'Checked twice',
};
const record = { id: 7, coldFood: [{ unit: 'Fridge 1', tempAm: '3' }], correctives: null };
const draft = (owner, overrides = {}) => ({
  version: 1, owner, siteId: 5, recordDate: TODAY, values, baseline: diaryFingerprint(record),
  origin: 'form', savedAt: '2026-10-09T09:00:00Z', ...overrides,
});

// Keys and isolation: one draft per account and diary.
assert.notEqual(kitchenFormDraftKey(A, 5, TODAY), kitchenFormDraftKey(B, 5, TODAY));
assert.notEqual(kitchenFormDraftKey(A, 5, TODAY), kitchenFormDraftKey(otherClient, 5, TODAY));
assert.notEqual(kitchenFormDraftKey(A, 5, TODAY), kitchenFormDraftKey(A, null, TODAY));
assert.notEqual(kitchenFormDraftKey(A, 5, TODAY), kitchenFormDraftKey(A, 5, '2026-10-08'));
await saveKitchenDraft(storage, draft(A));
assert.deepEqual((await loadKitchenDraft(storage, A, 5, TODAY)).values, values, 'the owner sees their draft');
assert.equal(await loadKitchenDraft(storage, B, 5, TODAY), null, "another user never sees it");
assert.equal(await loadKitchenDraft(storage, otherClient, 5, TODAY), null, "another client never sees it");
assert.equal(await loadKitchenDraft(storage, A, 6, TODAY), null, 'another site has no draft');
// A record planted under the owner's key but naming someone else is ignored.
memory.set(kitchenFormDraftKey(B, 5, TODAY), JSON.stringify(draft(A)));
assert.equal(await loadKitchenDraft(storage, B, 5, TODAY), null, 'the stored owner is re-checked on read');
memory.set(kitchenFormDraftKey(A, 9, TODAY), '{not json');
assert.equal(await loadKitchenDraft(storage, A, 9, TODAY), null, 'unreadable drafts are treated as absent');
memory.set(kitchenFormDraftKey(A, 8, TODAY), JSON.stringify({ ...draft(A, { siteId: 8 }), values: { ...values, coldFood: 'x' } }));
assert.equal(await loadKitchenDraft(storage, A, 8, TODAY), null, 'malformed values are rejected');

// Review: unchanged diary → restore; changed diary or restored entry → review; another day → read-only.
assert.deepEqual(reviewKitchenDraft(draft(A), diaryFingerprint(record), TODAY), { kind: 'restore' });
assert.deepEqual(reviewKitchenDraft(draft(A), diaryFingerprint({ ...record, correctives: 'edited on the web' }), TODAY), { kind: 'review' });
assert.deepEqual(reviewKitchenDraft(draft(A, { baseline: null, origin: 'restored' }), diaryFingerprint(record), TODAY), { kind: 'review' });
assert.deepEqual(reviewKitchenDraft(draft(A, { recordDate: '2026-10-08' }), diaryFingerprint(record), TODAY), { kind: 'other-date' });
assert.equal(diaryFingerprint({ b: 1, a: [{ y: 2, x: 1 }] }), diaryFingerprint({ a: [{ x: 1, y: 2 }], b: 1 }), 'fingerprints ignore key order');
assert.notEqual(diaryFingerprint(null), diaryFingerprint(record), 'a diary created since is a change');

// Fresh baseline: draft readings land on the latest configured units only.
const fresh = [{ unit: 'Fridge 1', tempAm: '', tempPm: '', correctiveAction: '' },
  { unit: 'New freezer', tempAm: '', tempPm: '', correctiveAction: '' }];
assert.deepEqual(mergeColdReadings(fresh, values.coldFood), [
  { unit: 'Fridge 1', tempAm: '4', tempPm: '', correctiveAction: '' },
  { unit: 'New freezer', tempAm: '', tempPm: '', correctiveAction: '' },
]);

// Values from a rejected device entry, in both payload shapes the form sends.
const created = formValuesFromEntryBody({
  recordDate: TODAY, coldFood: [{ unit: 'Fridge 1', tempAm: '9', tempPm: '', correctiveAction: '' }],
  deliveries: [{ supplier: 'Dairy Co', items: 'Milk', tempChilled: '9' }], hotHolding: [], hotTemperature: [],
  cooling: [], reheating: [{ item: 'Stew', coreTemp: 70, timeStart: '11:00', timeFinish: '11:20' }], correctives: 'Binned',
});
assert.equal(created.coldFood[0].tempAm, '9');
assert.equal(created.delivery.tempChilled, '9');
assert.deepEqual(created.hotHolding, {});
assert.equal(created.reheating.coreTemp, '70', 'numbers become form strings');
assert.equal(created.correctives, 'Binned');
const updated = formValuesFromEntryBody({ mobileTemperatureLog: {
  coldFood: [{ unit: 'Freezer 1', tempAm: '-12' }], expectedColdFood: [], expectedCorrectives: null,
  hotHolding: { item: 'Soup', coreTemp: '58', timeOfCheck: '12:00' }, mobileEntryId: 'ignored',
} });
assert.equal(updated.coldFood[0].tempAm, '-12');
assert.equal(updated.hotHolding.coreTemp, '58');
assert.equal(updated.correctives, '');
const held = formValuesFromEntryBody({ mobileTemperatureLog: {
  coldFood: [], expectedColdFood: [], expectedCorrectives: null,
  hotTemperature: { item: 'Chicken', coreTemp: '80', holdSeconds: 12 },
} });
assert.equal(held.cooking.holdSeconds, '12', 'a restored cooking reading keeps its hold time');

// Listing finds only this owner's drafts, including earlier days'.
await saveKitchenDraft(storage, draft(A, { recordDate: '2026-10-08', siteId: null }));
await saveKitchenDraft(storage, draft(B, { siteId: 5 }));
const listed = await listKitchenDrafts(storage, A);
assert.deepEqual(listed.map(d => `${d.siteId}:${d.recordDate}`).sort(), ['5:2026-10-09', 'null:2026-10-08'].sort());
await discardKitchenDraft(storage, A, null, '2026-10-08');
assert.equal(await loadKitchenDraft(storage, A, null, '2026-10-08'), null, 'discard removes the draft');
assert.ok(await loadKitchenDraft(storage, B, 5, TODAY), "discarding never touches another account's draft");

// The form wires drafts to save, restore, review and discard.
const form = await readFile(new URL('../components/KitchenTemperatureForm.tsx', import.meta.url), 'utf8');
assert.match(form, /saveKitchenDraft\(/);
assert.match(form, /loadKitchenDraft\(kitchenDraftStorage, owner, siteId, date\)/);
assert.match(form, /Discard unsaved readings\?/, 'discarding asks first');
assert.match(form, /discardKitchenDraft\(kitchenDraftStorage, owner, siteId, date\)/, 'saving or discarding clears the draft');
console.log('KitchenTrack unfinished-form draft regressions passed.');
