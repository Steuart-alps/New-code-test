import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../lib/api.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  apiFetch,
  ApiError,
  isInvalidMobileLoginChallenge,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const message = 'This verification request is invalid or has expired. Please sign in again.';
const code = 'MOBILE_LOGIN_CHALLENGE_INVALID';
globalThis.fetch = async (url) => {
  assert.equal(url, '/api/auth/mobile-login/verify-totp');
  return new Response(JSON.stringify({ error: message, code }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
};

let caught;
try {
  await apiFetch('/api/auth/mobile-login/verify-totp', {
    method: 'POST',
    body: JSON.stringify({ pendingToken: 'pending', code: '123456' }),
  });
} catch (error) {
  caught = error;
}
assert.ok(caught instanceof ApiError);
assert.equal(caught.status, 401);
assert.equal(caught.code, code);
assert.equal(caught.message, message, 'keep the existing user-facing message');
assert.equal(isInvalidMobileLoginChallenge(caught), true);

// A changed message keeps the reset behavior because the structured code is stable.
assert.equal(
  isInvalidMobileLoginChallenge(new ApiError('Verification could not continue. Sign in again.', 401, code)),
  true,
);

// The old text alone must not trigger a reset without the structured code.
assert.equal(isInvalidMobileLoginChallenge(new ApiError(message, 401)), false);
assert.equal(isInvalidMobileLoginChallenge(new ApiError(message, 401, 'INVALID_CODE')), false);

console.log('Mobile login challenge error-code handling passed.');