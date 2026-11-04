import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Sleeping accommodation and night porter fire walks. Each site answers
// "Sleeping accommodation?" and "Night porter?". The escape route sign-off is
// only due at sites with sleeping accommodation and ticks every route the
// site lists. A night porter site needs three night walks (22:00, 02:00,
// 06:00; signed like every FireTrack record); missed ones raise one Urgent
// FireTrack action per site and night the morning after. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/night-fire-walks.mjs

const temp = await mkdtemp(fileURLToPath(new URL('.build-night-fire-walks-', import.meta.url)));
let job;
try {
  const output = `${temp}/runtime.mjs`;
  await build({
    entryPoints: [fileURLToPath(new URL('./night-fire-walks.entry.ts', import.meta.url))],
    outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    external: ['sharp', '*.node', 'pg-native', 'pino', 'pino-pretty', '@google-cloud/*', '@sentry/*', 'nodemailer'],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  job = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const reason = { 'X-Override-Reason': encodeURIComponent('Adding the night log from paper') };
const walkNotes = (routes, freeNotes = '') => JSON.stringify({ _type: 'fire_walk', routes, freeNotes });

try {
  const owner = await createTenant('night-fire-walks');
  const other = await createTenant('night-fire-walks-other');

  // ── Sites answer sleeping accommodation and night porter ───────────────
  const hotel = await owner.request('POST', '/sites', { name: 'Hotel', seedStarterChecks: false, sleepingAccommodation: true, nightPorter: true });
  assert.equal(hotel.status, 201, JSON.stringify(hotel.data));
  assert.deepEqual([hotel.data.sleepingAccommodation, hotel.data.nightPorter], [true, true]);
  assert.ok(hotel.data.nightPorterSince, 'the time the night porter answer became yes is kept');
  const lodge = await owner.request('POST', '/sites', { name: 'Lodge', seedStarterChecks: false, sleepingAccommodation: true, nightPorter: false });
  const shop = await owner.request('POST', '/sites', { name: 'Pro shop', seedStarterChecks: false, sleepingAccommodation: false, nightPorter: true });
  assert.deepEqual([shop.data.sleepingAccommodation, shop.data.nightPorter], [false, null], 'no night porter without sleeping accommodation');
  const unanswered = await owner.request('POST', '/sites', { name: 'Clubhouse', seedStarterChecks: false });
  assert.deepEqual([unanswered.data.sleepingAccommodation, unanswered.data.nightPorter], [null, null]);
  assert.equal((await owner.request('POST', '/sites', { name: 'Bad', sleepingAccommodation: 'yes' })).status, 400);
  const turnedOff = await owner.request('PATCH', `/sites/${lodge.data.id}`, { sleepingAccommodation: false });
  assert.deepEqual([turnedOff.data.sleepingAccommodation, turnedOff.data.nightPorter], [false, null]);
  const turnedOn = await owner.request('PATCH', `/sites/${lodge.data.id}`, { sleepingAccommodation: true, nightPorter: false });
  assert.deepEqual([turnedOn.data.sleepingAccommodation, turnedOn.data.nightPorter, turnedOn.data.nightPorterSince], [true, false, null]);
  const kept = await owner.request('PATCH', `/sites/${hotel.data.id}`, { phone: '01234 567890' });
  assert.equal(kept.data.nightPorterSince, hotel.data.nightPorterSince, 'other edits keep the answers');
  console.log('ok - sites answer sleeping accommodation and night porter');

  // ── Escape route sign-off only where people sleep ──────────────────────
  const fireTypes = async siteId => (await owner.request('GET', `/fire-safety/status?siteId=${siteId}`)).data.map(row => row.checkType);
  assert.ok((await fireTypes(hotel.data.id)).includes('fire_walk'));
  assert.ok(!(await fireTypes(shop.data.id)).includes('fire_walk'), 'no sleeping accommodation: no escape route sign-off');
  assert.ok(!(await fireTypes(unanswered.data.id)).includes('fire_walk'), 'not answered and never recorded: not shown');
  assert.ok(!(await fireTypes(hotel.data.id)).includes('night_walk'), 'night walks have their own card, not a due-date status');
  const legacyWalk = await owner.request('POST', '/fire-safety', {
    checkType: 'fire_walk', checkDate: isoDay(), result: 'pass', siteId: unanswered.data.id,
  });
  assert.equal(legacyWalk.status, 201, JSON.stringify(legacyWalk.data));
  assert.ok((await fireTypes(unanswered.data.id)).includes('fire_walk'), 'not answered but walked before: still shown');
  console.log('ok - the escape route sign-off is only due at sites with sleeping accommodation');

  // ── Each site lists its own escape routes ──────────────────────────────
  const routesUrl = `/fire-safety/escape-routes?siteId=${hotel.data.id}`;
  assert.deepEqual((await owner.request('GET', routesUrl)).data, { siteId: hotel.data.id, routes: [], shared: false });
  const routes = [
    { name: 'Final fire exit door route 1', location: 'Car park assembly point' },
    { name: 'Escape stairway 1' },
  ];
  const saved = await owner.request('PUT', routesUrl, { routes });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.routes, [routes[0], { name: 'Escape stairway 1', location: null }]);
  assert.equal((await owner.request('PUT', routesUrl, { routes: [{ name: 'Stair 1' }, { name: 'stair 1' }] })).status, 400, 'names are unique');
  assert.equal((await owner.request('PUT', routesUrl, { routes: [{ name: '  ' }] })).status, 400, 'every route has a name');
  const staff = await createUser(owner, { role: 'client_staff' });
  assert.equal((await staff.request('PUT', routesUrl, { routes })).status, 403, 'only managers change the list');
  assert.equal((await staff.request('GET', routesUrl)).data.routes.length, 2, 'staff see the list to tick it');
  assert.equal((await other.request('GET', routesUrl)).status, 400, "another business's site");
  // A list saved before routes were per site is still used where a site has none.
  assert.equal((await owner.request('PUT', '/fire-safety/escape-routes', { routes: [{ name: 'Old front door' }] })).status, 200);
  assert.deepEqual((await owner.request('GET', `/fire-safety/escape-routes?siteId=${lodge.data.id}`)).data,
    { siteId: lodge.data.id, routes: [{ name: 'Old front door', location: null }], shared: true });
  console.log('ok - each site lists its own escape routes, managed by managers');

  // ── A sign-off ticks every listed route ────────────────────────────────
  const signOff = { checkType: 'fire_walk', checkDate: isoDay(), result: 'pass', siteId: hotel.data.id };
  assert.equal((await owner.request('POST', '/fire-safety', signOff)).status, 400, 'routes must be answered');
  const oneMissing = await owner.request('POST', '/fire-safety', {
    ...signOff, notes: walkNotes([{ name: 'Final fire exit door route 1', status: 'clear', note: '' }]),
  });
  assert.equal(oneMissing.status, 400);
  assert.match(oneMissing.data.error, /Escape stairway 1/);
  const extra = await owner.request('POST', '/fire-safety', {
    ...signOff, notes: walkNotes([
      { name: 'Final fire exit door route 1', status: 'clear' }, { name: 'Escape stairway 1', status: 'clear' },
      { name: 'Back door', status: 'clear' },
    ]),
  });
  assert.equal(extra.status, 400, 'only the listed routes');
  const obstructed = await owner.request('POST', '/fire-safety', {
    ...signOff, notes: walkNotes([
      { name: 'Final fire exit door route 1', status: 'clear', note: '' }, { name: 'Escape stairway 1', status: 'obstructed', note: 'Linen trolley' },
    ]),
  });
  assert.equal(obstructed.status, 201, JSON.stringify(obstructed.data));
  assert.equal(obstructed.data.result, 'fail', 'a route not clear makes the sign-off a fail');
  console.log('ok - each sign-off ticks every listed route; one not clear is a fail');

  // ── Night walks: signed, at a walk time, once each ─────────────────────
  const night = isoDay(-2);
  const allClear = walkNotes(routes.map(route => ({ name: route.name, status: 'clear', note: '' })));
  const walk = {
    checkType: 'night_walk', checkDate: night, result: 'pass', siteId: hotel.data.id, walkTime: '22:00',
    performedBy: 'Night Porter', notes: allClear,
  };
  for (const [change, error] of [
    [{ walkTime: null }, 'Choose which night walk this is: 22:00, 02:00 or 06:00'],
    [{ siteId: null }, 'Choose the site of the night fire walk'],
    [{ performedBy: '' }, 'Say who did the night fire walk'],
  ]) {
    const refused = await owner.request('POST', '/fire-safety', { ...walk, ...change }, 'json', reason);
    assert.equal(refused.status, 400, JSON.stringify(change));
    assert.equal(refused.data.error, error);
  }
  assert.equal((await owner.request('POST', '/fire-safety', { ...walk, walkTime: '23:00' }, 'json', reason)).status, 400);
  assert.equal((await owner.request('POST', '/fire-safety', { ...walk, notes: undefined }, 'json', reason)).status, 400, 'routes are ticked on night walks too');
  const recorded = await owner.request('POST', '/fire-safety', walk, 'json', reason);
  assert.equal(recorded.status, 201, JSON.stringify(recorded.data));
  assert.deepEqual([recorded.data.walkTime, recorded.data.result], ['22:00', 'pass']);
  const twice = await owner.request('POST', '/fire-safety', walk, 'json', reason);
  assert.equal(twice.status, 409, 'each walk of a night is recorded once per site');
  const later = await owner.request('POST', '/fire-safety', { ...walk, checkDate: isoDay(1), walkTime: '22:00' });
  assert.equal(later.status, 400, 'a walk cannot be recorded before its time');
  const moved = await owner.request('PUT', `/fire-safety/${recorded.data.id}`, { walkTime: '02:00' }, 'json', reason);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const back = await owner.request('PUT', `/fire-safety/${recorded.data.id}`, { walkTime: '22:00' }, 'json', reason);
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const listed = await owner.request('GET', '/fire-safety?checkType=night_walk');
  assert.deepEqual(listed.data.map(row => row.id), [recorded.data.id]);
  console.log('ok - night walks are at 22:00, 02:00 or 06:00, by a named person, once each per site');

  // ── Tonight and the nights before ──────────────────────────────────────
  await pool.query(`UPDATE sites SET night_porter_since = now() - interval '10 days' WHERE id = $1`, [hotel.data.id]);
  const walks = await owner.request('GET', '/fire-safety/night-walks');
  assert.equal(walks.status, 200, JSON.stringify(walks.data));
  assert.deepEqual(walks.data.walkTimes, ['22:00', '02:00', '06:00']);
  assert.deepEqual(walks.data.sites.map(site => site.siteName), ['Hotel'], 'only sites with a night porter');
  const nights = walks.data.sites[0].nights;
  assert.equal(nights.length, 7);
  const that = nights.find(entry => entry.nightOf === night);
  assert.deepEqual(that.walks.map(entry => [entry.date, entry.time, entry.status]), [
    [night, '22:00', 'done'], [isoDay(-1), '02:00', 'missed'], [isoDay(-1), '06:00', 'missed'],
  ]);
  assert.equal(that.walks[0].performedBy, 'Night Porter');
  assert.ok(walks.data.sites[0].missedCount >= 2);
  // Before the site had a night porter, nothing was missed.
  await pool.query(`UPDATE sites SET night_porter_since = now() WHERE id = $1`, [hotel.data.id]);
  const fresh = await owner.request('GET', `/fire-safety/night-walks?siteId=${hotel.data.id}`);
  assert.deepEqual(fresh.data.sites[0].nights.find(entry => entry.nightOf === night).walks.map(entry => entry.status),
    ['done', 'not_needed', 'not_needed']);
  await pool.query(`UPDATE sites SET night_porter_since = now() - interval '10 days' WHERE id = $1`, [hotel.data.id]);
  const dept = await owner.request('POST', '/departments', { name: 'Lodge team', siteId: lodge.data.id });
  const lodgeStaff = await createUser(owner, { role: 'client_staff', departmentId: dept.data.id });
  assert.deepEqual((await lodgeStaff.request('GET', '/fire-safety/night-walks')).data.sites, [], "another site's walks are hidden");
  assert.equal((await lodgeStaff.request('GET', `/fire-safety/night-walks?siteId=${hotel.data.id}`)).status, 403);
  assert.deepEqual((await other.request('GET', '/fire-safety/night-walks')).data.sites, []);
  console.log('ok - night walks show done, missed and not needed for each night porter site');

  // ── Missed walks are chased the morning after ──────────────────────────
  const morning = new Date(`${isoDay(-1)}T09:30:00Z`);
  const first = await job.runNightFireWalkChaseJob({ now: morning, clientIds: [owner.clientId] });
  assert.deepEqual([first.actionsRaised, first.errors], [1, 0]);
  const { rows: actions } = await pool.query(
    `SELECT site_id, module, severity, status, title, source_kind FROM track_actions WHERE client_id = $1 AND source_kind LIKE $2`,
    [owner.clientId, `${job.NIGHT_WALK_ACTION_KIND}:%`]);
  assert.equal(actions.length, 1);
  assert.deepEqual([actions[0].site_id, actions[0].module, actions[0].severity, actions[0].status],
    [hotel.data.id, 'fire', 'urgent', 'open']);
  assert.equal(actions[0].source_kind, `${job.NIGHT_WALK_ACTION_KIND}:${night}`);
  assert.match(actions[0].title, /Night fire walks missed: 02:00, 06:00/);
  const again = await job.runNightFireWalkChaseJob({ now: new Date(morning.getTime() + 3600_000), clientIds: [owner.clientId] });
  assert.equal(again.actionsRaised, 0, 'once per site and night');
  const tooEarly = await job.runNightFireWalkChaseJob({ now: new Date(`${isoDay(-1)}T04:00:00Z`), clientIds: [owner.clientId] });
  assert.equal(tooEarly.clientsChecked, 0, 'nothing before 07:00, while the night is still running');
  console.log('ok - missed night walks raise one Urgent FireTrack action per site the morning after');

  console.log('Night fire walk tests passed.');
} finally {
  await pool.end();
  await job?.pool?.end();
}
