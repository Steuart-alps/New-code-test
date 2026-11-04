import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";
import { createDownloadToken } from "./downloadUsage";
import {
  MAX_RESTRICTED_UPLOAD_BYTES,
  ObjectContentError,
  UploadTooLargeError,
  detectIssueVideoType,
  detectUploadType,
  maxUploadBytes,
  validateUploadContent,
} from "./uploadValidation";
import type {
  AllowedIssueMediaType,
  AllowedIssueVideoType,
  AllowedUploadType,
} from "./uploadValidation";

export {
  ObjectContentError,
  UploadTooLargeError,
  maxUploadBytes,
  detectIssueVideoType,
  detectUploadType,
  validatePdfInWorker,
  validateUploadContent,
} from "./uploadValidation";
export type {
  AllowedIssueMediaType,
  AllowedIssueVideoType,
  AllowedUploadType,
} from "./uploadValidation";

const gcsServiceAccountJson = process.env.GCS_SERVICE_ACCOUNT_JSON?.trim();
const projectId = process.env.GCS_PROJECT_ID?.trim();

// Google Cloud Storage with standard Google credentials only: an explicit
// service-account key (GCS_SERVICE_ACCOUNT_JSON), GOOGLE_APPLICATION_CREDENTIALS,
// or ambient Application Default Credentials. With none of these, storage
// operations fail and upload signing answers OBJECT_STORAGE_UNAVAILABLE; there
// is no other fallback, and session credentials are never sent to storage.
function createObjectStorageClient(): Storage {
  const options: ConstructorParameters<typeof Storage>[0] = {};
  if (projectId) options.projectId = projectId;
  if (gcsServiceAccountJson) {
    options.credentials = JSON.parse(gcsServiceAccountJson);
  }
  return new Storage(options);
}

export const objectStorageClient = createObjectStorageClient();

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/** A caller attempted to attach an object not reserved for its tenant. */
export class ObjectOwnershipError extends Error {
  constructor(message = "Object does not belong to this tenant") {
    super(message);
    this.name = "ObjectOwnershipError";
    Object.setPrototypeOf(this, ObjectOwnershipError.prototype);
  }
}

export class ObjectGenerationError extends Error {
  constructor(message = "Uploaded object changed during validation") {
    super(message);
    this.name = "ObjectGenerationError";
    Object.setPrototypeOf(this, ObjectGenerationError.prototype);
  }
}

/** The reservation namespace is part of the upload security boundary. */
export function isTenantReservedObjectPath(objectPath: string, tenantId: number | string): boolean {
  return objectPath.startsWith(`/objects/uploads/tenant-${tenantId}/`);
}

// Stored objects are served from the app's own origin, so their content type
// decides what a browser does with them. Only these render inline; anything
// else (HTML, SVG, XML, scripts, Office files, unknown bytes) is a download.
const INLINE_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/heic", "image/heif",
]);

/**
 * Security headers for serving a stored object. nosniff stops a browser from
 * second-guessing the stored type; non-inline types are forced to download;
 * and the sandboxing CSP keeps anything that is rendered from running script
 * or loading content on the app origin. PDFs and videos are left without the
 * CSP: browsers' built-in PDF viewers refuse to run in a sandboxed document,
 * and neither type can execute script against the app.
 */
export function objectDownloadSecurityHeaders(contentType: string): Record<string, string> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  const isPdf = type === "application/pdf";
  const isVideo = type.startsWith("video/");
  if (!isPdf && !isVideo && !INLINE_IMAGE_TYPES.has(type)) {
    headers["Content-Disposition"] = "attachment";
  }
  if (!isPdf && !isVideo) {
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
  }
  return headers;
}

const OOXML_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const LEGACY_OFFICE_TYPES: Record<string, string> = {
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};
const TEXT_TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/**
 * Classify a DocTrack/SafeTrack document from its first bytes (and, for
 * container formats that share a signature, its file extension). Returns the
 * content type to store, or null when the file is not an allowed document:
 * PDF, Word/Excel/PowerPoint (current and legacy formats), images, the video
 * formats the upload form offers, or UTF-8 plain text/CSV.
 */
export function detectDocumentUploadType(bytes: Buffer, fileName: string): string | null {
  const extension = (fileName.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "").toLowerCase();
  const known = detectUploadType(bytes) ?? detectIssueVideoType(bytes);
  if (known) return known;
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return "video/x-msvideo";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
    && ascii(4, Math.min(bytes.length, 64)).includes("matroska")) return "video/x-matroska";
  // Office Open XML files are ZIP containers.
  if (OOXML_TYPES[extension] && bytes.length >= 4 && ascii(0, 4) === "PK\x03\x04") return OOXML_TYPES[extension];
  // Legacy Office files are OLE compound documents.
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (LEGACY_OFFICE_TYPES[extension] && bytes.length >= 8 && cfb.every((byte, index) => bytes[index] === byte)) {
    return LEGACY_OFFICE_TYPES[extension];
  }
  if (TEXT_TYPES[extension] && bytes.length > 0 && !bytes.includes(0)) {
    try {
      // stream: true tolerates a character cut off at the end of the sample.
      new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
      return TEXT_TYPES[extension];
    } catch {
      return null;
    }
  }
  return null;
}

type UsageMetadataFile = Pick<File, "name" | "getMetadata"> & { metadata?: File["metadata"] };

/** One finalised private object and its provider-reported size. */
export type StorageUsageEntry = { objectPath: string; sizeBytes: number };

export type StorageUsageChange =
  | { kind: "present"; objectPath: string; sizeBytes: number }
  | { kind: "removed"; objectPath: string };

/**
 * Receives tenant object lifecycle changes for the usage ledger
 * (storageUsageSnapshot.ts). Implementations must not throw.
 */
export interface StorageUsageRecorder {
  begin(tenantId: number): Promise<string | null>;
  record(tenantId: number, change: StorageUsageChange, pendingId: string | null): Promise<void>;
  abandon(pendingId: string): Promise<void>;
}

let storageUsageRecorder: StorageUsageRecorder | null = null;

/** Registered by the API at start-up; unit tests without a database leave it unset. */
export function setStorageUsageRecorder(recorder: StorageUsageRecorder | null): void {
  storageUsageRecorder = recorder;
}

/**
 * Mark a tenant lifecycle change as pending, apply it to the provider, then
 * record its outcome. Errors that guarantee nothing changed clear the marker;
 * any other failure leaves it so reconciliation re-checks the provider.
 */
async function trackStorageUsageChange<T>(
  tenantId: number | string,
  mutate: () => Promise<{ result: T; change: StorageUsageChange | null }>,
): Promise<T> {
  const recorder = storageUsageRecorder;
  const clientId = Number(tenantId);
  if (!recorder || !Number.isSafeInteger(clientId) || clientId <= 0) return (await mutate()).result;
  const pendingId = await recorder.begin(clientId);
  let outcome: Awaited<ReturnType<typeof mutate>>;
  try {
    outcome = await mutate();
  } catch (error) {
    if (pendingId && (error instanceof ObjectOwnershipError || error instanceof ObjectNotFoundError)) {
      await recorder.abandon(pendingId);
    }
    throw error;
  }
  // Without a change to record the marker stays, so reconciliation re-checks.
  if (outcome.change) await recorder.record(clientId, outcome.change, pendingId);
  return outcome.result;
}

function isProviderNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 404;
}

/** Provider-reported size of a private object this tenant owns, else null. */
async function ownedObjectSize(file: UsageMetadataFile, owner: string): Promise<number | null> {
  // Listings already carry each object's metadata; reuse it instead of one
  // metadata request per object.
  let metadata = file.metadata?.size !== undefined ? file.metadata : undefined;
  if (!metadata) {
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (isProviderNotFound(error)) return null;
      throw error;
    }
  }
  const rawPolicy = metadata.metadata?.["custom:aclPolicy"];
  if (!rawPolicy) return null;

  let policy: ObjectAclPolicy;
  try {
    policy = JSON.parse(String(rawPolicy)) as ObjectAclPolicy;
  } catch {
    return null;
  }
  if (policy.owner !== owner || policy.visibility !== "private") return null;

  const size = Number(metadata.size);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/**
 * List the private objects owned by one tenant, once each, with their
 * provider sizes. ACL metadata is the ownership source of truth.
 */
export async function listOwnedObjectMetadata(
  objects: Array<{ objectPath: string; file: UsageMetadataFile }>,
  tenantId: number | string,
): Promise<StorageUsageEntry[]> {
  const owner = String(tenantId);
  const unique = [...new Map(objects.map((object) => [object.objectPath, object])).values()];
  const entries: StorageUsageEntry[] = [];
  for (let offset = 0; offset < unique.length; offset += 10) {
    const batch = unique.slice(offset, offset + 10);
    const sizes = await Promise.all(batch.map(({ file }) => ownedObjectSize(file, owner)));
    sizes.forEach((sizeBytes, index) => {
      if (sizeBytes !== null) entries.push({ objectPath: batch[index].objectPath, sizeBytes });
    });
  }
  return entries;
}

export function sumStorageUsageEntries(entries: StorageUsageEntry[]): { usedBytes: number; objectCount: number } {
  let usedBytes = 0;
  for (const { sizeBytes } of entries) {
    if (!Number.isSafeInteger(usedBytes + sizeBytes)) {
      throw new Error("Tenant storage usage exceeds the supported range");
    }
    usedBytes += sizeBytes;
  }
  return { usedBytes, objectCount: entries.length };
}

export async function sumOwnedObjectMetadata(
  files: UsageMetadataFile[],
  tenantId: number | string,
): Promise<{ usedBytes: number; objectCount: number }> {
  return sumStorageUsageEntries(
    await listOwnedObjectMetadata(files.map((file) => ({ objectPath: file.name, file })), tenantId),
  );
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const configuredPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS?.trim();
    if (configuredPaths) {
      const paths = Array.from(
        new Set(
          configuredPaths
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path.length > 0),
        ),
      );
      if (paths.length === 0) {
        throw new Error("PUBLIC_OBJECT_SEARCH_PATHS must contain at least one non-empty path");
      }
      return paths;
    }

    const bucket = getConfiguredBucket("public");
    const prefixes = (process.env.GCS_PUBLIC_PREFIXES || "public")
      .split(",")
      .map(normalizePrefix)
      .filter((prefix) => prefix.length > 0);
    const paths = Array.from(new Set(prefixes.map((prefix) => `/${bucket}/${prefix}`)));
    if (paths.length === 0) {
      throw new Error("GCS_PUBLIC_PREFIXES must contain at least one non-empty prefix");
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const configuredDir = process.env.PRIVATE_OBJECT_DIR?.trim();
    if (configuredDir) {
      return configuredDir;
    }

    const bucket = getConfiguredBucket("private");
    const prefix = normalizePrefix(process.env.GCS_PRIVATE_PREFIX || "private");
    return prefix ? `/${bucket}/${prefix}` : `/${bucket}`;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600, byteRange?: { start: number; end: number }): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream(byteRange ? { start: byteRange.start, end: byteRange.end } : undefined);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const contentType = (metadata.contentType as string) || "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
      // Lets video players seek with byte ranges from the first response.
      "Accept-Ranges": "bytes",
      ...objectDownloadSecurityHeaders(contentType),
    };
    if (metadata.size) {
      const length = byteRange ? byteRange.end - byteRange.start + 1 : Number(metadata.size);
      headers["Content-Length"] = String(length);
      if (byteRange) {
        headers["Content-Range"] = `bytes ${byteRange.start}-${byteRange.end}/${metadata.size}`;
      }
    }

    return new Response(webStream, { status: byteRange ? 206 : 200, headers });
  }

  /**
   * List finalised private objects owned by one tenant with authoritative
   * provider-reported sizes. Request sizes and attachment-table metadata can be
   * missing or client supplied, so they are never used. Only the tenant's own
   * provider prefixes are listed, plus the tenant's legacy references outside
   * them, so this never scans other tenants' objects.
   */
  async listTenantStorageObjects(tenantId: number | string, referencedPaths: string[] = []): Promise<StorageUsageEntry[]> {
    if (process.env.NODE_ENV === "test" && process.env.OBJECT_STORAGE_TEST_FAKE_USAGE === "1") {
      const syntheticBytes = Number(tenantId);
      if (!Number.isSafeInteger(syntheticBytes) || syntheticBytes < 0) {
        throw new Error("Test tenant ID cannot be represented as storage usage");
      }
      return [{ objectPath: `/objects/test-fake-usage/tenant-${tenantId}`, sizeBytes: syntheticBytes }];
    }
    return listOwnedObjectMetadata(await this.tenantObjectCandidates(tenantId, referencedPaths), tenantId);
  }

  /**
   * The tenant's own provider prefixes plus its legacy references outside
   * them. Ownership is not checked here: callers filter by the ACL owner.
   */
  private async tenantObjectCandidates(
    tenantId: number | string,
    referencedPaths: string[],
  ): Promise<Array<{ objectPath: string; file: File }>> {
    const { bucketName, objectName: privatePrefix } = parseObjectPath(this.getPrivateObjectDir());
    const root = privatePrefix.replace(/\/$/, "");
    const bucket = objectStorageClient.bucket(bucketName);
    const tenantPrefixes = [
      `uploads/tenant-${tenantId}/`,
      `finalized/tenant-${tenantId}/`,
    ];
    const listings = await Promise.all(
      tenantPrefixes.map((prefix) => bucket.getFiles({ prefix: root ? `${root}/${prefix}` : prefix })),
    );
    const tenantObjects = listings.flatMap(([files]) => files.map((file) => ({
      objectPath: `/objects/${root ? file.name.slice(root.length + 1) : file.name}`,
      file,
    })));
    const legacyObjects = referencedPaths
      .filter((objectPath) => !tenantPrefixes.some((prefix) => objectPath.startsWith(`/objects/${prefix}`)))
      .map((objectPath) => ({ objectPath, file: this.objectEntityFileRef(objectPath) }))
      .filter((object): object is { objectPath: string; file: File } => object.file !== null);
    return [...new Map([...tenantObjects, ...legacyObjects].map((object) => [object.objectPath, object])).values()];
  }

  /**
   * Move every object this tenant owns (private ACL, same set as
   * listTenantStorageObjects) to a provider storage class. Objects already in
   * that class are not rewritten: a rewrite of a cold object counts as an early
   * deletion. The rewrite keeps the object's path, content and ACL metadata, and
   * every class stays readable by the same code.
   */
  async setTenantObjectsStorageClass(
    tenantId: number | string,
    referencedPaths: string[],
    storageClass: string,
  ): Promise<{ changed: number; unchanged: number }> {
    const owner = String(tenantId);
    let changed = 0;
    let unchanged = 0;
    for (const { file } of await this.tenantObjectCandidates(tenantId, referencedPaths)) {
      let metadata = file.metadata?.size !== undefined ? file.metadata : undefined;
      if (!metadata) {
        try {
          [metadata] = await file.getMetadata();
        } catch (error) {
          if (isProviderNotFound(error)) continue;
          throw error;
        }
      }
      let policy: ObjectAclPolicy | null = null;
      try {
        const raw = metadata.metadata?.["custom:aclPolicy"];
        policy = raw ? JSON.parse(String(raw)) as ObjectAclPolicy : null;
      } catch {
        policy = null;
      }
      if (policy?.owner !== owner || policy.visibility !== "private") continue;
      if (String(metadata.storageClass ?? "").toUpperCase() === storageClass) {
        unchanged++;
        continue;
      }
      await file.setStorageClass(storageClass);
      changed++;
    }
    return { changed, unchanged };
  }

  async getObjectEntityUploadURL(
    tenantId?: number | string,
    contentType?: string,
    fileExtension = "",
  ): Promise<string> {
    if (process.env.NODE_ENV === "test" && process.env.OBJECT_STORAGE_TEST_SIGNING_FAILURE === "1") {
      throw new Error("TEST_ONLY_PROVIDER_CREDENTIAL_SECRET bucket-internal-name");
    }
    if (fileExtension && !/^\.[a-z0-9]{1,10}$/i.test(fileExtension)) {
      throw new Error("Invalid upload file extension");
    }
    const privateObjectDir = this.getPrivateObjectDir();

    const objectId = randomUUID();
    const tenantSegment = tenantId === undefined ? "" : `/tenant-${tenantId}`;
    const fullPath = `${privateObjectDir}/uploads${tenantSegment}/${objectId}${fileExtension.toLowerCase()}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
      contentType,
    });
  }

  /** Map a /objects/ path to its provider file without checking it exists. */
  private objectEntityFileRef(objectPath: string): File | null {
    if (!objectPath.startsWith("/objects/")) {
      return null;
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      return null;
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    return objectStorageClient.bucket(bucketName).file(objectName);
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (process.env.NODE_ENV === "test" && process.env.OBJECT_STORAGE_TEST_SIGNING_FAILURE === "1") {
      throw new Error("TEST_ONLY_PROVIDER_CREDENTIAL_SECRET bucket-internal-name");
    }
    const objectFile = this.objectEntityFileRef(objectPath);
    if (!objectFile) {
      throw new ObjectNotFoundError();
    }
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const owner = aclPolicy.visibility === "private" ? Number(aclPolicy.owner) : NaN;
    return trackStorageUsageChange(owner, async () => {
      const objectFile = await this.getObjectEntityFile(normalizedPath);
      await setObjectAclPolicy(objectFile, aclPolicy);
      return { result: normalizedPath, change: await presentChange(objectFile, normalizedPath) };
    });
  }

  /**
   * Finalise a direct upload after the PUT has completed. A signed PUT cannot
   * carry our ACL metadata, so setting it before upload is both ineffective and
   * (with GCS) fails because the object does not exist yet.
   *
   * Only paths issued for this tenant may be claimed here. Legacy backfills are
   * deliberately a separate, explicit operation and must be preceded by a
   * tenant-owned database lookup in the caller.
   */
  async finalizeTenantUpload(objectPath: string, tenantId: number | string): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(objectPath);
    if (!isTenantReservedObjectPath(normalizedPath, tenantId)) {
      throw new ObjectOwnershipError("Upload was not reserved for this tenant");
    }
    await this.enforceUploadSizeLimit(normalizedPath, tenantId);
    return this.setTenantObjectAcl(normalizedPath, tenantId);
  }

  /**
   * Refuse a new upload over maxUploadBytes() before it becomes a record. The
   * rejected bytes were never attached to anything, so they are dropped rather
   * than left in the bucket costing money. Objects already finalised (outside
   * this tenant's upload reservation) are never touched.
   */
  async enforceUploadSizeLimit(objectPath: string, tenantId: number | string): Promise<void> {
    const normalizedPath = this.normalizeObjectEntityPath(objectPath);
    if (!isTenantReservedObjectPath(normalizedPath, tenantId)) return;
    const file = await this.getObjectEntityFile(normalizedPath);
    const [metadata] = await file.getMetadata();
    const limit = maxUploadBytes();
    if (Number(metadata.size) > limit) {
      await this.discardTenantUpload(normalizedPath, tenantId).catch(() => {});
      throw new UploadTooLargeError(limit);
    }
  }

  /** Delete an unfinalised reserved upload after content inspection rejects it. */
  async discardTenantUpload(objectPath: string, tenantId: number | string): Promise<void> {
    const normalizedPath = this.normalizeObjectEntityPath(objectPath);
    if (!normalizedPath.startsWith(`/objects/uploads/tenant-${tenantId}/`)) {
      throw new ObjectOwnershipError("Upload was not reserved for this tenant");
    }
    const file = await this.getObjectEntityFile(normalizedPath);
    await file.delete({ ignoreNotFound: true });
  }

  /** Delete a finalised private object only when it belongs to this tenant. */
  async deleteTenantObject(objectPath: string, tenantId: number | string): Promise<void> {
    return trackStorageUsageChange(tenantId, async () => {
      const file = await this.getObjectEntityFile(objectPath);
      const acl = await getObjectAclPolicy(file);
      if (acl?.owner !== String(tenantId) || acl.visibility !== "private") {
        throw new ObjectOwnershipError();
      }
      await file.delete({ ignoreNotFound: true });
      return { result: undefined, change: { kind: "removed", objectPath } };
    });
  }

  /**
   * Inspect no more than 8KiB of an uploaded object.  Content-Type metadata is
   * attacker controlled, so consumers must use this before attaching or
   * issuing a download URL for a restricted upload.
   */
  async verifyFileSignature(objectPath: string, allowed: ReadonlySet<AllowedUploadType>): Promise<AllowedUploadType> {
    const file = await this.getObjectEntityFile(objectPath);
    const [bytes] = await file.download({ start: 0, end: 8191 });
    const kind = detectUploadType(bytes);
    if (!kind || !allowed.has(kind)) throw new ObjectContentError();
    return kind;
  }

  /**
   * Check an uploaded DocTrack/SafeTrack document's bytes against the
   * document allow-list and store the content type derived from them, so the
   * client-declared type is never what the file is later served as. Callers
   * must have established that the object belongs to the tenant first.
   */
  async verifyDocumentUpload(objectPath: string, fileName: string): Promise<string> {
    const file = await this.getObjectEntityFile(this.normalizeObjectEntityPath(objectPath));
    const [bytes] = await file.download({ start: 0, end: 8191 });
    const contentType = detectDocumentUploadType(bytes, fileName);
    if (!contentType) {
      throw new ObjectContentError("Choose a PDF, Word, Excel, PowerPoint, image, video, text or CSV file");
    }
    const [metadata] = await file.getMetadata();
    if (String(metadata.contentType ?? "").toLowerCase() !== contentType) {
      await file.setMetadata({ contentType });
    }
    return contentType;
  }

  /**
   * Validate one exact staging generation, copy that generation to a fresh
   * immutable key, and only then grant the tenant ACL. The signed staging key
   * is never persisted, so replacing it after validation cannot swap content.
   */
  async finalizeVerifiedTenantUpload(
    objectPath: string,
    tenantId: number | string,
    allowed: ReadonlySet<AllowedUploadType>,
  ): Promise<{ objectPath: string; contentType: AllowedUploadType }> {
    const normalizedPath = this.normalizeObjectEntityPath(objectPath);
    if (!isTenantReservedObjectPath(normalizedPath, tenantId)) {
      throw new ObjectOwnershipError("Upload was not reserved for this tenant");
    }
    const staging = await this.getObjectEntityFile(normalizedPath);
    const [metadata] = await staging.getMetadata();
    const generation = String(metadata.generation ?? "");
    const metageneration = String(metadata.metageneration ?? "");
    const size = Number(metadata.size);
    if (!generation || !metageneration || !Number.isSafeInteger(size) || size <= 0 || size > MAX_RESTRICTED_UPLOAD_BYTES) {
      throw new ObjectContentError(`File must be between 1 byte and ${MAX_RESTRICTED_UPLOAD_BYTES} bytes`);
    }

    // Pin both metadata and body reads to the generation observed above.
    const pinned = staging.bucket.file(staging.name, {
      generation,
      preconditionOpts: {
        ifGenerationMatch: generation,
        ifMetagenerationMatch: metageneration,
      },
    });
    const [pinnedMetadata] = await pinned.getMetadata();
    if (String(pinnedMetadata.generation) !== generation || String(pinnedMetadata.metageneration) !== metageneration) {
      throw new ObjectGenerationError();
    }
    const [bytes] = await pinned.download({ validation: "crc32c" });
    if (bytes.length !== size) throw new ObjectGenerationError("Uploaded object size changed during validation");
    const validated = await validateUploadContent(bytes, allowed);
    const contentType = validated.contentType;
    const declaredType = String(pinnedMetadata.contentType ?? "").toLowerCase();
    const heifInputTypes = new Set(["image/heic", "image/heif"]);
    const matchingDeclaredType = declaredType === validated.sourceContentType
      || (heifInputTypes.has(declaredType) && heifInputTypes.has(validated.sourceContentType));
    if (declaredType && !matchingDeclaredType) {
      throw new ObjectContentError("Uploaded object does not match its content type");
    }

    const privateDir = this.getPrivateObjectDir().replace(/\/$/, "");
    const { bucketName, objectName } = parseObjectPath(
      `${privateDir}/finalized/tenant-${tenantId}/${randomUUID()}${uploadTypeExtension(contentType)}`,
    );
    const destination = objectStorageClient.bucket(bucketName).file(objectName);
    try {
      if (validated.normalizedBytes) {
        // Decoding then re-encoding strips trailing/polyglot bytes and metadata
        // from images. The immutable object is therefore data we produced,
        // rather than the attacker's original container.
        await destination.save(validated.normalizedBytes, {
          resumable: false,
          contentType,
          preconditionOpts: { ifGenerationMatch: 0 },
          validation: "crc32c",
        });
      } else {
        await pinned.copy(destination, {
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      }
    } catch (error: any) {
      if (error?.code === 409 || error?.code === 412) throw new ObjectGenerationError();
      throw error;
    }
    const finalPath = this.normalizeObjectEntityPath(
      `https://storage.googleapis.com/${bucketName}/${objectName}`,
    );
    const [destinationMetadata] = await destination.getMetadata();
    await destination.setMetadata(
      { contentType },
      {
        preconditionOpts: {
          ifGenerationMatch: destinationMetadata.generation,
          ifMetagenerationMatch: destinationMetadata.metageneration,
        },
      },
    );
    await this.setTenantObjectAcl(finalPath, tenantId);
    // Delete only the generation we inspected. A concurrently replaced staging
    // object remains private and expires through normal staging cleanup.
    await pinned.delete({ ignoreNotFound: true }).catch(() => {});
    return { objectPath: finalPath, contentType };
  }

  /**
   * Save bytes the server already holds and has checked (a certificate emailed
   * to the business, lib/certificateInbox.ts) as a private object the tenant
   * owns. The caller validates the content first.
   */
  async storeTenantFile(tenantId: number | string, bytes: Buffer, contentType: string, extension: string): Promise<string> {
    if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error("Invalid file extension");
    const privateDir = this.getPrivateObjectDir().replace(/\/$/, "");
    const { bucketName, objectName } = parseObjectPath(`${privateDir}/finalized/tenant-${tenantId}/${randomUUID()}${extension}`);
    const destination = objectStorageClient.bucket(bucketName).file(objectName);
    await destination.save(bytes, {
      resumable: false,
      contentType,
      preconditionOpts: { ifGenerationMatch: 0 },
      validation: "crc32c",
    });
    const objectPath = this.normalizeObjectEntityPath(`https://storage.googleapis.com/${bucketName}/${objectName}`);
    return this.setTenantObjectAcl(objectPath, tenantId);
  }

  /** Read back a private object the tenant owns (at most maxBytes). */
  async readTenantFile(objectPath: string, tenantId: number | string, maxBytes: number): Promise<Buffer> {
    const file = await this.getObjectEntityFile(objectPath);
    await this.assertTenantObjectOwnership(file, tenantId);
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) > maxBytes) throw new ObjectContentError("File is too large");
    const [bytes] = await file.download({ validation: "crc32c" });
    return bytes;
  }

  /**
   * Secure FixTrack media uploads. Images use the existing bounded decoder and
   * normalization path; videos are signature-checked and copied from one pinned
   * generation to a fresh immutable tenant key.
   */
  async finalizeVerifiedIssueMediaUpload(
    objectPath: string,
    tenantId: number | string,
  ): Promise<{ objectPath: string; contentType: AllowedIssueMediaType }> {
    const normalizedPath = this.normalizeObjectEntityPath(objectPath);
    if (!isTenantReservedObjectPath(normalizedPath, tenantId)) {
      throw new ObjectOwnershipError("Upload was not reserved for this tenant");
    }

    const staging = await this.getObjectEntityFile(normalizedPath);
    const [metadata] = await staging.getMetadata();
    const contentType = String(metadata.contentType ?? "").toLowerCase() as AllowedIssueMediaType;
    const imageTypes = new Set<AllowedUploadType>([
      "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif",
    ]);
    if (contentType.startsWith("image/") && imageTypes.has(contentType as AllowedUploadType)) {
      return this.finalizeVerifiedTenantUpload(normalizedPath, tenantId, imageTypes);
    }

    const videoTypes = new Set<AllowedIssueVideoType>(["video/mp4", "video/quicktime", "video/webm"]);
    if (!videoTypes.has(contentType as AllowedIssueVideoType)) {
      throw new ObjectContentError("Choose a JPEG, PNG, WebP, MP4, MOV, or WebM file");
    }

    const generation = String(metadata.generation ?? "");
    const metageneration = String(metadata.metageneration ?? "");
    const size = Number(metadata.size);
    if (Number.isSafeInteger(size) && size > maxUploadBytes()) throw new UploadTooLargeError();
    if (!generation || !metageneration || !Number.isSafeInteger(size) || size <= 0) {
      throw new ObjectContentError("Video must not be empty");
    }

    const pinned = staging.bucket.file(staging.name, {
      generation,
      preconditionOpts: {
        ifGenerationMatch: generation,
        ifMetagenerationMatch: metageneration,
      },
    });
    const [pinnedMetadata] = await pinned.getMetadata();
    if (String(pinnedMetadata.generation) !== generation || String(pinnedMetadata.metageneration) !== metageneration) {
      throw new ObjectGenerationError();
    }
    const [prefix] = await pinned.download({ start: 0, end: 8191 });
    if (detectIssueVideoType(prefix) !== contentType) {
      throw new ObjectContentError("Video contents do not match their declared format");
    }

    const privateDir = this.getPrivateObjectDir().replace(/\/$/, "");
    const { bucketName, objectName } = parseObjectPath(
      `${privateDir}/finalized/tenant-${tenantId}/${randomUUID()}${uploadTypeExtension(contentType)}`,
    );
    const destination = objectStorageClient.bucket(bucketName).file(objectName);
    try {
      await pinned.copy(destination, { preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (error: any) {
      if (error?.code === 409 || error?.code === 412) throw new ObjectGenerationError();
      throw error;
    }

    const finalPath = this.normalizeObjectEntityPath(
      `https://storage.googleapis.com/${bucketName}/${objectName}`,
    );
    const [destinationMetadata] = await destination.getMetadata();
    await destination.setMetadata(
      { contentType },
      {
        preconditionOpts: {
          ifGenerationMatch: destinationMetadata.generation,
          ifMetagenerationMatch: destinationMetadata.metageneration,
        },
      },
    );
    await this.setTenantObjectAcl(finalPath, tenantId);
    await pinned.delete({ ignoreNotFound: true }).catch(() => {});
    return { objectPath: finalPath, contentType };
  }

  /**
   * Backfills an ACL for a pre-tenant-namespace object. Callers may use this
   * only after establishing ownership from a tenant-scoped DB row; it never
   * overwrites an existing owner's ACL.
   */
  async backfillTenantObjectAcl(objectPath: string, tenantId: number | string): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(objectPath);
    if (!normalizedPath.startsWith("/objects/")) {
      throw new ObjectOwnershipError("Not a private object path");
    }
    return this.setTenantObjectAcl(normalizedPath, tenantId);
  }

  private async setTenantObjectAcl(objectPath: string, tenantId: number | string): Promise<string> {
    return trackStorageUsageChange(tenantId, async () => {
      const objectFile = await this.getObjectEntityFile(objectPath);
      const existing = await getObjectAclPolicy(objectFile);
      if (existing?.owner && existing.owner !== String(tenantId)) {
        throw new ObjectOwnershipError();
      }
      if (existing?.visibility === "public") {
        throw new ObjectOwnershipError("Public objects cannot be attached to a tenant");
      }
      if (!existing?.owner) {
        await setObjectAclPolicy(objectFile, {
          owner: String(tenantId),
          visibility: "private",
        });
      }
      return { result: objectPath, change: await presentChange(objectFile, objectPath) };
    });
  }

  /**
   * Generate a short-lived signed GET URL for an object stored via
   * getObjectEntityUploadURL / normalizeObjectEntityPath.
   * objectPath must start with /objects/  (e.g. /objects/uploads/<uuid>).
   */
  async getSignedDownloadURL(
    objectPath: string,
    ttlSec = 900,
    allowedTypes?: ReadonlySet<AllowedUploadType>,
    expectedTenantId?: number | string,
  ): Promise<string> {
    // Resolve through getObjectEntityFile so callers cannot get a signed URL
    // for a nonexistent private object.
    const objectFile = await this.getObjectEntityFile(objectPath);
    if (allowedTypes) {
      const [metadata] = await objectFile.getMetadata();
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RESTRICTED_UPLOAD_BYTES) {
        throw new ObjectContentError("Object size is not allowed");
      }
      const [bytes] = await objectFile.download({ validation: "crc32c" });
      await validateUploadContent(bytes, allowedTypes);
    }
    const acl = await getObjectAclPolicy(objectFile);
    const clientId = Number(acl?.owner);
    if (acl?.visibility !== "private" || !Number.isSafeInteger(clientId) || clientId <= 0) {
      throw new ObjectOwnershipError("Private object has no tenant owner");
    }
    if (expectedTenantId !== undefined && acl.owner !== String(expectedTenantId)) {
      throw new ObjectOwnershipError("Object does not belong to the record's tenant");
    }
    return createDownloadToken(objectPath, clientId, ttlSec);
  }

  /** Require the stored object ACL owner to match the tenant on its DB record. */
  async assertTenantObjectOwnership(
    objectFile: File,
    tenantId: number | string,
  ): Promise<void> {
    const acl = await getObjectAclPolicy(objectFile);
    if (acl?.visibility !== "private" || acl.owner !== String(tenantId)) {
      throw new ObjectOwnershipError("Object does not belong to the record's tenant");
    }
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

/**
 * Ledger entry for an object that now carries a tenant ACL. Null when its size
 * cannot be read: the ACL change has already succeeded, so the pending marker
 * is left for reconciliation rather than failing the caller.
 */
async function presentChange(objectFile: File, objectPath: string): Promise<StorageUsageChange | null> {
  const metadata = await objectFile.getMetadata().then(([value]) => value, () => null);
  if (!metadata) return null;
  const sizeBytes = Number(metadata.size);
  return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
    ? { kind: "present", objectPath, sizeBytes }
    : null;
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
  contentType,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
  /** Bound into a GCS V4 PUT signature when provided. */
  contentType?: string;
}): Promise<string> {
  const action = method === "PUT" ? "write" : method === "DELETE" ? "delete" : "read";
  const [signedUrl] = await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .getSignedUrl({
      version: "v4",
      action,
      expires: Date.now() + ttlSec * 1000,
      ...(method === "PUT" && contentType ? { contentType } : {}),
    });
  return signedUrl;
}

function getConfiguredBucket(kind: "private" | "public"): string {
  const bucket = (
    kind === "private" ? process.env.GCS_PRIVATE_BUCKET : process.env.GCS_PUBLIC_BUCKET
  )?.trim() || process.env.GCS_BUCKET_NAME?.trim();
  if (!bucket) {
    throw new Error(
      `GCS_${kind === "private" ? "PRIVATE" : "PUBLIC"}_BUCKET or GCS_BUCKET_NAME must be configured`,
    );
  }
  return bucket;
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

function uploadTypeExtension(contentType: AllowedIssueMediaType): string {
  const extensions: Record<AllowedIssueMediaType, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return extensions[contentType];
}
