import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/staged-photo-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  STAGED_RECEIPT_TTL_MS,
  classifyStagedCreateError,
  evidenceReady,
  isSafeUploadUrl,
  parsePhotoRequirements,
  requirementFor,
  splitExpiredPhotos,
  stagedCreateErrorMessage,
  stagedPhotoScope,
  stageRequiredPhoto,
  validatePhotoAsset,
  withPhotoUploadIds,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const RECEIPT = '3f2a8c1e-6b4d-4e8f-9a1b-2c3d4e5f6a7b';

// Requirements: same validation as the web hook.
const rules = parsePhotoRequirements([
  { entity_type: 'green_pre_use_check', required: true, min_photos: 2 },
  { entity_type: 'swim_session', required: false, min_photos: 1 },
]);
assert.deepEqual(requirementFor(rules, 'green_pre_use_check'), { required: true, minimum: 2 });
assert.deepEqual(requirementFor(rules, 'swim_session'), { required: false, minimum: 0 });
assert.deepEqual(requirementFor(rules, 'green_defect'), { required: false, minimum: 0 });
assert.throws(() => parsePhotoRequirements({}), /Invalid photo requirements/);
assert.throws(() => parsePhotoRequirements([{ entity_type: 'x', required: true, min_photos: 0 }]), /Invalid photo requirement/);
assert.throws(() => parsePhotoRequirements([{ entity_type: 'x', required: 'yes', min_photos: 1 }]), /Invalid photo requirement/);

// Scope: actor and client aware, so receipts never cross accounts.
assert.equal(stagedPhotoScope(7, 3, 'swim_session'), '7:3:swim_session');
assert.notEqual(stagedPhotoScope(7, 3, 'swim_session'), stagedPhotoScope(8, 3, 'swim_session'));
assert.notEqual(stagedPhotoScope(7, 3, 'swim_session'), stagedPhotoScope(7, 4, 'swim_session'));
assert.notEqual(stagedPhotoScope(7, 3, 'swim_session'), stagedPhotoScope(7, 3, 'green_pre_use_check'));
assert.equal(stagedPhotoScope(undefined, 3, 'swim_session'), null);

// Asset validation.
assert.deepEqual(validatePhotoAsset({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileName: 'a.jpg', fileSize: 1000 }),
  { contentType: 'image/jpeg', name: 'a.jpg' });
assert.equal(validatePhotoAsset({ uri: 'file:///b.png', fileName: 'b.png' }).contentType, 'image/png');
assert.match(validatePhotoAsset({ uri: 'file:///c.heic', mimeType: 'image/heic' }).error, /JPEG or PNG/);
assert.match(validatePhotoAsset({ uri: 'file:///d.jpg', mimeType: 'image/jpeg', fileSize: 11 * 1024 * 1024 }).error, /10 MB/);

// Upload URL safety.
assert.ok(isSafeUploadUrl('https://storage.googleapis.com/bucket/uploads/x?X-Goog-Signature=abc'));
assert.ok(!isSafeUploadUrl('http://storage.googleapis.com/bucket/x'));
assert.ok(!isSafeUploadUrl('https://user:pass@storage.example/x'));
assert.ok(!isSafeUploadUrl('javascript:alert(1)'));
assert.ok(!isSafeUploadUrl(undefined));

// Staging flow: bearer API calls for request + verify; storage PUT gets only
// Content-Type (never session credentials), and order is request → PUT → verify.
function fakeDeps({ putOk = true, uploadUrl = 'https://storage.example/upload/abc?sig=1', receiptId = RECEIPT } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      async apiPost(path, body) {
        calls.push({ kind: 'api', path, body });
        if (path === '/api/photos/request-staged-upload') return { uploadUrl, objectPath: '/objects/uploads/abc' };
        if (path === '/api/photos/staged') return { id: receiptId, objectPath: '/objects/final/abc' };
        throw new Error(`unexpected ${path}`);
      },
      async putObject(url, headers, uri) {
        calls.push({ kind: 'put', url, headers: { ...headers }, uri });
        return { ok: putOk, status: putOk ? 200 : 403 };
      },
      now: () => 1_000,
    },
  };
}
{
  const { calls, deps } = fakeDeps();
  const staged = await stageRequiredPhoto(deps, 'green_pre_use_check',
    { uri: 'file:///photo.jpg', mimeType: 'image/jpeg', fileName: 'photo.jpg', fileSize: 2048 });
  assert.deepEqual(staged, { id: RECEIPT, name: 'photo.jpg', uri: 'file:///photo.jpg', stagedAt: 1_000 });
  assert.deepEqual(calls.map((call) => call.kind === 'put' ? 'put' : call.path), [
    '/api/photos/request-staged-upload', 'put', '/api/photos/staged',
  ]);
  assert.deepEqual(calls[0].body, { entityType: 'green_pre_use_check', name: 'photo.jpg', contentType: 'image/jpeg' });
  assert.deepEqual(Object.keys(calls[1].headers), ['Content-Type'], 'storage PUT carries no Authorization or cookie header');
  assert.deepEqual(calls[2].body, { entityType: 'green_pre_use_check', objectPath: '/objects/uploads/abc' });
}
{
  const { calls, deps } = fakeDeps({ putOk: false });
  await assert.rejects(stageRequiredPhoto(deps, 'swim_session', { uri: 'file:///p.png', mimeType: 'image/png' }), /Upload to storage failed/);
  assert.ok(!calls.some((call) => call.path === '/api/photos/staged'), 'failed PUT is never verified');
}
{
  const { calls, deps } = fakeDeps({ uploadUrl: 'http://storage.example/upload' });
  await assert.rejects(stageRequiredPhoto(deps, 'swim_session', { uri: 'file:///p.png', mimeType: 'image/png' }), /Invalid photo upload response/);
  assert.ok(!calls.some((call) => call.kind === 'put'), 'never uploads over cleartext');
}
{
  const { deps } = fakeDeps({ receiptId: 'not-a-uuid' });
  await assert.rejects(stageRequiredPhoto(deps, 'swim_session', { uri: 'file:///p.png', mimeType: 'image/png' }), /Invalid photo verification/);
}
{
  const { calls, deps } = fakeDeps();
  await assert.rejects(stageRequiredPhoto(deps, 'swim_session', { uri: 'file:///p.heic', mimeType: 'image/heic' }), /JPEG or PNG/);
  assert.equal(calls.length, 0, 'invalid assets make no network calls');
}

// Readiness: required minimum enforced; uploading blocks; failed requirement
// load (e.g. offline) keeps optional saves possible because the server decides.
const base = { enabled: true, loading: false, loadFailed: false, uploading: false, required: true, minimum: 2, photoCount: 1 };
assert.equal(evidenceReady(base), false);
assert.equal(evidenceReady({ ...base, photoCount: 2 }), true);
assert.equal(evidenceReady({ ...base, photoCount: 2, uploading: true }), false);
assert.equal(evidenceReady({ ...base, required: false, minimum: 0, photoCount: 0 }), true);
assert.equal(evidenceReady({ ...base, loading: true, required: false }), false);
assert.equal(evidenceReady({ ...base, loadFailed: true, required: false, photoCount: 0 }), true);
assert.equal(evidenceReady({ ...base, enabled: false }), true);

// Payload: optional saves without photos are byte-for-byte unchanged.
const body = { siteId: 4, sessionDate: '2026-10-09' };
assert.equal(withPhotoUploadIds(body, []), body);
assert.deepEqual(withPhotoUploadIds(body, [{ id: RECEIPT, name: 'a', uri: 'u', stagedAt: 0 }]),
  { siteId: 4, sessionDate: '2026-10-09', photoUploadIds: [RECEIPT] });
assert.ok(!('objectPath' in withPhotoUploadIds(body, [{ id: RECEIPT, name: 'a', uri: 'u', stagedAt: 0 }])));

// Expiry: receipts are dropped before the 30-minute server TTL.
const now = 10 * STAGED_RECEIPT_TTL_MS;
const split = splitExpiredPhotos([
  { id: 'fresh', stagedAt: now - 60_000 },
  { id: 'stale', stagedAt: now - (STAGED_RECEIPT_TTL_MS - 60_000) },
], now);
assert.deepEqual(split.fresh.map((photo) => photo.id), ['fresh']);
assert.deepEqual(split.expired.map((photo) => photo.id), ['stale']);

// Create failures: network errors keep everything; receipt errors drop only photos.
const apiError = (status, message) => Object.assign(new Error(message), { status });
assert.equal(classifyStagedCreateError(new TypeError('Network request failed')), 'network');
assert.equal(classifyStagedCreateError(apiError(400, 'One or more photo upload receipts are invalid or already claimed')), 'receipts-invalid');
assert.equal(classifyStagedCreateError(apiError(400, 'Photo upload receipt is expired or already claimed')), 'receipts-invalid');
assert.equal(classifyStagedCreateError(apiError(403, 'Photo upload receipt is not available to this user')), 'receipts-invalid');
assert.equal(classifyStagedCreateError(apiError(422, 'At least 2 verified photo(s) are required')), 'requirement');
assert.equal(classifyStagedCreateError(apiError(400, 'machineId is required')), 'other');
assert.match(stagedCreateErrorMessage('network', 'x'), /kept/);
assert.match(stagedCreateErrorMessage('requirement', 'At least 2 verified photo(s) are required'), /^At least 2/);

// The production uploader must not send credentials to object storage.
const hook = await readFile(new URL('../hooks/useStagedPhotoEvidence.ts', import.meta.url), 'utf8');
const putBlock = hook.slice(hook.indexOf('putObject:'), hook.indexOf('};', hook.indexOf('putObject:')));
assert.match(putBlock, /credentials: 'omit'/);
assert.doesNotMatch(putBlock, /Authorization|apiFetch|Cookie/i);

console.log('staged photo evidence: all assertions passed');
