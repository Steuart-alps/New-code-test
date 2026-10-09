// Test-side view of the photo round trip's storage: lists, inspects and
// removes objects under the run's unique prefix in the dedicated test bucket
// (real GCS mode) or in the in-process fake (via its loopback control port).
// It never touches anything outside private/photo-roundtrip-<hex>/.
import { fileURLToPath } from "node:url";
import { PREFIX_PATTERN, resolvePhotoRoundtripConfig } from "./photo-roundtrip-config.mjs";

function requirePrefix(prefix) {
  if (!PREFIX_PATTERN.test(prefix ?? "")) {
    throw new Error("Refusing storage fixture operations outside a unique private/photo-roundtrip-<hex> prefix");
  }
  return prefix;
}

export async function createBucketInspector(env = process.env) {
  const prefix = requirePrefix(env.PHOTO_ROUNDTRIP_PREFIX);
  const mode = env.PHOTO_ROUNDTRIP_STORAGE;

  if (mode === "in-process-fake") {
    const control = env.PHOTO_ROUNDTRIP_FAKE_CONTROL_URL;
    if (!control) throw new Error("PHOTO_ROUNDTRIP_FAKE_CONTROL_URL is required in fake mode");
    const call = async (method, path) => {
      const response = await fetch(`${control}${path}`, { method });
      if (!response.ok) throw new Error(`Fake storage control ${method} ${path}: ${response.status}`);
      return response.json();
    };
    return {
      mode,
      prefix,
      label: "IN-PROCESS FAKE storage (not real GCS)",
      list: (sub = "") => call("GET", `/objects?prefix=${encodeURIComponent(`${prefix}/${sub}`)}`),
      deleteAll: async () => (await call("DELETE", `/objects?prefix=${encodeURIComponent(`${prefix}/`)}`)).deleted,
      storageRequests: () => call("GET", "/requests"),
    };
  }

  if (mode !== "gcs") throw new Error(`Unknown PHOTO_ROUNDTRIP_STORAGE ${mode}`);
  const config = resolvePhotoRoundtripConfig(env);
  if (config.action !== "run") throw new Error(config.reason);
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage({ credentials: config.credentials, ...(config.projectId ? { projectId: config.projectId } : {}) });
  const bucket = storage.bucket(config.bucket);
  return {
    mode,
    prefix,
    label: `gs://${config.bucket}`,
    bucket,
    async list(sub = "") {
      const [files] = await bucket.getFiles({ prefix: `${prefix}/${sub}` });
      return files.map(file => ({
        name: file.name,
        contentType: file.metadata.contentType,
        size: Number(file.metadata.size),
        metadata: file.metadata.metadata ?? {},
      }));
    },
    async deleteAll() {
      const [files] = await bucket.getFiles({ prefix: `${prefix}/` });
      await Promise.all(files.map(file => file.delete({ ignoreNotFound: true })));
      return files.length;
    },
    // Real GCS does not expose the browser's request headers; the browser test
    // observes them directly instead.
    storageRequests: async () => null,
  };
}

async function preflight(env, inspector) {
  const origin = env.PHOTO_ROUNDTRIP_APP_ORIGIN;
  if (!origin) throw new Error("PHOTO_ROUNDTRIP_APP_ORIGIN is required for the CORS preflight");
  const [metadata] = await inspector.bucket.getMetadata().catch(error => {
    throw new Error(`Cannot read the test bucket's metadata (grant storage.buckets.get on it): ${error.message}`);
  });
  const cors = metadata.cors ?? [];
  const allowsUpload = cors.some(rule =>
    (rule.origin ?? []).some(allowed => allowed === "*" || allowed === origin)
    && (rule.method ?? []).some(method => method === "PUT" || method === "*")
    && (rule.responseHeader ?? []).some(header => header.toLowerCase() === "content-type"));
  if (!allowsUpload) {
    throw new Error(`Test bucket CORS must allow PUT from ${origin} with Content-Type (see the PR setup steps)`);
  }
  // Prove the credentials can sign a V4 upload and the bucket answers CORS for
  // this origin, the same way the browser upload will.
  const probe = inspector.bucket.file(`${inspector.prefix}/preflight-probe.txt`);
  const [signedUrl] = await probe.getSignedUrl({
    version: "v4", action: "write", expires: Date.now() + 60_000, contentType: "text/plain",
  });
  const uploaded = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain", Origin: origin },
    body: "photo round-trip probe",
  });
  if (!uploaded.ok) throw new Error(`Signed PUT to the test bucket failed (${uploaded.status})`);
  if (uploaded.headers.get("access-control-allow-origin") !== origin && uploaded.headers.get("access-control-allow-origin") !== "*") {
    throw new Error(`Test bucket did not return CORS headers for ${origin}`);
  }
  await probe.delete({ ignoreNotFound: true });
  console.log(`Dedicated photo test bucket ${inspector.label} accepts signed uploads from ${origin}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const inspector = await createBucketInspector(process.env);
  const command = process.argv[2];
  if (command === "preflight") {
    await preflight(process.env, inspector);
  } else if (command === "cleanup") {
    const deleted = await inspector.deleteAll();
    const remaining = await inspector.list();
    if (remaining.length) throw new Error(`Photo round-trip cleanup left ${remaining.length} object(s) under ${inspector.prefix}/`);
    console.log(`Photo round-trip storage cleanup: ${deleted} leftover object(s) removed from ${inspector.label}/${inspector.prefix}/`);
  } else {
    throw new Error("Expected preflight or cleanup");
  }
}
