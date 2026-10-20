import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Store-review requirements kept in config and the legal-link helpers:
// export-compliance flag, permission wording, no microphone or location
// permission, opaque 1024px store icon, adaptive icon, and links to the
// public privacy policy and terms.
const appJson = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8')).expo;
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

assert.equal(appJson.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
assert.ok(appJson.ios.bundleIdentifier && appJson.android.package, 'store identifiers are set');
assert.match(String(appJson.ios.buildNumber), /^\d+$/);
assert.ok(Number.isInteger(appJson.android.versionCode));

const picker = appJson.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')[1];
for (const use of ['issue reports', 'check records', 'certificates']) {
  assert.ok(picker.cameraPermission.includes(use), `camera wording covers ${use}`);
  assert.ok(picker.photosPermission.includes(use), `photo library wording covers ${use}`);
}
assert.equal(picker.microphonePermission, false, 'no microphone permission (photos only)');
for (const permission of ['RECORD_AUDIO', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']) {
  assert.ok(appJson.android.blockedPermissions.includes(`android.permission.${permission}`), `${permission} blocked`);
}
assert.deepEqual(pkg.expo.autolinking.exclude, ['expo-location'], 'unused location module is not linked');

// PNG IHDR: width, height, colour type (2 = RGB, no alpha; 6 = RGBA).
async function png(path) {
  const data = await readFile(new URL(`../${path}`, import.meta.url));
  assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data[25] };
}
const icon = await png(appJson.icon);
assert.deepEqual(icon, { width: 1024, height: 1024, colourType: 2 }, 'store icon is 1024x1024 without alpha');
const adaptive = await png(appJson.android.adaptiveIcon.foregroundImage);
assert.equal(adaptive.width, 1024);
assert.match(appJson.android.adaptiveIcon.backgroundColor, /^#[0-9a-f]{6}$/i);
const splash = appJson.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')[1];
await png(splash.image);

const source = await readFile(new URL('../lib/links.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = () => import(`data:text/javascript,${encodeURIComponent(js)}#${Math.random()}`);

delete process.env.EXPO_PUBLIC_SITE_URL;
let links = await load();
assert.equal(links.privacyPolicyUrl(), 'https://complytrack.alpsconsultancy.co.uk/privacy');
assert.equal(links.termsUrl(), 'https://complytrack.alpsconsultancy.co.uk/terms');
process.env.EXPO_PUBLIC_SITE_URL = 'https://staging.example.test/';
assert.equal(links.privacyPolicyUrl(), 'https://staging.example.test/privacy');
process.env.EXPO_PUBLIC_SITE_URL = 'http://insecure.example.test';
assert.equal(links.termsUrl(), 'https://complytrack.alpsconsultancy.co.uk/terms', 'non-HTTPS override ignored');
delete process.env.EXPO_PUBLIC_SITE_URL;

assert.equal(links.canRequestBusinessDeletion('client_admin'), true);
assert.equal(links.canRequestBusinessDeletion('consultant'), true);
assert.equal(links.canRequestBusinessDeletion('client_staff'), false);
assert.equal(links.canRequestBusinessDeletion('client_viewer'), false);
assert.equal(links.canRequestBusinessDeletion(undefined), false);

// The profile and sign-in screens link to both pages; profile links to deletion.
const profile = await readFile(new URL('../app/(tabs)/profile.tsx', import.meta.url), 'utf8');
const login = await readFile(new URL('../app/(auth)/login.tsx', import.meta.url), 'utf8');
for (const screen of [profile, login]) {
  assert.match(screen, /privacyPolicyUrl\(\)/);
  assert.match(screen, /termsUrl\(\)/);
}
assert.match(profile, /\/account\/delete/);
const deletion = await readFile(new URL('../app/account/delete.tsx', import.meta.url), 'utf8');
assert.match(deletion, /'\/api\/data-deletion\/request'/, 'uses the existing reviewed erasure request');

console.log('store compliance: ok');
