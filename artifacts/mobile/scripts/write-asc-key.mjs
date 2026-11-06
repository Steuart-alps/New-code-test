#!/usr/bin/env node
// Writes the App Store Connect API key (the .p8 text in the ASC_API_KEY_P8
// secret) to a clean PEM file, whatever way it was pasted: with or without
// the BEGIN/END lines, with Windows line endings, spaces, or "\n" typed as
// text. Fails with a plain message (never printing the key) if it isn't a
// usable private key.
//
//   ASC_API_KEY_P8=... node scripts/write-asc-key.mjs <output path>
import { createPrivateKey } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';

const outPath = process.argv[2];
const raw = process.env.ASC_API_KEY_P8 ?? '';
if (!outPath || !raw.trim()) {
  console.error('usage: ASC_API_KEY_P8=... node scripts/write-asc-key.mjs <output path>');
  process.exit(2);
}

const body = raw
  .replace(/\\n/g, '\n')
  .replace(/-----(BEGIN|END)[^-]*-----/g, '')
  .replace(/[^A-Za-z0-9+/=]/g, '');

let key;
try {
  key = createPrivateKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'pkcs8' });
} catch {
  const hadHeader = /BEGIN PRIVATE KEY/.test(raw);
  console.error(
    `::error::The ASC_API_KEY_P8 secret is not a readable App Store Connect key ` +
      `(${raw.length} characters, BEGIN line ${hadHeader ? 'present' : 'missing'}). ` +
      'Open the AuthKey_XXXXXXXXXX.p8 file in TextEdit or Notepad, copy everything ' +
      'from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----, and paste it ' +
      'as the secret again (Settings > Secrets and variables > Actions > ASC_API_KEY_P8 > Update).',
  );
  process.exit(1);
}
if (key.asymmetricKeyType !== 'ec') {
  console.error('::error::The ASC_API_KEY_P8 secret is a private key, but not an App Store Connect (EC) key.');
  process.exit(1);
}

const lines = body.match(/.{1,64}/g).join('\n');
writeFileSync(outPath, `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
chmodSync(outPath, 0o600);
console.log('App Store Connect key written.');
