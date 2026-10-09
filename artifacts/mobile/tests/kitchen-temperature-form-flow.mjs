import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = [
  await readFile(new URL('../components/kitchen-diary-scope.ts', import.meta.url), 'utf8'),
  await readFile(new URL('../components/kitchen-temperature-form-logic.ts', import.meta.url), 'utf8'),
].join('\n');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  FOOD_SAFETY_QUERY_KEY,
  buildKitchenTemperatureWrite,
  configuredUnits,
  deviceLocalCalendarDate,
  hydrateColdReadings,
  invalidateKitchenDashboard,
  kitchenDiaryScope,
  saveKitchenTemperatureDiary,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const originalTimezone = process.env.TZ;
for (const [timezone, expected] of [
  ['Europe/London', '2026-10-03'],
  ['America/Los_Angeles', '2026-10-02'],
  ['Asia/Tokyo', '2026-10-03'],
]) {
  process.env.TZ = timezone;
  assert.equal(
    deviceLocalCalendarDate(new Date('2026-10-02T23:30:00.000Z')),
    expected,
    `today follows the ${timezone} device-local calendar`,
  );
}
if (originalTimezone === undefined) delete process.env.TZ;
else process.env.TZ = originalTimezone;

const date = '2026-10-02';
const scope = kitchenDiaryScope(null, date);
const configured = configuredUnits({
  food_cold_units: JSON.stringify([
    { name: 'Walk-in chiller', type: 'fridge' },
    { name: 'Prep freezer', type: 'freezer' },
  ]),
});
assert.deepEqual(configured, [
  { name: 'Walk-in chiller', type: 'fridge' },
  { name: 'Prep freezer', type: 'freezer' },
]);

const newDiary = hydrateColdReadings(configured, null);
assert.deepEqual(newDiary.coldFood, [
  { unit: 'Walk-in chiller', tempAm: '', tempPm: '', correctiveAction: '' },
  { unit: 'Prep freezer', tempAm: '', tempPm: '', correctiveAction: '' },
]);
const newBody = { recordDate: date, coldFood: newDiary.coldFood };
const createCalls = [];
const createEvents = [];
const createResult = await saveKitchenTemperatureDiary(
  scope,
  null,
  newBody,
  async (url, options) => {
    createCalls.push({ url, options });
    createEvents.push('api-save');
    return { id: 731 };
  },
  { async invalidateQueries(options) {
    createEvents.push(['invalidate', options]);
  } },
);
assert.deepEqual(createCalls, [{
  url: '/api/food-safety',
  options: { method: 'POST', body: JSON.stringify(newBody) },
}]);
assert.deepEqual(createResult, { id: 731 });
assert.deepEqual(createEvents, ['api-save', ['invalidate', { queryKey: ['food-safety'] }]],
  'successful creation invalidates the dashboard after the API save');

const existingRecord = {
  id: 731,
  coldFood: [
    { unit: 'Walk-in chiller', tempAm: '3.5', tempPm: '4', correctiveAction: 'Moved stock' },
    { unit: 'Prep freezer', tempAm: '-18', tempPm: '-19', correctiveAction: '' },
    { unit: 'Removed unit', tempAm: '5', tempPm: '6', correctiveAction: '' },
  ],
};
const existingDiary = hydrateColdReadings(configured, existingRecord.coldFood);
assert.deepEqual(existingDiary.coldFood, existingRecord.coldFood.slice(0, 2),
  'configured fridge and freezer values pre-populate without reviving removed slots');
assert.deepEqual(existingDiary.initialColdFood, existingRecord.coldFood.slice(0, 2));
const existingBody = { coldFood: existingDiary.coldFood };
const updateCalls = [];
const updateEvents = [];
await saveKitchenTemperatureDiary(
  scope,
  existingRecord.id,
  existingBody,
  async (url, options) => {
    updateCalls.push({ url, options });
    updateEvents.push('api-save');
    return { ok: true };
  },
  { async invalidateQueries(options) {
    updateEvents.push(['invalidate', options]);
  } },
);
assert.deepEqual(updateCalls, [{
  url: '/api/food-safety/731',
  options: { method: 'PUT', body: JSON.stringify(existingBody) },
}]);
assert.deepEqual(updateEvents, ['api-save', ['invalidate', { queryKey: ['food-safety'] }]],
  'successful update invalidates the dashboard after the API save');
const updateWrite = buildKitchenTemperatureWrite(scope, existingRecord.id, existingBody);
assert.equal(updateWrite.url, '/api/food-safety/731');
assert.equal(updateWrite.options.method, 'PUT');
assert.deepEqual(JSON.parse(updateWrite.options.body), existingBody);
assert.throws(() => buildKitchenTemperatureWrite(scope, undefined, {}),
  /Wait for the selected diary to load/);
const failedSaveInvalidations = [];
await assert.rejects(saveKitchenTemperatureDiary(
  scope,
  null,
  newBody,
  async () => { throw new Error('offline'); },
  { async invalidateQueries(options) { failedSaveInvalidations.push(options); } },
), /offline/);
assert.deepEqual(failedSaveInvalidations, [], 'failed saves do not mark a stale dashboard as fresh');

const invalidations = [];
const queryClient = {
  async invalidateQueries(options) {
    invalidations.push(options);
  },
};
await invalidateKitchenDashboard(queryClient);
assert.deepEqual(FOOD_SAFETY_QUERY_KEY, ['food-safety']);
assert.deepEqual(invalidations, [{ queryKey: ['food-safety'] }]);

const formSource = await readFile(new URL('../components/KitchenTemperatureForm.tsx', import.meta.url), 'utf8');
const logicSource = await readFile(new URL('../components/kitchen-temperature-form-logic.ts', import.meta.url), 'utf8');
assert.match(formSource, /function today\(\): string \{\s*return deviceLocalCalendarDate\(new Date\(\)\);/);
assert.match(formSource, /const \[date\] = useState\(today\);/,
  'the diary date stays stable while a staff member is editing it');
assert.match(formSource, /hydrateColdReadings\(units, existingRecord\?\.coldFood\)/);
assert.match(formSource, /return kitchenOutbox\.enqueue\(/,
  'the form persists each save before its HTTP attempt');
assert.match(logicSource, /buildKitchenTemperatureWrite\(scope, recordId, body\)/);
assert.match(logicSource, /await invalidateKitchenDashboard\(queryClient\)/);
assert.match(formSource, /coldFood\.map\(\(reading, index\)/);
const kitchenRoute = await readFile(new URL('../app/checks/kitchen.tsx', import.meta.url), 'utf8');
assert.match(kitchenRoute, /return <KitchenTemperatureForm \/>;/,
  'the direct KitchenTrack route uses the tested form');
const typedRoute = await readFile(new URL('../app/checks/[type].tsx', import.meta.url), 'utf8');
assert.match(typedRoute, /if \(isKitchen\) \{\s*return <KitchenTemperatureForm \/>;/,
  'the checks/kitchen route uses the tested form');

console.log('KitchenTrack temperature diary create, update, hydration, and cache-invalidation tests passed.');