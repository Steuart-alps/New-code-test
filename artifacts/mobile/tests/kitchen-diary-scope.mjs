import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = [
  await readFile(new URL('../components/kitchen-diary-scope.ts', import.meta.url), 'utf8'),
  await readFile(new URL('../components/kitchen-diary-draft-logic.ts', import.meta.url), 'utf8'),
].join('\n');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  DEFAULT_DIARY_SITE,
  kitchenDiaryScope,
  requestDiaryScopeChange,
  shouldHydrateDiaryDraft,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
assert.equal(DEFAULT_DIARY_SITE, null);
const date = '2026-09-23';
const all = kitchenDiaryScope(DEFAULT_DIARY_SITE, date);
assert.equal(all.configUrl, '/api/food-safety/config');
assert.equal(all.recordUrl, `/api/food-safety?date=${date}`);
assert.equal(all.saveUrl(null), '/api/food-safety');
assert.equal(all.saveUrl(42), '/api/food-safety/42');
for (const siteId of [1, 2]) {
  const scope = kitchenDiaryScope(siteId, date);
  assert.equal(scope.configUrl, `/api/food-safety/config?siteId=${siteId}`);
  assert.equal(scope.recordUrl, `/api/food-safety?date=${date}&siteId=${siteId}`);
  assert.equal(scope.saveUrl(null), `/api/food-safety?siteId=${siteId}`);
  assert.equal(scope.saveUrl(42), `/api/food-safety/42?siteId=${siteId}`);
  assert.deepEqual(scope.configKey, ['food-safety', 'config', siteId]);
  assert.deepEqual(scope.recordKey, ['food-safety', 'today', siteId, date]);
}
assert.notDeepEqual(kitchenDiaryScope(1, date).recordKey, kitchenDiaryScope(2, date).recordKey);
assert.notDeepEqual(all.recordKey, kitchenDiaryScope(null, '2026-09-24').recordKey);
const backToAll = kitchenDiaryScope(null, date);
assert.deepEqual(backToAll.recordKey, all.recordKey);
assert.equal(backToAll.saveUrl(null), all.saveUrl(null));
assert.equal(shouldHydrateDiaryDraft(false), true);
assert.equal(shouldHydrateDiaryDraft(true), false);
assert.deepEqual(requestDiaryScopeChange(1, 2, false, false), { kind: 'switch', siteId: 2 });
assert.deepEqual(requestDiaryScopeChange(1, 2, true, false), { kind: 'confirm', siteId: 2 });
assert.deepEqual(requestDiaryScopeChange(1, 2, true, true), { kind: 'ignore' });
assert.deepEqual(requestDiaryScopeChange(1, 1, true, false), { kind: 'ignore' });
// Cancelling a confirmation leaves the current scope unchanged; the caller
// only invokes the switch callback after the user chooses "Discard changes".
const pendingDiscard = requestDiaryScopeChange(1, 2, true, false);
assert.equal(pendingDiscard.kind, 'confirm');
assert.equal(pendingDiscard.siteId, 2);
console.log('Kitchen diary scope and draft-protection tests passed.');