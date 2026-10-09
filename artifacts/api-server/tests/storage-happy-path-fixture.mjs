// Dedicated-bucket fixture for the required-storage run (tests/run-storage-happy-path.sh).
// CLI: `node tests/storage-happy-path-fixture.mjs preflight|cleanup`.
// Suites import openStorageFixture() to read provider metadata directly and to
// remove their own objects; every operation is confined to the run's unique
// private/integration-<hex> prefix in the dedicated test bucket.
import { Storage } from "@google-cloud/storage";
import { pathToFileURL } from "node:url";

const PREFIX_PATTERN = /^private\/integration-[0-9a-f]{32}$/;

/** True when the runner has configured the dedicated bucket for this process. */
export function storageFixtureConfigured() {
  return Boolean(process.env.GCS_STORAGE_TEST_BUCKET?.trim());
}

export function openStorageFixture() {
  const bucketName = process.env.GCS_STORAGE_TEST_BUCKET?.trim();
  const applicationBucket = process.env.GCS_APPLICATION_BUCKET?.trim();
  const prefix = process.env.GCS_PRIVATE_PREFIX?.trim();

  if (!bucketName || !applicationBucket || bucketName === applicationBucket) {
    throw new Error("A dedicated GCS_STORAGE_TEST_BUCKET distinct from GCS_APPLICATION_BUCKET is required");
  }
  if (!PREFIX_PATTERN.test(prefix ?? "")) {
    throw new Error("Refusing fixture operations outside a unique private/integration-<hex> prefix");
  }
  // The API must store private objects in exactly this bucket and prefix.
  if (process.env.GCS_PRIVATE_BUCKET !== bucketName || process.env.PRIVATE_OBJECT_DIR) {
    throw new Error("The API's private storage must point at the dedicated test bucket and run prefix");
  }

  // Same credential sources as the API (src/lib/objectStorage.ts), so the
  // fixture reads exactly what the API wrote. Credentials are never logged.
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

async function preflight({ bucket, prefix }) {
  const [exists] = await bucket.exists();
  if (!exists) throw new Error("Dedicated storage test bucket does not exist or is inaccessible");
  const probe = bucket.file(`${prefix}/preflight`);
  const [signedUrl] = await probe.getSignedUrl({
    version: "v4", action: "write", expires: Date.now() + 60_000,
    contentType: "text/plain",
  });
  const uploaded = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "storage fixture probe",
  });
  if (!uploaded.ok) throw new Error(`Test-bucket signed PUT failed (${uploaded.status})`);
  await probe.delete();
  console.log("Dedicated storage fixture is ready for upload and signing");
}

async function cleanup({ bucket, prefix }) {
  await bucket.deleteFiles({ prefix: `${prefix}/`, force: true });
  const [remaining] = await bucket.getFiles({ prefix: `${prefix}/` });
  if (remaining.length) throw new Error("Storage fixture cleanup left objects behind");
  console.log("Dedicated storage fixture objects removed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== "preflight" && mode !== "cleanup") throw new Error("Expected preflight or cleanup");
  const fixture = openStorageFixture();
  await (mode === "preflight" ? preflight(fixture) : cleanup(fixture));
}
