import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Daily checklists answer each item Pass, Fail or N/A; a submit needs every
// item answered and a note on each fail. Failed items become actions, and
// every action outside GreenTrack raises a FixTrack job that completes it.
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
  assert.ok(action.fixTrackIssueId, 'the failed item raised a FixTrack job');
  assert.equal(action.fixTrackDisposition, 'parallel');

  const issue = (await owner.request('GET', `/fix-track/issues/${action.fixTrackIssueId}`)).data;
  assert.equal(issue.title, action.title);
  assert.equal(issue.priority, 'high');
  assert.equal(issue.siteId, site.id);

  // Finishing the job completes an action whose track needs no evidence.
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
  assert.ok(pmActions[0].fixTrackIssueId);

  // Signing the action off in its track also resolves its FixTrack job.
  const signedOff = await owner.request('PATCH', `/track-actions/${pmActions[0].id}`, {
    status: 'resolved', remedialAction: 'Alarm engineer reset the panel', evidenceReference: 'Engineer report', resolutionNotes: 'Alarm sets correctly', resolverSignature: 'data:image/png;base64,AAAA',
  });
  assert.equal(signedOff.status, 200, JSON.stringify(signedOff));
  const pmIssue = (await owner.request('GET', `/fix-track/issues/${pmActions[0].fixTrackIssueId}`)).data;
  assert.equal(pmIssue.status, 'resolved');
  assert.ok(pmIssue.resolvedByName);

  // GreenTrack actions stay in GreenTrack; other tracks raise a job.
  const { rows: inserted } = await pool.query(`
    INSERT INTO track_actions (client_id, site_id, module, title, severity, status, provenance)
    VALUES ($1, $2, 'green', 'Green follow-up', 'monitor', 'open', 'one_off'),
           ($1, $2, 'fire', 'Fire follow-up', 'urgent', 'open', 'one_off')
    RETURNING id, module, fix_track_issue_id`, [owner.clientId, site.id]);
  const { rows: linked } = await pool.query(
    `SELECT a.module, a.fix_track_issue_id, i.priority FROM track_actions a LEFT JOIN fix_track_issues i ON i.id = a.fix_track_issue_id WHERE a.id = ANY($1) ORDER BY a.module`,
    [inserted.map(row => row.id)]);
  assert.deepEqual(linked.map(row => [row.module, row.fix_track_issue_id !== null, row.priority]), [['fire', true, 'urgent'], ['green', false, null]]);

  // Compliance Hub actions raise a job as well.
  const hub = await owner.request('POST', '/compliance-hub/actions', {
    sourceTrack: 'FireTrack', title: 'Replace fire door closer', severity: 'critical', ownerName: 'Site manager', correctiveAction: 'Fit a new closer',
  });
  assert.equal(hub.status, 201, JSON.stringify(hub));
  assert.ok(hub.data.fixTrackIssueId);
  const hubIssue = (await owner.request('GET', `/fix-track/issues/${hub.data.fixTrackIssueId}`)).data;
  assert.equal(hubIssue.priority, 'urgent');

  console.log('Checklist results and FixTrack jobs passed.');
} finally {
  await pool.end();
}
