import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// TreeTrack phone form (components/tree-track-logic.ts): the POST
// /api/tree-track body matches the website's (same fields, blank text as
// null, severity only on a failed inspection), client-side checks stop a bad
// submission, the "what's due" wording follows the website, and the screen
// sends through the device outbox and is gated on the treetrack service.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../components/tree-track-logic.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const logic = await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`);
const { buildTreeInspectionBody, treeDueText, treeObservationResult, calendarDaysUntil, TREE_CHECK_TYPES } = logic;

// Same inspection types as the API (lib/db schema TREE_CHECK_TYPES).
const schema = await readFile(new URL('../../../lib/db/src/schema/tree-inspections.ts', import.meta.url), 'utf8');
for (const type of TREE_CHECK_TYPES) assert.ok(schema.includes(`"${type}"`), `${type} is an API check type`);
assert.equal(TREE_CHECK_TYPES.length, (schema.match(/^\s+"[a-z_]+",$/gm) ?? []).length, 'no API check type is missing');

const today = '2026-10-15';
const draft = {
  checkType: 'post_storm', checkDate: today, result: 'fail', actionSeverity: 'urgent_action',
  treeRef: '  T1 ', location: 'East boundary', inspector: ' Arborist Ltd ', followUpDate: '2026-11-01',
  notes: '  Split limb  ', siteId: 7,
};
assert.deepEqual(buildTreeInspectionBody(draft, today), {
  ok: true,
  body: {
    checkType: 'post_storm', checkDate: today, result: 'fail', actionSeverity: 'urgent_action',
    treeRef: 'T1', location: 'East boundary', inspector: 'Arborist Ltd', followUpDate: '2026-11-01',
    siteId: 7, notes: 'Split limb',
  },
});
const blank = buildTreeInspectionBody({
  ...draft, result: 'pass', treeRef: ' ', location: '', inspector: '', followUpDate: ' ', notes: '', siteId: null,
}, today);
assert.equal(blank.ok, true);
assert.deepEqual(blank.body, {
  checkType: 'post_storm', checkDate: today, result: 'pass', actionSeverity: null,
  treeRef: null, location: null, inspector: null, followUpDate: null, siteId: null, notes: null,
}, 'blank text is null and a pass carries no severity');

const refused = (changes) => buildTreeInspectionBody({ ...draft, ...changes }, today);
assert.match(refused({ result: null }).title, /Result required/, 'Pass or Fail must be chosen');
assert.match(refused({ checkDate: '2026-10-16' }).message, /future/);
assert.match(refused({ checkDate: '2026-02-30' }).title, /Date required/);
assert.match(refused({ followUpDate: '01/11/2026' }).title, /Follow-up/);

assert.equal(calendarDaysUntil('2026-10-25', today), 10);
assert.equal(calendarDaysUntil('2026-03-29', '2026-03-28'), 1, 'DST change is one calendar day');
const row = (status, dueDate) => ({ checkType: 'visual_assessment', frequencyDays: 365, lastDate: null, dueDate, status });
assert.equal(treeDueText(row('never', null), today), 'Not yet recorded');
assert.equal(treeDueText(row('overdue', '2026-10-12'), today), '3d overdue');
assert.equal(treeDueText(row('due_soon', '2026-10-20'), today), 'Due in 5d');
assert.equal(treeDueText(row('ok', '2027-06-01'), today), 'Next 1 Jun 2027');

assert.equal(treeObservationResult({ result: 'pass' }), 'pass');
assert.equal(treeObservationResult({ result: 'urgent_action' }), 'fail', 'legacy severity results read as a failed observation');
assert.equal(treeObservationResult({ result: 'monitor', observationResult: 'fail' }), 'fail');

// The screen sends through the outbox and is gated like the other modules.
const screen = await readFile(new URL('../app/checks/tree.tsx', import.meta.url), 'utf8');
assert.ok(screen.includes("useRecordOutbox('tree-inspection')"), 'inspections go through the device outbox');
assert.ok(screen.includes('<OutboxEntries'), 'unsent inspections are shown');
assert.ok(screen.includes("hasService('treetrack')"), 'the screen is gated on the service');
const checks = await readFile(new URL('../app/(tabs)/checks.tsx', import.meta.url), 'utf8');
assert.ok(checks.includes("(mod.id !== 'tree' || hasService('treetrack'))"), 'TreeTrack is hidden from Checks without the service');

console.log('TreeTrack logic tests passed: website body, client-side checks, due wording, outbox and service gating.');
