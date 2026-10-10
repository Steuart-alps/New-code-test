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
  detectIssueVideoType,
  detectUploadType,
  validateUploadContent,
} from "./uploadValidation";
import type {
  AllowedIssueMediaType,
  AllowedIssueVideoType,
  AllowedUploadType,
} from "./uploadValidation";

export {
  ObjectContentError,
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

const MAX_ISSUE_VIDEO_UPLOAD_BYTES = 250 * 1024 * 1024;
/** The reservation namespace is part of the upload security boundary. */
export function isTenantReservedObjectPath(objectPath: string, tenantId: number | string): boolean {
  return objectPath.startsWith(`/objects/uploads/tenant-${tenantId}/`);
}

type UsageMetadataFile = Pick<File, "name" | "getMetadata">;

export async function sumOwnedObjectMetadata(
  files: UsageMetadataFile[],
  tenantId: number | string,
): Promise<{ usedBytes: number; objectCount: number }> {
  const owner = String(tenantId);
  const uniqueFiles = [...new Map(files.map((file) => [file.name, file])).values()];
  let usedBytes = 0;
  let objectCount = 0;

  for (let offset = 0; offset < uniqueFiles.length; offset += 10) {
    const batch = uniqueFiles.slice(offset, offset + 10);
    const ownedSizes = await Promise.all(batch.map(async (file) => {
      const [metadata] = await file.getMetadata();
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
    }));

    for (const size of ownedSizes) {
      if (size === null) continue;
      if (!Number.isSafeInteger(usedBytes + size)) {
        throw new Error("Tenant storage usage exceeds the supported range");
      }
      usedBytes += size;
      objectCount += 1;
    }
  }

  return { usedBytes, objectCount };
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

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
      // Lets video players seek with byte ranges from the first response.
      "Accept-Ranges": "bytes",
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
   * Sum authoritative provider-reported sizes for finalised private objects
   * owned by one tenant. ACL metadata is the ownership source of truth: request
   * sizes and attachment-table metadata can be missing or client supplied.
   */
  async getTenantStorageUsage(tenantId: number | string, referencedPaths: string[] = []): Promise<{
    usedBytes: number;
    objectCount: number;
  }> {
    if (process.env.NODE_ENV === "test" && process.env.OBJECT_STORAGE_TEST_FAKE_USAGE === "1") {
      const syntheticBytes = Number(tenantId);
      if (!Number.isSafeInteger(syntheticBytes) || syntheticBytes < 0) {
        throw new Error("Test tenant ID cannot be represented as storage usage");
      }
      return { usedBytes: syntheticBytes, objectCount: 1 };
    }
    const { bucketName, objectName: privatePrefix } = parseObjectPath(this.getPrivateObjectDir());
    const root = privatePrefix.replace(/\/$/, "");
    const bucket = objectStorageClient.bucket(bucketName);
    const tenantPrefixes = [
      `${root}/uploads/tenant-${tenantId}/`,
      `${root}/finalized/tenant-${tenantId}/`,
    ];
    const listings = await Promise.all(
      tenantPrefixes.map((prefix) => bucket.getFiles({ prefix })),
    );
    const tenantFiles = listings.flatMap(([files]) => files);
    const tenantPrefixSet = tenantPrefixes.map((prefix) => `/objects/${prefix.slice(root.length + 1)}`);
    const legacyFiles = await Promise.all(referencedPaths
      .filter((objectPath) => !tenantPrefixSet.some((prefix) => objectPath.startsWith(prefix)))
      .map(async (objectPath) => {
        try {
          return await this.getObjectEntityFile(objectPath);
        } catch (error) {
          if (error instanceof ObjectNotFoundError) return null;
          throw error;
        }
      }));

    return sumOwnedObjectMetadata(
      [...tenantFiles, ...legacyFiles.filter((file): file is File => file !== null)],
      tenantId,
    );
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

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
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

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
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
    return this.setTenantObjectAcl(normalizedPath, tenantId);
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
    const file = await this.getObjectEntityFile(objectPath);
    const acl = await getObjectAclPolicy(file);
    if (acl?.owner !== String(tenantId) || acl.visibility !== "private") {
      throw new ObjectOwnershipError();
    }
    await file.delete({ ignoreNotFound: true });
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
    if (!generation || !metageneration || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ISSUE_VIDEO_UPLOAD_BYTES) {
      throw new ObjectContentError(`Video must be between 1 byte and ${MAX_ISSUE_VIDEO_UPLOAD_BYTES} bytes`);
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
    return objectPath;
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
