import assert from 'node:assert/strict';
import { createTenant, createUser, pool, runCertificateFollowUpJob, runPersonalReminderJob } from './approval-workflow-fixtures.mjs';

// A contractor visit that has happened with no certificate 2 weeks on, then
// every 2 weeks: the contractor gets a follow-up through Contractor Approvals
// with the people responsible copied in (the assigned person, the site's
// Maintenance person and head of department; else a Manager, else the Owner),
// who see it in their 08:00 personal reminder that day, and every Owner and
// Manager update lists it. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/certificate-follow-up.mjs

const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
};

// Days are counted from the latest Wednesday, so no run falls on a Monday
// (the Owner update day).
const base = new Date();
base.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 4) % 7));
const day = (offset) => {
  const date = new Date(base);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const at = (offset) => new Date(`${day(offset)}T08:30:00Z`);

const sent = [];
const send = async (email) => { sent.push(email); };
const followUp = (offset = 0) => runCertificateFollowUpJob({ now: at(offset) });
const remind = async (clientIds, offset = 0) => {
  sent.length = 0;
  await pool.query(`DELETE FROM scheduled_email_claims WHERE job = 'personal-reminders'`);
  await runPersonalReminderJob({ now: at(offset), clientIds, send, sendPush: async () => 0 });
};
const to = (address) => sent.filter((email) => email.to === address);
const emailOf = async (userId) => (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email.toLowerCase();
const ownerEmailOf = async (clientId) => (await pool.query(
  `SELECT email FROM users WHERE client_id = $1 AND role = 'client_admin' ORDER BY id LIMIT 1`, [clientId])).rows[0].email.toLowerCase();

try {
  const owner = await createTenant('certificate-follow-up');
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Follow-up site A', seedStarterChecks: false }), 201);
  const siteB = ok(await owner.request('POST', '/sites', { name: 'Follow-up site B', seedStarterChecks: false }), 201);
  const deptA = ok(await owner.request('POST', '/departments', { name: 'Grounds A', siteId: siteA.id }), 201);
  const maintenanceA = await createUser(owner, { role: 'client_staff', departmentId: deptA.id, isMaintenanceManager: true });
  const maintenanceAEmail = await emailOf(maintenanceA.userId);
  const staffA = await createUser(owner, { role: 'client_staff', departmentId: deptA.id });
  const staffAEmail = await emailOf(staffA.userId);
  const headA = await createUser(owner, { role: 'client_staff', departmentId: deptA.id, isDepartmentManager: true });
  const headAEmail = await emailOf(headA.userId);
  const manager = await createUser(owner, { role: 'client_manager' });
  const managerEmail = await emailOf(manager.userId);
  const ownerEmail = await ownerEmailOf(owner.clientId);
  const gasCo = ok(await owner.request('POST', '/contractors', { name: 'Sam Gas', company: 'Gas Co', email: 'sam@gas.test' }), 201);

  const check = async (title, siteId, extra = {}) => ok(await owner.request('POST', '/compliance-items', {
    title, priority: 'high', siteId, contractorId: gasCo.id, frequencyMonths: 12, dueDate: `${day(-5)}T00:00:00.000Z`, ...extra,
  }), 201);
  const complete = async (id, completedAt) =>
    ok(await owner.request('PATCH', `/compliance-items/${id}/status`, { status: 'completed', completedAt }));
  const drafts = async (itemId) => (await pool.query(
    `SELECT status, email_type, to_email, subject, body_text, cc_json, last_error FROM contractor_email_queue
     WHERE client_id = $1 AND entity_type = 'compliance' AND entity_id = $2 AND email_type = 'certificate_followup'
     ORDER BY id`, [owner.clientId, itemId])).rows;

  const gas = await check('Gas Safety Inspection', siteA.id);
  const eicr = await check('EICR', siteB.id);
  const recent = await check('LOLER Examination', siteA.id);
  const certified = await check('Fire Alarm Maintenance', siteA.id);
  const old = await check('Boiler Service', siteA.id);
  const assigned = await check('Emergency Lighting Test', siteA.id, { assigneeUserId: staffA.userId });
  await complete(gas.id, day(-14));
  await complete(eicr.id, day(-14));
  await complete(recent.id, day(-10));
  await complete(certified.id, day(-20));
  await complete(old.id, day(-120));
  await complete(assigned.id, day(-14));
  ok(await owner.request('POST', `/items/${certified.id}/certificates`, { name: 'Alarm certificate', issueDate: `${day(-20)}T00:00:00.000Z` }), 201);

  // ── Contractor follow-up ───────────────────────────────────────────────────
  let result = await followUp();
  const [gasDraft, ...moreGas] = await drafts(gas.id);
  assert.equal(moreGas.length, 0);
  assert.equal(gasDraft.status, 'pending', 'the contractor follow-up waits in Contractor Approvals');
  assert.equal(gasDraft.to_email, 'sam@gas.test');
  assert.match(gasDraft.subject, /Certificate needed: Gas Safety Inspection/);
  assert.match(gasDraft.body_text, new RegExp(`email it to ${maintenanceAEmail.replace(/[.+]/g, '\\$&')}`));
  assert.match(gasDraft.body_text, /invoice/);
  assert.deepEqual([...gasDraft.cc_json].sort(), [maintenanceAEmail, headAEmail].sort(), 'Maintenance and the HoD are copied in');
  assert.equal((await drafts(eicr.id)).length, 1);
  const [assignedDraft] = await drafts(assigned.id);
  assert.equal(assignedDraft.cc_json[0], staffAEmail, 'a check given to someone asks for the certificate to go to them');
  assert.deepEqual(assignedDraft.cc_json.slice(1).sort(), [maintenanceAEmail, headAEmail].sort());
  for (const item of [recent, certified, old]) {
    assert.equal((await drafts(item.id)).length, 0, `${item.title} is not followed up`);
  }
  console.log('ok - two weeks after a visit with no certificate, the contractor follow-up is drafted, Maintenance and HoD copied in');

  result = await followUp();
  assert.equal(result.drafted, 0);
  assert.equal((await drafts(gas.id)).length, 1, 'each visit is followed up once');
  console.log('ok - each visit is followed up once');

  // ── The person responsible hears in their 08:00 email ──────────────────────
  await remind([owner.clientId]);
  const only = (address) => {
    const emails = to(address);
    assert.equal(emails.length, 1, `${address} gets one email`);
    return emails[0].html;
  };
  const maintenanceHtml = only(maintenanceAEmail);
  assert.match(maintenanceHtml, /Certificates outstanding/);
  assert.match(maintenanceHtml, /Gas Safety Inspection/);
  assert.match(maintenanceHtml, /Emergency Lighting Test/, 'Maintenance is copied in on a check given to someone');
  assert.doesNotMatch(maintenanceHtml, /EICR/, "site B's visit is not theirs");
  assert.match(only(headAEmail), /Gas Safety Inspection/, 'the HoD hears too');
  const staffHtml = only(staffAEmail);
  assert.match(staffHtml, /Emergency Lighting Test/);
  assert.doesNotMatch(staffHtml, /Gas Safety Inspection/, 'staff only hear about checks given to them');
  assert.match(only(managerEmail), /EICR/, 'site B has no Maintenance person, so its Manager hears');
  assert.equal(to(ownerEmail).length, 0, 'the Owner is not emailed');
  for (const email of sent) assert.doesNotMatch(email.html, /LOLER Examination|Fire Alarm Maintenance|Boiler Service/);
  console.log('ok - the assigned person, Maintenance and HoD for the site hear, else the Manager; never the Owner');

  await remind([owner.clientId], 1);
  assert.equal(sent.filter((email) => /Certificates outstanding/.test(email.html)).length, 0, 'not repeated the next day');
  await remind([owner.clientId], 7);
  assert.equal(sent.filter((email) => /Certificates outstanding/.test(email.html)).length, 0, 'not repeated a week later');
  await remind([owner.clientId], 14);
  assert.match(only(maintenanceAEmail), /Gas Safety Inspection/, 'still missing two weeks later: reminded again');
  console.log('ok - repeated every two weeks while the certificate is missing');

  // ── The contractor is chased again every two weeks, never stacked ─────────
  result = await followUp(14);
  assert.equal((await drafts(gas.id)).length, 1, 'no second follow-up while the first is still waiting');
  const [firstGas] = (await pool.query(
    `SELECT id FROM contractor_email_queue WHERE entity_id = $1 AND email_type = 'certificate_followup'`, [gas.id])).rows;
  ok(await owner.request('POST', `/fix-track/contractor-email-queue/${firstGas.id}/approve-and-send`));
  await followUp(7);
  assert.equal((await drafts(gas.id)).length, 1, 'not chased again before two weeks');
  await followUp(14);
  const gasChases = await drafts(gas.id);
  assert.equal(gasChases.length, 2, 'chased again two weeks after the first');
  assert.equal(gasChases[1].status, 'pending');
  await followUp(14);
  assert.equal((await drafts(gas.id)).length, 2, 'once per chase');
  console.log('ok - the contractor is chased again every two weeks, one waiting follow-up at a time');

  // ── Owner and Manager updates list every certificate outstanding ───────────
  await pool.query(
    `INSERT INTO app_settings (client_id, key, value) VALUES ($1, 'ownerUpdateFrequency', 'daily')
     ON CONFLICT (client_id, key) DO UPDATE SET value = EXCLUDED.value`, [owner.clientId]);
  await remind([owner.clientId], 1);
  const update = only(ownerEmail);
  assert.match(update, /Certificates outstanding/);
  assert.match(update, /Gas Safety Inspection/);
  assert.match(update, /EICR/);
  const managerUpdate = only(managerEmail);
  assert.match(managerUpdate, /Certificates outstanding/);
  assert.match(managerUpdate, /EICR/, 'the Manager update lists them too');
  assert.doesNotMatch(update, /LOLER Examination/, 'a visit under two weeks ago is not outstanding yet');
  await pool.query(`DELETE FROM app_settings WHERE client_id = $1 AND key = 'ownerUpdateFrequency'`, [owner.clientId]);
  console.log('ok - Owner and Manager updates list them, with no separate Owner email');

  // ── A certificate withdraws the waiting draft ──────────────────────────────
  ok(await owner.request('POST', `/items/${gas.id}/certificates`, { name: 'Gas Safe certificate' }), 201);
  result = await followUp();
  const withdrawn = (await drafts(gas.id)).at(-1);
  assert.equal(withdrawn.status, 'cancelled');
  assert.equal(withdrawn.last_error, 'Certificate received');
  await remind([owner.clientId]);
  assert.doesNotMatch(to(maintenanceAEmail)[0]?.html ?? '', /Gas Safety Inspection/, 'no reminder once the certificate is in');
  console.log('ok - uploading the certificate withdraws the follow-up and stops the reminder');

  // ── Sending the follow-up does not count as the due reminder ───────────────
  const [eicrDraft] = (await pool.query(
    `SELECT id FROM contractor_email_queue WHERE entity_id = $1 AND email_type = 'certificate_followup'`, [eicr.id])).rows;
  ok(await owner.request('POST', `/fix-track/contractor-email-queue/${eicrDraft.id}/approve-and-send`));
  const eicrAfter = ok(await owner.request('GET', `/compliance-items/${eicr.id}`));
  assert.equal(eicrAfter.notificationSentAt, null, 'the next due reminder is still to come');
  console.log("ok - a sent follow-up doesn't stop the next visit's reminder");

  // ── A booked visit date that has passed counts as a visit ──────────────────
  const booked = await check('Lift LOLER', siteA.id);
  await pool.query(`UPDATE compliance_items SET visit_scheduled_at = $2 WHERE id = $1`, [booked.id, `${day(-14)}T10:00:00Z`]);
  await followUp();
  assert.equal((await drafts(booked.id)).length, 1);
  await remind([owner.clientId]);
  assert.match(to(maintenanceAEmail)[0]?.html ?? '', /Lift LOLER/);
  console.log('ok - a booked visit date that has passed is followed up too');

  // ── A business with only an Owner: the Owner hears ─────────────────────────
  const solo = await createTenant('certificate-follow-up-solo');
  const soloSite = ok(await solo.request('POST', '/sites', { name: 'Solo site', seedStarterChecks: false }), 201);
  const soloContractor = ok(await solo.request('POST', '/contractors', { name: 'Solo Co', email: 'solo@contractor.test' }), 201);
  const soloCheck = ok(await solo.request('POST', '/compliance-items', {
    title: 'PAT testing', priority: 'high', siteId: soloSite.id, contractorId: soloContractor.id,
  }), 201);
  ok(await solo.request('PATCH', `/compliance-items/${soloCheck.id}/status`, { status: 'completed', completedAt: day(-14) }));
  await remind([solo.clientId]);
  assert.match(only(await ownerEmailOf(solo.clientId)), /PAT testing/, 'with no Maintenance person or Manager, the Owner hears');
  console.log('ok - a business with only an Owner still hears about it');
} finally {
  await pool.end();
}
