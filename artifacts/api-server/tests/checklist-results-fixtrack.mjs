import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Daily checklists answer each item Pass, Fail or N/A; a submit needs every
// item answered and a note on each fail. Failed items, premises findings and
// pest sightings become actions; the user chooses whether each goes to
// FixTrack (not GreenTrack), and finishing the job completes the action.
try {
  const owner = await createTenant('checklist-results');
  const staff = await createUser(owner, { role: 'client_staff' });
  const site = (await owner.request('POST', '/sites', { name: 'Results site', seedStarterChecks: false })).data;
  const date = isoDay();
  const items = [
    { label: 'Fire exits clear', checked: false, result: 'pass' },
    { label: 'Hand basin stocked', checked: false },
    { label: 'Outdoor lighting', checked: false, result: 'na' },
  ];
  const body = { checklistType: 'premises_opening', checkDate: date, siteId: site.id, items };

  // Unanswered item: a draft saves, a submit is refused.
  const draft = await staff.request('POST', '/daily-track-am', body);
  assert.equal(draft.status, 201, JSON.stringify(draft));
  const early = await staff.request('PUT', `/daily-track-am/${draft.data.id}`, { submittedAt: new Date().toISOString() });
  assert.equal(early.status, 400);
  assert.equal(early.data.code, 'CHECKLIST_INCOMPLETE');

  // A fail without a note is refused too.
  const noNote = items.map((item, i) => i === 1 ? { ...item, result: 'fail' } : item);
  const refused = await staff.request('POST', '/daily-track-am', { ...body, items: noNote, submittedAt: new Date().toISOString() });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /failed item/);

  // Complete with one fail: submitted, the fail is stored as not checked.
  const answered = items.map((item, i) => i === 1 ? { ...item, result: 'fail', notes: 'No soap' } : item);
  const submitted = await staff.request('PUT', `/daily-track-am/${draft.data.id}`, { items: answered, submittedAt: new Date().toISOString() });
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  assert.deepEqual(submitted.data.items.map(item => [item.result, item.checked]), [['pass', true], ['fail', false], ['na', true]]);

  const actions = (await owner.request('GET', `/track-actions?module=daily_am&siteId=${site.id}`)).data;
  assert.equal(actions.length, 1, JSON.stringify(actions));
  const action = actions[0];
  assert.equal(action.sourceKind, 'daily_checklist_item:1');
  assert.match(action.instruction, /No soap/);
  assert.equal(action.fixTrackIssueId, null, 'FixTrack is the user\'s choice');

  // The user sends it to FixTrack; finishing the job completes the action.
  const sent = await staff.request('POST', `/track-actions/${action.id}/fix-track`, { create: true });
  assert.equal(sent.status, 201, JSON.stringify(sent));
  assert.equal(sent.data.fixTrackDisposition, 'linked');
  const issue = (await owner.request('GET', `/fix-track/issues/${sent.data.fixTrackIssueId}`)).data;
  assert.equal(issue.title, action.title);
  assert.equal(issue.priority, 'high');
  assert.equal(issue.siteId, site.id);
  assert.equal((await owner.request('PUT', `/fix-track/issues/${issue.id}`, { status: 'in_progress' })).status, 200);
  const done = await owner.request('PUT', `/fix-track/issues/${issue.id}`, { status: 'resolved', solutionNotes: 'Soap refilled', resolverSignature: 'data:image/png;base64,AAAA' });
  assert.equal(done.status, 200, JSON.stringify(done));
  const after = (await owner.request('GET', `/track-actions?module=daily_am&siteId=${site.id}`)).data.find(row => row.id === action.id);
  assert.equal(after.status, 'resolved');

  // Phone checklists follow the same rule.
  const mobilePath = `/daily-checklists/${site.id}/${date}/pm`;
  const mobileIncomplete = await staff.request('POST', mobilePath, { answers: [{ question: 'Doors locked', checked: false }], clientEntryId: randomUUID().replaceAll('-', '') });
  assert.equal(mobileIncomplete.status, 400);
  assert.equal(mobileIncomplete.data.code, 'CHECKLIST_INCOMPLETE');
  const mobile = await staff.request('POST', mobilePath, {
    answers: [{ question: 'Doors locked', checked: true, result: 'pass' }, { question: 'Alarm set', checked: false, result: 'fail', notes: 'Panel fault' }],
    clientEntryId: randomUUID().replaceAll('-', ''),
  });
  assert.equal(mobile.status, 201, JSON.stringify(mobile));
  const pmActions = (await owner.request('GET', `/track-actions?module=daily_pm&siteId=${site.id}`)).data;
  assert.equal(pmActions.length, 1);
  assert.equal(pmActions[0].fixTrackIssueId, null);
  // Kept in its track: resolved there directly.
  const signedOff = await owner.request('PATCH', `/track-actions/${pmActions[0].id}`, {
    status: 'resolved', remedialAction: 'Alarm engineer reset the panel', evidenceReference: 'Engineer report', resolutionNotes: 'Alarm sets correctly', resolverSignature: 'data:image/png;base64,AAAA',
  });
  assert.equal(signedOff.status, 200, JSON.stringify(signedOff));

  // GreenTrack actions cannot be sent to FixTrack.
  const { rows: [green] } = await pool.query(`
    INSERT INTO track_actions (client_id, site_id, module, title, severity, status, provenance)
    VALUES ($1, $2, 'green', 'Green follow-up', 'monitor', 'open', 'one_off') RETURNING id`, [owner.clientId, site.id]);
  assert.equal((await owner.request('POST', `/track-actions/${green.id}/fix-track`, { create: true })).status, 400);

  // A premises inspection that needs action, and a pest sighting, raise actions.
  const inspection = await staff.request('POST', '/premises-track', {
    inspectionDate: date, area: 'Rear yard', actionRequired: 'Repair the loose paving slab', hazardDetails: 'Trip hazard', siteId: site.id,
  });
  assert.equal(inspection.status, 201, JSON.stringify(inspection));
  const clean = await staff.request('POST', '/premises-track', { inspectionDate: date, area: 'Reception', siteId: site.id });
  assert.equal(clean.status, 201, JSON.stringify(clean));
  const premisesActions = (await owner.request('GET', `/track-actions?module=premises&siteId=${site.id}`)).data;
  assert.equal(premisesActions.length, 1, JSON.stringify(premisesActions));
  assert.match(premisesActions[0].title, /Rear yard/);
  assert.match(premisesActions[0].instruction, /loose paving slab/);
  const sighting = await staff.request('POST', '/pest-track/activity', {
    recordedDate: date, pestType: 'rodent', evidenceType: 'droppings', location: 'Dry store', severity: 'high', siteId: site.id,
  });
  assert.equal(sighting.status, 201, JSON.stringify(sighting));
  const pestActions = (await owner.request('GET', `/track-actions?module=pest&siteId=${site.id}`)).data;
  assert.equal(pestActions.length, 1, JSON.stringify(pestActions));
  assert.equal(pestActions[0].severity, 'urgent');

  // Compliance Hub actions are sent to FixTrack on request.
  const hub = await owner.request('POST', '/compliance-hub/actions', {
    sourceTrack: 'FireTrack', title: 'Replace fire door closer', severity: 'critical', ownerName: 'Site manager', correctiveAction: 'Fit a new closer',
  });
  assert.equal(hub.status, 201, JSON.stringify(hub));
  assert.equal(hub.data.fixTrackIssueId ?? null, null);
  const hubSent = await owner.request('POST', `/compliance-hub/actions/${hub.data.id}/fix-track`, {});
  assert.equal(hubSent.status, 201, JSON.stringify(hubSent));
  const hubIssue = (await owner.request('GET', `/fix-track/issues/${hubSent.data.fixTrackIssueId}`)).data;
  assert.equal(hubIssue.priority, 'urgent');
  assert.equal((await owner.request('POST', `/compliance-hub/actions/${hub.data.id}/fix-track`, {})).data.fixTrackIssueId, hubSent.data.fixTrackIssueId);
  const listed = (await owner.request('GET', '/compliance-hub/actions')).data.find(row => row.id === hub.data.id);
  assert.equal(listed.fixTrackIssueId, hubSent.data.fixTrackIssueId);

  console.log('Checklist results and FixTrack jobs passed.');
} finally {
  await pool.end();
}
