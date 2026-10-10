import assert from 'node:assert/strict';
import { createTenant, createUser, pool } from './approval-workflow-fixtures.mjs';
import { pdfText } from "./pdf-text.mjs";

try {
  const owner = await createTenant('cleaning'), other = await createTenant('foreign-cleaning');
  const staff = await createUser(owner, { role: 'client_staff' });
  await pool.query('UPDATE clients SET name = $1 WHERE id = $2', ['Harbour Kitchens Ltd', owner.clientId]);
  const site = (await owner.request('POST', '/sites', { name: 'Quayside kitchen', seedStarterChecks: false })).data;
  const second = (await owner.request('POST', '/sites', { name: 'Station kitchen', seedStarterChecks: false })).data;
  const foreign = (await other.request('POST', '/sites', { name: 'Foreign kitchen', seedStarterChecks: false })).data;
  const from = '2026-09-01', to = '2026-09-02';
  for (const [client, sid, date, marker] of [
    [owner.clientId, site.id, from, 'included-site'],
    [owner.clientId, site.id, '2026-09-03', 'outside-range'],
    [owner.clientId, second.id, from, 'other-site'],
    [owner.clientId, null, to, 'no-site'],
    [other.clientId, foreign.id, from, 'other-tenant'],
  ]) {
    await pool.query(
      `INSERT INTO kitchen_cleaning_logs(client_id, site_id, log_date, frequency, completions, signed_by)
       VALUES($1, $2, $3, 'daily', $4::jsonb, $5)`,
      [client, sid, date, JSON.stringify([{ taskArea: 'Prep', taskName: `Task ${marker}`, done: true, doneBy: marker }]), marker],
    );
  }

  const base = `/kitchen-cleaning/export?from=${from}&to=${to}&frequency=daily`;
  const download = async (session, query) => {
    const response = await session.request('GET', `${base}${query}`, undefined, 'buffer');
    assert.equal(response.status, 200, response.data.toString());
    return pdfText(response.data);
  };

  const single = await download(owner, `&siteId=${site.id}`);
  assert.match(single, /Business: Harbour Kitchens Ltd/);
  assert.match(single, /Site: Quayside kitchen/);
  assert.match(single, /Task included-site/);
  assert.doesNotMatch(single, /outside-range|other-site|no-site|other-tenant/);

  const all = await download(owner, '');
  assert.match(all, /Business: Harbour Kitchens Ltd/);
  assert.match(all, /Site: All sites/);
  for (const marker of ['included-site', 'other-site', 'no-site']) assert.match(all, new RegExp(`Task ${marker}`));
  assert.doesNotMatch(all, /outside-range|other-tenant/);
  assert.match(all, /Site: Station kitchen/);
  assert.match(all, /Site: No site recorded/);

  const secondOnly = await download(owner, `&siteId=${second.id}`);
  assert.match(secondOnly, /Site: Station kitchen/);
  assert.match(secondOnly, /Task other-site/);
  assert.doesNotMatch(secondOnly, /included-site|no-site/);
  const quiet = await owner.request('GET', `/kitchen-cleaning/export?from=2025-01-01&to=2025-01-02&frequency=daily&siteId=${site.id}`, undefined, 'buffer');
  assert.equal(quiet.status, 200);
  assert.match(pdfText(quiet.data), /No cleaning logs were recorded for this site/);

  assert.equal((await owner.request('GET', `${base}&siteId=${foreign.id}`)).status, 403);
  assert.equal((await other.request('GET', `${base}&siteId=${site.id}`)).status, 403);
  assert.equal((await owner.request('GET', `${base}&siteId=999999999`)).status, 403);
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    assert.equal((await owner.request('GET', `${base}&siteId=${bad}`)).status, 400, bad);
  }
  assert.equal((await staff.request('GET', `${base}&siteId=${site.id}`)).status, 403);
  console.log('Cleaning PDF site filter, tenant-owned site validation and business/site heading passed.');
} finally { await pool.end(); }
