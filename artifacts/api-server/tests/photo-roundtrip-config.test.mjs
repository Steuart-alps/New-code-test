// The photo round trip must never run against application storage and must
// skip (not pass) when no dedicated test bucket is configured.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePhotoRoundtripConfig, SKIP_EXIT_CODE } from "./photo-roundtrip-config.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = JSON.stringify({
  type: "service_account",
  project_id: "synthetic-test-project",
  client_email: "photo-roundtrip@synthetic-test-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const configured = { PHOTO_ROUNDTRIP_TEST_BUCKET: "complytrack-photo-roundtrip-test", PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON: credentials };

// Unconfigured: skip with a clear reason, or fail when the fixture is required.
let result = resolvePhotoRoundtripConfig({});
assert.equal(result.action, "skip");
assert.match(result.reason, /PHOTO_ROUNDTRIP_TEST_BUCKET/);
assert.equal(resolvePhotoRoundtripConfig({ PHOTO_ROUNDTRIP_REQUIRED: "1" }).action, "refuse");
assert.equal(resolvePhotoRoundtripConfig({ PHOTO_ROUNDTRIP_TEST_BUCKET: "complytrack-photo-roundtrip-test" }).action, "skip",
  "a bucket without dedicated test credentials is not enough");

// Configured with a distinct bucket: run.
result = resolvePhotoRoundtripConfig({ ...configured, GCS_BUCKET_NAME: "complytrack-app", PRIVATE_OBJECT_DIR: "/complytrack-app/private" });
assert.equal(result.action, "run");
assert.equal(result.bucket, "complytrack-photo-roundtrip-test");
assert.equal(result.projectId, "synthetic-test-project");
assert.equal(result.webPort, 5317);

// Any application bucket or path variable naming the same bucket refuses.
for (const [variable, value] of [
  ["GCS_BUCKET_NAME", "complytrack-photo-roundtrip-test"],
  ["GCS_PRIVATE_BUCKET", "Complytrack-Photo-Roundtrip-Test"],
  ["GCS_PUBLIC_BUCKET", "gs://complytrack-photo-roundtrip-test/"],
  ["GCS_APPLICATION_BUCKET", "complytrack-photo-roundtrip-test"],
  ["PRIVATE_OBJECT_DIR", "/complytrack-photo-roundtrip-test/private"],
  ["PUBLIC_OBJECT_SEARCH_PATHS", "/other-bucket/public, /complytrack-photo-roundtrip-test/public"],
]) {
  result = resolvePhotoRoundtripConfig({ ...configured, [variable]: value });
  assert.equal(result.action, "refuse", `${variable}=${value} must refuse`);
  assert.match(result.reason, new RegExp(variable));
}

// Credentials must be a service-account key, and their text is never echoed.
result = resolvePhotoRoundtripConfig({ ...configured, PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON: "{\"type\":\"authorized_user\",\"refresh_token\":\"secret-value\"}" });
assert.equal(result.action, "refuse");
assert.doesNotMatch(result.reason, /secret-value/);
result = resolvePhotoRoundtripConfig({ ...configured, PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON: "not json secret-value" });
assert.equal(result.action, "refuse");
assert.doesNotMatch(result.reason, /secret-value/);
assert.equal(resolvePhotoRoundtripConfig({ ...configured, PHOTO_ROUNDTRIP_TEST_BUCKET: "../bad" }).action, "refuse");

// The fake mode needs no bucket or credentials and is clearly not real GCS.
assert.equal(resolvePhotoRoundtripConfig({}, { mode: "in-process-fake" }).action, "run");

// CLI exit codes used by the runner: skip = 78, refuse = 1.
const script = fileURLToPath(new URL("./photo-roundtrip-config.mjs", import.meta.url));
const cli = env => spawnSync(process.execPath, [script, "check", "gcs"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
let run = cli({});
assert.equal(run.status, SKIP_EXIT_CODE);
assert.match(run.stdout, /^SKIP: Photo storage round trip is not configured/);
run = cli({ ...configured, GCS_BUCKET_NAME: "complytrack-photo-roundtrip-test" });
assert.equal(run.status, 1);
assert.match(run.stderr, /Refusing to run/);
assert.doesNotMatch(run.stdout + run.stderr, /PRIVATE KEY/);

console.log("Photo round-trip configuration gate checks passed");
