import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Site registers on the phone (components/registers-logic.ts): read-only
// allergen, COSHH and asbestos look-ups. Vocabularies match the API, search
// and filters follow the website, the offline copy is per account and never
// hides a refusal from the server, and the screens have no write calls.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../components/registers-logic.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const logic = await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`);
const {
  ALLERGENS, PICTOGRAMS, CONDITION_LABELS, PRIORITY_LABELS, ACTION_LABELS, SURVEY_LABELS, BUILT_LABELS,
  fmtDate, siteName, filterAllergens, allergenMatrix, allergenShortNames, allergenReviewedText,
  filterCoshh, pictogramLabels, coshhReview, filterAsbestos, highestPriority, sortEntriesForSite,
  surveyText, planReviewText, priorityText, registerCacheKey, serializeRegisterCache, parseRegisterCache,
  chooseRegisterData, lastUpdatedText, REGISTER_CACHE_PREFIX,
} = logic;

// Vocabularies match the API route (routes/registers.ts).
const route = await readFile(new URL('../../api-server/src/routes/registers.ts', import.meta.url), 'utf8');
const list = (name) => [...route.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
assert.deepEqual(ALLERGENS.map((a) => a.key), list('ALLERGEN_KEYS'), 'the 14 allergens, in the API order');
assert.deepEqual(PICTOGRAMS.map((p) => p.key), list('GHS_PICTOGRAM_KEYS'));
assert.deepEqual(Object.keys(CONDITION_LABELS), list('CONDITIONS'));
assert.deepEqual(Object.keys(PRIORITY_LABELS), list('PRIORITIES'));
assert.deepEqual(Object.keys(ACTION_LABELS), list('ACTIONS'));
assert.deepEqual(Object.keys(SURVEY_LABELS), list('SURVEY_TYPES'));
assert.deepEqual(Object.keys(BUILT_LABELS), list('BUILT_BEFORE_2000'));
// Labels match the website pages.
const allergenPage = await readFile(new URL('../../compliance-tracker/src/pages/allergens.tsx', import.meta.url), 'utf8');
for (const a of ALLERGENS) assert.ok(allergenPage.includes(`label: "${a.label}"`), `${a.key} label matches the website`);
const asbestosPage = await readFile(new URL('../../compliance-tracker/src/pages/asbestos-register.tsx', import.meta.url), 'utf8');
for (const label of Object.values(ACTION_LABELS)) assert.ok(asbestosPage.includes(`"${label}"`), `${label} matches the website`);

// Display helpers.
assert.equal(fmtDate('2026-10-05'), '5 Oct 2026');
assert.equal(fmtDate('2026-01-31T10:00:00.000Z'), '31 Jan 2026');
assert.equal(fmtDate(null), '');
const sites = [{ id: 1, name: 'Main kitchen' }, { id: 2, name: 'Cafe' }];
assert.equal(siteName(sites, 2), 'Cafe');
assert.equal(siteName(sites, null), 'Site removed');
assert.equal(siteName(sites, 9), 'Unknown site');

// Allergens: website search (name + description), site filter, full matrix.
const dishes = [
  { id: 1, siteId: 1, name: 'Fish pie', description: 'Cod, milk sauce', allergens: ['milk', 'fish', 'gluten'], ppds: false, lastReviewedAt: '2026-09-01', reviewedBy: 'Sam' },
  { id: 2, siteId: 2, name: 'Fruit salad', description: null, allergens: [], ppds: true, lastReviewedAt: null, reviewedBy: null },
];
assert.deepEqual(filterAllergens(dishes, null, '').map((d) => d.id), [1, 2]);
assert.deepEqual(filterAllergens(dishes, 2, '').map((d) => d.id), [2]);
assert.deepEqual(filterAllergens(dishes, null, 'MILK').map((d) => d.id), [1], 'searches the description');
const matrix = allergenMatrix(dishes[0]);
assert.equal(matrix.length, 14, 'every regulated allergen is shown');
assert.deepEqual(matrix.filter((r) => r.contains).map((r) => r.key), ['gluten', 'fish', 'milk']);
assert.deepEqual(allergenShortNames(dishes[0]), ['Gluten', 'Fish', 'Milk'], 'regulation order');
assert.equal(allergenReviewedText(dishes[0]), 'Reviewed: 1 Sep 2026 by Sam');
assert.equal(allergenReviewedText(dishes[1]), 'Reviewed: not recorded');

// COSHH: withdrawn hidden unless asked; review badge as on the website.
const substances = [
  { id: 1, siteId: 1, productName: 'Oven cleaner', supplier: 'Acme', hazardPictograms: ['ghs05', 'ghs07'], whereUsed: 'Kitchen', status: 'in_use', reviewDue: '2026-10-01', reviewOverdue: true, sdsObjectPath: null },
  { id: 2, siteId: 2, productName: 'Bleach', supplier: null, hazardPictograms: [], whereUsed: 'Toilets', status: 'withdrawn', reviewDue: null, reviewOverdue: false, sdsObjectPath: 'x' },
  { id: 3, siteId: 1, productName: 'Descaler', supplier: 'Acme', hazardPictograms: ['ghs99'], whereUsed: null, status: 'in_use', reviewDue: '2026-11-01', reviewOverdue: false, sdsObjectPath: 'y' },
];
assert.deepEqual(filterCoshh(substances, null, '', false).map((s) => s.id), [1, 3]);
assert.deepEqual(filterCoshh(substances, null, '', true).map((s) => s.id), [1, 2, 3]);
assert.deepEqual(filterCoshh(substances, null, 'acme', false).map((s) => s.id), [1, 3], 'searches the supplier');
assert.deepEqual(filterCoshh(substances, null, 'toilets', true).map((s) => s.id), [2], 'searches where used');
assert.deepEqual(pictogramLabels(['ghs05']), [{ key: 'ghs05', label: 'Corrosive', code: 'GHS05' }]);
assert.equal(pictogramLabels(['ghs99'])[0].label, 'ghs99', 'an unknown key is still shown');
const today = '2026-10-15';
assert.deepEqual(coshhReview(substances[0], today), { state: 'overdue', text: 'Review overdue (1 Oct 2026)' });
assert.deepEqual(coshhReview(substances[1], today), { state: 'withdrawn', text: 'Withdrawn' });
assert.equal(coshhReview(substances[2], today).state, 'soon', 'due within 30 days');
assert.equal(coshhReview({ ...substances[2], reviewDue: '2027-01-01' }, today).text, 'Review 1 Jan 2027');
assert.equal(coshhReview({ ...substances[2], reviewDue: null }, today).text, 'No review date');

// Asbestos: search by site, location, material; worst first for someone on site.
const records = [
  { id: 1, siteId: 1, builtBefore2000: 'yes', noAsbestosExpected: false, surveyType: 'management', surveyDate: '2025-03-02', surveyor: 'Survey Co', planReviewDue: '2026-03-02', planReviewOverdue: true, notes: null,
    entries: [
      { id: 10, location: 'Boiler room', material: 'Pipe lagging', condition: 'low_damage', riskScore: 5, priority: 'medium', action: 'encapsulate', lastInspected: null, notes: null },
      { id: 11, location: 'Corridor ceiling', material: 'AIB tiles', condition: 'high_damage', riskScore: 12, priority: 'high', action: 'remove', lastInspected: '2026-01-01', notes: null },
      { id: 12, location: 'Attic', material: 'Cement sheet', condition: 'good', riskScore: null, priority: 'low', action: 'manage', lastInspected: null, notes: null },
    ] },
  { id: 2, siteId: 2, builtBefore2000: 'no', noAsbestosExpected: true, surveyType: null, surveyDate: null, surveyor: null, planReviewDue: null, planReviewOverdue: false, notes: null, entries: [] },
];
assert.deepEqual(filterAsbestos(records, sites, null, 'lagging').map((r) => r.id), [1]);
assert.deepEqual(filterAsbestos(records, sites, null, 'cafe').map((r) => r.id), [2], 'searches the site name');
assert.deepEqual(filterAsbestos(records, sites, 1, '').map((r) => r.id), [1]);
assert.equal(highestPriority(records[0]), 'high');
assert.equal(highestPriority(records[1]), null);
assert.deepEqual(sortEntriesForSite(records[0].entries).map((e) => e.id), [11, 10, 12]);
assert.equal(surveyText(records[0]), 'Management survey on 2 Mar 2025 by Survey Co');
assert.equal(surveyText(records[1], true), 'No survey recorded');
assert.equal(planReviewText(records[0]), 'Plan review overdue 2 Mar 2026');
assert.equal(planReviewText(records[1]), null, 'no plan review when no asbestos is expected');
assert.equal(priorityText(records[0].entries[1]), 'High priority (score 12)');

// Offline copy: per client and user, versioned, corrupt copies ignored.
const key = registerCacheKey({ clientId: 4, userId: 9 }, 'coshh');
assert.equal(key, `${REGISTER_CACHE_PREFIX}4:9:coshh`);
assert.notEqual(key, registerCacheKey({ clientId: 5, userId: 9 }, 'coshh'));
const saved = serializeRegisterCache(substances, new Date('2026-10-15T08:05:00Z'));
assert.deepEqual(parseRegisterCache(saved), { version: 1, savedAt: '2026-10-15T08:05:00.000Z', data: substances });
assert.equal(parseRegisterCache('{nope'), null);
assert.equal(parseRegisterCache(JSON.stringify({ version: 2, savedAt: 'x', data: [] })), null);
assert.equal(parseRegisterCache(null), null);
const cached = parseRegisterCache(saved);
assert.deepEqual(chooseRegisterData({ live: [1], cached, errored: false, connectionError: false }), { data: [1], fromCache: false, savedAt: null });
assert.equal(chooseRegisterData({ live: undefined, cached, errored: false, connectionError: false }).fromCache, true, 'saved copy while loading');
assert.equal(chooseRegisterData({ live: undefined, cached, errored: true, connectionError: true }).data.length, 3, 'saved copy offline');
assert.equal(chooseRegisterData({ live: undefined, cached, errored: true, connectionError: false }).data, null, 'a refusal from the server is not hidden');
assert.equal(chooseRegisterData({ live: undefined, cached: null, errored: true, connectionError: true }).data, null);
assert.match(lastUpdatedText('2026-10-15T08:05:00.000Z'), /^Saved on this phone\. Last updated 15 Oct 2026, \d\d:05\.$/);

// Screens: read only (GET requests only), hub entries and sign-out clearing.
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
for (const screen of ['allergens', 'coshh', 'asbestos']) {
  const source = await read(`../app/manage/${screen}.tsx`);
  assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/, `${screen} never writes`);
  assert.match(source, /useCachedRegister/, `${screen} keeps an offline copy`);
  const layout = await read('../app/_layout.tsx');
  assert.ok(layout.includes(`name="manage/${screen}"`), `${screen} is registered in the stack`);
}
assert.match(await read('../app/manage/allergens.tsx'), /hasService\('kitchentrack'\)/, 'allergens need KitchenTrack, as on the website');
assert.match(await read('../app/manage/asbestos.tsx'), /DO NOT DISTURB/);
const items = await read('../components/manage-items.ts');
assert.match(items, /id: 'allergens',[\s\S]*?audience: 'everyone',\s*service: 'kitchentrack'/);
assert.match(items, /id: 'coshh',[\s\S]*?audience: 'everyone',\s*\}/);
assert.match(items, /id: 'asbestos',[\s\S]*?audience: 'everyone',\s*\}/);
const auth = await read('../lib/auth.tsx');
assert.equal((auth.match(/clearRegisterCache\(\)/g) ?? []).length, 2, 'saved registers are cleared on sign-out and on an expired session');
assert.doesNotMatch(await read('../components/register-ui.tsx'), /method:/, 'documents open with a GET for a signed link');

console.log('Register look-up tests passed: API vocabularies, website search and labels, offline copy per account, read-only screens.');
