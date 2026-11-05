#!/usr/bin/env node
// Creates the iPhone signing files for an unattended EAS build, using the
// App Store Connect API key (EAS itself won't create them in non-interactive
// mode). Used by .github/workflows/iphone-testflight.yml.
//
//   node scripts/ios-signing.mjs <output dir>
//
// Needs EXPO_ASC_API_KEY_PATH, EXPO_ASC_KEY_ID, EXPO_ASC_ISSUER_ID and the
// openssl command. It:
//   0. revokes older distribution certificates, keeping only the newest one
//      (Apple allows 2-3; apps already uploaded keep working). Steuart
//      approved this on 5 Nov 2026,
//   1. makes a new private key and App Store distribution certificate,
//   2. turns on the App ID capabilities the app needs (push notifications,
//      associated domains) and makes an App Store provisioning profile,
//   3. writes dist.p12, profile.mobileprovision and credentials.json (EAS
//      "local" credentials) into the output dir, plus asc-app-id.txt (the
//      App Store Connect app's Apple ID, which non-interactive submit needs).
// Nothing else in the Apple account is removed.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BUNDLE_ID = 'uk.co.alpsconsultancy.complytrack';
const PROFILE_PREFIX = 'ComplyTrack GitHub build';
const CAPABILITIES = ['PUSH_NOTIFICATIONS', 'ASSOCIATED_DOMAINS'];
const API = 'https://api.appstoreconnect.apple.com/v1';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/ios-signing.mjs <output dir>');
  process.exit(2);
}
for (const name of ['EXPO_ASC_API_KEY_PATH', 'EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID']) {
  if (!process.env[name]) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function token() {
  const key = createPrivateKey(readFileSync(process.env.EXPO_ASC_API_KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.EXPO_ASC_KEY_ID, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: process.env.EXPO_ASC_ISSUER_ID, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

const jwt = token();

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 409 && url === '/certificates') {
      throw new Error(
        'Apple refused a new distribution certificate because the account already has the most it allows. ' +
          'Revoke an old one at developer.apple.com > Certificates, IDs & Profiles > Certificates, then run again.\n' +
          text.slice(0, 1000),
      );
    }
    throw new Error(`${method} ${url} failed (${res.status}): ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listAll(url) {
  const items = [];
  let next = url;
  while (next) {
    const page = await api('GET', next);
    items.push(...page.data);
    next = page.links?.next ?? null;
  }
  return items;
}

function openssl(args, input) {
  return execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'inherit'] });
}

mkdirSync(outDir, { recursive: true });

// 0. Keep only the newest existing distribution certificate.
const existing = (await listAll('/certificates?limit=200')).filter((c) =>
  ['DISTRIBUTION', 'IOS_DISTRIBUTION'].includes(c.attributes.certificateType),
);
existing.sort((a, b) => String(b.attributes.expirationDate).localeCompare(String(a.attributes.expirationDate)));
for (const old of existing.slice(1)) {
  console.log(`Revoking older distribution certificate ${old.attributes.serialNumber ?? old.id}`);
  await api('DELETE', `/certificates/${old.id}`);
}

// 1. New key and distribution certificate.
const keyPath = path.join(outDir, 'dist.key');
openssl(['genrsa', '-out', keyPath, '2048']);
const csr = openssl(['req', '-new', '-key', keyPath, '-subj', '/CN=ComplyTrack GitHub build/C=GB']).toString();
const cert = await api('POST', '/certificates', {
  data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csr } },
});
const certId = cert.data.id;
const certDer = Buffer.from(cert.data.attributes.certificateContent, 'base64');
const certPemPath = path.join(outDir, 'dist.pem');
writeFileSync(certPemPath, openssl(['x509', '-inform', 'der', '-outform', 'pem'], certDer));
console.log(`Created distribution certificate ${cert.data.attributes.serialNumber ?? certId}`);

const password = randomBytes(18).toString('base64url');
const p12Path = path.join(outDir, 'dist.p12');
// 3DES/SHA1 so the macOS keychain on the build server can import it.
openssl([
  'pkcs12', '-export', '-inkey', keyPath, '-in', certPemPath, '-out', p12Path,
  '-passout', `pass:${password}`, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1',
]);

// 2. App ID capabilities and a profile for this certificate.
const bundles = (await listAll(`/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=200`)).filter(
  (b) => b.attributes.identifier === BUNDLE_ID,
);
if (bundles.length === 0) {
  throw new Error(`App ID ${BUNDLE_ID} not found. Register it under Certificates, IDs & Profiles > Identifiers.`);
}
const bundleId = bundles[0].id;
const enabled = new Set(
  (await listAll(`/bundleIds/${bundleId}/bundleIdCapabilities`)).map((c) => c.attributes.capabilityType),
);
for (const capabilityType of CAPABILITIES) {
  if (enabled.has(capabilityType)) continue;
  console.log(`Turning on ${capabilityType} for ${BUNDLE_ID}`);
  await api('POST', '/bundleIdCapabilities', {
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType },
      relationships: { bundleId: { data: { type: 'bundleIds', id: bundleId } } },
    },
  });
}

const profile = await api('POST', '/profiles', {
  data: {
    type: 'profiles',
    attributes: { name: `${PROFILE_PREFIX} ${new Date().toISOString().slice(0, 16)}`, profileType: 'IOS_APP_STORE' },
    relationships: {
      bundleId: { data: { type: 'bundleIds', id: bundleId } },
      certificates: { data: [{ type: 'certificates', id: certId }] },
    },
  },
});
const profilePath = path.join(outDir, 'profile.mobileprovision');
writeFileSync(profilePath, Buffer.from(profile.data.attributes.profileContent, 'base64'));
console.log(`Created provisioning profile "${profile.data.attributes.name}"`);

// 3. EAS local credentials.
writeFileSync(
  path.join(outDir, 'credentials.json'),
  JSON.stringify(
    {
      ios: {
        provisioningProfilePath: path.resolve(profilePath),
        distributionCertificate: { path: path.resolve(p12Path), password },
      },
    },
    null,
    2,
  ),
);
const apps = (await listAll(`/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=200`)).filter(
  (a) => a.attributes.bundleId === BUNDLE_ID,
);
if (apps.length === 0) {
  throw new Error(`No App Store Connect app uses ${BUNDLE_ID}. Create it under Apps > + > New App.`);
}
writeFileSync(path.join(outDir, 'asc-app-id.txt'), `${apps[0].id}\n`);
console.log(`App Store Connect app: ${apps[0].attributes.name} (${apps[0].id})`);

console.log('Signing files ready.');
