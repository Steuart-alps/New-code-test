import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// "Hand the phone to staff to sign" (components/staff-sign-off-logic.ts and
// app/manage/staff-sign-off.tsx): the same API and wording as the website's
// staff sign-off page, a typed-name signature body the API accepts, rows read
// in snake or camel case, managers only, internet-only (nothing queued), and
// a kiosk that keeps back gestures inside the flow until the manager returns.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../components/staff-sign-off-logic.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const logic = await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`);
const {
  ALL_STAFF, signOffPaths, buildAcknowledgeBody, canSignWithTypedName, signOffProgress, toSignOffDoc,
  toSignOffStaff, categoryLabel, isMissingSignOffLink, canHandPhoneToStaff, hasSignOffService, kioskStep,
  signedDateLabel,
} = logic;

// Paths match api-server routes/sign-off.ts (mounted at /api/sign-off).
const paths = signOffPaths('tok/en');
assert.equal(paths.info, '/api/sign-off/tok%2Fen/info');
assert.equal(paths.departments, '/api/sign-off/tok%2Fen/departments');
assert.equal(paths.staff('Front & back'), '/api/sign-off/tok%2Fen/staff?department=Front%20%26%20back');
assert.equal(paths.staff(ALL_STAFF), '/api/sign-off/tok%2Fen/staff');
assert.equal(paths.documents(7), '/api/sign-off/tok%2Fen/documents?staffId=7');
assert.equal(paths.download({ id: 3, documentType: 'sop' }, 7), '/api/sign-off/tok%2Fen/documents/3/download?documentType=sop&staffId=7');
assert.equal(paths.acknowledge, '/api/sign-off/tok%2Fen/acknowledge');
const route = await readFile(new URL('../../api-server/src/routes/sign-off.ts', import.meta.url), 'utf8');
for (const path of ['/:token/info', '/:token/departments', '/:token/staff', '/:token/documents', '/:token/documents/:docId/download', '/:token/acknowledge']) {
  assert.ok(route.includes(`"${path}"`), `${path} exists on the API`);
}
const docTrack = await readFile(new URL('../../api-server/src/routes/doc-track.ts', import.meta.url), 'utf8');
assert.ok(docTrack.includes('router.get("/sign-off-info", requireAuth, requireClientAdmin'), 'link token is for client admins and consultants');

// Typed-name signature, as the website's "Type name" tab sends it.
assert.equal(canSignWithTypedName(' A '), false);
assert.equal(canSignWithTypedName('Al'), true);
assert.deepEqual(buildAcknowledgeBody({ id: 3, documentType: 'ra' }, 7, '  Ann Smith '), {
  ok: true,
  body: { documentId: 3, documentType: 'ra', staffRosterId: 7, signature: null, typedName: 'Ann Smith' },
});
assert.equal(buildAcknowledgeBody({ id: 3, documentType: 'doc' }, 7, 'A').ok, false);
assert.ok(route.includes('typedName: z.string().max(300)'), 'API accepts a typed name');

// Progress wording (website: "N document(s) need(s) your signature").
assert.equal(signOffProgress([{ signed: false }]).message, '1 document needs your signature');
assert.equal(signOffProgress([{ signed: false }, { signed: false }, { signed: true }]).message, '2 documents need your signature');
assert.deepEqual(signOffProgress([{ signed: true }]), { signed: 1, total: 1, unsigned: 0, allSigned: true, message: null });
assert.equal(signOffProgress([]).allSigned, false, 'no documents is not "All signed!"');

// Rows in either case (PR #95 moves some responses to camelCase).
const snakeDoc = {
  document_type: 'handbook', id: 4, title: 'Handbook', category: 'handbook', description: 'Read it', file_name: 'h.pdf',
  mime_type: 'application/pdf', has_file: true, department: null, signed: true, acknowledged_at: '2026-10-05T09:00:00Z',
};
const camelDoc = {
  documentType: 'handbook', id: 4, title: 'Handbook', category: 'handbook', description: 'Read it', fileName: 'h.pdf',
  mimeType: 'application/pdf', hasFile: true, department: null, signed: true, acknowledgedAt: '2026-10-05T09:00:00Z',
};
assert.deepEqual(toSignOffDoc(snakeDoc), toSignOffDoc(camelDoc));
assert.equal(toSignOffDoc({ ...snakeDoc, document_type: 'bogus' }).documentType, 'doc');
assert.deepEqual(toSignOffStaff({ id: 2, name: 'Bob', job_title: 'Chef', department: 'Kitchen' }),
  toSignOffStaff({ id: 2, name: 'Bob', jobTitle: 'Chef', department: 'Kitchen' }));
assert.equal(signedDateLabel('2026-10-05T09:00:00Z'), 'Signed 05 Oct 2026');
assert.equal(signedDateLabel(null), null);
assert.equal(categoryLabel('risk_assessment'), 'Risk Assessment');
assert.equal(categoryLabel('other'), 'Document');
assert.equal(categoryLabel(null), 'Document');

// Access and steps.
assert.equal(isMissingSignOffLink({ status: 404 }), true);
assert.equal(isMissingSignOffLink(new TypeError('Network request failed')), false);
assert.equal(canHandPhoneToStaff('client_admin'), true);
assert.equal(canHandPhoneToStaff('consultant'), true);
assert.equal(canHandPhoneToStaff('client_staff'), false);
assert.equal(canHandPhoneToStaff('client_viewer'), false);
assert.equal(hasSignOffService((key) => key === 'safetrack'), true);
assert.equal(hasSignOffService(() => false), false);
assert.equal(kioskStep({ department: null, staffId: null, signing: false }), 'department');
assert.equal(kioskStep({ department: 'Bar', staffId: null, signing: false }), 'staff');
assert.equal(kioskStep({ department: 'Bar', staffId: 2, signing: false }), 'documents');
assert.equal(kioskStep({ department: 'Bar', staffId: 2, signing: true }), 'sign');

// Screen: managers only, online-only, kiosk exit, no caching of staff data.
const screen = await readFile(new URL('../app/manage/staff-sign-off.tsx', import.meta.url), 'utf8');
assert.ok(!/useOutboxAction|useRecordOutbox|checkOutbox/.test(screen), 'signing is never queued offline');
assert.ok(screen.includes("'/api/doc-track/sign-off-info'"));
assert.ok(screen.includes("addListener('beforeRemove'") && screen.includes('gestureEnabled: !kioskToken'), 'back stays inside the kiosk');
assert.ok(screen.includes('Return to manager') && screen.includes('Alert.alert('), 'exit is explicit and confirmed');
assert.ok(screen.includes('qc.removeQueries({ queryKey: [KIOSK_KEY] })'), 'staff data is dropped on exit');
assert.ok(!/AsyncStorage|SecureStore/.test(screen), 'the link token is never stored on the phone');
for (const wording of ['Select your department', 'Who are you?', 'Your documents', 'All signed!', 'Confirm & Sign',
  'Open & read document before signing', 'Not in the list? Ask your manager to add you to the staff roster.']) {
  assert.ok(screen.includes(wording), `website wording: ${wording}`);
}
const items = await readFile(new URL('../components/manage-items.ts', import.meta.url), 'utf8');
assert.ok(/route: '\/manage\/staff-sign-off',\n\s+audience: 'managers'/.test(items));
const layout = await readFile(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
assert.ok(/name="manage\/staff-sign-off"\n\s+options=\{\{\n[^}]*headerShown: false/.test(layout));

console.log('staff sign-off logic: ok');
