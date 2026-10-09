import { Storage } from "@google-cloud/storage";

const bucketName = process.env.GCS_STORAGE_TEST_BUCKET?.trim();
const applicationBucket = process.env.GCS_APPLICATION_BUCKET?.trim();
const prefix = process.env.GCS_PRIVATE_PREFIX?.trim();

if (!bucketName || !applicationBucket || bucketName === applicationBucket) {
  throw new Error("A dedicated GCS_STORAGE_TEST_BUCKET distinct from GCS_APPLICATION_BUCKET is required");
}
if (!/^private\/integration-[0-9a-f]{32}$/.test(prefix ?? "")) {
  throw new Error("Refusing fixture operations outside a unique private/integration-<hex> prefix");
}

const storage = new Storage(process.env.GCS_PROJECT_ID ? { projectId: process.env.GCS_PROJECT_ID } : {});
const bucket = storage.bucket(bucketName);
const mode = process.argv[2];

if (mode === "preflight") {
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
} else if (mode === "cleanup") {
  await bucket.deleteFiles({ prefix: `${prefix}/`, force: true });
  const [remaining] = await bucket.getFiles({ prefix: `${prefix}/` });
  if (remaining.length) throw new Error("Storage fixture cleanup left objects behind");
  console.log("Dedicated storage fixture objects removed");
} else {
  throw new Error("Expected preflight or cleanup");
}