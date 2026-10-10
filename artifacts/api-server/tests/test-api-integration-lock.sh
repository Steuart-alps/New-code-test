#!/usr/bin/env bash
# Regression check: a second DB-backed runner cannot enter while the first is
# still using the shared database/build resources.
set -euo pipefail
cd "$(dirname "$0")/.."

tmpdir="$(mktemp -d)"
cleanup() {
  [ -z "${first_pid:-}" ] || wait "$first_pid" 2>/dev/null || true
  [ -z "${second_pid:-}" ] || wait "$second_pid" 2>/dev/null || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

API_TEST_LOCK_FILE="$tmpdir/lock" bash -c '
  source tests/api-integration-lock.sh
  : > "$1/first-entered"
  sleep 1
  : > "$1/first-released"
' _ "$tmpdir" &
first_pid=$!

for _ in $(seq 1 50); do
  [ -f "$tmpdir/first-entered" ] && break
  sleep 0.02
done
[ -f "$tmpdir/first-entered" ] || { echo "first lock holder did not start" >&2; exit 1; }

API_TEST_LOCK_FILE="$tmpdir/lock" bash -c '
  source tests/api-integration-lock.sh
  [ -f "$1/first-released" ]
' _ "$tmpdir" &
second_pid=$!

wait "$first_pid"
wait "$second_pid"


# Package scripts are the supported entrypoints in automation. Keep this
# inventory explicit so a new DB/API/storage test cannot accidentally bypass
# the lock: an unclassified test:* script fails this check (fail closed).
#
# HOW TO CLASSIFY A NEW test:* SCRIPT (add it to exactly one set below):
#   directLocked - `bash tests/run-db-workflow.sh tests/<file>.mjs`. Use for any
#                  suite that touches DATABASE_URL (the shared dev database).
#   runnerLocked - `bash tests/run-<name>.sh` where that runner itself sources
#                  tests/api-integration-lock.sh (self-booting API, shared dist/,
#                  shared database, object storage, ...).
#   freshSchema  - `bash tests/run-fresh-schema.sh [tests/<file>.mjs ...]`, or a
#                  runner that only delegates to run-fresh-schema.sh. These use
#                  a private initdb cluster, so they cannot touch shared data,
#                  but they are NOT pure: run-fresh-schema.sh still takes the
#                  shared lock because bundling and booting the API compete for
#                  machine memory. The check below verifies that runner keeps
#                  taking the lock, uses initdb, and scrubs the caller's env.
#   pure         - only static source assertions, in-memory fakes and unique
#                  mkdtemp outputs. Never DATABASE_URL, API_BASE, a booted API,
#                  dist/, object storage, or a fixed shared output path such as
#                  /tmp/<name>.mjs. Bundled TypeScript unit tests should use
#                  `bash tests/run-bundled-unit.sh tests/<file>.ts <cjs|esm>`.
#                  When in doubt, the test is not pure: lock it.
# New standalone entrypoints (tests/*.mjs) must also be reachable from a locked
# script/runner, be listed in pureEntrypoints, or be listed in helperModules.
node <<'NODE'
const { readFileSync, readdirSync } = require("node:fs");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const scripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith("test:"));
const howTo = "Classify it in tests/test-api-integration-lock.sh (see HOW TO CLASSIFY at the top of its inventory).";
const fail = (message) => {
  console.error(`Lock coverage inventory: ${message}`);
  process.exit(1);
};
const directLocked = new Set([
  "test:isolation", "test:trial-reminders", "test:cancellation-warnings",
  "test:modules", "test:dept-isolation", "test:dailytrack-locks",
  "test:config", "test:training-expiry", "test:safe-track-ack-reminders",
  "test:discounts", "test:compliance-hub", "test:guidance-register",
  "test:daily-checklist-entitlements", "test:export-attachment-acl",
  "test:photo-attachments",
  "test:fix-track-overdue-alerts", "test:track-summary-delivery",
  "test:contractor-upload-signatures", "test:contractor-compliance-reminders",
  "test:track-controls-mobile",
]);
const runnerLocked = new Set([
  "test:photo-storage-roundtrip", "test:photo-storage-roundtrip:fake", // runner sources the lock after its config gate
  "test:isolation:ci", "test:modules:ci", "test:dept-isolation:ci",
  "test:dailytrack-locks:ci", "test:config:ci", "test:doc-track-status",
  "test:discounts:ci", "test:compliance-hub:ci", "test:track-actions-trigger",
  "test:track-action-templates", "test:room-track", "test:doc-track-object-acl",
  "test:bike-hire-export", "test:riddor-audit-history",
  "test:compliance-audit-history", "test:twofa-recovery", "test:fix-track-history",
  "test:contractor-portal", "test:premises-inspection-date-range",
  "test:pat-dept-isolation", "test:data-deletion-request",
  "test:daily-track-month-history", "test:stored-track-lock",
  "test:privacy-governance:ci", "test:staff-roster-reconciliation",
  "test:staff-pin", "test:staff-attribution", "test:mandatory-2fa",
  "test:generic-document-object-acl", "test:track-evidence",
  "test:track-export-isolation", "test:pat-export-attachments",
  "test:storage-happy-path", "test:storage-outage-routes",
  "test:pest-control-register", "test:water-safety",
  "test:compliance-schedule-tokens", "test:compliance-reminder-cycles",
  "test:contractor-draft-tamper", "test:contractor-key-preflight",
  "test:contractor-queue-migration-bounds", "test:staff-invitations",
  "test:welcome-email",
]);
const freshSchema = new Set([
  "test:schema:fresh", "test:kitchen-mobile-replay",
  "test:kitchen-temperature-actions", "test:kitchen-hold-controls",
  "test:kitchen-inspection-export", "test:content-filter",
  "test:feedback-triage", "test:contractor-token-security",
  "test:contractor-key-rotation",
  "test:fix-track-contractor-approval", // delegates each suite to run-fresh-schema.sh
  "test:password-reset-fresh-schema", "test:password-reset-rate-limit-postgres",
  "test:login-rate-limit-postgres", "test:pat-photo-boundary",
  "test:staged-photo-cleanup", "test:service-price-preflight-db",
  "test:service-price-audit", "test:biketrack-config-cadence", "test:bike-overdue-reminders",
  "test:two-factor-reset-alerts", // in-process jobs plus restart worker processes on the private cluster
  "test:contractor-approval-inbox-browser", // wrapper: browser policy env, then run-fresh-schema.sh
  "test:fixture-cleanup-isolation", // concurrent per-run cleanup on the private cluster
  "test:client-data-deletion-feedback",
  "test:train-track-roster-identity",
  "test:analytics", // in-process app (per-request CSRF/token env) on the private cluster; runs the analytics:report CLI against it
]);
const pure = new Set([
  "test:api-runner-lock", // validates this lock without application resources
  "test:staged-photo-creation", // real routes/helper with in-memory transaction/storage fakes
  "test:login-rate-limit", // isolated temp bundle and in-process Express fixture
  "test:track-summary-routing", // unique temp bundle; pure formatting helpers
  "test:billing-addon-activation", // fake Stripe; unique temp bundle
  "test:billing-addon-catalog", // fake Stripe/database; in-process Express router
  "test:private-file-acl", // real routes with isolated provider/database doubles
  "test:service-price-preflight", // read-only source assertions and fake inputs
  "test:biketrack-billing", // fake Stripe/static wiring assertions
  "test:pesttrack-billing", // fake Stripe/static wiring assertions
  "test:pattrack-billing", // static catalogue assertions; unique temp bundle
  "test:track-record-lock", // transpiles one middleware module in memory
  "test:passkey-mandatory-2fa", // read-only source assertions
  "test:viewer-route-policy", // read-only route source analysis
  "test:storage-usage", // fake storage file objects; unique temp bundle
  "test:monthly-compliance-summary", // in-memory db/email fakes; unique temp dir
  "test:calendar-invite-compatibility", // run-bundled-unit.sh: unique bundle, placeholder DB URL
  "test:csrf-origin-policy", // run-bundled-unit.sh: in-memory middleware requests
  "test:stripe-startup-readiness", // fake Stripe/clock; unique mkdtemp bundle
  "test:photo-roundtrip-config", // config gate only: env parsing, no storage or database
  "test:email-escaping", // run-bundled-unit.sh: pure renderers, nothing sent
]);
// Runners allowed for pure scripts. They must not source the lock, boot the
// API or read DATABASE_URL; each one writes only to a unique temp directory.
const pureRunners = new Set([
  "tests/test-api-integration-lock.sh",
  "tests/run-login-rate-limit.sh",
  "tests/run-bundled-unit.sh",
]);

const sets = { directLocked, runnerLocked, freshSchema, pure };
for (const [name] of scripts) {
  const owners = Object.entries(sets).filter(([, set]) => set.has(name)).map(([label]) => label);
  if (owners.length === 0) {
    fail(`${name} (${pkg.scripts[name]}) is not classified as directLocked, runnerLocked, freshSchema or pure. ${howTo}`);
  }
  if (owners.length > 1) fail(`${name} is classified more than once (${owners.join(", ")}).`);
}
for (const [label, set] of Object.entries(sets)) {
  for (const name of set) {
    if (!(name in pkg.scripts)) fail(`classified ${label} script no longer exists: ${name}`);
  }
}

const read = (file) => readFileSync(file, "utf8");
const mjsRefs = (text) => [...text.matchAll(/tests\/([A-Za-z0-9._-]+\.mjs)\b/g)].map((m) => m[1]);
const sourcesLock = (file) => /^\s*source tests\/api-integration-lock\.sh\s*$/m.test(read(file));
const freshRunner = "tests/run-fresh-schema.sh";
{
  const text = read(freshRunner);
  if (!sourcesLock(freshRunner)) fail(`${freshRunner} must source api-integration-lock.sh`);
  if (!/^initdb /m.test(text) || !/env -i /.test(text)) {
    fail(`${freshRunner} must use a private initdb cluster and scrub the caller's environment`);
  }
}

// Entrypoint -> how it is covered; filled while validating each script.
const lockedEntrypoints = new Set(mjsRefs(read(freshRunner)));
const pureRunEntrypoints = new Set();
for (const [name, command] of scripts) {
  if (directLocked.has(name)) {
    const match = command.match(/^bash tests\/run-db-workflow\.sh (tests\/[A-Za-z0-9._-]+\.mjs)$/);
    if (!match) fail(`${name} must be \`bash tests/run-db-workflow.sh tests/<file>.mjs\`: ${command}`);
    mjsRefs(match[1]).forEach((entry) => lockedEntrypoints.add(entry));
  } else if (runnerLocked.has(name)) {
    // Plain --flag arguments are allowed; the runner itself must take the lock.
    const runner = command.match(/^bash (tests\/run-[A-Za-z0-9._-]+\.sh)(?: --[a-z][a-z0-9-]*)*$/)?.[1];
    if (!runner || runner === freshRunner || !sourcesLock(runner)) {
      fail(`${name} runner must source api-integration-lock.sh: ${command}`);
    }
    mjsRefs(read(runner)).forEach((entry) => lockedEntrypoints.add(entry));
  } else if (freshSchema.has(name)) {
    const direct = command.match(/^bash tests\/run-fresh-schema\.sh((?: tests\/[A-Za-z0-9._-]+\.mjs)*)$/);
    if (direct) {
      mjsRefs(direct[1]).forEach((entry) => lockedEntrypoints.add(entry));
      continue;
    }
    // A wrapper may only hand suites to run-fresh-schema.sh; it must not start
    // node or receive a database URL itself.
    const runner = command.match(/^bash (tests\/run-[A-Za-z0-9._-]+\.sh)$/)?.[1];
    const text = runner ? read(runner) : "";
    if (!runner || !/\bbash tests\/run-fresh-schema\.sh\b/.test(text) ||
        /(^|[\s;&|])node\s/m.test(text) || /DATABASE_URL|API_BASE/.test(text)) {
      fail(`${name} must run through tests/run-fresh-schema.sh (directly or via a wrapper that only delegates to it): ${command}`);
    }
    mjsRefs(text).forEach((entry) => lockedEntrypoints.add(entry));
  } else {
    const nodeEntry = command.match(/^node tests\/([A-Za-z0-9._-]+\.mjs)$/)?.[1];
    const runner = command.match(/^bash (tests\/[A-Za-z0-9._-]+\.sh)(?: tests\/[A-Za-z0-9._-]+\.ts (?:cjs|esm))?$/)?.[1];
    if (nodeEntry) {
      pureRunEntrypoints.add(nodeEntry);
    } else if (runner && pureRunners.has(runner)) {
      if (runner !== "tests/test-api-integration-lock.sh" && sourcesLock(runner)) {
        fail(`${runner} sources the lock, so ${name} is not pure`);
      }
      mjsRefs(read(runner)).forEach((entry) => pureRunEntrypoints.add(entry));
      const tsEntry = command.match(/ (tests\/[A-Za-z0-9._-]+\.ts) /)?.[1];
      if (tsEntry && /DATABASE_URL|API_BASE|dist\/index|["'`]\/tmp\//.test(read(tsEntry))) {
        fail(`${name} entry ${tsEntry} references shared resources, so it is not pure`);
      }
    } else {
      fail(`pure script ${name} must be \`node tests/<file>.mjs\` or use a pure runner (${[...pureRunners].join(", ")}): ${command}`);
    }
  }
}

// Check every direct test entrypoint as well as the package command inventory.
// Standalone pure entrypoints use isolated fixtures with no shared database,
// build output or live storage. Helper modules are only imported by suites.
const pureEntrypoints = new Set([
  "billing-addon-activation.mjs", "billing-addon-catalog.mjs", "biketrack-billing.mjs", "login-rate-limit.mjs",
  "pesttrack-billing.mjs", "service-price-preflight.mjs", "track-summary-routing.mjs",
  "private-file-acl.mjs", "staged-photo-creation.mjs", "pattrack-billing.mjs",
  "track-record-lock.mjs", "passkey-mandatory-2fa.mjs", "viewer-route-policy.mjs",
  "storage-usage.mjs", "monthly-compliance-summary.mjs",
  "stripe-startup-readiness.mjs", "photo-roundtrip-config.test.mjs",
]);
const helperModules = new Set([
  "approval-workflow-fixtures.mjs", "doc-train-flows.mjs",
  "private-file-acl-fixture.mjs", "storage-test-availability.mjs",
  "fixture-ownership.mjs", "storage-acl-session.mjs",
]);
// Runners kept for manual use without a package script. They must still lock.
const unscriptedLockedRunners = ["tests/run-audit-log-endpoint.sh"];
for (const runner of unscriptedLockedRunners) {
  if (!sourcesLock(runner)) fail(`${runner} must source api-integration-lock.sh`);
  mjsRefs(read(runner)).forEach((entry) => lockedEntrypoints.add(entry));
}
for (const entry of pureRunEntrypoints) {
  if (!pureEntrypoints.has(entry)) fail(`pure script runs tests/${entry}, which is not listed in pureEntrypoints. ${howTo}`);
}
const testFiles = readdirSync("tests");
for (const entry of pureEntrypoints) {
  if (lockedEntrypoints.has(entry)) fail(`tests/${entry} is listed as pure but also runs under a locked runner`);
  if (/DATABASE_URL|API_BASE|dist\/index|["'`]\/tmp\/|run-db-workflow/.test(read(`tests/${entry}`))) {
    fail(`tests/${entry} references shared resources (DATABASE_URL, API_BASE, dist/, or a fixed /tmp path), so it is not pure`);
  }
}
for (const helper of helperModules) {
  const importer = testFiles.find((file) => /\.(mjs|ts)$/.test(file) && file !== helper &&
    new RegExp(`["/]${helper.replace(/\./g, "\\.")}"`).test(read(`tests/${file}`)));
  if (!importer) fail(`helper module tests/${helper} is not imported by any suite`);
}
for (const entry of testFiles.filter((file) => file.endsWith(".mjs"))) {
  if (lockedEntrypoints.has(entry) || pureEntrypoints.has(entry) || helperModules.has(entry)) continue;
  fail(`tests/${entry} is not covered by a locked package entrypoint, pureEntrypoints, or helperModules. ${howTo}`);
}
console.log(`Lock coverage inventory validated for ${scripts.length} package test scripts ` +
  `(${directLocked.size} direct, ${runnerLocked.size} runner, ${freshSchema.size} fresh-schema, ${pure.size} pure).`);
NODE
echo "API integration lock serializes concurrent runners."
