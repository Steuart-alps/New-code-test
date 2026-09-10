import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('../components/cleaning-schedule-logic.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const logic = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const thursday = new Date(2026, 8, 10, 12, 0, 0);
assert.equal(logic.cleaningPeriodDate('daily', thursday), '2026-09-10');
assert.equal(logic.cleaningPeriodDate('weekly', thursday), '2026-09-07');
assert.equal(logic.cleaningPeriodDate('monthly', thursday), '2026-09-01');

const sunday = new Date(2026, 8, 13, 12, 0, 0);
assert.equal(logic.cleaningPeriodDate('weekly', sunday), '2026-09-07');

const monday = new Date(2026, 8, 14, 12, 0, 0);
assert.equal(logic.cleaningPeriodDate('weekly', monday), '2026-09-14');

const newYear = new Date(2027, 0, 1, 12, 0, 0);
assert.equal(logic.cleaningPeriodDate('weekly', newYear), '2026-12-28');
assert.equal(logic.cleaningPeriodDate('monthly', newYear), '2027-01-01');

console.log('Cleaning schedule period-date tests passed');