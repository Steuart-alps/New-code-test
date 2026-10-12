// KitchenTrack cleaning schedule PDF export: role and authentication gates,
// consultant client scoping, inclusive date ranges, controlled validation
// errors, frequency filters and the evidence printed in the PDF itself.
// Run: pnpm --filter @workspace/api-server run test:cleaning-schedule-export
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base, createTenant, createUser, pool, requestSession } from './approval-workflow-fixtures.mjs';

try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
} catch {
  throw new Error('pdftotext (poppler-utils) is required to read the exported PDF text.');
}

function pdfText(pdf) {
  const dir = mkdtempSync(join(tmpdir(), 'cleaning-export-'));
  try {
    writeFileSync(join(dir, 'export.pdf'), pdf);
    execFileSync('pdftotext', ['-layout', join(dir, 'export.pdf'), join(dir, 'export.txt')]);
    return readFileSync(join(dir, 'export.txt'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The fixture session helper parses JSON or returns bytes; exports need both
// the headers and whichever body shape came back.
async function download(session, query) {
  const cookie = session.request.cookie();
  const response = await fetch(`${base}/kitchen-cleaning/export?${query}`, {
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    type,
    disposition: response.headers.get('content-disposition') ?? '',
    bytes,
    json: type.includes('application/json') ? JSON.parse(bytes.toString()) : null,
  };
}

async function exportText(session, query, label) {
  const result = await download(session, query);
  assert.equal(result.status, 200, `${label}: ${result.bytes.toString().slice(0, 300)}`);
  assert.match(result.type, /^application\/pdf/, label);
  assert.equal(result.bytes.subarray(0, 5).toString('ascii'), '%PDF-', label);
  return { ...result, text: pdfText(result.bytes) };
}

function assertDenied(result, status, label) {
  assert.equal(result.status, status, `${label}: ${result.bytes.toString().slice(0, 300)}`);
  assert.doesNotMatch(result.type, /application\/pdf/, `${label} must not return a PDF`);
  assert.notEqual(result.bytes.subarray(0, 5).toString('ascii'), '%PDF-', `${label} must not return PDF bytes`);
}

// "N. dd/mm/yyyy — x/y tasks completed" headings, in document order.
function logHeadings(text) {
  return [...text.matchAll(/(\d+)\.\s+(\d{2}\/\d{2}\/\d{4})\s+—\s+(\d+)\/(\d+) tasks completed/g)]
    .map(([, index, date, done, total]) => ({ index: Number(index), date, done: Number(done), total: Number(total) }));
}

async function insertLog(clientId, logDate, frequency, completions, { signedBy = null, submittedAt = null } = {}) {
  await pool.query(
    `INSERT INTO kitchen_cleaning_logs (client_id, log_date, frequency, completions, signed_by, submitted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [clientId, logDate, frequency, JSON.stringify(completions), signedBy, submittedAt],
  );
}

const task = (marker, extra = {}) => ({ taskArea: 'Kitchen', taskName: `Task ${marker}`, done: true, doneBy: `Cook ${marker}`, ...extra });

try {
  const owner = await createTenant('cleaning-export');
  const foreign = await createTenant('cleaning-export-foreign');
  // A consultant from another account, explicitly linked to the owner's business.
  const consultant = await createTenant('cleaning-export-consultant');
  await pool.query('INSERT INTO consultant_clients (user_id, client_id) VALUES ($1, $2)', [consultant.userId, owner.clientId]);

  const admin = await createUser(owner, { role: 'client_admin' });
  const staff = await createUser(owner, { role: 'client_staff' });
  const viewer = await createUser(owner, { role: 'client_viewer' });
  const department = (await owner.request('POST', '/departments', { name: 'Cleaning team' })).data;
  assert.ok(Number.isInteger(department?.id), 'department fixture');
  const departmentManager = await createUser(owner, { role: 'client_staff', departmentId: department.id, isDepartmentManager: true });

  const names = Object.fromEntries((await pool.query(
    'SELECT id, name FROM clients WHERE id = ANY($1::int[])',
    [[owner.clientId, foreign.clientId, consultant.clientId]],
  )).rows.map((row) => [row.id, row.name]));

  // Owner business: boundary, interior and out-of-range logs for every frequency.
  await insertLog(owner.clientId, '2026-08-31', 'daily', [task('daily-before')], { signedBy: 'Early Signer', submittedAt: '2026-08-31T18:00:00Z' });
  await insertLog(owner.clientId, '2026-09-01', 'daily', [
    task('daily-start', { doneBy: 'Alex Starter', notes: 'Degreased extraction hood' }),
    { taskArea: 'Walk-in fridge', taskName: 'Task daily-start-missed', done: false, doneBy: 'Ghost Name', notes: 'Fridge out of service' },
  ], { signedBy: 'Morgan Supervisor', submittedAt: '2026-09-01T17:30:00Z' });
  await insertLog(owner.clientId, '2026-09-15', 'daily', [task('daily-middle', { doneBy: 'Priya Midmonth' })], { signedBy: 'Jo Pending' });
  await insertLog(owner.clientId, '2026-09-30', 'daily', [task('daily-end', { doneBy: 'Sam Finisher' })]);
  await insertLog(owner.clientId, '2026-10-01', 'daily', [task('daily-after')], { signedBy: 'Late Signer', submittedAt: '2026-10-01T18:00:00Z' });
  await insertLog(owner.clientId, '2026-08-24', 'weekly', [task('weekly-before')]);
  await insertLog(owner.clientId, '2026-09-07', 'weekly', [task('weekly-in', { doneBy: 'Wren Weekly' })], { signedBy: 'Weekly Lead', submittedAt: '2026-09-07T16:00:00Z' });
  await insertLog(owner.clientId, '2026-10-05', 'weekly', [task('weekly-after')]);
  await insertLog(owner.clientId, '2026-08-01', 'monthly', [task('monthly-before')]);
  await insertLog(owner.clientId, '2026-09-30', 'monthly', [task('monthly-in', { doneBy: 'Max Monthly' })]);
  await insertLog(owner.clientId, '2026-10-01', 'monthly', [task('monthly-after')]);
  // Other businesses, same dates and frequencies: must never appear in the owner's export.
  for (const frequency of ['daily', 'weekly', 'monthly']) {
    await insertLog(foreign.clientId, '2026-09-15', frequency, [task(`foreign-${frequency}`)], { signedBy: 'Foreign Signer', submittedAt: '2026-09-15T12:00:00Z' });
    await insertLog(consultant.clientId, '2026-09-15', frequency, [task(`consultant-own-${frequency}`)]);
  }

  const range = 'from=2026-09-01&to=2026-09-30';
  const daily = `${range}&frequency=daily`;
  const ownerMarkers = /Task (daily|weekly|monthly)-/;
  const otherBusinessMarkers = /foreign-|consultant-own-|Foreign Signer/;

  // ── Authentication and roles ────────────────────────────────────────────────
  assertDenied(await download({ request: requestSession() }, daily), 401, 'unauthenticated export');
  for (const [label, session] of [['client staff', staff], ['client viewer', viewer], ['department manager', departmentManager]]) {
    assertDenied(await download(session, daily), 403, `${label} export`);
  }

  // ── Client admins and the owning consultant export the whole range ──────────
  const ownerExport = await exportText(owner, daily, 'owner daily export');
  assert.equal(ownerExport.disposition, 'attachment; filename="cleaning-schedule-daily-2026-09-01-to-2026-09-30.pdf"');
  const adminExport = await exportText(admin, daily, 'client admin daily export');
  assert.deepEqual(logHeadings(adminExport.text), logHeadings(ownerExport.text), 'client admin sees the same register as the owner');

  // ── Inclusive date range ────────────────────────────────────────────────────
  const text = ownerExport.text;
  assert.deepEqual(logHeadings(text), [
    { index: 1, date: '01/09/2026', done: 1, total: 2 },
    { index: 2, date: '15/09/2026', done: 1, total: 1 },
    { index: 3, date: '30/09/2026', done: 1, total: 1 },
  ], 'both boundary days are included, in date order');
  assert.doesNotMatch(text, /daily-before|daily-after|31\/08\/2026|01\/10\/2026/, 'days outside the range are excluded');
  assert.match(text, /Daily logs · 01\/09\/2026 to 30\/09\/2026/);
  assert.match(text, new RegExp(names[owner.clientId].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'business name is printed');
  assert.doesNotMatch(text, otherBusinessMarkers, 'no other business data in the owner export');

  const singleDay = await exportText(owner, 'from=2026-09-15&to=2026-09-15&frequency=daily', 'single-day export');
  assert.deepEqual(logHeadings(singleDay.text).map((h) => h.date), ['15/09/2026'], 'a one-day range includes that day');

  // ── PDF evidence: done / not-done states, done-by names, draft vs signed-off ─
  assert.match(text, /\bDONE\s+Kitchen — Task daily-start\b/);
  assert.match(text, /Done by: Alex Starter · Notes: Degreased extraction hood/);
  assert.match(text, /NOT DONE\s+Walk-in fridge — Task daily-start-missed/);
  assert.match(text, /Done by: Not applicable · Notes: Fridge out of service/);
  assert.doesNotMatch(text, /Ghost Name/, 'a done-by name is never printed for a task that was not done');
  assert.match(text, /Signed off by Morgan Supervisor on \S/, 'submitted log shows its sign-off');
  assert.match(text, /Done by: Priya Midmonth/);
  assert.match(text, /Draft — sign-off: Jo Pending/, 'unsubmitted log with a name is a draft');
  assert.match(text, /Done by: Sam Finisher/);
  assert.match(text, /Draft — sign-off: Not recorded/, 'unsubmitted, unsigned log is a draft');
  assert.equal([...text.matchAll(/Signed off by /g)].length, 1, 'only the submitted log is shown as signed off');
  assert.equal([...text.matchAll(/Draft — sign-off:/g)].length, 2);

  // ── Frequency filters ───────────────────────────────────────────────────────
  const weekly = await exportText(owner, `${range}&frequency=weekly`, 'weekly export');
  assert.deepEqual(logHeadings(weekly.text).map((h) => h.date), ['07/09/2026']);
  assert.match(weekly.text, /Weekly logs · 01\/09\/2026 to 30\/09\/2026/);
  assert.match(weekly.text, /Task weekly-in[\s\S]*Done by: Wren Weekly/);
  assert.match(weekly.text, /Signed off by Weekly Lead on \S/);
  assert.doesNotMatch(weekly.text, /Task (daily|monthly)-|weekly-before|weekly-after/);
  assert.doesNotMatch(weekly.text, otherBusinessMarkers);
  assert.equal(weekly.disposition, 'attachment; filename="cleaning-schedule-weekly-2026-09-01-to-2026-09-30.pdf"');

  const monthly = await exportText(owner, `${range}&frequency=monthly`, 'monthly export');
  assert.deepEqual(logHeadings(monthly.text).map((h) => h.date), ['30/09/2026']);
  assert.match(monthly.text, /Monthly logs · 01\/09\/2026 to 30\/09\/2026/);
  assert.match(monthly.text, /Task monthly-in[\s\S]*Done by: Max Monthly/);
  assert.match(monthly.text, /Draft — sign-off: Not recorded/);
  assert.doesNotMatch(monthly.text, /Task (daily|weekly)-|monthly-before|monthly-after/);
  assert.doesNotMatch(monthly.text, otherBusinessMarkers);

  const empty = await exportText(owner, 'from=2025-01-01&to=2025-01-31&frequency=daily', 'empty export');
  assert.equal(logHeadings(empty.text).length, 0);
  assert.match(empty.text, /No cleaning logs were recorded for the selected date range and frequency\./);

  // ── Consultant client scoping ───────────────────────────────────────────────
  const linked = await exportText(consultant, `${daily}&clientId=${owner.clientId}`, 'linked consultant export');
  assert.deepEqual(logHeadings(linked.text), logHeadings(text), 'linked consultant gets the selected client register');
  assert.match(linked.text, /Task daily-start/);
  assert.doesNotMatch(linked.text, otherBusinessMarkers, "the consultant's own business is not mixed in");

  const own = await exportText(consultant, daily, 'consultant own-business export');
  assert.deepEqual(logHeadings(own.text).map((h) => h.date), ['15/09/2026']);
  assert.match(own.text, /Task consultant-own-daily/);
  assert.doesNotMatch(own.text, ownerMarkers, 'without a selected client the consultant sees only their own business');
  assert.doesNotMatch(own.text, /foreign-/);

  assertDenied(await download(consultant, `${daily}&clientId=${foreign.clientId}`), 403, 'consultant with an unlinked client id');
  assertDenied(await download(owner, `${daily}&clientId=${foreign.clientId}`), 403, 'owner with an unlinked client id');
  assertDenied(await download(admin, `${daily}&clientId=${foreign.clientId}`), 403, 'client admin with another client id');
  assertDenied(await download(foreign, `${daily}&clientId=${owner.clientId}`), 403, 'other business with the owner client id');
  for (const bad of ['abc', '0', '-1', '1.5']) {
    assertDenied(await download(consultant, `${daily}&clientId=${bad}`), 400, `consultant with clientId=${bad}`);
  }

  // ── Controlled errors for invalid or reversed dates ─────────────────────────
  const invalid = [
    ['', 'no parameters'],
    ['to=2026-09-30&frequency=daily', 'missing from'],
    ['from=2026-09-01&frequency=daily', 'missing to'],
    [range, 'missing frequency'],
    [`${range}&frequency=yearly`, 'unknown frequency'],
    [`${range}&frequency=Daily`, 'frequency is case-sensitive'],
    ['from=2026-9-1&to=2026-09-30&frequency=daily', 'unpadded date'],
    ['from=01/09/2026&to=2026-09-30&frequency=daily', 'UK-format date'],
    ['from=2026-02-30&to=2026-09-30&frequency=daily', 'impossible day'],
    ['from=2026-09-01&to=2026-13-01&frequency=daily', 'impossible month'],
    ['from=2025-02-29&to=2025-03-01&frequency=daily', 'non-leap 29 February'],
    ['from=not-a-date&to=2026-09-30&frequency=daily', 'free text'],
    ['from=2026-09-01T00:00:00Z&to=2026-09-30&frequency=daily', 'timestamp instead of date'],
    ['from=2026-09-01&from=2026-09-02&to=2026-09-30&frequency=daily', 'repeated from'],
  ];
  for (const [query, label] of invalid) {
    const result = await download(owner, query);
    assertDenied(result, 400, label);
    assert.equal(result.json?.error, 'Valid from, to and frequency query parameters are required', label);
  }
  const reversed = await download(owner, 'from=2026-09-30&to=2026-09-01&frequency=daily');
  assertDenied(reversed, 400, 'reversed range');
  assert.equal(reversed.json?.error, 'The start date must be on or before the end date');
  const leapDay = await exportText(owner, 'from=2024-02-29&to=2024-03-01&frequency=daily', 'leap-day range');
  assert.equal(logHeadings(leapDay.text).length, 0);

  console.log('Cleaning schedule PDF export: auth/role gates, consultant client scoping, inclusive ranges, controlled date errors, frequency filters and PDF evidence passed.');
} finally {
  await pool.end();
}
