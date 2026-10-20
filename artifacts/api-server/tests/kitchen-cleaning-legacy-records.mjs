// Replit #338: cleaning logs with no site are account-level (most predate
// kitchens). Rule: a kitchen's history and dated log only ever show that
// kitchen's logs; account-level logs have their own view (siteId=account on
// history, no siteId on the dated log) and are never moved to a kitchen.
import assert from 'node:assert/strict';
import { createTenant, createUser, pool } from './approval-workflow-fixtures.mjs';

try {
  const owner = await createTenant('legacy-cleaning'), other = await createTenant('foreign-legacy-cleaning');
  const staff = await createUser(owner, { role: 'client_staff' });
  const quay = (await owner.request('POST', '/sites', { name: 'Quayside kitchen', seedStarterChecks: false })).data;
  const station = (await owner.request('POST', '/sites', { name: 'Station kitchen', seedStarterChecks: false })).data;
  const foreign = (await other.request('POST', '/sites', { name: 'Foreign kitchen', seedStarterChecks: false })).data;
  // Today in the account's time zone, so staff saves fall inside the 24-hour correction window.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const earlier = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const completion = (marker) => JSON.stringify([{ taskArea: 'Prep', taskName: `Task ${marker}`, done: true, doneBy: marker }]);
  const insert = async (clientId, siteId, date, marker) => (await pool.query(
    `INSERT INTO kitchen_cleaning_logs(client_id, site_id, log_date, frequency, completions, signed_by, submitted_at)
     VALUES($1, $2, $3, 'daily', $4::jsonb, $5, now()) RETURNING id`,
    [clientId, siteId, date, completion(marker), marker],
  )).rows[0].id;
  const legacyId = await insert(owner.clientId, null, day, 'legacy');
  await insert(owner.clientId, station.id, day, 'station');
  await insert(owner.clientId, quay.id, earlier, 'quay');
  await insert(other.clientId, null, day, 'other-tenant');

  const history = async (session, query) => {
    const res = await session.request('GET', `/kitchen-cleaning/logs/history${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data;
  };
  const signers = (rows) => rows.map((r) => r.signed_by).sort();

  // A kitchen's history never lists an account-level log.
  for (const session of [owner, staff]) {
    const quayRows = await history(session, `?siteId=${quay.id}`);
    assert.deepEqual(signers(quayRows), ['quay']);
    assert.ok(quayRows.every((r) => r.site_id === quay.id && r.account_level === false && r.site_name === 'Quayside kitchen'));
    assert.deepEqual(signers(await history(session, `?siteId=${station.id}`)), ['station']);
  }

  // Account-level logs have their own view, labelled as such.
  const accountRows = await history(owner, '?siteId=account');
  assert.deepEqual(signers(accountRows), ['legacy']);
  assert.equal(accountRows[0].account_level, true);
  assert.equal(accountRows[0].site_id, null);
  assert.equal(accountRows[0].site_name, null);

  // The unfiltered list keeps every log reachable, each marked with its kitchen or account-level.
  const allRows = await history(owner, '');
  assert.deepEqual(signers(allRows), ['legacy', 'quay', 'station']);
  for (const r of allRows) assert.equal(r.account_level, r.site_id === null, JSON.stringify(r));

  // Dated lookup: a kitchen's day is that kitchen's log or nothing, never the account-level one.
  const dated = (session, query) => session.request('GET', `/kitchen-cleaning/logs?date=${day}&frequency=daily${query}`);
  assert.equal((await dated(owner, `&siteId=${quay.id}`)).status, 404);
  const stationDay = await dated(owner, `&siteId=${station.id}`);
  assert.equal(stationDay.status, 200);
  assert.equal(stationDay.data.signed_by, 'station');
  const accountDay = await dated(owner, '');
  assert.equal(accountDay.status, 200);
  assert.equal(accountDay.data.id, legacyId, 'no siteId opens the account-level log, not a kitchen log for the same day');

  // Saving a kitchen's day leaves the account-level log alone (no reassignment or migration).
  const saved = await staff.request('POST', '/kitchen-cleaning/logs', {
    logDate: day, frequency: 'daily', siteId: quay.id, signedBy: 'quay staff',
    completions: [{ taskArea: 'Prep', taskName: 'Task quay-new', done: true }],
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.notEqual(saved.data.id, legacyId);
  const legacyRow = (await pool.query('SELECT site_id, signed_by, completions FROM kitchen_cleaning_logs WHERE id = $1', [legacyId])).rows[0];
  assert.equal(legacyRow.site_id, null);
  assert.equal(legacyRow.signed_by, 'legacy');
  assert.equal(legacyRow.completions[0].taskName, 'Task legacy');

  // The web can still open and update the account-level log.
  const webSave = await owner.request('POST', '/kitchen-cleaning/logs', {
    logDate: day, frequency: 'daily', signedBy: 'legacy',
    completions: [{ taskArea: 'Prep', taskName: 'Task legacy', done: true, notes: 'checked later' }],
  });
  assert.equal(webSave.status, 200, JSON.stringify(webSave.data));
  assert.equal(webSave.data.id, legacyId);
  assert.equal(webSave.data.site_id, null);
  assert.deepEqual(signers(await history(owner, `?siteId=${quay.id}`)), ['quay', 'quay staff']);
  assert.deepEqual(signers(await history(owner, '?siteId=account')), ['legacy']);

  // Tenant checks still apply to the kitchen filter.
  assert.equal((await owner.request('GET', `/kitchen-cleaning/logs/history?siteId=${foreign.id}`)).status, 403);
  assert.equal((await other.request('GET', `/kitchen-cleaning/logs/history?siteId=${quay.id}`)).status, 403);
  for (const bad of ['0', 'abc', 'ACCOUNT']) {
    assert.equal((await owner.request('GET', `/kitchen-cleaning/logs/history?siteId=${bad}`)).status, 400, bad);
  }
  assert.deepEqual(signers(await history(other, '?siteId=account')), ['other-tenant']);
  console.log('Account-level cleaning logs stay out of kitchen views and remain reachable on their own.');
} finally { await pool.end(); }
