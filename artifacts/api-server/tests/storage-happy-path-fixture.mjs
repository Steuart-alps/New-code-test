// Dedicated-bucket fixture for the required-storage run (tests/run-storage-happy-path.sh).
// CLI: `node tests/storage-happy-path-fixture.mjs check|preflight|cleanup`, plus
// `bucket|application-buckets|service-account-json|project-id` for the runner.
// Suites import openStorageFixture() to read provider metadata directly and to
// remove their own objects; every operation is confined to the run's unique
// private/integration-<hex> prefix in the dedicated test bucket.
//
// Configuration (test-only; application storage variables are never used):
//   GCS_STORAGE_TEST_BUCKET                 dedicated non-production bucket
//   GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON   service-account key JSON, or
//   GCS_STORAGE_TEST_CREDENTIALS_FILE       a path to that key file
//   GCS_STORAGE_TEST_PROJECT_ID             optional; defaults to the key's project
//   STORAGE_HAPPY_PATH_REQUIRED=1           fail instead of skip when none is set
//
// `check` exits 78 (SKIP_EXIT_CODE) when no GCS_STORAGE_TEST_* variable is set,
// so release validation reports an intentional skip rather than a pass. A
// partial configuration, or an application bucket, always fails.
import { Storage } from "@google-cloud/storage";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applicationBuckets, normalizeBucketName } from "./photo-roundtrip-config.mjs";

export const SKIP_EXIT_CODE = 78;
const PREFIX_PATTERN = /^private\/integration-[0-9a-f]{32}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/** True when the runner has configured the dedicated bucket for this process. */
export function storageFixtureConfigured() {
  return Boolean(process.env.GCS_STORAGE_TEST_BUCKET?.trim());
}

/**
 * Resolve the dedicated-bucket configuration from an environment that still
 * carries the application's storage variables, so a clash can be detected.
 * Returns { ok: true, bucket, credentials, projectId, applicationBuckets } or
 * { ok: false, unconfigured, reason }; `unconfigured` means no test variable is
 * set at all. The reason never contains credential text.
 */
export function resolveStorageTestConfig(env, { readFile = (path) => readFileSync(path, "utf8") } = {}) {
  const bucket = normalizeBucketName(env.GCS_STORAGE_TEST_BUCKET);
  const inlineCredentials = String(env.GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON ?? "").trim();
  const credentialsFile = String(env.GCS_STORAGE_TEST_CREDENTIALS_FILE ?? "").trim();
  const missing = [
    !bucket && "GCS_STORAGE_TEST_BUCKET",
    !inlineCredentials && !credentialsFile && "GCS_STORAGE_TEST_SERVICE_ACCOUNT_JSON or GCS_STORAGE_TEST_CREDENTIALS_FILE",
  ].filter(Boolean);
  if (missing.length) {
    const unconfigured = !bucket && !inlineCredentials && !credentialsFile && !String(env.GCS_STORAGE_TEST_PROJECT_ID ?? "").trim();
    return { ok: false, unconfigured, reason: `Required-storage tests need a dedicated non-production bucket: set ${missing.join(" and ")}` };
  }
  if (!BUCKET_PATTERN.test(bucket)) {
    return { ok: false, reason: "GCS_STORAGE_TEST_BUCKET is not a valid bucket name" };
  }
  const found = applicationBuckets(env);
  const clash = found.filter((entry) => entry.bucket === bucket);
  if (clash.length) {
    return {
      ok: false,
      reason: `Refusing to run: GCS_STORAGE_TEST_BUCKET is the application bucket named by ${clash.map((entry) => entry.variable).join(", ")}. Use a dedicated test bucket.`,
    };
  }

  let credentials;
  try {
    credentials = JSON.parse(inlineCredentials || readFile(credentialsFile));
  } catch {
    return { ok: false, reason: "Storage test credentials are not readable service-account JSON" };
  }
  if (credentials?.type !== "service_account" || !credentials.client_email || !credentials.private_key) {
    return {
      ok: false,
      reason: "Storage test credentials must be a service-account key (V4 signed URLs are signed with its private key)",
    };
  }
  const projectId = String(env.GCS_STORAGE_TEST_PROJECT_ID || credentials.project_id || "").trim();
  return {
    ok: true,
    bucket,
    credentials,
    projectId,
    applicationBuckets: [...new Set(found.map((entry) => entry.bucket))],
  };
}

export function openStorageFixture() {
  const bucketName = normalizeBucketName(process.env.GCS_STORAGE_TEST_BUCKET);
  const prefix = process.env.GCS_PRIVATE_PREFIX?.trim();
  // Set (possibly empty) by the runner before it swaps in the test bucket.
  const recordedApplicationBuckets = process.env.GCS_APPLICATION_BUCKETS;

  if (!bucketName || recordedApplicationBuckets === undefined) {
    throw new Error("A dedicated GCS_STORAGE_TEST_BUCKET is required (run through tests/run-storage-happy-path.sh)");
  }
  if (recordedApplicationBuckets.split(",").map(normalizeBucketName).includes(bucketName)) {
    throw new Error("GCS_STORAGE_TEST_BUCKET must differ from every application bucket");
  }
  if (!PREFIX_PATTERN.test(prefix ?? "")) {
    throw new Error("Refusing fixture operations outside a unique private/integration-<hex> prefix");
  }
  // The API must store private objects in exactly this bucket and prefix.
  if (process.env.GCS_PRIVATE_BUCKET !== bucketName || process.env.PRIVATE_OBJECT_DIR) {
    throw new Error("The API's private storage must point at the dedicated test bucket and run prefix");
  }

  // The runner hands the test-only key to the API as GCS_SERVICE_ACCOUNT_JSON,
  // so the fixture reads exactly what the API wrote. Credentials are never logged.
  const options = {};
  if (process.env.GCS_PROJECT_ID?.trim()) options.projectId = process.env.GCS_PROJECT_ID.trim();
  if (process.env.GCS_SERVICE_ACCOUNT_JSON?.trim()) {
    options.credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON);
  }
  const bucket = new Storage(options).bucket(bucketName);

  /** Provider object for an API `/objects/...` path, only inside the run prefix. */
  function fileFor(objectPath) {
    if (typeof objectPath !== "string" || !/^\/objects\/[A-Za-z0-9._/-]+$/.test(objectPath) || objectPath.includes("..")) {
      throw new Error(`Refusing fixture access to unexpected object path ${JSON.stringify(objectPath)}`);
    }
    return bucket.file(`${prefix}/${objectPath.slice("/objects/".length)}`);
  }

  return { bucket, bucketName, prefix, fileFor };
}

function describeProviderError(error) {
  const code = error?.code ?? error?.response?.status;
  if (code === 404) return "the bucket does not exist";
  if (code === 403 || code === 401) return "the test service account has no object access on the bucket";
  return error?.message ?? String(error);
}

async function preflight({ bucket, prefix }) {
  // Listing needs only object permissions (Storage Object Admin on the bucket),
  // unlike bucket.exists(), which also needs storage.buckets.get.
  let existing;
  try {
    [existing] = await bucket.getFiles({ prefix: `${prefix}/`, maxResults: 1 });
  } catch (error) {
    throw new Error(`Dedicated storage test bucket is not usable: ${describeProviderError(error)}`);
  }
  if (existing.length) throw new Error("The run prefix already holds objects; refusing to start");

  const probe = bucket.file(`${prefix}/preflight`);
  const body = `storage fixture probe ${prefix}`;
  const expires = Date.now() + 60_000;
  const [putUrl] = await probe.getSignedUrl({ version: "v4", action: "write", expires, contentType: "text/plain" });
  const uploaded = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body });
  if (!uploaded.ok) throw new Error(`Test-bucket signed PUT failed (${uploaded.status})`);

  const [getUrl] = await probe.getSignedUrl({ version: "v4", action: "read", expires });
  const downloaded = await fetch(getUrl);
  if (!downloaded.ok) throw new Error(`Test-bucket signed GET failed (${downloaded.status})`);
  if ((await downloaded.text()) !== body) throw new Error("Test-bucket signed GET returned different bytes");

  await probe.delete();
  console.log("Dedicated storage fixture is ready: signed PUT and GET both work");
}

async function cleanup({ bucket, prefix }) {
  await bucket.deleteFiles({ prefix: `${prefix}/`, force: true });
  const [remaining] = await bucket.getFiles({ prefix: `${prefix}/` });
  if (remaining.length) throw new Error("Storage fixture cleanup left objects behind");
  console.log("Dedicated storage fixture objects removed; the run prefix is empty");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "preflight" || mode === "cleanup") {
    const fixture = openStorageFixture();
    await (mode === "preflight" ? preflight(fixture) : cleanup(fixture));
  } else if (["check", "bucket", "application-buckets", "service-account-json", "project-id"].includes(mode)) {
    const config = resolveStorageTestConfig(process.env);
    if (!config.ok) {
      if (mode === "check" && config.unconfigured && process.env.STORAGE_HAPPY_PATH_REQUIRED !== "1") {
        console.log(`SKIP: storage happy-path checks did not run. ${config.reason} (docs/testing/storage-test-bucket.md)`);
        process.exit(SKIP_EXIT_CODE);
      }
      console.error(config.unconfigured ? `${config.reason} (STORAGE_HAPPY_PATH_REQUIRED=1)` : config.reason);
      process.exit(1);
    }
    if (mode === "check") {
      console.error(`Required-storage run: dedicated bucket gs://${config.bucket} as ${config.credentials.client_email}`);
    } else if (mode === "bucket") {
      process.stdout.write(config.bucket);
    } else if (mode === "application-buckets") {
      process.stdout.write(config.applicationBuckets.join(","));
    } else if (mode === "service-account-json") {
      // stdout only, captured by the runner; never logged.
      process.stdout.write(JSON.stringify(config.credentials));
    } else {
      process.stdout.write(config.projectId);
    }
  } else {
    console.error("Usage: storage-happy-path-fixture.mjs check|preflight|cleanup|bucket|application-buckets|service-account-json|project-id");
    process.exit(2);
  }
}
