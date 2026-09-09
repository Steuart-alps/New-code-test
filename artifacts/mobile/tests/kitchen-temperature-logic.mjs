import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = new URL('../components/kitchen-temperature-logic.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const logic = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const blankValues = () => ({
  coldFood: [{ tempAm: '', tempPm: '' }],
  delivery: { supplier: '', tempChilled: '', tempFrozen: '' },
  hotHolding: { item: '', coreTemp: '', timeOfCheck: '12:30' },
  cooking: { item: '', coreTemp: '' },
  cooling: { item: '', coreTemp: '' },
  reheating: { item: '', coreTemp: '' },
  correctives: '',
});
const visible = {
  deliveries: true,
  hotHolding: true,
  cooking: true,
  cooling: true,
  reheating: true,
};

assert.equal(logic.shouldIncludeHotHolding(blankValues().hotHolding), false);
assert.equal(logic.canSaveTemperatureForm(blankValues(), visible), false);

for (const section of ['delivery', 'cooking', 'cooling', 'reheating']) {
  const values = blankValues();
  values[section].coreTemp = '6.2';
  assert.equal(
    logic.canSaveTemperatureForm(values, visible),
    true,
    `${section} temperature should enable saving`,
  );
}

const hiddenDelivery = blankValues();
hiddenDelivery.delivery.tempChilled = '5';
assert.equal(
  logic.canSaveTemperatureForm(hiddenDelivery, { ...visible, deliveries: false }),
  false,
);

console.log('Kitchen temperature form logic tests passed');