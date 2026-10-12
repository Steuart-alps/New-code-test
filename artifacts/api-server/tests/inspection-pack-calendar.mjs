// Inspection pack PDF (GET /reports/inspection-pack) and the due-dates
// calendar (GET /calendar): tenant isolation, consultant client scoping,
// department scoping, read access for viewers, entitlement-gated sections,
// validation, and what the PDF leaves out (incident personal details).
// Run: pnpm --filter @workspace/api-server run test:inspection-pack-calendar
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base, createTenant, createUser, pool, requestSession } from './approval-workflow-fixtures.mjs';

try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
} catch {
  throw new Error('pdftotext (poppler-utils) is required to read the inspection pack text.');
}

function pdfText(pdf) {
  const dir = mkdtempSync(join(tmpdir(), 'inspection-pack-'));
  try {
    writeFileSync(join(dir, 'pack.pdf'), pdf);
    execFileSync('pdftotext', ['-layout', join(dir, 'pack.pdf'), join(dir, 'pack.txt')]);
    return readFileSync(join(dir, 'pack.txt'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function get(session, path, method = 'GET') {
  const cookie = session?.request?.cookie?.() ?? '';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status, type, bytes,
    disposition: response.headers.get('content-disposition') ?? '',
    json: type.includes('application/json') ? JSON.parse(bytes.toString()) : null,
  };
}

async function pack(session, query, label) {
  const result = await get(session, `/reports/inspection-pack?${query}`);
  assert.equal(result.status, 200, `${label}: ${result.bytes.toString().slice(0, 300)}`);
  assert.match(result.type, /^application\/pdf/, label);
  assert.equal(result.bytes.subarray(0, 5).toString('ascii'), '%PDF-', label);
  return { ...result, text: pdfText(result.bytes).replace(/\s+/g, ' ') };
}

function denied(result, status, label) {
  assert.equal(result.status, status, `${label}: ${result.bytes.toString().slice(0, 300)}`);
  assert.notEqual(result.bytes.subarray(0, 5).toString('ascii'), '%PDF-', `${label} must not return a PDF`);
}

async function calendar(session, query, label) {
  const result = await get(session, `/calendar?${query}`);
  assert.equal(result.status, 200, `${label}: ${result.bytes.toString().slice(0, 300)}`);
  return result.json;
}

const one = async (text, values) => (await pool.query(text, values)).rows[0];
const site = async (clientId, name, departmentId = null) =>
  (await one('INSERT INTO sites (client_id, name, department_id) VALUES ($1, $2, $3) RETURNING id', [clientId, name, departmentId])).id;

/** The same kinds of record for any business; `tag` marks which business it belongs to. */
async function seedBusiness(clientId, siteId, tag) {
  const item = await one(
    `INSERT INTO compliance_items (client_id, site_id, title, status, due_date)
     VALUES ($1, $2, $3, 'pending', '2026-09-10') RETURNING id`, [clientId, siteId, `${tag} gas safety check`]);
  await pool.query('INSERT INTO certificates (item_id, name) VALUES ($1, $2)', [item.id, `${tag}-gas-cert.pdf`]);
  await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result, notes)
     VALUES ($1, $2, 'alarm', '2026-09-05', 'fail', $3), ($1, $2, 'alarm', '2026-09-12', 'pass', NULL)`,
    [clientId, siteId, `${tag} sounder fault`]);
  await pool.query(
    `INSERT INTO legionella_checks (client_id, site_id, check_type, check_date, result, temperature, location)
     VALUES ($1, $2, 'hot_sentinel_temp', '2026-09-07', 'fail', 41.5, $3)`, [clientId, siteId, `${tag} basin`]);
  const diary = await one(
    `INSERT INTO food_safety_records (client_id, site_id, record_date, submitted_at)
     VALUES ($1, $2, '2026-09-03', '2026-09-03T18:00:00Z') RETURNING id`, [clientId, siteId]);
  await pool.query(
    `INSERT INTO track_actions (client_id, site_id, module, source_kind, source_record_id, provenance,
       title, instruction, severity, remedial_action, status)
     VALUES ($1, $2, 'kitchen', 'kitchen_temperature_' || gen_random_uuid(), $3, 'product_default',
       'Failed temperature: Fridge 1 · 2026-09-03',
       'Diary 2026-09-03. Fridge 1 · temperature: 9°C. Required range: maximum 8; °C. Initial action taken: moved stock. Keep the failed observation.',
       'action_required', $4, 'open')`, [clientId, siteId, diary.id, `${tag} moved stock to fridge 2`]);
  await pool.query(
    `INSERT INTO incidents (client_id, site_id, incident_type, severity, status, incident_date, location,
       description, involved_name, injuries_sustained, riddor_reportable, riddor_category, reported_by)
     VALUES ($1, $2, 'accident', 'serious', 'open', '2026-09-12', 'Kitchen', $3, $4, $5, true,
       'specified_injury', 'Duty manager')`,
    [clientId, siteId, `${tag} SECRET-DESCRIPTION`, `${tag} Private Person`, `${tag} SECRET-INJURY`]);
  const contractor = await one(
    `INSERT INTO contractors (client_id, name, email, public_liability_expiry)
     VALUES ($1, $2, 'contractor@test.local', '2026-09-20') RETURNING id`, [clientId, `${tag} Electrics`]);
  await pool.query(
    `INSERT INTO contractor_certificates (client_id, contractor_id, certificate_name, expiry_date)
     VALUES ($1, $2, $3, '2026-09-25')`, [clientId, contractor.id, `${tag} Gas Safe card`]);
  await pool.query(
    `INSERT INTO train_track_records (client_id, site_id, record_type, staff_name, training_type, completed_date, expiry_date)
     VALUES ($1, $2, 'certificate', $3, 'Food hygiene L2', '2023-09-15', '2026-09-15'),
            ($1, $2, 'certificate', $4, 'First aid', '2023-09-10', '2026-09-10'),
            ($1, $2, 'certificate', $4, 'First aid', '2026-09-09', '2029-09-09')`,
    [clientId, siteId, `${tag} Trainee`, `${tag} Renewed`]);
  await pool.query(
    `INSERT INTO pest_visits (client_id, site_id, visit_date, contractor_company, next_visit_date)
     VALUES ($1, $2, '2026-08-18', $3, '2026-09-18')`, [clientId, siteId, `${tag} Pest Co`]);
  const issue = await one(
    `INSERT INTO fix_track_issues (client_id, site_id, title, location, reported_by, reported_date, contractor_id, target_date)
     VALUES ($1, $2, $3, 'Kitchen', 'Duty manager', '2026-09-01', $4, '2026-09-22') RETURNING id`,
    [clientId, siteId, `${tag} leaking tap`, contractor.id]);
  await pool.query(
    `INSERT INTO daily_checklists (client_id, site_id, checklist_type, check_date, submitted_at)
     VALUES ($1, $2, 'am', '2026-09-02', '2026-09-02T09:00:00Z')`, [clientId, siteId]);
  return { itemId: item.id, contractorId: contractor.id, issueId: issue.id };
}

const range = 'from=2026-09-01&to=2026-09-30';
// Site-bound records of site B (contractors serve the whole business, so they
// appear in every pack of that business).
const SITE_B_RECORDS = ['SiteB gas safety check', 'SiteB sounder fault', 'SiteB basin', 'SiteB moved stock', 'SiteB Trainee'];
const hasNoSiteB = (text) => SITE_B_RECORDS.every(marker => !text.includes(marker));

try {
  const owner = await createTenant('pack');
  const foreign = await createTenant('pack-foreign');
  const consultant = await createTenant('pack-consultant');
  await pool.query('INSERT INTO consultant_clients (user_id, client_id) VALUES ($1, $2)', [consultant.userId, owner.clientId]);

  const deptA = (await owner.request('POST', '/departments', { name: 'Front of house' })).data;
  const deptB = (await owner.request('POST', '/departments', { name: 'Leisure' })).data;
  assert.ok(Number.isInteger(deptA?.id) && Number.isInteger(deptB?.id), 'department fixtures');
  const siteA = await site(owner.clientId, 'Harbour Hotel', deptA.id);
  const siteB = await site(owner.clientId, 'Lakeside Spa', deptB.id);
  const foreignSite = await site(foreign.clientId, 'Foreign Inn');

  const seededA = await seedBusiness(owner.clientId, siteA, 'SiteA');
  // A contractor confirmed a visit through their scheduling link.
  await pool.query("UPDATE compliance_items SET visit_scheduled_at = '2026-09-08T10:00:00' WHERE id = $1", [seededA.itemId]);
  const seededB = await seedBusiness(owner.clientId, siteB, 'SiteB');
  await seedBusiness(foreign.clientId, foreignSite, 'Foreign');

  const viewer = await createUser(owner, { role: 'client_viewer' });
  const deptViewer = await createUser(owner, { role: 'client_viewer', departmentId: deptA.id });
  const ownerName = (await one('SELECT name FROM users WHERE id = $1', [owner.userId])).name;
  const businessName = (await one('SELECT name FROM clients WHERE id = $1', [owner.clientId])).name;

  // ── Inspection pack: whole business ────────────────────────────────────────
  const all = await pack(owner, range, 'owner all-sites pack');
  assert.equal(all.disposition, 'attachment; filename="inspection-pack-all-sites-2026-09-01-to-2026-09-30.pdf"');
  for (const expected of [
    'Inspection pack', businessName, 'All sites (2)', '1 Sep 2026 to 30 Sep 2026', `Generated by: ${ownerName}`,
    'Summary by module', 'SiteA gas safety check', 'SiteA-gas-cert.pdf', 'Overdue',
    'Fire safety check log', 'SiteA sounder fault', 'SiteB sounder fault',
    'Legionella temperature log', '41.5°C', 'SiteA basin',
    'Kitchen temperatures and daily diary', 'SiteA moved stock to fridge 2', 'Fridge 1 · temperature: 9°C',
    'Daily checklist completion', 'Incidents (2)', 'Specified injury — report overdue',
    'Contractors (2)', 'SiteA Electrics', 'SiteA Gas Safe card',
    'SiteA Trainee', 'Food hygiene L2',
  ]) assert.ok(all.text.includes(expected), `all-sites pack should include "${expected}"`);
  for (const absent of ['Foreign', 'SECRET-DESCRIPTION', 'SECRET-INJURY', 'Private Person', 'SiteA Renewed']) {
    assert.ok(!all.text.includes(absent), `all-sites pack must not include "${absent}"`);
  }

  // ── One site ───────────────────────────────────────────────────────────────
  const single = await pack(owner, `${range}&siteId=${siteA}`, 'owner site pack');
  assert.equal(single.disposition, 'attachment; filename="inspection-pack-harbour-hotel-2026-09-01-to-2026-09-30.pdf"');
  assert.ok(single.text.includes('Site: Harbour Hotel'), 'site name on the cover');
  assert.ok(single.text.includes('SiteA sounder fault'));
  assert.ok(hasNoSiteB(single.text), 'a site pack has no other site records');

  // ── Viewers can read; department scope applies ─────────────────────────────
  // A viewer with no department sees only sites without a department (as on
  // GET /sites): here none, so only business-wide contractors.
  const viewerPack = await pack(viewer, range, 'viewer pack');
  assert.ok(viewerPack.text.includes('All sites you can access (0)'));
  assert.ok(hasNoSiteB(viewerPack.text) && !viewerPack.text.includes('SiteA sounder fault'));
  assert.ok(viewerPack.text.includes('SiteA Electrics'), 'contractors are business-wide');
  const deptPack = await pack(deptViewer, range, 'department viewer pack');
  assert.ok(deptPack.text.includes('SiteA sounder fault'), 'department viewer sees their site');
  assert.ok(hasNoSiteB(deptPack.text), 'department viewer must not see another department’s site');
  assert.ok(deptPack.text.includes('All sites you can access (1)'));
  denied(await get(deptViewer, `/reports/inspection-pack?${range}&siteId=${siteB}`), 403, 'department viewer, other site');

  // ── Tenant isolation ───────────────────────────────────────────────────────
  const foreignPack = await pack(foreign, range, 'foreign pack');
  assert.ok(foreignPack.text.includes('Foreign gas safety check'));
  assert.ok(!foreignPack.text.includes('SiteA') && !foreignPack.text.includes('SiteB'), 'other business data never appears');
  denied(await get(foreign, `/reports/inspection-pack?${range}&siteId=${siteA}`), 400, 'another business’s site');
  denied(await get(foreign, `/reports/inspection-pack?${range}&clientId=${owner.clientId}`), 403, 'unlinked clientId');
  const consultantPack = await pack(consultant, `${range}&clientId=${owner.clientId}`, 'linked consultant pack');
  assert.ok(consultantPack.text.includes('SiteA gas safety check'), 'a linked consultant reads the chosen client');
  denied(await get({ request: requestSession() }, `/reports/inspection-pack?${range}`), 401, 'signed out');

  // ── Validation ─────────────────────────────────────────────────────────────
  denied(await get(owner, '/reports/inspection-pack?from=2026-09-30&to=2026-09-01'), 400, 'reversed range');
  denied(await get(owner, '/reports/inspection-pack?from=2025-09-01&to=2026-09-01'), 400, 'over 12 months');
  denied(await get(owner, '/reports/inspection-pack?from=2026-02-30&to=2026-03-01'), 400, 'impossible date');
  await pack(owner, 'from=2025-09-01&to=2026-08-31', 'exactly 12 months');

  // ── Only enabled modules: a core-only business gets no module sections ──────
  // Trial over + a Stripe customer that cannot be looked up (no Stripe in the
  // fresh-schema API): entitlements fall back to core, and the billing lock
  // fails open, so the request itself is still served.
  await pool.query(
    "UPDATE clients SET trial_ends_at = now() - interval '1 day', stripe_customer_id = $2 WHERE id = $1",
    [foreign.clientId, `cus_inspection_pack_${foreign.clientId}`]);
  const corePack = await pack(foreign, range, 'core-only pack');
  assert.ok(corePack.text.includes('Compliance checks') && corePack.text.includes('Contractors'), 'core sections stay');
  for (const section of ['Fire safety check log', 'Legionella temperature log', 'Kitchen temperatures', 'Incidents (', 'Training expired']) {
    assert.ok(!corePack.text.includes(section), `core-only pack must not include "${section}"`);
  }

  // ── Calendar ───────────────────────────────────────────────────────────────
  const ownerCalendar = await calendar(owner, range, 'owner calendar');
  const byId = new Map(ownerCalendar.entries.map(entry => [entry.id, entry]));
  const expectEntry = (id, fields) => {
    const entry = byId.get(id);
    assert.ok(entry, `calendar entry ${id}: ${JSON.stringify(ownerCalendar.entries.map(e => e.id))}`);
    for (const [key, value] of Object.entries(fields)) assert.equal(entry[key], value, `${id}.${key}`);
  };
  expectEntry(`compliance-${seededA.itemId}`, { date: '2026-09-10', kind: 'compliance_due', status: 'overdue', href: `/items/${seededA.itemId}`, siteName: 'Harbour Hotel' });
  expectEntry(`visit-${seededA.itemId}`, { date: '2026-09-08', kind: 'contractor_visit', href: `/items/${seededA.itemId}` });
  expectEntry(`contractor_insurance-${seededA.contractorId}`, { date: '2026-09-20', href: `/contractors/${seededA.contractorId}` });
  expectEntry(`fix-${seededA.issueId}`, { date: '2026-09-22', kind: 'fix_visit', href: `/fix-track/${seededA.issueId}` });
  assert.ok(ownerCalendar.entries.some(entry => entry.kind === 'contractor_accreditation' && entry.title === 'SiteA Gas Safe card expires'));
  assert.ok(ownerCalendar.entries.some(entry => entry.kind === 'pest_visit' && entry.date === '2026-09-18' && entry.href === '/pest-track'));
  const training = ownerCalendar.entries.filter(entry => entry.kind === 'training_expiry').map(entry => entry.detail);
  assert.deepEqual(training.sort(), ['SiteA Trainee', 'SiteB Trainee'], 'renewed training is not shown as expiring');
  assert.ok(!JSON.stringify(ownerCalendar).includes('Foreign'), 'calendar never shows another business');
  const dates = ownerCalendar.entries.map(entry => entry.date);
  assert.deepEqual(dates, [...dates].sort(), 'entries are in date order');

  const viewerCalendar = await calendar(viewer, range, 'viewer calendar');
  assert.ok(viewerCalendar.entries.length > 0 && viewerCalendar.entries.every(entry => entry.kind.startsWith('contractor_') && entry.siteName === null),
    'a viewer without a department sees only business-wide contractor dates');
  const deptCalendar = await calendar(deptViewer, range, 'department calendar');
  assert.ok(deptCalendar.entries.some(entry => entry.id === `compliance-${seededA.itemId}`));
  assert.ok(!deptCalendar.entries.some(entry => entry.id === `compliance-${seededB.itemId}` || entry.id === `fix-${seededB.issueId}`),
    'department viewer must not see another department’s site');
  denied(await get(deptViewer, `/calendar?${range}&siteId=${siteB}`), 403, 'department calendar, other site');
  const siteCalendar = await calendar(owner, `${range}&siteId=${siteB}`, 'site calendar');
  assert.ok(siteCalendar.entries.every(entry => entry.siteName === null || entry.siteName === 'Lakeside Spa'));
  denied(await get(foreign, `/calendar?${range}&siteId=${siteA}`), 400, 'calendar, another business’s site');
  denied(await get(foreign, `/calendar?${range}&clientId=${owner.clientId}`), 403, 'calendar, unlinked clientId');
  const consultantCalendar = await calendar(consultant, `${range}&clientId=${owner.clientId}`, 'consultant calendar');
  assert.equal(consultantCalendar.entries.length, ownerCalendar.entries.length);
  denied(await get({ request: requestSession() }, `/calendar?${range}`), 401, 'calendar signed out');
  denied(await get(owner, '/calendar?from=2026-09-01&to=2026-12-31'), 400, 'calendar range too long');
  denied(await get(owner, '/calendar?from=2026-09-30&to=2026-09-01'), 400, 'calendar reversed range');

  // Read-only: nothing on these paths accepts a write, for viewers or anyone.
  for (const path of [`/calendar?${range}`, `/reports/inspection-pack?${range}`]) {
    for (const session of [viewer, owner]) {
      const result = await get(session, path, 'POST');
      assert.ok([403, 404].includes(result.status), `POST ${path} must not be accepted (${result.status})`);
    }
  }

  console.log('Inspection pack and calendar checks passed.');
} finally {
  await pool.end();
}
