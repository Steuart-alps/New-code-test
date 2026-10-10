import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../lib/passkeyErrors.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  classifyPasskeyError,
  passkeyFailureMessage,
  passkeyFailureNeedsSetup,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

// iOS rejects with Expo exceptions; the code comes from the exception class.
const ios = (code, message) => Object.assign(new Error(message), { code });
assert.equal(classifyPasskeyError(ios('ERR_USER_CANCELLED', 'User cancelled the passkey interaction')), 'cancelled');
assert.equal(classifyPasskeyError(ios('ERR_NOT_CONFIGURED', 'Your Apple app site association is not properly configured.')), 'not-configured');
assert.equal(classifyPasskeyError(ios('ERR_PASSKEY_REQUEST_FAILED',
  'Application with identifier ABC.uk.app is not associated with domain example.com')), 'not-configured');
assert.equal(classifyPasskeyError(ios('ERR_NOT_SUPPORTED', 'Passkeys are not supported on this iOS version')), 'unsupported');

// Android's Credential Manager rejects with the exception name as the message.
const android = (message) => Object.assign(new Error(message), { code: 'Passkey Get' });
assert.equal(classifyPasskeyError(android('NoCredentials')), 'no-passkey');
assert.equal(classifyPasskeyError(android('UserCancelled')), 'cancelled');
assert.equal(classifyPasskeyError(android('NotConfigured')), 'not-configured');
assert.equal(classifyPasskeyError(android('NotSupported')), 'unsupported');
assert.equal(classifyPasskeyError(android('DomError: NotAllowedError - timed out')), 'cancelled');

// The JavaScript wrapper's own error, and anything unexpected.
assert.equal(classifyPasskeyError({ name: 'NotSupportedError', message: 'Passkey are not supported' }), 'unsupported');
assert.equal(classifyPasskeyError(new Error('Something else broke')), 'failed');
assert.equal(classifyPasskeyError(undefined), 'failed');

// No passkey (and a cancelled iOS "no passkeys" sheet) leads to setup help;
// configuration and support problems point to the password instead.
assert.equal(passkeyFailureNeedsSetup('no-passkey'), true);
assert.equal(passkeyFailureNeedsSetup('cancelled'), true);
assert.equal(passkeyFailureNeedsSetup('not-configured'), false);
assert.equal(passkeyFailureNeedsSetup('unsupported'), false);
assert.match(passkeyFailureMessage('not-configured'), /email and password/);
assert.match(passkeyFailureMessage('unsupported'), /email and password/);

// The login screen's help, the passkey path and the TOTP step stay wired.
const login = await readFile(new URL('../app/(auth)/login.tsx', import.meta.url), 'utf8');
assert.match(login, /No passkey on this phone\?/);
assert.match(login, /Add a passkey on the web/);
assert.match(login, /setPendingVia\('passkey'\)/);
assert.match(login, /testID="totp-input"/);
const auth = await readFile(new URL('../lib/auth.tsx', import.meta.url), 'utf8');
const loginWithPasskey = auth.slice(auth.indexOf('const loginWithPasskey'), auth.indexOf('const logout'));
assert.doesNotMatch(loginWithPasskey, /SecureStore|applyToken|setUser/, 'a passkey alone must never sign in');

console.log('Mobile passkey error handling passed.');
