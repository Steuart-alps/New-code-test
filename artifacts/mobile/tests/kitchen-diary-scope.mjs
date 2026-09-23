import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/kitchen-diary-scope.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DEFAULT_DIARY_SITE, kitchenDiaryScope } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
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
console.log('Kitchen diary default, site-scoped load/save URLs and cache isolation passed.');