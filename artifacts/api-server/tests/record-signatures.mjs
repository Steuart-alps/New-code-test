import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { base, createTenant, createUser, isoDay, pool } from './approval-workflow-fixtures.mjs';

// Every recorded check saved from the web app is signed by the logged-in
// user with a drawn signature. An unsigned save gets 428 SIGNATURE_REQUIRED;
// the drawing is stored under a one-use token (POST /record-signatures) and
// the save is sent again with it in X-Record-Signature. The token belongs to
// one user and business, is used once, survives a failed save, and the
// signature is listed with the record. Drafts are signed when submitted.
// Phone-app (bearer) saves are not asked yet.
// Usage: pnpm --filter @workspace/api-server run test:record-signatures

const today = isoDay();
const SIGNATURE = [[10, 50, 60, 80, 120, 40, 180, 90], [200, 60, 260, 120]];
const signed = token => ({ 'x-record-signature': token });

async function sign(session, strokes = SIGNATURE) {
  const created = await session.request('POST', '/record-signatures', { strokes });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(typeof created.data.token, 'string');
  return created.data.token;
}

try {
  const owner = await createTenant('record-signatures');
  const other = await createTenant('record-signatures-other');
  const staff = await createUser(owner, { role: 'client_staff' });
  const viewer = await createUser(owner, { role: 'client_viewer' });
  const site = (await owner.request('POST', '/sites', { name: 'Signed site', seedStarterChecks: false })).data;
  const ownerName = (await owner.request('GET', '/auth/me')).data;

  // ── An unsigned check is refused with who is asked to sign ─────────────
  const check = { checkType: 'fire_doors', checkDate: today, result: 'pass', siteId: site.id, notes: 'All lights on' };
  const unsigned = await owner.request('POST', '/fire-safety', check);
  assert.equal(unsigned.status, 428, JSON.stringify(unsigned.data));
  assert.equal(unsigned.data.code, 'SIGNATURE_REQUIRED');
  assert.equal(unsigned.data.error, 'Sign to save this record.');
  assert.equal(unsigned.data.signedBy, (ownerName.user ?? ownerName).name);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fire_safety_checks WHERE client_id = $1', [owner.clientId])).rows[0].n, 0,
    'nothing is saved without a signature');
  console.log('ok - an unsigned check is refused with 428 SIGNATURE_REQUIRED and nothing is saved');

  // ── Drawings that are not signatures are refused ───────────────────────
  for (const strokes of [[], [[5, 5]], [[5, 5, 6, 6]], [[0, 0, 700, 10]], [[1.5, 2, 30, 40]], 'scribble', [[1, 2, 3]]]) {
    const refused = await owner.request('POST', '/record-signatures', { strokes });
    assert.equal(refused.status, 400, JSON.stringify(strokes));
  }
  assert.equal((await viewer.request('POST', '/record-signatures', { strokes: SIGNATURE })).status, 403, 'Viewers cannot sign');
  console.log('ok - empty, tiny, out-of-box and malformed drawings are refused; Viewers cannot sign');

  // ── A signed save is kept with its signature ───────────────────────────
  const token = await sign(owner);
  const saved = await owner.request('POST', '/fire-safety', check, 'json', signed(token));
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const listed = await owner.request('GET', `/record-signatures?recordType=fire_safety_check&ids=${saved.data.id}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].recordId, saved.data.id);
  assert.equal(listed.data[0].signerName, (ownerName.user ?? ownerName).name);
  assert.deepEqual(listed.data[0].strokes, SIGNATURE);
  const row = (await pool.query('SELECT user_id, site_id, signed_at FROM record_signatures WHERE token = $1', [token])).rows[0];
  assert.equal(row.user_id, owner.userId);
  assert.equal(row.site_id, site.id, "the record's site is kept for department scoping");
  assert.ok(row.signed_at instanceof Date);
  console.log('ok - a signed check is saved and its signature is listed with the signer, time and drawing');

  // ── A token is used once, and only by its own user and business ────────
  const reused = await owner.request('POST', '/fire-safety', check, 'json', signed(token));
  assert.equal(reused.status, 428);
  assert.equal(reused.data.error, 'Your signature has expired. Please sign again.');
  const staffToken = await sign(staff);
  assert.equal((await owner.request('POST', '/fire-safety', check, 'json', signed(staffToken))).status, 428,
    "another user's signature cannot sign this save");
  assert.equal((await other.request('POST', '/fire-safety', check, 'json', signed(staffToken))).status, 428,
    "another business's user cannot use it either");
  assert.equal((await owner.request('POST', '/fire-safety', check, 'json', signed(`${randomUUID()}`))).status, 428);
  console.log('ok - a signature token is used once, by its own user in its own business');

  // ── A failed save gives the signature back for the next try ────────────
  const retryToken = await sign(staff);
  const invalid = await staff.request('POST', '/fire-safety', { ...check, result: 'maybe' }, 'json', signed(retryToken));
  assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
  const fixed = await staff.request('POST', '/fire-safety', check, 'json', signed(retryToken));
  assert.equal(fixed.status, 201, JSON.stringify(fixed.data));
  const fixedSignature = await staff.request('GET', `/record-signatures?recordType=fire_safety_check&ids=${fixed.data.id}`);
  assert.equal(fixedSignature.data.length, 1);
  assert.equal(fixedSignature.data[0].signerName, 'Approval fixture user');
  console.log('ok - a save that fails keeps the signature for the corrected save');

  // ── Signatures stay in their business; Viewers see only their training ─
  const otherList = await other.request('GET', `/record-signatures?recordType=fire_safety_check&ids=${saved.data.id},${fixed.data.id}`);
  assert.deepEqual(otherList.data, [], "another business sees no signatures for this business's records");
  assert.equal((await viewer.request('GET', `/record-signatures?recordType=fire_safety_check&ids=${saved.data.id}`)).status, 403,
    'Viewers only see their own training');
  assert.equal((await owner.request('GET', '/record-signatures?recordType=users&ids=1')).status, 400, 'only signed record types');
  assert.equal((await owner.request('GET', '/record-signatures?recordType=fire_safety_check&ids=1;2')).status, 400);
  console.log('ok - signatures are listed only inside their business, and only for signed record types');

  // ── Drafts are signed when they are submitted ──────────────────────────
  const items = [{ label: 'Fire exits clear', checked: true, result: 'pass' }];
  const draftBody = { checklistType: 'premises_opening', checkDate: today, siteId: site.id, items };
  const draft = await staff.request('POST', '/daily-track-am', draftBody);
  assert.equal(draft.status, 201, `a draft saves without a signature: ${JSON.stringify(draft.data)}`);
  const submit = { submittedAt: new Date().toISOString() };
  assert.equal((await staff.request('PUT', `/daily-track-am/${draft.data.id}`, submit)).status, 428, 'submitting needs a signature');
  const submitToken = await sign(staff);
  const submitted = await staff.request('PUT', `/daily-track-am/${draft.data.id}`, submit, 'json', signed(submitToken));
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal((await staff.request('GET', `/record-signatures?recordType=daily_checklist&ids=${draft.data.id}`)).data.length, 1);
  console.log('ok - a draft checklist saves unsigned and is signed when submitted');

  // ── Completing a compliance check is signed; other status changes are not ──
  const item = await owner.request('POST', '/compliance-items', {
    title: 'Gas safety', priority: 'high', siteId: site.id, frequencyMonths: 12, dueDate: `${isoDay(5)}T00:00:00.000Z`,
  });
  assert.equal(item.status, 201, JSON.stringify(item.data));
  assert.equal((await owner.request('PATCH', `/compliance-items/${item.data.id}/status`, { status: 'in_progress' })).status, 200);
  const completion = { status: 'completed', completedAt: today };
  assert.equal((await owner.request('PATCH', `/compliance-items/${item.data.id}/status`, completion)).status, 428);
  const completeToken = await sign(owner);
  assert.equal((await owner.request('PATCH', `/compliance-items/${item.data.id}/status`, completion, 'json', signed(completeToken))).status, 200);
  assert.equal((await owner.request('GET', `/record-signatures?recordType=compliance_item_completion&ids=${item.data.id}`)).data.length, 1);
  console.log('ok - marking a compliance check complete is signed; other status changes are not asked');

  // ── The phone app (bearer) is not asked yet ────────────────────────────
  const staffEmail = (await pool.query('SELECT email FROM users WHERE id = $1', [staff.userId])).rows[0].email;
  const mobile = await fetch(`${base}/auth/mobile-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: staffEmail, password: 'private-approval-fixture-123' }),
  }).then(r => r.json());
  assert.equal(typeof mobile.token, 'string', JSON.stringify(mobile));
  const phoneSave = await fetch(`${base}/fire-safety`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mobile.token}` },
    body: JSON.stringify(check),
  });
  assert.equal(phoneSave.status, 201, await phoneSave.text());
  console.log('ok - phone-app saves are not asked for a signature yet');

  // ── Every signed save is linked to its record ──────────────────────────
  const exported = (await pool.query(
    `SELECT count(*)::int AS n FROM record_signatures WHERE client_id = $1 AND record_id IS NOT NULL`, [owner.clientId])).rows[0].n;
  assert.equal(exported, 4);
  console.log('ok - four signatures are linked to records for this business');
} finally {
  await pool.end();
}
