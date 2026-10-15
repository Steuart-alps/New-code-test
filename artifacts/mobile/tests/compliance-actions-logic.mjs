import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import ts from 'typescript';

// Actions on the phone (components/compliance-actions-logic.ts) and the drawn
// signature PNG (components/drawn-signature-logic.ts). Shapes and rules mirror
// api-server routes/track-actions.ts and routes/compliance-hub.ts, and the
// website's module-actions-panel.tsx and pages/compliance-hub.tsx.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}
const L = await load('../components/compliance-actions-logic.ts');
const S = await load('../components/drawn-signature-logic.ts');
const M = await load('../components/manage-items.ts');
const TODAY = '2026-10-15';

// --- Manage hub entry: staff act on actions and viewers read them, as on the website.
{
  const entry = M.MANAGE_ITEMS.find((item) => item.id === 'actions');
  assert.equal(entry.route, '/manage/actions');
  for (const role of ['client_admin', 'consultant', 'client_staff', 'client_viewer']) {
    assert.ok(M.visibleManageItems(M.MANAGE_ITEMS, role, () => false).some((item) => item.id === 'actions'), role);
  }
}

const action = (id, overrides = {}) => ({
  id, module: 'fire', title: `Action ${id}`, severity: 'monitor', status: 'open', siteId: 7,
  ownerName: null, dueDate: null, sourceKind: null, fixTrackIssueId: null, fixTrackDisposition: null, ...overrides,
});
const hub = (id, overrides = {}) => ({
  id, sourceTrack: 'FireTrack', title: `Hub ${id}`, severity: 'medium', status: 'open', ownerName: 'Sam',
  dueDate: null, correctiveAction: 'Fix it', evidenceReference: null, verificationNotes: null, ...overrides,
});

// --- Parsing: tolerant of extra fields, wrapped lists and snake_case rows.
{
  const camel = L.moduleActionsFrom([action(1, { futureField: 'x' }), { id: 'bad' }, null]);
  assert.equal(camel.length, 1);
  assert.equal(camel[0].futureField, 'x');
  const snake = L.moduleActionsFrom({ actions: [{ id: 2, module: 'pest', title: 'S', severity: 'urgent', status: 'open', site_id: 9, due_date: '2026-10-01', fix_track_issue_id: 44, source_kind: null }] });
  assert.equal(snake[0].siteId, 9);
  assert.equal(snake[0].dueDate, '2026-10-01');
  assert.equal(snake[0].fixTrackIssueId, 44);
  const both = L.camelRow({ due_date: 'old', dueDate: 'new' });
  assert.equal(both.dueDate, 'new');
  const hubSnake = L.hubActionsFrom([{ id: 3, source_track: 'PestTrack', title: 'H', severity: 'low', status: 'open', owner_name: 'Ann', due_date: '2026-09-01', evidence_reference: 'photo', verification_notes: null }]);
  assert.equal(hubSnake[0].sourceTrack, 'PestTrack');
  assert.equal(hubSnake[0].ownerName, 'Ann');
  assert.equal(hubSnake[0].evidenceReference, 'photo');
  assert.deepEqual(L.hubActionsFrom(L.hubActionsFrom([hub(4)])).map((a) => a.sourceTrack), ['FireTrack']);
  assert.deepEqual(L.hubActionsFrom({ error: 'x' }), []);
  assert.deepEqual(L.sitesFrom({ sites: [{ id: 1, name: 'A' }, { id: 'x' }] }), [{ id: 1, name: 'A' }]);
}

// --- Filters: unresolved only, by module / site / overdue, most pressing first.
{
  const actions = [
    action(1, { dueDate: '2026-10-20' }),
    action(2, { dueDate: '2026-10-01', module: 'pest', siteId: 8 }),
    action(3, { status: 'resolved', dueDate: '2026-09-01' }),
    action(4, { severity: 'urgent' }),
    action(5, { dueDate: '2026-10-14T00:00:00.000Z', status: 'in_progress' }),
  ];
  assert.deepEqual(L.filterModuleActions(actions, L.DEFAULT_FILTERS, TODAY).map((a) => a.id), [2, 5, 1, 4]);
  assert.deepEqual(L.filterModuleActions(actions, { ...L.DEFAULT_FILTERS, overdueOnly: true }, TODAY).map((a) => a.id), [2, 5]);
  assert.deepEqual(L.filterModuleActions(actions, { ...L.DEFAULT_FILTERS, track: 'pest' }, TODAY).map((a) => a.id), [2]);
  assert.deepEqual(L.filterModuleActions(actions, { ...L.DEFAULT_FILTERS, site: '7' }, TODAY).map((a) => a.id), [5, 1, 4]);
  assert.deepEqual(L.moduleTrackOptions(actions), [{ value: 'fire', label: 'FireTrack' }, { value: 'pest', label: 'PestTrack' }]);
  assert.deepEqual(L.siteFilterOptions(actions, [{ id: 7, name: 'Main' }, { id: 8, name: 'Annex' }, { id: 9, name: 'Empty' }]).map((s) => s.value), ['7', '8']);
  assert.deepEqual(L.countModuleActions(actions, TODAY), { open: 4, overdue: 2 });
  const stale = { track: 'swim', site: '99', overdueOnly: true };
  assert.deepEqual(L.reconcileFilters(stale, [{ value: 'fire' }], [{ value: '7' }]), { track: 'all', site: 'all', overdueOnly: true });
  const kept = { track: 'fire', site: '7', overdueOnly: false };
  assert.equal(L.reconcileFilters(kept, [{ value: 'fire' }], [{ value: '7' }]), kept);

  const hubs = [hub(1, { status: 'verified' }), hub(2, { dueDate: '2026-10-02', sourceTrack: 'PestTrack' }), hub(3, { severity: 'critical' })];
  assert.deepEqual(L.filterHubActions(hubs, L.DEFAULT_FILTERS, TODAY).map((a) => a.id), [2, 3]);
  assert.deepEqual(L.filterHubActions(hubs, { ...L.DEFAULT_FILTERS, track: 'FireTrack' }, TODAY).map((a) => a.id), [3]);
  assert.deepEqual(L.hubTrackOptions(hubs).map((o) => o.value), ['FireTrack', 'PestTrack']);
  assert.deepEqual(L.countHubActions(hubs, TODAY), { open: 2, overdue: 1 });
  assert.equal(L.formatDay('2026-10-05'), '5 Oct 2026');
  assert.equal(L.moduleLabel('hot_tub'), 'TubTrack');
  assert.equal(L.moduleLabel('new_track'), 'new track');
}

// --- Module action roles: viewers read only; KitchenTrack is managers only.
{
  assert.equal(L.canMutateModuleAction('client_viewer', action(1)), false);
  assert.equal(L.canMutateModuleAction('client_staff', action(1)), true);
  assert.equal(L.canMutateModuleAction('client_staff', action(1, { module: 'kitchen' })), false);
  assert.equal(L.canMutateModuleAction('client_admin', action(1, { module: 'kitchen' })), true);
  assert.equal(L.canMutateModuleAction('consultant', action(1, { status: 'resolved' })), false);
  assert.equal(L.canMutateModuleAction(undefined, action(1)), false);
}

// --- FixTrack choice mirrors the website.
{
  assert.deepEqual(L.fixTrackChoice(action(1), true), { kind: 'ask', canDecline: true });
  assert.deepEqual(L.fixTrackChoice(action(1, { fixTrackDisposition: 'not_needed' }), true), { kind: 'ask', canDecline: false });
  assert.deepEqual(L.fixTrackChoice(action(1, { fixTrackIssueId: 12 }), false), { kind: 'linked', issueId: 12 });
  assert.deepEqual(L.fixTrackChoice(action(1), false), { kind: 'none' });
  assert.deepEqual(L.fixTrackChoice(action(1, { module: 'green' }), true), { kind: 'none' });
  assert.deepEqual(L.fixTrackChoice(action(1, { module: 'kitchen', sourceKind: 'kitchen_temperature_fridge' }), true), { kind: 'none' });
  assert.match(L.fixTrackQuestion({ kind: 'ask', canDecline: true }), /require FixTrack repair/);
  assert.equal(L.fixTrackQuestion({ kind: 'ask', canDecline: false }), 'Kept in this track. Add it to FixTrack now?');
  assert.match(L.fixTrackQuestion({ kind: 'linked', issueId: 12 }), /#12/);
  assert.match(L.resolutionBlocker(action(1, { fixTrackIssueId: 12 })), /FixTrack issue #12/);
  assert.equal(L.resolutionBlocker(action(1)), null);
}

// --- Details: only changed fields; locked fields never sent.
{
  const a = action(1, { title: 'Old', ownerName: 'Ann', dueDate: '2026-10-30' });
  assert.deepEqual(L.buildDetailsPatch(a, L.detailsFromAction(a)), { ok: false, message: 'Nothing has changed.' });
  assert.deepEqual(L.buildDetailsPatch(a, { ...L.detailsFromAction(a), ownerName: '  Bob ', dueDate: '' }), { ok: true, patch: { ownerName: 'Bob', dueDate: null } });
  assert.deepEqual(L.buildDetailsPatch(a, { ...L.detailsFromAction(a), siteId: '' }), { ok: true, patch: { siteId: null } });
  assert.equal(L.buildDetailsPatch(a, { ...L.detailsFromAction(a), title: ' ' }).ok, false);
  assert.equal(L.buildDetailsPatch(a, { ...L.detailsFromAction(a), dueDate: '2026-02-30' }).ok, false);
  const sourced = action(2, { sourceKind: 'fire_check', module: 'kitchen' });
  assert.deepEqual(L.buildDetailsPatch(sourced, { ...L.detailsFromAction(sourced), siteId: '9', ownerName: 'Cat' }), { ok: true, patch: { ownerName: 'Cat' } });
  const temp = action(3, { module: 'kitchen', sourceKind: 'kitchen_temperature_fridge' });
  assert.deepEqual(L.lockedDetails(temp), { site: true, titleAndSeverity: true });
  assert.deepEqual(L.buildDetailsPatch(temp, { ...L.detailsFromAction(temp), title: 'New', severity: 'urgent', dueDate: '2026-11-01' }), { ok: true, patch: { dueDate: '2026-11-01' } });
  assert.equal(L.provenanceLabel(action(1, { templateId: 4 })), 'Client template');
  assert.equal(L.provenanceLabel(temp), 'Product default');
  assert.equal(L.provenanceLabel(action(1)), 'One-off');
}

// --- Resolution: the website's three fields and a drawn signature.
{
  const values = { remedialAction: ' Replaced ', evidenceReference: 'Photo 1', resolutionNotes: 'Done' };
  assert.equal(L.resolutionReady({ ...values, resolutionNotes: ' ' }), false);
  assert.equal(L.buildResolutionPatch(values, null).ok, false);
  assert.equal(L.buildResolutionPatch({ ...values, evidenceReference: '' }, 'data:image/png;base64,AAAA').ok, false);
  assert.deepEqual(L.buildResolutionPatch(values, 'data:image/png;base64,AAAA'), {
    ok: true,
    patch: { status: 'resolved', remedialAction: 'Replaced', evidenceReference: 'Photo 1', resolutionNotes: 'Done', resolverSignature: 'data:image/png;base64,AAAA' },
  });
}

// --- Corrective actions: anyone but a viewer updates; managers verify from awaiting verification.
{
  assert.equal(L.canEditHubAction('client_staff', hub(1)), true);
  assert.equal(L.canEditHubAction('client_viewer', hub(1)), false);
  assert.equal(L.canEditHubAction('client_admin', hub(1, { status: 'verified' })), false);
  const values = (role, status) => L.hubStatusOptions(role, status).map((o) => o.value);
  assert.deepEqual(values('client_admin', 'open'), ['open', 'in_progress', 'awaiting_verification']);
  assert.deepEqual(values('client_admin', 'awaiting_verification'), ['open', 'in_progress', 'awaiting_verification', 'verified']);
  assert.deepEqual(values('consultant', 'awaiting_verification').includes('verified'), true);
  assert.deepEqual(values('client_staff', 'awaiting_verification'), ['open', 'in_progress', 'awaiting_verification']);
  assert.equal(L.hubStatusLabel('awaiting_verification'), 'Awaiting verification');
  assert.deepEqual(L.hubUpdateFrom(hub(1, { evidenceReference: 'Cert' })), { status: 'open', evidenceReference: 'Cert', verificationNotes: '' });
  assert.deepEqual(L.buildHubPatch({ status: 'verified', evidenceReference: 'Cert', verificationNotes: ' ' }).ok, false);
  assert.deepEqual(L.buildHubPatch({ status: 'verified', evidenceReference: ' Cert ', verificationNotes: 'Checked' }), { ok: true, patch: { status: 'verified', evidenceReference: 'Cert', verificationNotes: 'Checked' } });
  assert.deepEqual(L.buildHubPatch({ status: 'in_progress', evidenceReference: '', verificationNotes: '' }), { ok: true, patch: { status: 'in_progress', evidenceReference: '', verificationNotes: '' } });
  assert.equal(L.buildHubPatch({ status: 'closed', evidenceReference: '', verificationNotes: '' }).ok, false);
}

// --- Drawn signature: a valid PNG the API accepts, with the strokes inked.
{
  assert.equal(S.hasSignatureInk([]), false);
  assert.equal(S.hasSignatureInk([[{ x: 5, y: 5 }, { x: 5, y: 5 }]]), false);
  assert.equal(S.signatureDataUrl([[{ x: 1, y: 1 }]], 300, 100), null);
  const strokes = [[{ x: 10, y: 50 }, { x: 290, y: 50 }], [{ x: 150, y: 10 }, { x: 150, y: 90 }]];
  const url = S.signatureDataUrl(strokes, 300, 100);
  assert.match(url, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(url.length < S.SIGNATURE_MAX_LENGTH && url.length < 60_000, `signature is ${url.length} chars`);
  const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Walk the chunks, checking each CRC with zlib's crc32 when available.
  const chunks = {};
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.subarray(o + 4, o + 8).toString('ascii');
    chunks[type] = png.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  assert.deepEqual(Object.keys(chunks), ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  assert.equal(chunks.IHDR.readUInt32BE(0), S.SIGNATURE_WIDTH);
  assert.equal(chunks.IHDR.readUInt32BE(4), S.SIGNATURE_HEIGHT);
  const raw = inflateSync(chunks.IDAT); // checks the deflate stream and Adler-32
  const rowBytes = Math.ceil(S.SIGNATURE_WIDTH / 8) + 1;
  assert.equal(raw.length, rowBytes * S.SIGNATURE_HEIGHT);
  const pixel = (x, y) => (raw[y * rowBytes + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
  assert.equal(pixel(360, 120), 1, 'centre of the cross is inked');
  assert.equal(pixel(100, 120), 1, 'horizontal stroke is inked');
  assert.equal(pixel(360, 40), 1, 'vertical stroke is inked');
  assert.equal(pixel(100, 30), 0, 'background is clear');
  assert.equal(S.toBase64(new Uint8Array([102, 111, 111, 98])), Buffer.from('foob').toString('base64'));
  assert.equal(S.toBase64(new Uint8Array([102, 111])), Buffer.from('fo').toString('base64'));
}

console.log('compliance actions logic: ok');
