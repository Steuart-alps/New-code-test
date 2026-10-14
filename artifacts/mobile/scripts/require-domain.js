// Refuse to export a bundle without EXPO_PUBLIC_DOMAIN (the API host). A
// bundle built without it cannot reach the server: release builds would only
// show a configuration error screen. Same rule as scripts/build.js.
//
// Expo also reads EXPO_PUBLIC_* from the project's .env files, so those count.
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function fromEnvFiles() {
  const mode = process.env.NODE_ENV || 'production';
  const files = [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'];
  for (const file of files) {
    const full = path.join(projectRoot, file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?EXPO_PUBLIC_DOMAIN\s*=\s*(.*)\s*$/.exec(line);
      if (match) {
        const value = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
        if (value) return value;
      }
    }
  }
  return '';
}

function normalise(domain) {
  let urlString = domain.trim();
  if (!urlString || urlString === 'undefined' || urlString === 'null') return null;
  if (!/^https?:\/\//i.test(urlString)) urlString = `https://${urlString}`;
  try {
    return new URL(urlString).host || null;
  } catch {
    return null;
  }
}

const raw = process.env.EXPO_PUBLIC_DOMAIN || fromEnvFiles();
const host = normalise(raw || '');
if (!host) {
  console.error(
    raw
      ? `ERROR: EXPO_PUBLIC_DOMAIN is not a valid host: ${JSON.stringify(raw)}`
      : 'ERROR: No deployment domain found. Set EXPO_PUBLIC_DOMAIN to the API host (e.g. your Render URL) before exporting the app.',
  );
  process.exit(1);
}
console.log(`EXPO_PUBLIC_DOMAIN=${host}`);
