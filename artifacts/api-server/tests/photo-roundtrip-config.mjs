// Configuration gate for the real photo storage browser round trip.
//
// The round trip uploads, finalizes and deletes real objects, so it only runs
// against a dedicated test bucket named by explicit test-only variables. It
// refuses to start when that bucket is also named by any application storage
// variable, and skips (exit 78) when nothing is configured unless
// PHOTO_ROUNDTRIP_REQUIRED=1 makes the missing fixture a failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SKIP_EXIT_CODE = 78;
export const DEFAULT_WEB_PORT = 5317;
export const PREFIX_PATTERN = /^private\/photo-roundtrip-[0-9a-f]{32}$/;

// Application variables that can name a bucket directly...
const APPLICATION_BUCKET_VARIABLES = [
  "GCS_BUCKET_NAME",
  "GCS_PRIVATE_BUCKET",
  "GCS_PUBLIC_BUCKET",
  "GCS_APPLICATION_BUCKET",
];
// ...or as the first segment of a /bucket/prefix path (comma-separated lists allowed).
const APPLICATION_PATH_VARIABLES = ["PRIVATE_OBJECT_DIR", "PUBLIC_OBJECT_SEARCH_PATHS"];

export function normalizeBucketName(value) {
  return String(value ?? "").trim().replace(/^gs:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function bucketFromObjectPath(value) {
  const trimmed = String(value ?? "").trim().replace(/^gs:\/\//i, "/");
  const segment = trimmed.replace(/^\/+/, "").split("/")[0];
  return normalizeBucketName(segment);
}

/** Every application bucket the current environment names, with its source variable. */
export function applicationBuckets(env) {
  const found = [];
  for (const name of APPLICATION_BUCKET_VARIABLES) {
    const bucket = normalizeBucketName(env[name]);
    if (bucket) found.push({ variable: name, bucket });
  }
  for (const name of APPLICATION_PATH_VARIABLES) {
    for (const entry of String(env[name] ?? "").split(",")) {
      const bucket = bucketFromObjectPath(entry);
      if (bucket) found.push({ variable: name, bucket });
    }
  }
  return found;
}

/**
 * Resolve the round-trip configuration.
 * Returns { action: "run", ... } | { action: "skip", reason } | { action: "refuse", reason }.
 */
export function resolvePhotoRoundtripConfig(env, { mode = "gcs", readFile = path => readFileSync(path, "utf8") } = {}) {
  const webPort = Number(env.PHOTO_ROUNDTRIP_WEB_PORT || DEFAULT_WEB_PORT);
  if (!Number.isInteger(webPort) || webPort <= 0 || webPort > 65535) {
    return { action: "refuse", reason: `PHOTO_ROUNDTRIP_WEB_PORT must be a TCP port, received ${env.PHOTO_ROUNDTRIP_WEB_PORT}` };
  }
  if (mode === "in-process-fake") {
    return { action: "run", mode, bucket: "photo-roundtrip-in-process-fake", webPort };
  }
  if (mode !== "gcs") return { action: "refuse", reason: `Unknown storage mode ${mode}` };

  const bucket = normalizeBucketName(env.PHOTO_ROUNDTRIP_TEST_BUCKET);
  const inlineCredentials = String(env.PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON ?? "").trim();
  const credentialsFile = String(env.PHOTO_ROUNDTRIP_GCS_CREDENTIALS_FILE ?? "").trim();
  const required = env.PHOTO_ROUNDTRIP_REQUIRED === "1";

  if (!bucket || (!inlineCredentials && !credentialsFile)) {
    const missing = [
      !bucket && "PHOTO_ROUNDTRIP_TEST_BUCKET",
      !inlineCredentials && !credentialsFile && "PHOTO_ROUNDTRIP_GCS_SERVICE_ACCOUNT_JSON or PHOTO_ROUNDTRIP_GCS_CREDENTIALS_FILE",
    ].filter(Boolean).join(" and ");
    const reason = `Photo storage round trip is not configured: set ${missing} for a dedicated test bucket`;
    return required ? { action: "refuse", reason: `${reason} (PHOTO_ROUNDTRIP_REQUIRED=1)` } : { action: "skip", reason };
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
    return { action: "refuse", reason: "PHOTO_ROUNDTRIP_TEST_BUCKET is not a valid bucket name" };
  }
  const clash = applicationBuckets(env).filter(entry => entry.bucket === bucket);
  if (clash.length) {
    return {
      action: "refuse",
      reason: `Refusing to run: PHOTO_ROUNDTRIP_TEST_BUCKET is the application bucket named by ${clash.map(entry => entry.variable).join(", ")}. Use a dedicated test bucket.`,
    };
  }

  let credentials;
  try {
    credentials = JSON.parse(inlineCredentials || readFile(credentialsFile));
  } catch {
    // Never echo the credential text itself.
    return { action: "refuse", reason: "Photo round-trip credentials are not readable service-account JSON" };
  }
  if (credentials?.type !== "service_account" || !credentials.client_email || !credentials.private_key) {
    return {
      action: "refuse",
      reason: "Photo round-trip credentials must be a service-account key (V4 upload URLs are signed with its private key)",
    };
  }
  const projectId = String(env.PHOTO_ROUNDTRIP_GCS_PROJECT_ID || credentials.project_id || "").trim();
  return { action: "run", mode, bucket, webPort, credentials, projectId, serviceAccount: credentials.client_email };
}

// CLI: `node photo-roundtrip-config.mjs check <gcs|in-process-fake>` prints the
// decision. `... service-account-json` prints the credential JSON for the
// runner to hand to the disposable API (stdout only, never logged).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, mode = "gcs"] = process.argv.slice(2);
  const config = resolvePhotoRoundtripConfig(process.env, { mode });
  if (command === "check") {
    if (config.action === "skip") {
      console.log(`SKIP: ${config.reason}`);
      process.exit(SKIP_EXIT_CODE);
    }
    if (config.action === "refuse") {
      console.error(config.reason);
      process.exit(1);
    }
    console.error(
      config.mode === "gcs"
        ? `Photo storage round trip: dedicated bucket gs://${config.bucket} as ${config.serviceAccount}`
        : "Photo storage round trip: IN-PROCESS FAKE storage client (not the real Google Cloud Storage round trip)",
    );
  } else if (command === "service-account-json") {
    if (config.action !== "run" || config.mode !== "gcs") process.exit(1);
    process.stdout.write(JSON.stringify(config.credentials));
  } else if (command === "bucket") {
    if (config.action !== "run") process.exit(1);
    process.stdout.write(config.bucket);
  } else if (command === "project-id") {
    if (config.action !== "run") process.exit(1);
    process.stdout.write(config.projectId ?? "");
  } else if (command === "web-port") {
    if (config.action !== "run") process.exit(1);
    process.stdout.write(String(config.webPort));
  } else {
    console.error("Usage: photo-roundtrip-config.mjs check|bucket|project-id|web-port|service-account-json [gcs|in-process-fake]");
    process.exit(2);
  }
}
