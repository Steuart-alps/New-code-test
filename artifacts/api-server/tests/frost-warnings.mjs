import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Frost warnings. From 15:00 each site whose address has a UK postcode gets
// tonight's forecast checked once; a low below 4°C emails the Maintenance
// managers who cover the site (else its Managers, else the Owners) and shows
// on the dashboard for everyone who can see the site. The network is faked.
// Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/frost-warnings.mjs

const temp = await mkdtemp(fileURLToPath(new URL('.build-frost-warnings-', import.meta.url)));
let job;
try {
  const output = `${temp}/runtime.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL('./frost-warnings.entry.ts', import.meta.url))],
    outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    external: ['sharp', '*.node', 'pg-native', 'pino', 'pino-pretty', '@google-cloud/*', '@sentry/*', 'nodemailer'],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  job = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const today = isoDay();
const tomorrow = isoDay(1);
const at = (day, hour) => `${day}T${String(hour).padStart(2, '0')}:00:00Z`;

// The forecast: cold at the Kilmarnock site, mild at the Plymouth one.
function series(coldest) {
  const entries = [{ time: at(today, 12), data: { instant: { details: { air_temperature: -9 } } } }]; // before the night
  for (let hour = 17; hour <= 23; hour++) entries.push({ time: at(today, hour), data: { instant: { details: { air_temperature: 6 } } } });
  for (let hour = 0; hour <= 12; hour++) {
    entries.push({ time: at(tomorrow, hour), data: { instant: { details: { air_temperature: hour === 5 ? coldest : 5 } } } });
  }
  entries.push({ time: at(tomorrow, 14), data: { instant: { details: { air_temperature: -12 } } } }); // after the night
  return { properties: { timeseries: entries } };
}
const calls = [];
let forecastFails = false;
const fakeFetch = async (url, init) => {
  calls.push(String(url));
  assert.match(init.headers['User-Agent'], /^ComplyTrack\/1\.0 \(\+http/, 'MET Norway asks for an identifying User-Agent');
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.postcodes.io/postcodes/')) {
    const postcode = decodeURIComponent(url.slice('https://api.postcodes.io/postcodes/'.length));
    if (postcode === 'KA3 6AA') return json(200, { status: 200, result: { latitude: 55.6253, longitude: -4.4921 } });
    if (postcode === 'PL1 1AA') return json(200, { status: 200, result: { latitude: 50.3705, longitude: -4.1426 } });
    return json(404, { status: 404, error: 'Postcode not found' });
  }
  if (url.startsWith('https://api.met.no/')) {
    if (forecastFails) return json(503, {});
    assert.match(url, /lat=-?\d+\.\d{2}&lon=-?\d+\.\d{2}$/, 'coordinates rounded to 2 decimals');
    return json(200, series(url.includes('lat=55.63') ? -1.6 : 7.2));
  }
  throw new Error(`unexpected request ${url}`);
};
const sent = [];
const send = async (message) => { sent.push(message); };
const sendPush = async () => {};
const run = (now, clientIds) => job.runFrostWarningJob({ now: new Date(now), clientIds, fetch: fakeFetch, send, sendPush });

try {
  // ── Pure helpers ───────────────────────────────────────────────────────
  assert.equal(job.ukPostcodeIn('31 De Walden Drive\nKilmarnock ka36aa'), 'KA3 6AA');
  assert.equal(job.ukPostcodeIn('Bramshaw, Lyndhurst SO43 7JN, UK'), 'SO43 7JN');
  assert.equal(job.ukPostcodeIn('Main Street, Belfast BT1 5GS'), 'BT1 5GS');
  assert.equal(job.ukPostcodeIn('Somewhere without a postcode'), null);
  assert.equal(job.ukPostcodeIn(null), null);
  assert.deepEqual(job.overnightLow(series(-1.6).properties.timeseries, today, 'UTC'), { lowestC: -1.6, coldestAt: new Date(at(tomorrow, 5)) },
    'only 18:00 to 09:00 counts');
  assert.equal(job.formatTemperature(-1.6), '−2°C');
  assert.equal(job.formatTemperature(3.4), '3°C');
  console.log('ok - postcodes and the overnight low');

  const owner = await createTenant('frost-warnings');
  const other = await createTenant('frost-warnings-other');
  const cold = await owner.request('POST', '/sites', { name: 'Kilmarnock', seedStarterChecks: false, address: '31 De Walden Drive, Kilmarnock KA3 6AA' });
  assert.equal(cold.status, 201, JSON.stringify(cold.data));
  const mild = await owner.request('POST', '/sites', { name: 'Plymouth', seedStarterChecks: false, address: 'The Hoe, Plymouth PL1 1AA' });
  const nowhere = await owner.request('POST', '/sites', { name: 'No postcode', seedStarterChecks: false, address: 'The farm' });
  const unknown = await owner.request('POST', '/sites', { name: 'Unknown', seedStarterChecks: false, address: 'Nowhere AB99 9ZZ' });
  const otherSite = await other.request('POST', '/sites', { name: 'Elsewhere', seedStarterChecks: false, address: 'Kilmarnock KA3 6AA' });
  assert.equal(otherSite.status, 201);
  const clients = [owner.clientId, other.clientId];

  // Before 15:00 nothing is checked.
  const early = await run(`${today}T12:30:00Z`, clients);
  assert.deepEqual([early.clientsChecked, calls.length], [0, 0], 'nothing before 15:00');

  // A forecast outage is retried the next hour, with nothing sent.
  forecastFails = true;
  const outage = await run(`${today}T15:40:00Z`, clients);
  assert.ok(outage.errors > 0);
  assert.equal(sent.length, 0);
  forecastFails = false;

  // ── The afternoon check ────────────────────────────────────────────────
  calls.length = 0;
  const first = await run(`${today}T16:35:00Z`, clients);
  assert.equal(first.errors, 0, JSON.stringify(first));
  assert.equal(first.forecastsFetched, 2, 'one request per location: the other business shares Kilmarnock');
  assert.ok(!calls.some((url) => url.includes('postcodes.io')), 'postcodes were looked up once, at the first try');
  const { rows: located } = await pool.query('SELECT name, location_postcode, latitude FROM sites WHERE client_id = $1 ORDER BY name', [owner.clientId]);
  assert.deepEqual(located.map((row) => [row.name, row.location_postcode, row.latitude != null]), [
    ['Kilmarnock', 'KA3 6AA', true], ['No postcode', null, false], ['Plymouth', 'PL1 1AA', true], ['Unknown', 'AB99 9ZZ', false],
  ]);
  const { rows: forecasts } = await pool.query('SELECT site_id, warn FROM frost_forecasts WHERE client_id = $1 ORDER BY site_id', [owner.clientId]);
  assert.deepEqual(forecasts.map((row) => [row.site_id, row.warn]), [[cold.data.id, true], [mild.data.id, false]]);
  // With no Managers, the Owners are told (one email per business here).
  const ownerMail = sent.filter((message) => message.clientId === owner.clientId);
  assert.equal(ownerMail.length, 1);
  assert.match(ownerMail[0].subject, /^Frost tonight at Kilmarnock: grit and de-ice/);
  assert.match(ownerMail[0].html, /down to −2°C around/);
  assert.match(ownerMail[0].html, /MET Norway/);
  assert.doesNotMatch(ownerMail[0].html, /Plymouth/);
  assert.equal(sent.filter((message) => message.clientId === other.clientId).length, 1);
  const { rows: bells } = await pool.query("SELECT title FROM user_notifications WHERE client_id = $1 AND kind = 'frost_warning'", [owner.clientId]);
  assert.deepEqual(bells.map((row) => row.title), ['Frost tonight at Kilmarnock: grit and de-ice']);
  console.log('ok - the afternoon check warns about the cold site only');

  // Once per site and night, however often the job runs.
  calls.length = 0;
  sent.length = 0;
  const again = await run(`${today}T17:35:00Z`, clients);
  assert.deepEqual([again.forecastsFetched, again.emailsSent, sent.length], [0, 0, 0]);
  assert.ok(!calls.some((url) => url.includes('api.met.no')), 'no second forecast request');
  console.log('ok - one forecast and one warning per site and night');

  // ── Who is told: Maintenance managers, else Managers, else Owners ──────
  await pool.query('DELETE FROM frost_forecasts WHERE client_id = $1', [owner.clientId]);
  await pool.query("DELETE FROM scheduled_email_claims WHERE job = 'frost-warnings'");
  const manager = await createUser(owner, { role: 'client_manager' });
  const maintenance = await createUser(owner, { role: 'client_manager', isMaintenanceManager: true });
  const staff = await createUser(owner, { role: 'client_staff' });
  sent.length = 0;
  await run(`${today}T18:35:00Z`, [owner.clientId]);
  const { rows: maintenanceUser } = await pool.query('SELECT email FROM users WHERE id = $1', [maintenance.userId]);
  assert.deepEqual(sent.map((message) => message.to), [maintenanceUser[0].email.toLowerCase()], 'only the Maintenance manager');
  assert.ok(manager);
  console.log('ok - the Maintenance manager who covers the site is told');

  // Too late in the evening: no new checks.
  await pool.query('DELETE FROM frost_forecasts WHERE client_id = $1', [owner.clientId]);
  const late = await run(`${today}T22:35:00Z`, [owner.clientId]);
  assert.equal(late.clientsChecked, 0, 'nothing after 22:00');
  await run(`${today}T19:35:00Z`, [owner.clientId]);

  // ── Dashboard ──────────────────────────────────────────────────────────
  // It shows "tonight": from midday to midday (London), by the real clock.
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/London' }).format(new Date()));
  const londonToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const tonight = londonHour >= 12 ? londonToday : new Date(Date.parse(`${londonToday}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await pool.query('UPDATE frost_forecasts SET night_of = $2 WHERE client_id = $1', [owner.clientId, tonight]);
  const shown = await staff.request('GET', '/dashboard/frost-warnings');
  assert.equal(shown.status, 200, JSON.stringify(shown.data));
  assert.equal(shown.data.belowC, 4);
  assert.match(shown.data.credit, /MET Norway/);
  assert.deepEqual(shown.data.warnings.map((warning) => [warning.siteName, warning.lowestC]), [['Kilmarnock', -1.6]]);
  const oneSite = await owner.request('GET', `/dashboard/frost-warnings?siteId=${mild.data.id}`);
  assert.deepEqual(oneSite.data.warnings, [], 'the mild site has no warning');
  assert.equal((await owner.request('GET', `/dashboard/frost-warnings?siteId=${otherSite.data.id}`)).status, 400, "another business's site");
  assert.equal((await owner.request('GET', '/dashboard/frost-warnings?siteId=abc')).status, 400);
  const dept = await owner.request('POST', '/departments', { name: 'Plymouth team', siteId: mild.data.id });
  const plymouthStaff = await createUser(owner, { role: 'client_staff', departmentId: dept.data.id });
  assert.deepEqual((await plymouthStaff.request('GET', '/dashboard/frost-warnings')).data.warnings, [], "another site's warning is hidden");
  assert.ok(nowhere.data.id && unknown.data.id);
  console.log('ok - the dashboard shows tonight\'s warning to people who can see the site');

  console.log('Frost warning tests passed.');
} finally {
  await pool.end();
  await job?.pool?.end();
}
