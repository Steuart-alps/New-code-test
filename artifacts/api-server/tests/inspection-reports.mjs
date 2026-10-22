import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Uploaded audit and inspection reports turned into track actions. Owners,
// Managers and consultants only; a Manager works only with their own
// department's sites; nothing becomes an action until a person confirms the
// list; the actions point back to the report and say who confirmed them.
// The file upload itself needs object storage, so reports are seeded in the
// database here. Run:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/inspection-reports.mjs

const outbox = () => {
  try {
    return readFileSync(process.env.TEST_EMAIL_CAPTURE_PATH, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
};
const ok = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
};
async function seedReport(clientId, values = {}) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO inspection_reports (client_id, site_id, report_type, title, report_date, object_path, file_name, mime_type, uploaded_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Fixture') RETURNING id`,
    [clientId, values.siteId ?? null, values.reportType ?? 'eho', values.title ?? 'EHO visit', values.reportDate ?? isoDay(-3),
      `/objects/uploads/tenant-${clientId}/report-${Math.random().toString(36).slice(2)}`, 'report.pdf', 'application/pdf'],
  );
  return row.id;
}

try {
  const owner = await createTenant('inspection-reports');
  const other = await createTenant('inspection-reports-other');
  const siteA = ok(await owner.request('POST', '/sites', { name: 'Care home', seedStarterChecks: false }), 201);
  const siteB = ok(await owner.request('POST', '/sites', { name: 'Day centre', seedStarterChecks: false }), 201);
  const dayTeam = ok(await owner.request('POST', '/departments', { name: 'Day centre team', siteId: siteB.id }), 201);
  const manager = await createUser(owner, { role: 'client_manager', departmentId: dayTeam.id, name: 'Morgan Manager' });
  const maintenance = await createUser(owner, { role: 'client_manager', isMaintenanceManager: true, name: 'Sam Maintenance' });
  const staff = await createUser(owner, { role: 'client_staff' });
  const viewer = await createUser(owner, { role: 'client_viewer' });

  // ── Who may use it ───────────────────────────────────────────────────────
  const options = ok(await owner.request('GET', '/inspection-reports/options'));
  assert.equal(options.reading.available, false, 'reading is off until ANTHROPIC_API_KEY is set');
  assert.ok(options.reportTypes.some((type) => type.key === 'care_inspectorate'));
  assert.ok(options.modules.some((module) => module.key === 'audit'), 'every business has the general report actions list');
  assert.deepEqual(options.sites.map((site) => site.name), ['Care home', 'Day centre']);
  const assignable = new Map(options.assignees.map((person) => [person.id, person]));
  assert.ok(assignable.has(maintenance.userId), 'Maintenance managers can be assigned');
  assert.ok(assignable.has(manager.userId), 'Managers can be assigned');
  assert.ok(assignable.has(owner.userId), 'Owners can be assigned');
  assert.equal(assignable.has(staff.userId), false, 'Staff are not in the list');
  assert.equal(assignable.get(maintenance.userId).isMaintenanceManager, true);
  assert.deepEqual(ok(await manager.request('GET', '/inspection-reports/options')).sites.map((site) => site.name), ['Day centre'],
    "a Manager sees only their department's site");
  assert.equal((await staff.request('GET', '/inspection-reports')).status, 403, 'Staff cannot see reports');
  assert.equal((await viewer.request('GET', '/inspection-reports')).status, 403, 'Viewers cannot see reports');
  console.log('ok - Owners, Managers and consultants use reports; Staff and Viewers cannot');

  // ── Registering an upload ────────────────────────────────────────────────
  assert.equal((await owner.request('POST', '/inspection-reports', {
    title: 'Not mine', reportType: 'eho', objectPath: `/objects/uploads/tenant-${other.clientId}/stolen`, fileName: 'x.pdf',
  })).status, 403, "another business's upload cannot be attached");
  assert.equal((await manager.request('POST', '/inspection-reports', {
    title: 'Wrong site', reportType: 'eho', siteId: siteA.id, objectPath: `/objects/uploads/tenant-${owner.clientId}/x`, fileName: 'x.pdf',
  })).status, 403, "a Manager cannot file a report against another department's site");
  assert.equal((await staff.request('POST', '/inspection-reports', {
    title: 'Staff', reportType: 'eho', objectPath: `/objects/uploads/tenant-${owner.clientId}/x`, fileName: 'x.pdf',
  })).status, 403);
  console.log('ok - only this business\'s own uploads are registered');

  // ── Reports are scoped to the business and the Manager's sites ───────────
  const homeReport = await seedReport(owner.clientId, { siteId: siteA.id, reportType: 'care_inspectorate', title: 'Care Inspectorate inspection' });
  const centreReport = await seedReport(owner.clientId, { siteId: siteB.id, title: 'EHO food hygiene visit' });
  const wideReport = await seedReport(owner.clientId, { reportType: 'alps_audit', title: 'ALPS annual audit' });
  assert.deepEqual(ok(await owner.request('GET', '/inspection-reports')).map((r) => r.id).sort(), [homeReport, centreReport, wideReport].sort());
  assert.deepEqual(ok(await manager.request('GET', '/inspection-reports')).map((r) => r.id).sort(), [centreReport, wideReport].sort());
  assert.equal((await manager.request('GET', `/inspection-reports/${homeReport}`)).status, 404, "another department's report answers as missing");
  assert.equal((await other.request('GET', `/inspection-reports/${homeReport}`)).status, 404, "another business's report answers as missing");
  assert.deepEqual(ok(await other.request('GET', '/inspection-reports')), []);
  const detail = ok(await owner.request('GET', `/inspection-reports/${homeReport}`));
  assert.equal(detail.objectPath, undefined, 'the storage path is not handed out');
  assert.equal(detail.readable, true);
  console.log('ok - reports are kept per business and per Manager\'s sites');

  // ── Without the AI key, reading is unavailable and typing still works ───
  const read = await owner.request('POST', `/inspection-reports/${homeReport}/read`);
  assert.equal(read.status, 503);
  assert.equal(read.data.code, 'REPORT_READING_UNAVAILABLE');

  const typed = [
    { title: 'Repair the fire door closer on the first floor', instruction: 'Requirement 1: door does not self-close.', module: 'audit',
      severity: 'urgent', siteId: siteA.id, dueDate: isoDay(7), assignedUserId: maintenance.userId, reportReference: 'Requirement 1', draftSource: 'ai' },
    { title: 'Update the falls risk assessment', module: 'audit', severity: 'action_required', siteId: siteA.id,
      assignedUserId: owner.userId, draftSource: 'manual' },
    { title: 'Review night staffing', module: 'audit', severity: 'monitor', siteId: null, draftSource: 'manual' },
  ];
  ok(await owner.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: typed }));
  assert.equal(ok(await owner.request('GET', `/inspection-reports/${homeReport}`)).draftActions.length, 3, 'the list is kept while it is checked');
  assert.equal((await owner.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: [{ ...typed[0], assignedUserId: staff.userId }] })).status, 400,
    'Staff cannot be assigned');
  assert.equal((await owner.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: [{ ...typed[0], assignedUserId: manager.userId }] })).status, 400,
    "a Manager can't be assigned an action at a site their department can't see");
  assert.equal((await owner.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: [{ ...typed[0], module: 'compliance' }] })).status, 400,
    'only a track with an action list is accepted');
  assert.equal((await owner.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: [{ ...typed[0], siteId: 999999 }] })).status, 400);
  assert.equal((await other.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: typed })).status, 404);
  assert.equal((await viewer.request('PUT', `/inspection-reports/${homeReport}/draft`, { actions: typed })).status, 403);
  console.log('ok - without the AI key a person types the list, and it is checked against the business');

  // ── Department boundary on saving and confirming ─────────────────────────
  const centreAction = { title: 'Label the fridge', module: 'audit', severity: 'action_required', siteId: siteB.id, draftSource: 'manual' };
  {
    const label = "scoped manager cannot save report actions for another department's site";
    assert.equal((await manager.request('PUT', `/inspection-reports/${centreReport}/draft`, { actions: [{ ...centreAction, siteId: siteA.id }] })).status, 400, label);
    ok(await manager.request('PUT', `/inspection-reports/${centreReport}/draft`, { actions: [centreAction] }));
  }
  {
    const label = "scoped manager cannot confirm report actions for another department's site";
    assert.equal((await manager.request('POST', `/inspection-reports/${centreReport}/confirm`, { actions: [{ ...centreAction, siteId: siteA.id }] })).status, 400, label);
    const { actions } = ok(await manager.request('POST', `/inspection-reports/${centreReport}/confirm`, { actions: [centreAction] }), 201);
    assert.equal(actions[0].siteId, siteB.id);
  }
  console.log('ok - a Manager saves and confirms actions only for their own sites');

  // ── Confirming creates the actions ───────────────────────────────────────
  assert.equal((await owner.request('POST', `/inspection-reports/${homeReport}/confirm`, { actions: [] })).status, 400);
  const sentBefore = outbox().length;
  const { actions, emailedTo } = ok(await owner.request('POST', `/inspection-reports/${homeReport}/confirm`, { actions: typed }), 201);
  assert.equal(actions.length, 3);
  for (const action of actions) {
    assert.match(action.sourceKind, /^inspection_report:/);
    assert.equal(action.sourceRecordId, homeReport);
    assert.equal(action.status, 'open');
    assert.equal(action.confirmedByName, 'inspection-reports manager');
  }
  const [door, falls, staffing] = actions;
  assert.equal(door.draftSource, 'ai', 'AI-drafted actions say so');
  assert.equal(falls.draftSource, 'manual');
  assert.equal(door.ownerName, 'Sam Maintenance', 'the assigned person is recorded');
  assert.equal(door.assigneeUserId, maintenance.userId, 'as a person, so their reminders reach them');
  assert.equal(staffing.assigneeUserId, null);
  assert.equal(staffing.ownerName, null);
  assert.equal(door.severity, 'urgent');
  assert.equal(door.dueDate, isoDay(7));
  assert.match(door.instruction, /Report reference: Requirement 1/);
  const after = ok(await owner.request('GET', `/inspection-reports/${homeReport}`));
  assert.deepEqual(after.draftActions, [], 'the checked list is cleared once its actions exist');
  assert.equal(after.actions.length, 3);
  const listed = ok(await owner.request('GET', '/inspection-reports')).find((r) => r.id === homeReport);
  assert.equal(listed.actionCount, 3);
  assert.equal(listed.openCount, 3);
  assert.ok(ok(await owner.request('GET', '/track-actions?module=audit')).some((a) => a.id === door.id), 'the actions are on the Report actions list');
  console.log('ok - confirming creates open actions linked to the report, marked AI-drafted or typed, with who confirmed them');

  // ── The action plan email goes out the same day ──────────────────────────
  assert.deepEqual([...emailedTo].sort(), ['Morgan Manager', 'Sam Maintenance'],
    'Owners and Managers get the plan, not the person who confirmed it');
  const plans = outbox().slice(sentBefore).filter((email) => email.subject.startsWith('Action plan: Care Inspectorate inspection'));
  assert.equal(plans.length, 2, 'one email per person');
  const toSam = plans.find((email) => email.html.includes('Hi Sam Maintenance'));
  const toMorgan = plans.find((email) => email.html.includes('Hi Morgan Manager'));
  assert.ok(toSam && toMorgan);
  assert.match(toSam.subject, /3 actions, 1 to assign/);
  for (const action of [door, falls, staffing]) assert.ok(toSam.html.includes(action.title), 'Sam sees every action at the sites he covers');
  assert.ok(toSam.html.includes(`/report-actions?report=${homeReport}&amp;action=${staffing.id}`), 'each action links to its picker');
  assert.match(toSam.html, /Assign to…/);
  assert.match(toSam.html, /Assigned to <strong>Sam Maintenance<\/strong>/);
  assert.ok(toSam.html.indexOf(door.title) < toSam.html.indexOf(staffing.title), 'urgent actions come first');
  assert.ok(!toMorgan.html.includes(door.title) && toMorgan.html.includes(staffing.title),
    "a Manager is sent only the actions at sites they can see");
  assert.match(toSam.text, new RegExp(`Assign to someone: \\S+report=${homeReport}&action=${staffing.id}`));
  console.log('ok - the action plan is emailed the same day to Owners and Managers, with a link to assign each action');

  // ── Due dates on report actions ──────────────────────────────────────────
  assert.equal((await staff.request('PATCH', `/track-actions/${door.id}`, { dueDate: isoDay(30) })).status, 403,
    'Staff cannot move the due date of an action from a report');
  ok(await maintenance.request('PATCH', `/track-actions/${door.id}`, { dueDate: isoDay(14) }));
  ok(await owner.request('PATCH', `/track-actions/${door.id}`, { ownerName: 'Morgan Manager' }));
  const moves = ok(await owner.request('GET', `/inspection-reports/${homeReport}`)).actions.find((a) => a.id === door.id).dueDateChanges;
  assert.equal(moves.length, 1, 'only due date changes are listed');
  assert.deepEqual({ ...moves[0], changedAt: undefined }, { changedAt: undefined, changedByName: 'Sam Maintenance', from: isoDay(7), to: isoDay(14) },
    'who moved the due date, from and to, is kept');
  console.log('ok - Owners and Managers change a report action\'s due date, and every change is kept');

  // ── Report actions behave like other actions ─────────────────────────────
  const moved = ok(await owner.request('PATCH', `/track-actions/${falls.id}`, { siteId: siteB.id }));
  assert.equal(moved.siteId, siteB.id, "a report action's site can be corrected");
  const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const resolved = ok(await owner.request('PATCH', `/track-actions/${staffing.id}`, {
    status: 'resolved', remedialAction: 'Rota reviewed', evidenceReference: 'Rota v3', resolutionNotes: 'Agreed with the manager', resolverSignature: signature,
  }));
  assert.equal(resolved.status, 'resolved');
  assert.equal(ok(await owner.request('GET', '/inspection-reports')).find((r) => r.id === homeReport).openCount, 2);
  console.log('ok - report actions are corrected and signed off like any other action');

  // ── Removing a report ────────────────────────────────────────────────────
  assert.equal((await owner.request('DELETE', `/inspection-reports/${homeReport}`)).status, 409, 'a report with actions is kept as their evidence');
  assert.equal((await other.request('DELETE', `/inspection-reports/${wideReport}`)).status, 404);
  assert.equal((await staff.request('DELETE', `/inspection-reports/${wideReport}`)).status, 403);
  assert.equal((await owner.request('DELETE', `/inspection-reports/${wideReport}`)).status, 204, 'a report uploaded by mistake can be removed');
  assert.equal((await owner.request('GET', `/inspection-reports/${wideReport}`)).status, 404);
  console.log('ok - a report is removed only while no actions come from it');

  console.log('Inspection report checks passed.');
} finally {
  await pool.end();
}
