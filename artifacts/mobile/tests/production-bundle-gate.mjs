import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedLines, decide } from '../scripts/production-bundle-gate.mjs';

// CI runs the phone production bundle check only for phone changes; this pins
// which changes count and that anything uncertain runs it.
const noDiff = () => '';
const diffs = (map) => (file) => map[file] ?? '';

// Phone files, the bundled API client and patches always run it.
for (const file of [
  'artifacts/mobile/app/(tabs)/index.tsx',
  'artifacts/mobile/package.json',
  'lib/api-client-react/src/generated/api.ts',
  'patches/image-size-safe@2.0.3.patch',
]) {
  assert.equal(decide([file], noDiff).run, true, `${file} runs the check`);
}

// Web-only and API-only changes skip it.
assert.equal(decide([
  'artifacts/compliance-tracker/src/pages/incidents.tsx',
  'artifacts/api-server/src/routes/swim-track.ts',
  'lib/db/src/schema/tasks.ts',
  'docs/mobile-launch.md',
], noDiff).run, false);

// CI workflow edits count only when they touch a phone step.
const ciDiff = (line) => ({ '.github/workflows/ci.yml': `@@ -90,0 +91,2 @@\n+      - name: ${line}\n` });
assert.equal(decide(['.github/workflows/ci.yml'], diffs(ciDiff('Pest register tests'))).run, false, 'a new API test step skips');
assert.equal(decide(['.github/workflows/ci.yml'], diffs(ciDiff('Phone production bundle check'))).run, true, 'a phone step change runs');

// Shared dependency files count only when a changed line is phone toolchain.
const webBump = {
  'package.json': '--- a/package.json\n+++ b/package.json\n@@ -40 +40 @@\n-    "qs": "6.16.0",\n+    "qs": "6.16.1",\n',
  'pnpm-lock.yaml': '@@ -10,2 +10,2 @@\n-  lucide-react@0.545.0:\n+  lucide-react@0.546.0:\n',
};
assert.equal(decide(['package.json', 'pnpm-lock.yaml', 'artifacts/compliance-tracker/package.json'], diffs(webBump)).run, false,
  'a web dependency bump skips the check');

const cases = {
  'the image-size override': { 'package.json': '@@ -55 +55 @@\n-    "image-size": "npm:image-size-safe@2.0.3",\n+    "image-size": "npm:image-size-safe@2.0.4",\n' },
  'a Metro lockfile entry': { 'pnpm-lock.yaml': '@@ -900 +900 @@\n-  metro@0.83.3:\n+  metro@0.83.4:\n' },
  'an Expo workspace override': { 'pnpm-workspace.yaml': "@@ -36,0 +37 @@\n+  '@expo/cli': 57.0.24\n" },
  'a Babel override': { 'package.json': '@@ -44 +44 @@\n-    "@babel/core": "7.29.6",\n+    "@babel/core": "7.29.7",\n' },
};
for (const [name, map] of Object.entries(cases)) {
  const result = decide(Object.keys(map), diffs(map));
  assert.equal(result.run, true, `${name} runs the check`);
  assert.match(result.reason, /changes the phone toolchain/);
}

// File headers that merely mention a path are not changed lines.
assert.deepEqual(changedLines('--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-a\n+b\n'), ['a', 'b']);
assert.deepEqual(changedLines('+++ b/expo.json\n--- a/expo.json\n'), []);

// The CLI against a real repository, as CI calls it.
const gate = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'production-bundle-gate.mjs');
const repo = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
function cli(base) {
  const out = join(repo, 'github-output');
  writeFileSync(out, '');
  execFileSync('node', [gate, ...(base === undefined ? [] : [base]), 'HEAD'], {
    cwd: repo, env: { ...process.env, GITHUB_OUTPUT: out }, encoding: 'utf8',
  });
  return readFileSync(out, 'utf8').trim();
}
try {
  git('init', '-q');
  writeFileSync(join(repo, 'package.json'), '{\n  "pnpm": { "overrides": { "qs": "6.16.0" } }\n}\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();

  mkdirSync(join(repo, 'artifacts/compliance-tracker'), { recursive: true });
  writeFileSync(join(repo, 'artifacts/compliance-tracker/page.tsx'), 'export {};\n');
  git('add', '.');
  git('commit', '-qm', 'web only');
  assert.equal(cli(base), 'run=false', 'CLI: a web-only commit skips');

  writeFileSync(join(repo, 'package.json'), '{\n  "pnpm": { "overrides": { "qs": "6.16.0", "image-size": "npm:image-size-safe@2.0.3" } }\n}\n');
  git('commit', '-qam', 'override');
  assert.equal(cli(base), 'run=true', 'CLI: an override change runs');

  assert.equal(cli(''), 'run=true', 'CLI: no base (manual run) runs');
  assert.equal(cli('0000000000000000000000000000000000000000'), 'run=true', 'CLI: a new branch push runs');
  assert.equal(cli('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), 'run=true', 'CLI: an unknown base runs');
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log('production bundle gate: ok');
