// Dashboard and reminder accuracy on a fresh runtime-migrated schema:
//  - FireTrack status is per site (one site's check never makes another green),
//    uses configurable frequencies, and feeds the dashboard and reminder email;
//  - check dates after the account's today are rejected;
//  - registered legionella outlets / spa tubs without readings are "never";
//  - every dashboard track evaluates real columns (no swallowed SQL errors)
//    and counts beyond the displayed rows;
//  - a brand-new business sees "not started", not "action required".
// Run: pnpm --filter @workspace/api-server run test:dashboard-accuracy
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTenant, pool } from './approval-workflow-fixtures.mjs';

const temp = await mkdtemp(fileURLToPath(new URL('.build-dashboard-accuracy-', import.meta.url)));
let runtime;
try {
  const output = `${temp}/runtime.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL('./dashboard-accuracy.entry.ts', import.meta.url))],
    outfile: output,
    bundle: true, platform: 'node', format: 'esm',
    external: ['sharp', '*.node', 'pg-native', 'pino', 'pino-pretty', '@google-cloud/*', '@sentry/*', 'nodemailer'],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  runtime = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}
const { getCheckAlerts, buildCheckReminderEmailHtml, localDateIn, zonedDateTimeToUtc, futureCheckDate } = runtime;

const londonDay = (offset = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const ok = (response, expected = [200, 201]) => {
  assert.ok(expected.includes(response.status), JSON.stringify(response));
  return response.data;
};

try {
  // ── Pure helpers: the account calendar is Europe/London, not UTC ──────────
  assert.equal(localDateIn('Europe/London', new Date('2026-10-11T23:30:00Z')), '2026-10-12', 'BST midnight starts the new day');
  assert.equal(localDateIn('Europe/London', new Date('2026-12-11T23:30:00Z')), '2026-12-11', 'GMT matches UTC');
  assert.equal(zonedDateTimeToUtc('2026-07-01', '09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedDateTimeToUtc('2026-01-15', '09:00:00', 'Europe/London').toISOString(), '2026-01-15T09:00:00.000Z');
  assert.equal(zonedDateTimeToUtc('2026-10-25', '12:00', 'Europe/London').toISOString(), '2026-10-25T12:00:00.000Z', 'after the autumn change');
  assert.deepEqual(
    futureCheckDate({ method: 'POST', path: '/fire-safety', body: { checkDate: '2026-10-13' } }, new Date('2026-10-12T23:30:00Z')),
    null, 'just after midnight BST the London date is already the 13th');
  assert.ok(futureCheckDate({ method: 'POST', path: '/fire-safety', body: { checkDate: '2026-10-13' } }, new Date('2026-10-12T21:30:00Z')));
  assert.equal(futureCheckDate({ method: 'POST', path: '/fix-track', body: { targetDate: '2099-01-01' } }), null,
    'future target dates elsewhere are untouched');

  const owner = await createTenant('dashboard-accuracy');
  const c = owner.clientId;
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Site A', seedStarterChecks: false }));
  const siteB = ok(await owner.request('POST', '/sites', { name: 'B & Co', seedStarterChecks: false }));
  const summary = async (query = '') => {
    const response = await owner.request('GET', `/dashboard/summary${query}`);
    assert.equal(response.status, 200, JSON.stringify(response));
    return Object.fromEntries(response.data.tracks.map(track => [track.trackId, track]));
  };

  // ── U1: a brand-new business is "not started", not failing ──────────────────
  const fresh = await summary();
  const enabled = Object.values(fresh).filter(track => track.enabled);
  assert.ok(enabled.length > 5, 'the trial enables the tracks');
  const failing = enabled.filter(track => track.health !== 'not_started');
  assert.deepEqual(failing.map(track => `${track.trackId}: ${track.badge} (${track.health})`), [],
    'nothing recorded and nothing overdue is neutral');

  // ── C6: future check dates are rejected for every role ──────────────────────
  const tomorrow = londonDay(1);
  for (const path of ['/fire-safety', '/legionella', '/hot-tub', '/pool-track', '/tree-track']) {
    const response = await owner.request('POST', path, { checkType: 'alarm', checkDate: tomorrow, result: 'pass', siteId: siteA.id });
    assert.equal(response.status, 400, `${path}: ${JSON.stringify(response)}`);
    assert.equal(response.data?.code, 'CHECK_DATE_IN_FUTURE', path);
  }
  assert.equal((await owner.request('PUT', '/fire-safety/999999', { checkDate: '2099-01-01' })).data?.code, 'CHECK_DATE_IN_FUTURE');

  // ── C1: fire status per site ────────────────────────────────────────────────
  const fire = (body) => owner.request('POST', '/fire-safety', { result: 'pass', ...body });
  ok(await fire({ checkType: 'alarm', checkDate: londonDay(), siteId: siteA.id }));
  ok(await fire({ checkType: 'alarm', checkDate: londonDay(-10), siteId: siteB.id }));
  const fireStatus = async (query = '') => Object.fromEntries(
    ok(await owner.request('GET', `/fire-safety/status${query}`)).map(row => [row.checkType, row]));

  assert.equal((await fireStatus(`?siteId=${siteA.id}`)).alarm.status, 'ok');
  assert.equal((await fireStatus(`?siteId=${siteB.id}`)).alarm.status, 'overdue', "site A's alarm test does not cover site B");
  const allFire = await fireStatus();
  assert.equal(allFire.alarm.status, 'overdue', 'all sites shows the worst site');
  assert.equal(allFire.alarm.siteId, siteB.id);
  assert.equal(allFire.alarm.sitesAffected, 1);
  assert.equal(allFire.alarm.siteCount, 2);
  assert.equal(allFire.emergency_lights.status, 'never');
  assert.equal(allFire.emergency_lights.sitesAffected, 2);

  const siteC = ok(await owner.request('POST', '/sites', { name: 'Site C', seedStarterChecks: false }));
  assert.equal((await fireStatus(`?siteId=${siteC.id}`)).alarm.status, 'never', 'a site with no checks is never');
  assert.equal((await fireStatus()).alarm.sitesAffected, 2);
  // A "No specific site" check is business-wide and covers every site.
  ok(await fire({ checkType: 'fire_doors', checkDate: londonDay() }));
  for (const site of [siteA, siteB, siteC]) {
    const doors = (await fireStatus(`?siteId=${site.id}`)).fire_doors;
    assert.equal(doors.lastDate, londonDay(), `business-wide check covers ${site.name}`);
    assert.equal(doors.status, 'ok');
  }
  assert.equal((await fireStatus()).fire_doors.sitesAffected, 0);

  const dashboardFire = (await summary()).fire;
  assert.equal(dashboardFire.status, 'overdue', JSON.stringify(dashboardFire));
  assert.equal(dashboardFire.health, 'action_required');
  assert.equal(dashboardFire.items[0]?.label, 'B & Co: Alarm test', 'the worst site comes first');
  assert.equal(dashboardFire.badge, '1 overdue');
  const reminders = ok(await owner.request('GET', '/check-reminders'));
  assert.ok(reminders.some(alert => alert.module === 'fire' && alert.checkType === 'alarm'
    && alert.siteName === 'Site C' && alert.status === 'never'), 'the new site is reported as never recorded');
  assert.ok(!reminders.some(alert => alert.module === 'fire' && alert.checkType === 'alarm' && alert.siteName === 'Site A'));
  assert.ok(!dashboardFire.items.some(item => item.label === 'Site A: Alarm test'), JSON.stringify(dashboardFire.items));
  assert.equal((await summary(`?siteId=${siteA.id}`)).fire.items.some(item => /Alarm test/.test(item.label)), false);

  // The daily reminder email is built from the same per-site alerts (the job
  // sends getCheckAlerts' overdue, due-soon and unsafe results).
  const emailAlerts = (await getCheckAlerts(c))
    .filter(alert => ['action_required', 'overdue', 'due_soon'].includes(alert.status));
  assert.deepEqual(emailAlerts.filter(alert => alert.module === 'fire').map(alert => alert.checkLabel), ['B & Co: Alarm test']);
  const html = buildCheckReminderEmailHtml(emailAlerts, 'https://app.test.local');
  assert.ok(html.includes('B &amp; Co: Alarm test'), 'site names are escaped business text');
  assert.ok(!html.includes('Site A: Alarm test'));

  // Configurable frequencies: business-wide setting, then a site profile.
  ok(await owner.request('PUT', '/fire-safety/config', { fire_frequency_days: JSON.stringify({ alarm: 14 }) }));
  const relaxed = await fireStatus(`?siteId=${siteB.id}`);
  assert.equal(relaxed.alarm.frequencyDays, 14);
  assert.equal(relaxed.alarm.status, 'ok', 'the configured 14-day interval applies');
  ok(await owner.request('PUT', `/fire-safety/config?siteId=${siteA.id}`, { controlProfile: { frequencyDays: { alarm: 1 } } }));
  const strict = await fireStatus(`?siteId=${siteA.id}`);
  assert.equal(strict.alarm.frequencyDays, 1, "the site's risk-assessed interval wins");
  assert.equal(strict.alarm.status, 'due_soon');

  // ── C12: registered outlets and tubs without readings are "never" ──────────
  const approve = (path, frequencies) => owner.request('PUT', `/${path}/monitoring-plan?siteId=${siteA.id}`, {
    action: 'approve', riskAssessmentReference: 'RA-1', writtenSchemeReference: 'WS-1',
    competentPerson: 'Water manager', frequencies,
  });
  const legTypes = ok(await owner.request('GET', `/legionella/status?siteId=${siteA.id}`)).map(row => row.checkType);
  assert.equal(ok(await approve('legionella', Object.fromEntries(legTypes.map(type => [type, 30])))).approved, true);
  const outlet1 = ok(await owner.request('POST', '/legionella/outlets', { name: 'Kitchen tap', type: 'hot', siteId: siteA.id }));
  ok(await owner.request('POST', '/legionella', {
    checkType: 'hot_sentinel_temp', checkDate: londonDay(), result: 'pass', temperature: 55, siteId: siteA.id, outletId: outlet1.id,
  }));
  const legStatus = async () => Object.fromEntries(
    ok(await owner.request('GET', `/legionella/status?siteId=${siteA.id}`)).map(row => [row.checkType, row]));
  assert.equal((await legStatus()).hot_sentinel_temp.status, 'ok');
  ok(await owner.request('POST', '/legionella/outlets', { name: 'New shower', type: 'hot', siteId: siteA.id }));
  assert.equal((await legStatus()).hot_sentinel_temp.status, 'never', 'an untested outlet keeps the check open');

  const tubTypes = ok(await owner.request('GET', `/hot-tub/status?siteId=${siteA.id}`)).map(row => row.checkType);
  assert.equal(ok(await approve('hot-tub', Object.fromEntries(tubTypes.map(type => [type, 30])))).approved, true);
  // The registry route writes hot_tubs.description, which runtime-only
  // schemas once lacked; checks are seeded directly to control their dates.
  const addTub = async name => ok(await owner.request('POST', '/hot-tub/tubs', { name, siteId: siteA.id, description: `${name} by the deck` }));
  const tub1 = await addTub('Tub 1');
  await pool.query(`INSERT INTO hot_tub_checks (client_id, site_id, hot_tub_id, check_type, check_date, result)
    VALUES ($1, $2, $3, 'filter_clean', $4, 'pass')`, [c, siteA.id, tub1.id, londonDay()]);
  const tubStatus = async () => Object.fromEntries(
    ok(await owner.request('GET', `/hot-tub/status?siteId=${siteA.id}`)).map(row => [row.checkType, row]));
  assert.equal((await tubStatus()).filter_clean.status, 'ok');
  await addTub('Tub 2');
  assert.equal((await tubStatus()).filter_clean.status, 'never', 'a new tub without readings is never');

  // ── C4 / C8: every track reads its real columns and counts past the list ───
  const today = londonDay();
  const yesterday = londonDay(-1);
  const q = (text, values) => pool.query(text, values);
  const a = siteA.id;
  await q(`INSERT INTO daily_checklists (client_id, site_id, checklist_type, check_date, submitted_at)
           VALUES ($1, $2, 'kitchen_opening', $3, now())`, [c, a, yesterday]);
  await q(`INSERT INTO food_safety_records (client_id, site_id, record_date, submitted_at) VALUES ($1, $2, $3, now())`, [c, a, yesterday]);
  // PestTrack: site A's latest visit is overdue; site B's older overdue visit is superseded.
  await q(`INSERT INTO pest_visits (client_id, site_id, visit_date, next_visit_date, contractor_name)
           VALUES ($1, $2, $3, $4, 'Acme Pest'), ($1, $5, $6, $7, 'Old visit'), ($1, $5, $8, $9, 'New visit')`,
    [c, a, londonDay(-40), londonDay(-5), siteB.id, londonDay(-90), londonDay(-60), londonDay(-10), londonDay(20)]);
  await q(`INSERT INTO pest_activity (client_id, site_id, recorded_date, pest_type, location, resolved)
           VALUES ($1, $2, $3, 'rodent', 'Store room', false)`, [c, a, yesterday]);
  for (let i = 0; i < 12; i++) {
    await q(`INSERT INTO fix_track_issues (client_id, site_id, title, location, reported_by, reported_date, priority, status)
             VALUES ($1, $2, $3, 'Bar', 'Tester', $4, 'medium', 'reported')`, [c, a, `Issue ${i}`, yesterday]);
    await q(`INSERT INTO doc_track_documents (client_id, site_id, title, next_review_date) VALUES ($1, $2, $3, $4)`,
      [c, a, `Policy ${i}`, yesterday]);
    await q(`INSERT INTO train_track_records (client_id, site_id, staff_name, training_type, completed_date, expiry_date)
             VALUES ($1, $2, $3, 'Food hygiene', $4, $5)`, [c, a, `Staff ${i}`, londonDay(-400), yesterday]);
  }
  // A risk assessment's "Review Date" (review_date) drives the SafeTrack tile;
  // SOPs have no review date. Created through the routes so both schema
  // shapes must hold every column the SafeTrack writer uses.
  const safeDoc = (path, body) => owner.request('POST', `/safe-track/${path}`, { siteId: a, ...body });
  ok(await safeDoc('risk-assessments', { title: 'Cellar RA', description: 'Steps', assessedBy: 'Manager', reviewDate: yesterday }));
  ok(await safeDoc('risk-assessments', { title: 'Kitchen RA', reviewDate: londonDay(10) }));
  ok(await safeDoc('sops', { title: 'Closing SOP', scope: 'Bar' }));
  const bike = (await q(`INSERT INTO bikes (client_id, site_id, ref, name) VALUES ($1, $2, 'B1', 'Blue bike') RETURNING id`, [c, a])).rows[0];
  await q(`INSERT INTO bike_hire_records (client_id, site_id, bike_id, guest_name, hire_date, return_date_expected, status)
           VALUES ($1, $2, $3, 'Guest Smith', $4, $5, 'active')`, [c, a, bike.id, londonDay(-3), yesterday]);
  await q(`INSERT INTO bike_services (client_id, bike_id, service_date, next_service_date) VALUES ($1, $2, $3, $4)`,
    [c, bike.id, londonDay(-400), yesterday]);
  await q(`INSERT INTO premises_inspections (client_id, site_id, inspection_date, next_inspection_date, status)
           VALUES ($1, $2, $3, $4, 'open')`, [c, a, londonDay(-30), yesterday]);
  await q(`INSERT INTO room_track_rooms (client_id, site_id, room_number) VALUES ($1, $2, '101')`, [c, a]);
  await q(`INSERT INTO pat_appliances (client_id, site_id, name) VALUES ($1, $2, 'Kettle')`, [c, a]);
  await q(`INSERT INTO tree_inspections (client_id, site_id, check_type, check_date) VALUES ($1, $2, 'post_storm', $3)`, [c, a, londonDay(-40)]);
  await q(`INSERT INTO green_machines (client_id, site_id, name) VALUES ($1, $2, 'Mower')`, [c, a]);
  await q(`INSERT INTO swim_sessions (client_id, site_id, session_date) VALUES ($1, $2, $3)`, [c, a, londonDay(-3)]);
  await q(`INSERT INTO incidents (client_id, site_id, incident_date, location, description, involved_name, reported_by, status)
           VALUES ($1, $2, $3, 'Bar', 'Slip', 'Guest', 'Manager', 'open')`, [c, a, yesterday]);

  const seeded = await summary(`?siteId=${a}`);
  for (const trackId of ['pest', 'train', 'safe', 'bike', 'fix', 'doc', 'daily_am', 'kitchen']) {
    assert.ok(seeded[trackId]?.enabled, `${trackId} is enabled during the trial`);
  }
  const expected = {
    daily_am: /1 site not submitted/, daily_pm: /1 site not submitted/, kitchen: /1 site not recorded today/,
    pest: /^1 visit overdue$/, fix: /^12 open issues$/, doc: /^12 reviews overdue$/, train: /^12 expired certificates$/,
    safe: /^1 review overdue$/, bike: /^1 bike not returned$/, premises: /overdue inspection/, room: /0 \/ 1 checked today/,
    pat: /never tested/, tree: /1 overdue/, swim: /No swim session logged today/, incident: /1 open incident/,
    green: /not checked today/,
  };
  for (const [trackId, badge] of Object.entries(expected)) {
    const track = seeded[trackId];
    if (!track?.enabled) continue;
    assert.match(track.badge, badge, `${trackId}: ${JSON.stringify(track)}`);
    assert.equal(track.health, 'action_required', trackId);
  }
  assert.ok(seeded.train.enabled ? seeded.train.items.some(item => item.label === 'Staff 0 — Food hygiene') : true);
  assert.ok(seeded.bike.enabled ? seeded.bike.items.some(item => item.detail.startsWith('Guest Smith')) : true);
  assert.ok(seeded.pest.enabled ? seeded.pest.items.some(item => /Acme Pest/.test(item.detail)) : true);
  assert.deepEqual(seeded.safe.items.map(item => item.label), ['Cellar RA', 'Kitchen RA'], JSON.stringify(seeded.safe));
  const allSeeded = await summary();
  if (allSeeded.pest.enabled) {
    assert.equal(allSeeded.pest.badge, '1 visit overdue', "site B's superseded visit is not overdue");
    assert.ok(!allSeeded.pest.items.some(item => /Old visit/.test(item.detail)));
  }
  const unavailable = Object.values(allSeeded).filter(track => track.badge === 'Status unavailable');
  assert.deepEqual(unavailable.map(track => track.trackId), [], 'no track query fails');

  // ── Mobile app checklists (daily_checklist_submissions) count too ──────────
  assert.match(allSeeded.daily_am.badge, /^3 sites not submitted$/, JSON.stringify(allSeeded.daily_am));
  await q(`INSERT INTO daily_checklist_submissions (client_id, site_id, checklist_date, type, submitted_at)
           VALUES ($1, $2, $3, 'am', now())`, [c, siteB.id, today]);
  const mobileSite = await summary(`?siteId=${siteB.id}`);
  assert.equal(mobileSite.daily_am.status, 'ok', `a mobile-only AM checklist counts: ${JSON.stringify(mobileSite.daily_am)}`);
  assert.equal(mobileSite.daily_am.badge, 'All submitted');
  assert.match(mobileSite.daily_pm.badge, /^1 site not submitted$/, 'the PM period is still open');
  const mobileAll = await summary();
  assert.match(mobileAll.daily_am.badge, /^2 sites not submitted$/, JSON.stringify(mobileAll.daily_am));
  assert.ok(!mobileAll.daily_am.items.some(item => item.label === 'B & Co'), JSON.stringify(mobileAll.daily_am.items));

  console.log('Dashboard accuracy tests passed');
} finally {
  await runtime?.pool?.end().catch(() => {});
  await pool.end();
}
