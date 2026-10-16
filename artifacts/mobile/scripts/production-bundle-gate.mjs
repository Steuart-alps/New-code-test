// Decides whether a change needs the phone production bundle check
// (`pnpm --filter @workspace/mobile run validate:production`), so CI runs it
// for phone changes and skips it for web-only or API-only edits.
//
// It runs when the change touches:
// - the phone app (artifacts/mobile) or the workspace library it bundles
//   (lib/api-client-react);
// - patches/ (pnpm patches, e.g. the old image-size-safe patch);
// - a phone step in the CI workflow;
// - an Expo, Metro, React Native, Babel or image-size line in the root
//   package.json (dependencies and pnpm overrides), pnpm-workspace.yaml or
//   pnpm-lock.yaml. Other changes to those shared files (a web package bump)
//   don't count.
//
// CLI (CI): node production-bundle-gate.mjs <base-sha> [head-sha]
// Prints the reason and writes run=true|false to $GITHUB_OUTPUT when set. A
// missing or unknown base runs the check, so a failure here never skips it.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MOBILE_PATHS = [
  /^artifacts\/mobile\//,
  /^lib\/api-client-react\//,
  /^patches\//,
];
const SHARED_DEPENDENCY_FILES = new Set(['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']);
const MOBILE_TOOLCHAIN = /expo|metro|react-native|image-size|@babel\//i;
// CI workflow edits count only when they touch the phone steps; new API or web
// test steps are added there often.
const CI_WORKFLOW = '.github/workflows/ci.yml';
const CI_PHONE_STEP = /mobile|phone|expo|bundle/i;

/** Changed lines (without the +/- marker) of a unified diff, headers excluded. */
export function changedLines(diff) {
  return String(diff ?? '')
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)( |$)/.test(line))
    .map((line) => line.slice(1));
}

/**
 * @param {string[]} files changed paths, repository-relative
 * @param {(file: string) => string} diffFor unified diff of one shared file
 * @returns {{ run: boolean, reason: string }}
 */
export function decide(files, diffFor) {
  const mobile = files.find((file) => MOBILE_PATHS.some((pattern) => pattern.test(file)));
  if (mobile) return { run: true, reason: `phone file changed: ${mobile}` };
  for (const file of files.filter((f) => SHARED_DEPENDENCY_FILES.has(f))) {
    const line = changedLines(diffFor(file)).find((l) => MOBILE_TOOLCHAIN.test(l));
    if (line) return { run: true, reason: `${file} changes the phone toolchain: ${line.trim().slice(0, 120)}` };
  }
  if (files.includes(CI_WORKFLOW)) {
    const line = changedLines(diffFor(CI_WORKFLOW)).find((l) => CI_PHONE_STEP.test(l));
    if (line) return { run: true, reason: `${CI_WORKFLOW} changes a phone step: ${line.trim().slice(0, 120)}` };
  }
  return { run: false, reason: 'no phone app, Expo/Metro dependency, override or patch changes' };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  let result;
  if (!base || /^0+$/.test(base)) {
    result = { run: true, reason: 'no base commit to compare with' };
  } else {
    try {
      const files = git(['diff', '--name-only', base, head]).split('\n').filter(Boolean);
      result = decide(files, (file) => git(['diff', '-U0', base, head, '--', file]));
    } catch (error) {
      result = { run: true, reason: `could not compare with ${base} (${error.message.split('\n')[0]})` };
    }
  }
  console.log(`Phone production bundle check: ${result.run ? 'run' : 'skip'} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
