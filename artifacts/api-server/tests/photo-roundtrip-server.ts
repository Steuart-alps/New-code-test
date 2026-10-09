// Real API for the photo storage browser round trip: the production app,
// runtime migrations, sessions, CSRF and mandatory 2FA, serving the built web
// app from the same origin. Billing initialization and scheduled jobs are not
// started. Storage is the real Google Cloud Storage client configured for the
// dedicated test bucket, unless the runner explicitly selects the in-process
// fake (which is labelled as not being the real round trip).
import app, { markApplicationReady } from "../src/app";
import { runRuntimeMigrations } from "../src/lib/runtimeMigrations";
import { pool } from "@workspace/db";
import { objectStorageClient } from "../src/lib/objectStorage";
import { installInProcessFakeStorage } from "./photo-roundtrip-fake-storage";

if (process.env.NODE_ENV !== "test" || process.env.PHOTO_ROUNDTRIP_TEST !== "1") {
  throw new Error("This entry point is only for the isolated photo storage round trip");
}
if (process.env.ENFORCE_CSRF !== "1" || process.env.ENFORCE_MANDATORY_2FA !== "1") {
  throw new Error("The photo round trip must run with the production CSRF and 2FA checks enabled");
}
const bucket = process.env.GCS_PRIVATE_BUCKET ?? "";
if (!bucket || bucket !== process.env.GCS_BUCKET_NAME || bucket !== process.env.GCS_PUBLIC_BUCKET) {
  throw new Error("The photo round trip must point every storage bucket variable at its test bucket");
}
if (!/^private\/photo-roundtrip-[0-9a-f]{32}$/.test(process.env.GCS_PRIVATE_PREFIX ?? "")) {
  throw new Error("The photo round trip requires a unique private/photo-roundtrip-<hex> prefix");
}

if (process.env.PHOTO_ROUNDTRIP_STORAGE === "in-process-fake") {
  installInProcessFakeStorage(objectStorageClient as any, {
    bucketName: bucket,
    corsOrigin: process.env.PHOTO_ROUNDTRIP_FAKE_CORS_ORIGIN!,
    uploadPort: Number(process.env.PHOTO_ROUNDTRIP_FAKE_UPLOAD_PORT),
    controlPort: Number(process.env.PHOTO_ROUNDTRIP_FAKE_CONTROL_PORT),
    tlsCertFile: process.env.PHOTO_ROUNDTRIP_FAKE_TLS_CERT!,
    tlsKeyFile: process.env.PHOTO_ROUNDTRIP_FAKE_TLS_KEY!,
  });
  console.warn("[photo-roundtrip] IN-PROCESS FAKE storage client installed; this is not the real GCS round trip");
} else if (process.env.PHOTO_ROUNDTRIP_STORAGE !== "gcs" || !process.env.GCS_SERVICE_ACCOUNT_JSON) {
  throw new Error("Real photo round trip requires PHOTO_ROUNDTRIP_STORAGE=gcs and test service-account credentials");
}

await runRuntimeMigrations();
markApplicationReady();
const server = app.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => { void pool.end().then(() => process.exit(0)); }));
