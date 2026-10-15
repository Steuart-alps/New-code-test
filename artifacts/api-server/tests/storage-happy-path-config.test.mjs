// The required-storage run must only ever use its dedicated test bucket and
// test-only key, and must refuse to start without them.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveStorageTestConfig } from "./storage-happy-path-fixture.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = JSON.stringify({
  type: "service_account",
  project_id: "synthetic-test-project",
  client_email: "storage-tests@synthetic-test-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const configured = { GCS_STORAGE_TEST_BUCKET: "complytrack-storage-test", GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON: credentials };

// Unconfigured, or a bucket without its own key: refuse with a clear reason.
let result = resolveStorageTestConfig({});
assert.equal(result.ok, false);
assert.match(result.reason, /GCS_STORAGE_TEST_BUCKET/);
result = resolveStorageTestConfig({ GCS_STORAGE_TEST_BUCKET: "complytrack-storage-test", GCS_SERVICE_ACCOUNT_JSON: credentials });
assert.equal(result.ok, false, "the application key is never borrowed for the test bucket");
assert.match(result.reason, /GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON/);

// Configured with a distinct bucket: run, and remember the application buckets.
result = resolveStorageTestConfig({
  ...configured,
  GCS_STORAGE_TEST_BUCKET: "gs://Complytrack-Storage-Test/",
  PRIVATE_OBJECT_DIR: "/complytrack-app/private",
  PUBLIC_OBJECT_SEARCH_PATHS: "/complytrack-app/public",
});
assert.equal(result.ok, true);
assert.equal(result.bucket, "complytrack-storage-test");
assert.equal(result.projectId, "synthetic-test-project");
assert.deepEqual(result.applicationBuckets, ["complytrack-app"]);
assert.equal(resolveStorageTestConfig({ ...configured, GCS_STORAGE_TEST_PROJECT_ID: "other" }).projectId, "other");
assert.equal(resolveStorageTestConfig({
  GCS_STORAGE_TEST_BUCKET: "complytrack-storage-test",
  GCS_STORAGE_TEST_CREDENTIALS_FILE: "/key.json",
}, { readFile: () => credentials }).ok, true);

// Any application bucket or path variable naming the same bucket refuses.
for (const [variable, value] of [
  ["GCS_BUCKET_NAME", "complytrack-storage-test"],
  ["GCS_PRIVATE_BUCKET", "Complytrack-Storage-Test"],
  ["GCS_PUBLIC_BUCKET", "gs://complytrack-storage-test/"],
  ["GCS_APPLICATION_BUCKET", "complytrack-storage-test"],
  ["PRIVATE_OBJECT_DIR", "/complytrack-storage-test/private"],
  ["PUBLIC_OBJECT_SEARCH_PATHS", "/other-bucket/public, /complytrack-storage-test/public"],
]) {
  result = resolveStorageTestConfig({ ...configured, [variable]: value });
  assert.equal(result.ok, false, `${variable}=${value} must refuse`);
  assert.match(result.reason, new RegExp(variable));
}

// Credentials must be a service-account key, and their text is never echoed.
for (const bad of ["{\"type\":\"authorized_user\",\"refresh_token\":\"secret-value\"}", "not json secret-value"]) {
  result = resolveStorageTestConfig({ ...configured, GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON: bad });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.reason, /secret-value/);
}
assert.equal(resolveStorageTestConfig({ ...configured, GCS_STORAGE_TEST_BUCKET: "../bad" }).ok, false);

// The CLI the runner calls: refusal exits 1 without printing credentials.
const script = fileURLToPath(new URL("./storage-happy-path-fixture.mjs", import.meta.url));
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
let cli = run(["check"], {});
assert.equal(cli.status, 1);
assert.match(cli.stderr, /dedicated non-production bucket/);
cli = run(["check"], { ...configured, PRIVATE_OBJECT_DIR: "/complytrack-storage-test/private" });
assert.equal(cli.status, 1);
assert.doesNotMatch(cli.stdout + cli.stderr, /PRIVATE KEY/);
cli = run(["application-buckets"], { ...configured, GCS_BUCKET_NAME: "complytrack-app" });
assert.equal(cli.status, 0);
assert.equal(cli.stdout, "complytrack-app");
cli = run(["check"], configured);
assert.equal(cli.status, 0);
assert.doesNotMatch(cli.stdout + cli.stderr, /PRIVATE KEY/);

// The fixture refuses to open outside the runner's swapped-in configuration.
cli = run(["cleanup"], { GCS_STORAGE_TEST_BUCKET: "complytrack-storage-test" });
assert.notEqual(cli.status, 0, "cleanup without the runner's recorded application buckets refuses");
cli = run(["cleanup"], {
  GCS_STORAGE_TEST_BUCKET: "complytrack-storage-test",
  GCS_APPLICATION_BUCKETS: "complytrack-storage-test",
  GCS_PRIVATE_BUCKET: "complytrack-storage-test",
  GCS_PRIVATE_PREFIX: `private/integration-${"a".repeat(32)}`,
});
assert.notEqual(cli.status, 0, "cleanup refuses an application bucket");
assert.match(cli.stderr, /differ from every application bucket/);

console.log("storage happy-path config: all checks passed");
