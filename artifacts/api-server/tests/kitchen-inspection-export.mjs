import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createTenant, createUser, pool } from './approval-workflow-fixtures.mjs';

function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'response must be a ZIP');
  let offset = bytes.readUInt32LE(end + 16);
  const result = {};
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    result[name] = (method === 8 ? inflateRawSync(data) : data).toString();
    offset += 46 + nameLength + extra + comment;
  }
  return result;
}
function csv(text) {
  const cells = [...text.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(m => m[1].replaceAll('""', '"'));
  const headers = text.slice(1, text.indexOf('\r\n')).match(/"((?:[^"]|"")*)"/g).map(v => v.slice(1, -1));
  const rows = [];
  for (let i = headers.length; i < cells.length; i += headers.length) rows.push(Object.fromEntries(headers.map((h, j) => [h, cells[i + j]])));
  return rows;
}
try {
  const owner = await createTenant('inspection'), other = await createTenant('foreign-inspection');
  const staff = await createUser(owner, { role: 'client_staff' }), viewer = await createUser(owner, { role: 'client_viewer' });
  const site = (await owner.request('POST', '/sites', { name: 'Inspection kitchen', seedStarterChecks: false })).data;
  const second = (await owner.request('POST', '/sites', { name: 'Other kitchen', seedStarterChecks: false })).data;
  const foreign = (await other.request('POST', '/sites', { name: 'Foreign kitchen', seedStarterChecks: false })).data;
  const department = (await owner.request('POST', '/departments', { name: 'Kitchen team' })).data;
  const otherDepartment = (await owner.request('POST', '/departments', { name: 'Other team' })).data;
  await pool.query('UPDATE sites SET department_id = $1 WHERE id = $2', [department.id, site.id]);
  await pool.query('UPDATE sites SET department_id = $1 WHERE id = $2', [otherDepartment.id, second.id]);
  await pool.query('UPDATE users SET department_id = $1 WHERE id = $2', [department.id, staff.userId]);
  const manager = await createUser(owner, { role: 'client_staff', departmentId: department.id, isDepartmentManager: true });
  const wrongDepartmentManager = await createUser(owner, { role: 'client_staff', departmentId: otherDepartment.id, isDepartmentManager: true });
  const from = '2026-09-01', to = '2026-09-02';
  for (const [client, sid, date, marker] of [
    [owner.clientId, site.id, from, 'included'],
    [owner.clientId, site.id, '2026-08-31', 'outside-before'],
    [owner.clientId, site.id, '2026-09-03', 'outside-after'],
    [owner.clientId, second.id, from, 'wrong-site'],
    [other.clientId, foreign.id, from, 'wrong-tenant'],
    [owner.clientId, null, from, 'organisation-only'],
  ]) {
    await pool.query(`INSERT INTO kitchen_weekly_records(client_id,site_id,week_commencing,overall_result,manager_signature) VALUES($1,$2,$3,'fail',$4)`, [client,sid,date,marker]);
    await pool.query(`INSERT INTO kitchen_probe_checks(client_id,site_id,check_date,overall_result,notes) VALUES($1,$2,$3,'fail',$4)`, [client,sid,date,marker === 'included' ? '=1+1' : marker]);
    await pool.query(`INSERT INTO daily_checklists(client_id,site_id,check_date,checklist_type,completed_by) VALUES($1,$2,$3,'am',$4)`, [client,sid,date,marker]);
    await pool.query(`INSERT INTO daily_manager_signoffs(client_id,site_id,signoff_date,manager_name) VALUES($1,$2,$3,$4)`, [client,sid,date,marker]);
    if (sid != null) await pool.query(`INSERT INTO daily_checklist_submissions(client_id,site_id,checklist_date,type,signed_off_by_name) VALUES($1,$2,$3,'pm',$4)`, [client,sid,date,marker]);
    if (marker !== 'included') await pool.query(`INSERT INTO food_safety_records(client_id,site_id,record_date,correctives) VALUES($1,$2,$3,$4)`, [client,sid,date,marker]);
  }
  const failed = await owner.request('POST', `/food-safety?siteId=${site.id}`, { recordDate: from,
    coldFood: [{ unit: 'Fridge', tempAm: '10', correctiveAction: 'Moved affected food to the working fridge' }], managerSignature: 'Inspection manager' });
  assert.equal(failed.status, 201, JSON.stringify(failed));
  const [action] = (await owner.request('GET', `/track-actions?module=kitchen&siteId=${site.id}`)).data;
  assert.equal((await owner.request('GET', `/track-evidence/requirements?module=kitchen&actionId=${action.id}`)).status, 200);
  assert.equal((await staff.request('POST', '/track-evidence', {
    module: 'kitchen', siteId: site.id, actionId: action.id, requirementKey: 'temperature_control_restored',
    evidenceType: 'verification', title: 'Fridge recheck', details: 'Repeat reading 3°C after repair',
  })).status, 201);
  assert.equal((await owner.request('PATCH', `/track-actions/${action.id}`, {
    status: 'resolved', remedialAction: 'Repaired fridge', evidenceReference: 'Fridge recheck', resolutionNotes: 'Manager verified',
    resolverSignature: 'data:image/png;base64,AAAA',
  })).status, 200);
  const url = `/export/kitchen-register?siteId=${site.id}&from=${from}&to=${to}`;
  assert.equal((await staff.request('GET', url)).status, 403);
  assert.equal((await viewer.request('GET', url)).status, 403);
  assert.equal((await other.request('GET', url)).status, 403);
  assert.equal((await wrongDepartmentManager.request('GET', url)).status, 403);
  assert.equal((await manager.request('GET', `/export/kitchen-register?siteId=${second.id}&from=${from}&to=${to}`)).status, 403);
  assert.equal((await owner.request('GET', `${url}&clientId=${other.clientId}`)).status, 403);
  for (const bad of ['siteId=0&from=2026-09-01&to=2026-09-02', `siteId=${site.id}&from=2026-02-30&to=2026-09-02`, `siteId=${site.id}&from=2026-09-03&to=2026-09-01`, 'from=2026-09-01&to=2026-09-02']) {
    assert.equal((await owner.request('GET', `/export/kitchen-register?${bad}`)).status, 400);
  }
  const exported = await owner.request('GET', url, undefined, 'buffer');
  assert.equal(exported.status, 200, exported.data.toString());
  const files = unzip(exported.data);
  const scoped = await manager.request('GET', url, undefined, 'buffer');
  assert.equal(scoped.status, 200, scoped.data.toString());
  assert.deepEqual(Object.keys(unzip(scoped.data)), Object.keys(files));
  assert.equal((await manager.request('GET', '/auth/me')).data.user.isDepartmentManager, true);
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith('.csv')) continue;
    assert.ok(!/outside-before|outside-after|wrong-site|wrong-tenant|organisation-only/.test(text), name);
    for (const row of csv(text)) {
      assert.ok(row.inspection_date >= from && row.inspection_date <= to, `${name}: ${JSON.stringify(row)}`);
      assert.equal(Number(row.site_id), site.id, name);
    }
  }
  assert.equal(csv(files['daily-temperatures.csv']).length, 1);
  assert.equal(csv(files['daily-temperatures.csv'])[0].reading_tempAm, '10');
  assert.equal(csv(files['weekly-reviews.csv']).length, 1);
  assert.equal(csv(files['probe-checks.csv']).length, 1);
  assert.equal(csv(files['manager-signoffs.csv']).length, 1);
  assert.equal(csv(files['checklist-submissions-and-signoffs.csv']).length, 1);
  assert.equal(csv(files['failures.csv']).length, 3);
  assert.equal(csv(files['corrective-actions.csv'])[0].status, 'resolved');
  assert.equal(csv(files['verification-evidence.csv']).length, 1);
  assert.match(files['probe-checks.csv'], /'=1\+1/);
  const empty = await owner.request('GET', `/export/kitchen-register?siteId=${site.id}&from=2025-01-01&to=2025-01-02`, undefined, 'buffer');
  assert.equal(empty.status, 200);
  for (const [name, text] of Object.entries(unzip(empty.data))) if (name.endsWith('.csv')) assert.equal(csv(text).length, 0);
  console.log('Kitchen inspection ZIP contents, source-date anchoring, strict tenant/site/date/role isolation, empty exports and spreadsheet safety passed.');
} finally { await pool.end(); }