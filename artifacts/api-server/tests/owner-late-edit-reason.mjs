import assert from 'node:assert/strict';
import { createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Staff lose write access to a track record after its day and the next one.
// Owners (client admins and consultants) may still change it, delete it or
// backfill an older record, but only with a reason in X-Override-Reason; each
// accepted reason is written to audit_events.
const reasonHeader = reason => ({ 'X-Override-Reason': encodeURIComponent(reason) });

async function insertFireCheck(clientId, siteId, checkDate) {
  const { rows } = await pool.query(
    `INSERT INTO fire_safety_checks (client_id, site_id, check_type, check_date, result)
     VALUES ($1, $2, 'alarm', $3, 'pass') RETURNING id`,
    [clientId, siteId, checkDate],
  );
  return rows[0].id;
}

async function overrideEvents(clientId) {
  const { rows } = await pool.query(
    `SELECT client_id, actor_id, entity_type, entity_id, action, metadata
       FROM audit_events WHERE client_id = $1 AND action = 'late_edit_override' ORDER BY id`,
    [clientId],
  );
  return rows;
}

try {
  const owner = await createTenant('late-edit-owner');
  const staff = await createUser(owner, { role: 'client_staff' });
  const manager = await createUser(owner, { role: 'client_manager' });
  const site = await owner.request('POST', '/sites', { name: 'Late edit site', seedStarterChecks: false });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  const siteId = site.data.id;

  const oldDate = isoDay(-3);
  const oldId = await insertFireCheck(owner.clientId, siteId, oldDate);

  // Without a reason the owner is asked for one.
  const noReason = await owner.request('PUT', `/fire-safety/${oldId}`, { notes: 'Corrected' });
  assert.equal(noReason.status, 423, JSON.stringify(noReason.data));
  assert.equal(noReason.data.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal(noReason.data.error, 'This record is more than a day old. Add a reason to change it.');
  assert.match(noReason.data.cutoffDate, /^\d{4}-\d{2}-\d{2}$/);

  // Too short (after trimming) is the same as none.
  const tooShort = await owner.request('PUT', `/fire-safety/${oldId}`, { notes: 'Corrected' }, 'json', reasonHeader('  ok  '));
  assert.equal(tooShort.status, 423, JSON.stringify(tooShort.data));
  assert.equal(tooShort.data.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await overrideEvents(owner.clientId)).length, 0, 'refused attempts are not audited');

  // A valid reason lets the change through and is kept in the audit trail.
  const reason = 'Alarm test was logged against the wrong panel — corrected';
  const withReason = await owner.request('PUT', `/fire-safety/${oldId}`, { notes: 'Corrected' }, 'json', reasonHeader(reason));
  assert.equal(withReason.status, 200, JSON.stringify(withReason.data));
  assert.equal(withReason.data.notes, 'Corrected');
  let events = await overrideEvents(owner.clientId);
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].entity_type, 'track_record');
  assert.equal(events[0].entity_id, oldId);
  assert.equal(events[0].actor_id, owner.userId);
  assert.deepEqual(events[0].metadata, {
    method: 'PUT', path: `/fire-safety/${oldId}`, entryDate: oldDate, reason, role: 'client_admin',
  });

  // Moving a current record onto an older day needs a reason too.
  const todayId = await insertFireCheck(owner.clientId, siteId, isoDay());
  assert.equal((await owner.request('PUT', `/fire-safety/${todayId}`, { notes: 'Same day fix' })).status, 200,
    'owners need no reason for a current record');
  const backdated = await owner.request('PUT', `/fire-safety/${todayId}`, { checkDate: isoDay(-4) });
  assert.equal(backdated.status, 423, JSON.stringify(backdated.data));
  assert.equal(backdated.data.code, 'OVERRIDE_REASON_REQUIRED');

  // Backfilling a new record dated five days ago needs a reason.
  const backfill = { checkType: 'fire_drill', checkDate: isoDay(-5), result: 'pass', siteId, nightStaff: 'included' };
  const backfillRefused = await owner.request('POST', '/fire-safety', backfill);
  assert.equal(backfillRefused.status, 423, JSON.stringify(backfillRefused.data));
  assert.equal(backfillRefused.data.code, 'OVERRIDE_REASON_REQUIRED');
  const backfilled = await owner.request('POST', '/fire-safety', backfill, 'json', reasonHeader('Paper record from last week'));
  assert.equal(backfilled.status, 201, JSON.stringify(backfilled.data));
  events = await overrideEvents(owner.clientId);
  assert.equal(events.length, 2);
  assert.equal(events[1].entity_id, 0, 'a new record has no id yet');
  assert.equal(events[1].metadata.method, 'POST');
  assert.equal(events[1].metadata.entryDate, isoDay(-5));
  assert.equal(events[1].metadata.reason, 'Paper record from last week');

  // Deleting an older record needs a reason.
  const deleteId = await insertFireCheck(owner.clientId, siteId, oldDate);
  const deleteRefused = await owner.request('DELETE', `/fire-safety/${deleteId}`);
  assert.equal(deleteRefused.status, 423, JSON.stringify(deleteRefused.data));
  const deleted = await owner.request('DELETE', `/fire-safety/${deleteId}`, undefined, 'json', reasonHeader('Duplicate entry'));
  assert.equal(deleted.status, 204);
  events = await overrideEvents(owner.clientId);
  assert.equal(events.length, 3);
  assert.equal(events[2].entity_id, deleteId);
  assert.equal(events[2].metadata.method, 'DELETE');

  // Staff stay locked out, reason or not.
  const staffEdit = await staff.request('PUT', `/fire-safety/${oldId}`, { notes: 'Staff edit' }, 'json', reasonHeader('Please let me in'));
  assert.equal(staffEdit.status, 423, JSON.stringify(staffEdit.data));
  assert.equal(staffEdit.data.code, 'TRACK_RECORD_LOCKED');
  const staffBackfill = await staff.request('POST', '/fire-safety', backfill, 'json', reasonHeader('Please let me in'));
  assert.equal(staffBackfill.status, 423, JSON.stringify(staffBackfill.data));
  assert.equal(staffBackfill.data.code, 'TRACK_RECORD_LOCKED');
  // Only Owners and consultants change locked records: Managers are locked out too.
  const managerEdit = await manager.request('PUT', `/fire-safety/${oldId}`, { notes: 'Manager edit' }, 'json', reasonHeader('Please let me in'));
  assert.equal(managerEdit.status, 423, JSON.stringify(managerEdit.data));
  assert.equal(managerEdit.data.code, 'TRACK_RECORD_LOCKED');
  assert.equal((await overrideEvents(owner.clientId)).length, 3, 'staff and manager attempts are not audited as overrides');

  // Another business cannot use a reason to reach this record, and nothing is
  // written to either business's audit trail.
  const other = await createTenant('late-edit-other');
  const crossTenant = await other.request('PUT', `/fire-safety/${oldId}`, { notes: 'Not mine' }, 'json', reasonHeader('Trying another tenant'));
  assert.equal(crossTenant.status, 404, JSON.stringify(crossTenant.data));
  const crossDelete = await other.request('DELETE', `/fire-safety/${oldId}`, undefined, 'json', reasonHeader('Trying another tenant'));
  assert.equal(crossDelete.status, 404, JSON.stringify(crossDelete.data));
  const crossClientId = await other.request('PUT', `/fire-safety/${oldId}?clientId=${owner.clientId}`, { notes: 'Not mine' }, 'json', reasonHeader('Trying another tenant'));
  assert.ok([403, 404].includes(crossClientId.status), JSON.stringify(crossClientId));
  assert.equal((await overrideEvents(owner.clientId)).length, 3);
  assert.equal((await overrideEvents(other.clientId)).length, 0);
  const { rows: [stored] } = await pool.query('SELECT notes FROM fire_safety_checks WHERE id = $1', [oldId]);
  assert.equal(stored.notes, 'Corrected');

  console.log('Owner late-edit reason tests passed.');
} finally {
  await pool.end();
}
