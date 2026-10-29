import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool, runReminderJob } from './approval-workflow-fixtures.mjs';

// Contractor visits kept on the tracks reach the contractor through the one
// contractor reminder: each visit's compliance check takes its track's due
// date, and recording the visit on either side keeps the other in step. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/contractor-visits.mjs

const today = isoDay();
const addMonths = (day, months) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
};
const LEGIONELLA_FREQUENCIES = {
  calorifier_temp: 7, hot_sentinel_temp: 30, hot_nonsent_temp: 90, cold_tank_temp: 30, cold_sentinel_temp: 30,
  cold_nonsent_temp: 90, cold_tank_inspection: 183, cold_tank_clean: 365, calorifier_inspection: 365,
  calorifier_clean: 365, shower_clean: 90, tmv_service: 365, outlet_flush: 7,
};

try {
  const owner = await createTenant('contractor-visits', { overrideReason: 'Contractor visit test history' });
  const staff = await createUser(owner, { role: 'client_staff' });
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Visits site A', seedStarterChecks: false }), 201);
  const siteB = ok(await owner.request('POST', '/sites', { name: 'Visits site B', seedStarterChecks: false }), 201);
  const pestCo = ok(await owner.request('POST', '/contractors', { name: 'Jo Smith', company: 'Pest Co', email: 'jo@pest.test' }), 201);
  const waterCo = ok(await owner.request('POST', '/contractors', { name: 'Water Co', email: 'water@contractor.test' }), 201);

  const visits = async () => ok(await owner.request('GET', '/contractor-visits'));
  const row = async (visitKey, siteId) => (await visits()).visits.find(v => v.visitKey === visitKey && v.siteId === siteId);
  const choose = async (visitKey, siteId, contractorId, extra = {}) =>
    ok(await owner.request('PUT', '/contractor-visits', { visitKey, siteId, contractorId, ...extra }));
  const check = async (id) => ok(await owner.request('GET', `/compliance-items/${id}`));

  // ── Every track's contractor visits are listed per site ────────────────────
  const listed = await visits();
  for (const key of ['pest:visit', 'legionella:cold_tank_clean', 'legionella:calorifier_inspection', 'legionella:tmv_service',
    'legionella:risk_assessment', 'legionella:water_sampling', 'fire:alarm_service', 'fire:risk_assessment',
    'fire:sprinkler_service', 'fire:kitchen_suppression_service', 'fire:aov_service', 'fire:intruder_alarm_service', 'fire:cctv_service',
    'pat:testing', 'green:service', 'green:puwer', 'green:loler_6_monthly', 'green:loler', 'green:nsts', 'green:examination', 'bike:service',
    'coshh:lev_examination', 'tree:visual_assessment', 'hot_tub:microbiological_test']) {
    assert.ok(listed.types.some(type => type.key === key), `${key} is listed`);
    assert.ok(listed.visits.some(v => v.visitKey === key && v.siteId === siteA.id && v.checkId === null));
  }
  console.log("ok - each track's contractor visits are listed at each site");

  // ── PestTrack: the visit's next date drives the contractor reminder ────────
  ok(await owner.request('POST', '/pest-track/visits', { siteId: siteA.id, visitDate: isoDay(-80), nextVisitDate: isoDay(10) }), 201);
  assert.equal((await row('pest:visit', siteA.id)).trackDueDate, isoDay(10));
  await choose('pest:visit', siteA.id, pestCo.id);
  const pestA = await row('pest:visit', siteA.id);
  assert.equal(pestA.dueDate, isoDay(10), 'the new check is due when PestTrack says');
  assert.equal(pestA.contractorName, 'Jo Smith, Pest Co');
  const pestCheck = await check(pestA.checkId);
  assert.equal(pestCheck.title, 'Pest Control Visit');
  assert.equal(pestCheck.siteId, siteA.id);
  assert.equal(pestCheck.frequencyMonths, 3);

  const drafts = async (itemId) => (await pool.query(
    `SELECT status, superseded_reason FROM contractor_email_queue
     WHERE client_id = $1 AND entity_type = 'compliance' AND entity_id = $2 ORDER BY id`, [owner.clientId, itemId])).rows;
  await runReminderJob();
  assert.deepEqual((await drafts(pestA.checkId)).map(d => d.status), ['pending'], 'the pest contractor reminder is drafted');
  console.log('ok - the pest control contractor is reminded before the visit PestTrack has due');

  ok(await staff.request('POST', '/pest-track/visits', { siteId: siteA.id, visitDate: today, nextVisitDate: isoDay(95) }), 201);
  const afterVisit = await check(pestA.checkId);
  assert.equal(afterVisit.completedAt.slice(0, 10), today, 'recording the visit completes the check');
  assert.equal(afterVisit.dueDate.slice(0, 10), isoDay(95), "and it is due on the visit's next date");
  assert.equal(afterVisit.status, 'pending');
  assert.deepEqual((await drafts(pestA.checkId)).map(d => [d.status, d.superseded_reason]),
    [['superseded', 'Due date changed']], 'the reminder for the old date is withdrawn');
  console.log('ok - recording the visit in PestTrack completes the check and moves it to the next visit');

  // A site with no visits yet takes a typed first date, then completing the
  // check records the visit in PestTrack.
  await choose('pest:visit', siteB.id, pestCo.id, { dueDate: isoDay(3) });
  const pestB = await row('pest:visit', siteB.id);
  assert.equal(pestB.trackDueDate, null);
  assert.equal(pestB.dueDate, isoDay(3));
  ok(await staff.request('PATCH', `/compliance-items/${pestB.checkId}/status`, { status: 'completed', completedAt: today }));
  const recorded = (await pool.query(
    `SELECT visit_date::text AS day, next_visit_date::text AS next, contractor_name, contractor_company
     FROM pest_visits WHERE client_id = $1 AND site_id = $2`, [owner.clientId, siteB.id])).rows;
  assert.deepEqual(recorded, [{ day: today, next: addMonths(today, 3), contractor_name: 'Jo Smith', contractor_company: 'Pest Co' }]);
  assert.equal((await row('pest:visit', siteB.id)).dueDate, addMonths(today, 3));
  console.log('ok - completing the pest control check records the visit in PestTrack');

  // ── Water Safety: servicing follows the approved plan and the log ──────────
  ok(await owner.request('PUT', `/legionella/monitoring-plan?siteId=${siteA.id}`, {
    action: 'approve', riskAssessmentReference: 'LRA-1', writtenSchemeReference: 'WS-1', competentPerson: 'Water Co',
    frequencies: LEGIONELLA_FREQUENCIES,
  }));
  ok(await owner.request('POST', '/legionella', { siteId: siteA.id, checkType: 'calorifier_inspection', checkDate: isoDay(-300), result: 'pass' }), 201);
  await choose('legionella:calorifier_inspection', siteA.id, waterCo.id);
  const calorifier = await row('legionella:calorifier_inspection', siteA.id);
  assert.equal(calorifier.dueDate, isoDay(65));
  assert.equal((await check(calorifier.checkId)).title, 'Calorifier Inspection');
  ok(await staff.request('PATCH', `/compliance-items/${calorifier.checkId}/status`, { status: 'completed', completedAt: today }));
  const calorifierLog = (await pool.query(
    `SELECT check_date::text AS day FROM legionella_checks
     WHERE client_id = $1 AND site_id = $2 AND check_type = 'calorifier_inspection' ORDER BY check_date`, [owner.clientId, siteA.id])).rows;
  assert.deepEqual(calorifierLog.map(r => r.day), [isoDay(-300), today], 'completing the check records the inspection');
  assert.equal((await row('legionella:calorifier_inspection', siteA.id)).dueDate, addDays(today, 365));
  console.log('ok - calorifier servicing is due from the Water Safety log and recorded there when done');

  // Risk assessment review: the site template's review date, or a later one
  // typed on the check.
  ok(await owner.request('PUT', `/legionella/config?siteId=${siteB.id}`, { controlProfile: { riskAssessmentReviewDate: isoDay(200) } }));
  await choose('legionella:risk_assessment', siteB.id, waterCo.id);
  const review = await row('legionella:risk_assessment', siteB.id);
  assert.equal(review.dueDate, isoDay(200));
  ok(await owner.request('PUT', `/compliance-items/${review.checkId}`, { dueDate: `${isoDay(400)}T00:00:00.000Z` }));
  assert.equal((await row('legionella:risk_assessment', siteB.id)).dueDate, isoDay(400), 'a later date on the check is kept');
  console.log('ok - the legionella risk assessment review follows the template date');

  // Sampling has no track date; the check keeps its own.
  await choose('legionella:water_sampling', siteA.id, waterCo.id, { dueDate: isoDay(30) });
  const sampling = await row('legionella:water_sampling', siteA.id);
  assert.equal(sampling.dueDate, isoDay(30));
  assert.equal((await check(sampling.checkId)).title, 'Legionella Water Sampling');
  console.log('ok - water sampling keeps the date typed for it');

  // FireTrack's other fire and security services work the same way, and say
  // which contractor trade to suggest.
  await choose('fire:sprinkler_service', siteA.id, waterCo.id, { dueDate: isoDay(45) });
  const sprinkler = await row('fire:sprinkler_service', siteA.id);
  assert.equal(sprinkler.dueDate, isoDay(45));
  const sprinklerCheck = await check(sprinkler.checkId);
  assert.equal(sprinklerCheck.title, 'Sprinkler System Service');
  assert.equal(sprinklerCheck.contractorId, waterCo.id);
  assert.equal(sprinklerCheck.frequencyMonths, 3);
  const types = (await visits()).types;
  assert.deepEqual(types.find(type => type.key === 'fire:sprinkler_service').trades, ['sprinkler_systems']);
  assert.deepEqual(types.find(type => type.key === 'fire:alarm_service').trades, ['fire_alarm']);
  assert.deepEqual(types.find(type => type.key === 'pest:visit').trades, ['pest_control']);
  assert.deepEqual(types.find(type => type.key === 'bike:service').trades, []);
  console.log('ok - fire and security services keep their own date and suggest a trade');

  // ── FireTrack: the service is its compliance check, with its own date ──────
  // (FireTrack shows the check; it no longer records the service itself.)
  await choose('fire:alarm_service', siteA.id, waterCo.id, { dueDate: isoDay(10) });
  const alarm = await row('fire:alarm_service', siteA.id);
  assert.equal((await check(alarm.checkId)).title, 'Fire Alarm Maintenance');
  assert.equal(alarm.dueDate, isoDay(10));
  assert.equal(alarm.trackDueDate, null);
  console.log('ok - the fire alarm service check keeps the date typed for it');

  // ── PAT, GreenTrack and TreeTrack due dates ────────────────────────────────
  const insertId = async (text, values) => (await pool.query(text, values)).rows[0].id;
  for (const next of [isoDay(40), isoDay(20)]) {
    const appliance = await insertId(`INSERT INTO pat_appliances (client_id, site_id, name) VALUES ($1, $2, 'Kettle') RETURNING id`, [owner.clientId, siteA.id]);
    await pool.query(`INSERT INTO pat_tests (client_id, appliance_id, test_date, next_test_date) VALUES ($1, $2, $3, $4)`,
      [owner.clientId, appliance, isoDay(-300), next]);
  }
  const machine = await insertId(`INSERT INTO green_machines (client_id, site_id, name) VALUES ($1, $2, 'Mower') RETURNING id`, [owner.clientId, siteA.id]);
  await pool.query(`INSERT INTO green_service_records (client_id, machine_id, service_date, next_service_date) VALUES ($1, $2, $3, $4)`,
    [owner.clientId, machine, isoDay(-100), isoDay(80)]);
  await pool.query(`INSERT INTO tree_inspections (client_id, site_id, check_type, check_date) VALUES ($1, $2, 'visual_assessment', $3)`,
    [owner.clientId, siteA.id, isoDay(-300)]);
  assert.equal((await row('pat:testing', siteA.id)).trackDueDate, isoDay(20), 'the first appliance due sets the PAT visit');
  assert.equal((await row('green:service', siteA.id)).trackDueDate, isoDay(80));
  assert.equal((await row('tree:visual_assessment', siteA.id)).trackDueDate, isoDay(65));
  assert.equal((await row('pat:testing', siteB.id)).trackDueDate, null, 'another site has no PAT date');
  console.log('ok - PAT testing, machine servicing and the tree survey are due from their tracks');

  // ── GreenTrack: each kind of statutory inspection is its own line ─────────
  const loader = await insertId(`INSERT INTO green_machines (client_id, site_id, name) VALUES ($1, $2, 'Loader') RETURNING id`, [owner.clientId, siteA.id]);
  for (const [machineId, type, next] of [
    [machine, 'thorough_examination', isoDay(90)], [loader, 'thorough_examination', isoDay(70)],
    [loader, 'loler_examination', isoDay(30)], [loader, 'loler_examination_6_monthly', isoDay(45)],
    [machine, 'nsts_test', isoDay(400)], [machine, 'annual_inspection', isoDay(15)],
  ]) {
    await pool.query(`INSERT INTO green_puwer_inspections (client_id, machine_id, inspection_date, next_inspection_date, inspection_type)
      VALUES ($1, $2, $3, $4, $5)`, [owner.clientId, machineId, isoDay(-200), next, type]);
  }
  assert.equal((await row('green:puwer', siteA.id)).trackDueDate, isoDay(70), "the first machine's PUWER inspection");
  assert.equal((await row('green:loler', siteA.id)).trackDueDate, isoDay(30));
  assert.equal((await row('green:loler_6_monthly', siteA.id)).trackDueDate, isoDay(45), '6-monthly LOLER has its own line');
  assert.equal((await row('green:nsts', siteA.id)).trackDueDate, isoDay(400));
  assert.equal((await row('green:examination', siteA.id)).trackDueDate, isoDay(15), 'other inspections share one line');
  await choose('green:loler', siteA.id, waterCo.id);
  const loler = await row('green:loler', siteA.id);
  assert.equal((await check(loler.checkId)).title, 'GreenTrack LOLER Thorough Examination');
  assert.equal(loler.dueDate, isoDay(30));
  console.log('ok - GreenTrack PUWER, LOLER (6-monthly and annual), NSTS and other inspections each have their own line and date');

  // ── BikeTrack servicing and COSHHTrack LEV examinations ────────────────────
  const bike = await insertId(`INSERT INTO bikes (client_id, site_id, ref) VALUES ($1, $2, 'B1') RETURNING id`, [owner.clientId, siteA.id]);
  await pool.query(`INSERT INTO bike_services (client_id, bike_id, service_date, next_service_date) VALUES ($1, $2, $3, $4)`,
    [owner.clientId, bike, isoDay(-300), isoDay(25)]);
  await pool.query(`INSERT INTO coshh_checks (client_id, site_id, check_type, check_date, subject, next_due_date)
    VALUES ($1, $2, 'lev_examination', $3, 'Workshop extraction', $4)`, [owner.clientId, siteA.id, isoDay(-400), isoDay(35)]);
  assert.equal((await row('bike:service', siteA.id)).trackDueDate, isoDay(25));
  assert.equal((await row('coshh:lev_examination', siteA.id)).trackDueDate, isoDay(35));
  console.log('ok - bike servicing and LEV examinations are due from their tracks');

  // ── No contractor needed ──────────────────────────────────────────────────
  await choose('green:nsts', siteA.id, null, { notNeeded: true });
  const nsts = await row('green:nsts', siteA.id);
  assert.equal(nsts.notNeeded, true);
  assert.equal(nsts.checkId, null, 'marking it creates no compliance check');
  assert.equal((await row('green:nsts', siteB.id)).notNeeded, false, 'only at that site');
  assert.equal((await owner.request('PUT', '/contractor-visits', { visitKey: 'green:puwer', siteId: siteA.id, contractorId: waterCo.id, notNeeded: true })).status, 400);
  // A visit with a contractor loses it when marked, and a contractor clears the mark.
  await choose('green:loler', siteA.id, null, { notNeeded: true });
  const lolerNa = await row('green:loler', siteA.id);
  assert.equal(lolerNa.notNeeded, true);
  assert.equal(lolerNa.contractorId, null);
  assert.equal((await check(loler.checkId)).contractorId, null);
  await choose('green:loler', siteA.id, waterCo.id);
  assert.equal((await row('green:loler', siteA.id)).notNeeded, false);
  assert.equal((await row('green:loler', siteA.id)).contractorId, waterCo.id);
  // A date typed on a visit keeps the mark.
  await choose('legionella:water_sampling', siteB.id, null, { notNeeded: true });
  await choose('legionella:water_sampling', siteB.id, null, { dueDate: isoDay(12) });
  assert.equal((await row('legionella:water_sampling', siteB.id)).notNeeded, true);
  assert.equal((await staff.request('PUT', '/contractor-visits', { visitKey: 'green:nsts', siteId: siteB.id, contractorId: null, notNeeded: true })).status, 403);
  console.log('ok - a visit can be marked no contractor needed, and choosing a contractor clears it');

  // ── The compliance check register's other checks ───────────────────────────
  const gas = ok(await owner.request('POST', '/compliance-items', {
    title: 'Gas Safety Certificate', siteId: siteA.id, dueDate: `${isoDay(60)}T00:00:00.000Z`, frequencyMonths: 12,
  }), 201);
  const register = async () => (await visits()).checks;
  const gasRow = (await register()).find(c => c.checkId === gas.id);
  assert.ok(gasRow, 'a register check is listed');
  assert.equal(gasRow.siteName, 'Visits site A');
  assert.equal(gasRow.notNeeded, false);
  assert.ok(!(await register()).some(c => c.title === 'Pest Control Visit'), "a track visit's check is not listed twice");
  ok(await owner.request('PUT', `/contractor-visits/checks/${gas.id}`, { contractorId: waterCo.id }));
  assert.equal((await check(gas.id)).contractorId, waterCo.id);
  ok(await owner.request('PUT', `/contractor-visits/checks/${gas.id}`, { contractorId: null, notNeeded: true }));
  const gasNa = (await register()).find(c => c.checkId === gas.id);
  assert.equal(gasNa.notNeeded, true);
  assert.equal(gasNa.contractorId, null);
  assert.equal((await check(gas.id)).contractorId, null);
  ok(await owner.request('PUT', `/contractor-visits/checks/${gas.id}`, { contractorId: waterCo.id }));
  assert.equal((await register()).find(c => c.checkId === gas.id).notNeeded, false);
  const marks = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE client_id = $1 AND table_name = 'contractor_visit_not_needed'`,
    [owner.clientId])).rows[0].n;
  assert.ok(marks > 0, 'marking and clearing is in the audit log');
  assert.equal((await staff.request('PUT', `/contractor-visits/checks/${gas.id}`, { contractorId: null, notNeeded: true })).status, 403);
  console.log('ok - register checks take a contractor or no contractor needed too');

  // ── Only managers choose, and only their own business's contractors ────────
  const other = await createTenant('contractor-visits-other');
  const otherContractor = ok(await other.request('POST', '/contractors', { name: 'Other Co', email: 'other@contractor.test' }), 201);
  assert.equal((await owner.request('PUT', '/contractor-visits', { visitKey: 'pest:visit', siteId: siteA.id, contractorId: otherContractor.id })).status, 400);
  assert.equal((await other.request('PUT', '/contractor-visits', { visitKey: 'pest:visit', siteId: siteA.id, contractorId: otherContractor.id })).status, 400);
  assert.equal((await staff.request('PUT', '/contractor-visits', { visitKey: 'pest:visit', siteId: siteA.id, contractorId: pestCo.id })).status, 403);
  assert.equal((await owner.request('PUT', '/contractor-visits', { visitKey: 'nope', siteId: siteA.id, contractorId: pestCo.id })).status, 400);
  assert.equal((await other.request('PUT', `/contractor-visits/checks/${gas.id}`, { contractorId: null, notNeeded: true })).status, 404,
    "another business cannot touch this business's checks");
  assert.equal((await owner.request('PUT', `/contractor-visits/checks/${gas.id}`, { contractorId: otherContractor.id })).status, 400);
  console.log("ok - only a manager picks the contractor, from the business's own contractors");

  // ── A business-wide check counts at a business with one site ───────────────
  const solo = await createTenant('contractor-visits-solo');
  const soloSite = ok(await solo.request('POST', '/sites', { name: 'Only site', seedStarterChecks: false }), 201);
  // Sign-up adds the starter "Fire Risk Assessment Review" check for the whole business.
  const [fra, ...moreReviews] = (await pool.query(
    `SELECT id FROM compliance_items WHERE client_id = $1 AND title = 'Fire Risk Assessment Review'`, [solo.clientId])).rows;
  assert.equal(moreReviews.length, 0);
  ok(await solo.request('PUT', `/compliance-items/${fra.id}`, { siteId: null, dueDate: `${isoDay(5)}T00:00:00.000Z` }));
  ok(await solo.request('PUT', `/fire-safety/config?siteId=${soloSite.id}`, { controlProfile: { nextReviewDate: isoDay(50) } }));
  const soloRow = (await (async () => ok(await solo.request('GET', '/contractor-visits')))()).visits
    .find(v => v.visitKey === 'fire:risk_assessment' && v.siteId === soloSite.id);
  assert.equal(soloRow.checkId, fra.id);
  assert.equal(soloRow.dueDate, isoDay(50), 'the review date on the FireTrack template moves the check on');
  const audits = async () => Number((await pool.query(
    `SELECT count(*) FROM audit_events WHERE client_id = $1 AND entity_type = 'compliance_item' AND entity_id = $2`,
    [solo.clientId, fra.id])).rows[0].count);
  const auditsBefore = await audits();
  ok(await solo.request('GET', '/contractor-visits'));
  assert.equal(await audits(), auditsBefore, 'a check already in step is not touched again');
  console.log('ok - a business-wide check is kept in step at a business with one site');
} finally {
  await pool.end();
}
