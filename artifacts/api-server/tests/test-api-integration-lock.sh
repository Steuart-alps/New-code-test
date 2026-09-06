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
# the lock. The application-level pure tests below only use unique mkdtemp
# outputs and in-memory fakes/static source assertions; they do not connect to
# the DB, start runtime migrations, or access shared object storage.
node <<'NODE'
const { readFileSync } = require("node:fs");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const scripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith("test:"));
const directLocked = new Set([
  "test:isolation", "test:trial-reminders", "test:cancellation-warnings",
  "test:modules", "test:dept-isolation", "test:dailytrack-locks",
  "test:config", "test:training-expiry", "test:safe-track-ack-reminders",
  "test:discounts", "test:compliance-hub", "test:guidance-register",
  "test:daily-checklist-entitlements", "test:export-attachment-acl",
  "test:photo-attachments", "test:bike-overdue-reminders",
  "test:contractor-upload-signatures", "test:contractor-compliance-reminders",
]);
const runnerLocked = new Set([
  "test:isolation:ci", "test:modules:ci", "test:dept-isolation:ci",
  "test:dailytrack-locks:ci", "test:config:ci", "test:doc-track-status",
  "test:discounts:ci", "test:compliance-hub:ci", "test:track-actions-trigger",
  "test:track-action-templates", "test:room-track", "test:doc-track-object-acl",
  "test:bike-hire-export", "test:riddor-audit-history",
  "test:compliance-audit-history", "test:fix-track-contractor-approval",
  "test:twofa-recovery", "test:fix-track-history", "test:contractor-portal",
]);
const pure = new Set([
  "test:api-runner-lock", // validates this lock without application resources
  "test:track-summary-routing", // unique temp bundle; pure formatting helpers
  "test:billing-addon-activation", // fake Stripe; unique temp bundle
  "test:service-price-preflight", // read-only source assertions and fake inputs
  "test:biketrack-billing", // fake Stripe/static wiring assertions
  "test:pesttrack-billing", // fake Stripe/static wiring assertions
]);
for (const [name, command] of scripts) {
  if (directLocked.has(name)) {
    if (!command.startsWith("bash tests/run-db-workflow.sh tests/")) {
      throw new Error(`${name} must use run-db-workflow.sh: ${command}`);
    }
  } else if (runnerLocked.has(name)) {
    const runner = command.match(/^bash (tests\/run-[^ ]+\.sh)$/)?.[1];
    if (!runner || !readFileSync(runner, "utf8").includes("api-integration-lock.sh")) {
      throw new Error(`${name} runner must source api-integration-lock.sh: ${command}`);
    }
  } else if (!pure.has(name)) {
    throw new Error(`${name} is not classified as locked or pure`);
  }
}
for (const name of [...directLocked, ...runnerLocked, ...pure]) {
  if (!(name in pkg.scripts)) throw new Error(`classified script no longer exists: ${name}`);
}

// Check every direct test entrypoint as well as the package command inventory.
// A locked entrypoint may run through run-db-workflow directly, or through a
// self-booting API runner that sources the lock. `login-rate-limit` is the
// sole standalone pure entrypoint: it launches an in-process Express fixture
// and has no database, build output, or storage dependency.
const pureEntrypoints = new Set([
  "billing-addon-activation.mjs", "biketrack-billing.mjs", "login-rate-limit.mjs",
  "pesttrack-billing.mjs", "service-price-preflight.mjs", "track-summary-routing.mjs",
]);
const entrypoints = require("node:fs").readdirSync("tests").filter((file) => file.endsWith(".mjs"));
for (const entrypoint of entrypoints) {
  if (pureEntrypoints.has(entrypoint)) continue;
  const directlyLocked = Object.values(pkg.scripts).some(
    (command) => command === `bash tests/run-db-workflow.sh tests/${entrypoint}`,
  );
  const runner = Object.values(pkg.scripts)
    .map((command) => command.match(/^bash (tests\/run-[^ ]+\.sh)$/)?.[1])
    .find((file) => file && readFileSync(file, "utf8").includes(`node tests/${entrypoint}`));
  if (!directlyLocked && !(runner && readFileSync(runner, "utf8").includes("api-integration-lock.sh"))) {
    throw new Error(`${entrypoint} is not covered by a locked package entrypoint`);
  }
}
console.log(`Lock coverage inventory validated for ${scripts.length} package test scripts.`);
NODE
echo "API integration lock serializes concurrent runners."