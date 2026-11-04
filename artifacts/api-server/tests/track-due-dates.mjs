import assert from 'node:assert/strict';
import { createTenant, isoDay, pool, runReminderJob } from './approval-workflow-fixtures.mjs';

// Due dates that contractors' visits and inspections set on PestTrack,
// PremisesTrack and GreenTrack, and the lead time of the 08:00 contractor
// reminder. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/track-due-dates.mjs

const today = isoDay();
const addMonths = (day, months) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};
const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
};

try {
  const owner = await createTenant('track-due-dates', { overrideReason: 'Track due date test history' });
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Due dates site A', seedStarterChecks: false }), 201);
  const siteB = ok(await owner.request('POST', '/sites', { name: 'Due dates site B', seedStarterChecks: false }), 201);
  const trackSummary = async (trackId) => ok(await owner.request('GET', '/dashboard/summary')).tracks
    .find(track => track.trackId === trackId);

  // ── PestTrack: each site's latest visit sets its next visit ────────────────
  ok(await owner.request('POST', '/pest-track/visits', {
    siteId: siteA.id, visitDate: isoDay(-120), nextVisitDate: isoDay(-30), contractorName: 'Site A pest co',
  }), 201);
  ok(await owner.request('POST', '/pest-track/visits', {
    siteId: siteB.id, visitDate: isoDay(-5), nextVisitDate: isoDay(60), contractorName: 'Site B pest co',
  }), 201);
  const pestStatus = ok(await owner.request('GET', '/pest-track/status'));
  assert.equal(pestStatus.last_visit_date, isoDay(-5));
  assert.equal(pestStatus.last_contractor_name, 'Site B pest co');
  assert.equal(pestStatus.next_visit_date, isoDay(-30), "site A's visit is still due");
  assert.equal(pestStatus.next_visit_overdue, true);
  assert.equal((await trackSummary('pest')).status, 'overdue');
  console.log("ok - a newer visit at one site doesn't hide an overdue visit at another");

  // ── PestTrack: a visit with no next date uses the visit frequency ──────────
  const defaulted = ok(await owner.request('POST', '/pest-track/visits', { siteId: siteA.id, visitDate: today }), 201);
  assert.equal(defaulted.nextVisitDate, addMonths(today, 3), 'three months when no frequency is set');
  ok(await owner.request('PUT', '/pest-track/config', { pest_visit_frequency_months: '2' }));
  const twoMonthly = ok(await owner.request('POST', '/pest-track/visits', { siteId: siteB.id, visitDate: today }), 201);
  assert.equal(twoMonthly.nextVisitDate, addMonths(today, 2));
  const typed = ok(await owner.request('POST', '/pest-track/visits', { siteId: siteB.id, visitDate: today, nextVisitDate: isoDay(10) }), 201);
  assert.equal(typed.nextVisitDate, isoDay(10), 'a typed next visit date is kept');
  assert.equal(ok(await owner.request('GET', '/pest-track/status')).next_visit_overdue, false);
  console.log('ok - a visit saved without a next date is due again after the visit frequency');

  // ── PestTrack: a contractor's recommendations open an action ───────────────
  const pestActions = async (visitId) => (await pool.query(
    `SELECT title, instruction, module, severity, status FROM track_actions
     WHERE client_id = $1 AND source_kind = 'pest_visits' AND source_record_id = $2`, [owner.clientId, visitId])).rows;
  const advised = ok(await owner.request('POST', '/pest-track/visits', {
    siteId: siteA.id, visitDate: today, contractorName: 'Jo Smith', contractorCompany: 'Pest Co',
    recommendations: 'Proof the gap under the kitchen door',
  }), 201);
  const [action, ...extra] = await pestActions(advised.id);
  assert.equal(extra.length, 0);
  assert.equal(action.module, 'pest');
  assert.equal(action.status, 'open');
  assert.match(action.instruction, /Jo Smith, Pest Co/);
  assert.match(action.instruction, /Proof the gap under the kitchen door/);
  ok(await owner.request('PUT', `/pest-track/visits/${advised.id}`, {
    siteId: siteA.id, visitDate: today, recommendations: 'Proof the gap under the kitchen door and the bin store',
  }));
  assert.equal((await pestActions(advised.id)).length, 1, 'editing the visit adds no second action');
  assert.equal((await pestActions(defaulted.id)).length, 0, 'a visit with no recommendations opens nothing');
  console.log("ok - a pest contractor's recommendations open one PestTrack action");

  // ── PremisesTrack: the latest inspection sets the next one ─────────────────
  const premisesSummary = async () => ok(await owner.request('GET', '/premises-track/summary'));
  const closed = ok(await owner.request('POST', '/premises-track', {
    siteId: siteA.id, inspectionDate: isoDay(-100), nextInspectionDate: isoDay(-10),
    inspectionType: 'routine', area: 'Car park', status: 'closed',
  }), 201);
  assert.equal((await premisesSummary()).overdue, 1, 'a closed inspection still falls due again');
  assert.equal((await trackSummary('premises')).status, 'overdue');
  const listed = ok(await owner.request('GET', '/premises-track'));
  assert.equal(listed.find(row => row.id === closed.id).superseded, false);

  ok(await owner.request('POST', '/premises-track', {
    siteId: siteA.id, inspectionDate: today, nextInspectionDate: isoDay(90),
    inspectionType: 'routine', area: ' car park ', status: 'open',
  }), 201);
  assert.equal((await premisesSummary()).overdue, 0, 'the newer inspection supersedes the older date');
  assert.notEqual((await trackSummary('premises')).status, 'overdue');
  assert.equal(ok(await owner.request('GET', '/premises-track')).find(row => row.id === closed.id).superseded, true);

  ok(await owner.request('POST', '/premises-track', {
    siteId: siteB.id, inspectionDate: isoDay(-100), nextInspectionDate: isoDay(-1),
    inspectionType: 'routine', area: 'Car park', status: 'closed',
  }), 201);
  assert.equal((await premisesSummary()).overdue, 1, 'the same area at another site is tracked on its own');
  console.log('ok - premises inspections fall due from the latest inspection, whatever its status');

  // ── GreenTrack: overdue statutory examinations show on the dashboard ───────
  const machine = ok(await owner.request('POST', '/green-track/machines', { name: 'Ride-on 1', type: 'ride_on', siteId: siteA.id }), 201);
  const exam = (body) => owner.request('POST', '/green-track/puwer-inspections', { machineId: machine.id, safeToOperate: true, ...body });
  ok(await exam({ inspectionDate: isoDay(-400), nextInspectionDate: isoDay(-35), inspectionType: 'loler_examination' }), 201);
  ok(await exam({ inspectionDate: isoDay(-20), nextInspectionDate: isoDay(345), inspectionType: 'thorough_examination' }), 201);
  let green = await trackSummary('green');
  assert.equal(green.status, 'overdue', 'a newer PUWER examination does not cover the LOLER one');
  assert.match(green.badge, /1 examination overdue/);
  assert.ok(green.items.some(item => item.label === 'Ride-on 1' && /Thorough examination overdue/.test(item.detail)));
  ok(await exam({ inspectionDate: today, nextInspectionDate: isoDay(365), inspectionType: 'loler_examination' }), 201);
  green = await trackSummary('green');
  assert.doesNotMatch(green.badge, /examination/);
  console.log('ok - an overdue thorough examination turns GreenTrack red on the dashboard');

  // ── Contractor reminder uses the business's default lead time ──────────────
  const contractor = ok(await owner.request('POST', '/contractors', { name: 'Lead time contractor', email: 'lead-time@contractor.test' }), 201);
  const item = ok(await owner.request('POST', '/compliance-items', {
    title: 'Lead time check', priority: 'high', siteId: siteA.id, contractorId: contractor.id,
    dueDate: `${isoDay(20)}T00:00:00.000Z`,
  }), 201);
  assert.equal(item.leadTimeDays ?? null, null, 'the check has no lead time of its own');
  const queued = async () => (await pool.query(
    `SELECT id FROM contractor_email_queue WHERE client_id = $1 AND entity_type = 'compliance' AND entity_id = $2`,
    [owner.clientId, item.id])).rows.length;
  ok(await owner.request('PUT', '/settings', { defaultLeadTimeDays: '14' }));
  await runReminderJob();
  assert.equal(await queued(), 0, 'not drafted 20 days ahead with a 14-day lead time');
  ok(await owner.request('PUT', '/settings', { defaultLeadTimeDays: '25' }));
  await runReminderJob();
  assert.equal(await queued(), 1, 'drafted once inside a 25-day lead time');
  console.log("ok - the 08:00 contractor reminder follows the business's default lead time");
} finally {
  await pool.end();
}
