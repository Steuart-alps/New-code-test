const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

for (const platform of ['ios', 'android']) {
  // Run Expo's real production export, not a Metro HTTP bundle request. Keep
  // stdio inherited so the original Metro stack trace reaches the validation
  // log unchanged when a third-party image parser fails.
  const result = spawnSync('pnpm', ['run', `export:${platform}`], {
    cwd: root,
    env: { ...process.env, CI: '1' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const output = path.join(root, 'dist', platform);
  const assetmap = JSON.parse(fs.readFileSync(path.join(output, 'assetmap.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(output, 'metadata.json'), 'utf8'));
  const thirdPartyPng = Object.values(assetmap).find(asset =>
    asset.__packager_asset &&
    asset.files?.some(file => file.includes('/node_modules/') && file.endsWith('.png'))
  );
  if (!thirdPartyPng) {
    throw new Error(`${platform} export did not bundle a third-party PNG through Metro`);
  }
  const pngAssets = metadata.fileMetadata?.[platform]?.assets?.filter(asset => asset.ext === 'png') ?? [];
  if (!metadata.fileMetadata?.[platform]?.bundle ||
      !pngAssets.some(asset => fs.existsSync(path.join(output, asset.path)))) {
    throw new Error(`${platform} export is missing its bundle or emitted PNG assets`);
  }
  console.log(`${platform} production bundle includes third-party PNG assets`);
}