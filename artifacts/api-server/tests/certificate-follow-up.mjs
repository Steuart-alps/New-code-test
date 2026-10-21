import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool, runCertificateFollowUpJob } from './approval-workflow-fixtures.mjs';

// A contractor visit that has happened with no certificate 3 days on: the
// contractor gets one follow-up through Contractor Approvals and the site's
// Maintenance person (else a Manager, else the Owner) one email. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/certificate-follow-up.mjs

const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
};
const sent = [];
const send = async (email) => { sent.push(email); };
const run = () => runCertificateFollowUpJob({ send });

try {
  const owner = await createTenant('certificate-follow-up');
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Follow-up site A', seedStarterChecks: false }), 201);
  const siteB = ok(await owner.request('POST', '/sites', { name: 'Follow-up site B', seedStarterChecks: false }), 201);
  const deptA = ok(await owner.request('POST', '/departments', { name: 'Grounds A', siteId: siteA.id }), 201);
  const maintenanceA = await createUser(owner, { role: 'client_staff', departmentId: deptA.id, isMaintenanceManager: true });
  const maintenanceAEmail = (await pool.query('SELECT email FROM users WHERE id = $1', [maintenanceA.userId])).rows[0].email.toLowerCase();
  const manager = await createUser(owner, { role: 'client_manager' });
  const managerEmail = (await pool.query('SELECT email FROM users WHERE id = $1', [manager.userId])).rows[0].email.toLowerCase();
  const ownerEmail = (await pool.query(
    `SELECT email FROM users WHERE client_id = $1 AND role = 'client_admin' ORDER BY id LIMIT 1`, [owner.clientId])).rows[0].email.toLowerCase();
  const gasCo = ok(await owner.request('POST', '/contractors', { name: 'Sam Gas', company: 'Gas Co', email: 'sam@gas.test' }), 201);

  const check = async (title, siteId, extra = {}) => ok(await owner.request('POST', '/compliance-items', {
    title, priority: 'high', siteId, contractorId: gasCo.id, frequencyMonths: 12, dueDate: `${isoDay(-5)}T00:00:00.000Z`, ...extra,
  }), 201);
  const complete = async (id, completedAt) =>
    ok(await owner.request('PATCH', `/compliance-items/${id}/status`, { status: 'completed', completedAt }));
  const drafts = async (itemId) => (await pool.query(
    `SELECT status, email_type, to_email, subject, body_text, cc_json, last_error FROM contractor_email_queue
     WHERE client_id = $1 AND entity_type = 'compliance' AND entity_id = $2 ORDER BY id`, [owner.clientId, itemId])).rows;

  const gas = await check('Gas Safety Inspection', siteA.id);
  const eicr = await check('EICR', siteB.id);
  const recent = await check('LOLER Examination', siteA.id);
  const certified = await check('Fire Alarm Maintenance', siteA.id);
  const old = await check('Boiler Service', siteA.id);
  await complete(gas.id, isoDay(-4));
  await complete(eicr.id, isoDay(-3));
  await complete(recent.id, isoDay(-1));
  await complete(certified.id, isoDay(-6));
  await complete(old.id, isoDay(-45));
  ok(await owner.request('POST', `/items/${certified.id}/certificates`, { name: 'Alarm certificate', issueDate: `${isoDay(-6)}T00:00:00.000Z` }), 201);

  // ── First run ──────────────────────────────────────────────────────────────
  let result = await run();
  const [gasDraft, ...moreGas] = (await drafts(gas.id)).filter(d => d.email_type === 'certificate_followup');
  assert.equal(moreGas.length, 0);
  assert.equal(gasDraft.status, 'pending', 'the contractor follow-up waits in Contractor Approvals');
  assert.equal(gasDraft.to_email, 'sam@gas.test');
  assert.match(gasDraft.subject, /Certificate needed: Gas Safety Inspection/);
  assert.match(gasDraft.body_text, new RegExp(`email it to ${maintenanceAEmail.replace(/[.+]/g, '\\$&')}`));
  assert.deepEqual(gasDraft.cc_json, [maintenanceAEmail]);
  assert.equal((await drafts(eicr.id)).filter(d => d.email_type === 'certificate_followup').length, 1);
  for (const item of [recent, certified, old]) {
    assert.equal((await drafts(item.id)).filter(d => d.email_type === 'certificate_followup').length, 0, `${item.title} is not followed up`);
  }
  console.log('ok - a visit 3+ days ago with no certificate drafts one contractor follow-up');

  const to = (address) => sent.filter(email => email.to === address);
  assert.equal(to(maintenanceAEmail).length, 1, 'Maintenance covering site A gets one email');
  assert.match(to(maintenanceAEmail)[0].text, /Gas Safety Inspection/);
  assert.doesNotMatch(to(maintenanceAEmail)[0].text, /EICR/, "site B's visit is not theirs");
  assert.equal(to(managerEmail).length, 1, 'site B has no Maintenance person, so its Manager hears');
  assert.match(to(managerEmail)[0].text, /EICR/);
  assert.equal(to(ownerEmail).length, 0, 'the Owner is not emailed');
  console.log('ok - the Maintenance person for the site hears, else the Manager, never the Owner');

  // ── Once per visit ─────────────────────────────────────────────────────────
  sent.length = 0;
  result = await run();
  assert.equal(result.drafted, 0);
  assert.equal(sent.length, 0, 'nothing is sent twice for the same visit');
  console.log('ok - each visit is followed up once');

  // ── A certificate withdraws the waiting draft ──────────────────────────────
  ok(await owner.request('POST', `/items/${gas.id}/certificates`, { name: 'Gas Safe certificate' }), 201);
  await run();
  const withdrawn = (await drafts(gas.id)).find(d => d.email_type === 'certificate_followup');
  assert.equal(withdrawn.status, 'cancelled');
  assert.equal(withdrawn.last_error, 'Certificate received');
  console.log('ok - uploading the certificate withdraws the follow-up still waiting');

  // ── Sending the follow-up does not count as the due reminder ───────────────
  const [eicrDraft] = (await pool.query(
    `SELECT id FROM contractor_email_queue WHERE entity_id = $1 AND email_type = 'certificate_followup'`, [eicr.id])).rows;
  ok(await owner.request('POST', `/fix-track/contractor-email-queue/${eicrDraft.id}/approve-and-send`));
  const eicrAfter = ok(await owner.request('GET', `/compliance-items/${eicr.id}`));
  assert.equal(eicrAfter.notificationSentAt, null, "the next due reminder is still to come");
  console.log("ok - a sent follow-up doesn't stop the next visit's reminder");

  // ── A booked visit date that has passed counts as a visit ──────────────────
  const booked = await check('Lift LOLER', siteA.id);
  await pool.query(`UPDATE compliance_items SET visit_scheduled_at = $2 WHERE id = $1`, [booked.id, `${isoDay(-5)}T10:00:00Z`]);
  sent.length = 0;
  await run();
  assert.equal((await drafts(booked.id)).filter(d => d.email_type === 'certificate_followup').length, 1);
  assert.match(to(maintenanceAEmail)[0]?.text ?? '', /Lift LOLER/);
  console.log('ok - a booked visit date that has passed is followed up too');

  // ── A business with only an Owner: the Owner hears ─────────────────────────
  const solo = await createTenant('certificate-follow-up-solo');
  const soloSite = ok(await solo.request('POST', '/sites', { name: 'Solo site', seedStarterChecks: false }), 201);
  const soloContractor = ok(await solo.request('POST', '/contractors', { name: 'Solo Co', email: 'solo@contractor.test' }), 201);
  const soloCheck = ok(await solo.request('POST', '/compliance-items', {
    title: 'PAT testing', priority: 'high', siteId: soloSite.id, contractorId: soloContractor.id,
  }), 201);
  ok(await solo.request('PATCH', `/compliance-items/${soloCheck.id}/status`, { status: 'completed', completedAt: isoDay(-5) }));
  const soloOwner = (await pool.query(
    `SELECT email FROM users WHERE client_id = $1 AND role = 'client_admin' ORDER BY id LIMIT 1`, [solo.clientId])).rows[0].email.toLowerCase();
  sent.length = 0;
  await run();
  assert.equal(to(soloOwner).length, 1, 'with no Maintenance person or Manager, the Owner hears');
  console.log('ok - a business with only an Owner still hears about it');
} finally {
  await pool.end();
}
