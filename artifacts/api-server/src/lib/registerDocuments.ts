/**
 * Attached documents (PDF, JPEG or PNG) on register and COSHHTrack records:
 * safety data sheets, survey reports, assessments and examination reports.
 * Uploads use the verified finalisation flow (pinned generation, content
 * signature check, immutable copy, tenant ACL) also used for contractor
 * certificates and photos.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectOwnershipError,
  ObjectContentError,
  ObjectGenerationError,
  type AllowedUploadType,
} from "./objectStorage";
import { respondObjectStorageDownloadUnavailable } from "./objectStorageUnavailable";

export const ALLOWED_DOCUMENT_TYPES: ReadonlySet<AllowedUploadType> = new Set(["application/pdf", "image/jpeg", "image/png"]);

export const documentStorage = new ObjectStorageService();

/** Body fields for attaching a document: the uploaded path and its file name. */
export const documentFields = {
  objectPath: z.string().min(1).max(2000).nullish(),
  fileName: z.string().trim().max(500).nullish().transform((value) => value || null),
};

export interface StoredDocument {
  objectPath: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
}

/**
 * Turns a just-uploaded staging object into an immutable, content-checked,
 * tenant-owned file. Sends the error response and returns null on failure.
 */
async function finalizeDocument(req: Request, res: Response, objectPath: string, clientId: number) {
  try {
    return await documentStorage.finalizeVerifiedTenantUpload(objectPath, clientId, ALLOWED_DOCUMENT_TYPES);
  } catch (err) {
    // Rejected objects never received a tenant ACL; remove them best-effort.
    await documentStorage.discardTenantUpload(objectPath, clientId).catch(() => {});
    if (!(err instanceof ObjectNotFoundError || err instanceof ObjectOwnershipError
      || err instanceof ObjectContentError || err instanceof ObjectGenerationError)) {
      req.log.error({ err }, "Could not finalise register document upload");
    }
    const error = err instanceof ObjectNotFoundError ? "Uploaded file not found"
      : err instanceof ObjectContentError ? "The file must be a PDF, JPEG or PNG"
      : err instanceof ObjectGenerationError ? err.message
      : err instanceof ObjectOwnershipError ? err.message : "Could not secure the uploaded file";
    res.status(err instanceof ObjectNotFoundError ? 404
      : err instanceof ObjectContentError ? 400
      : err instanceof ObjectGenerationError ? 409 : 403).json({ error });
    return null;
  }
}

/** Responds with a short-lived download link for a record's attached file. */
export async function sendDownloadUrl(req: Request, res: Response, objectPath: string | null, fileName: string | null, clientId: number, recordId: number) {
  if (!objectPath) return res.status(404).json({ error: "No file attached" });
  try {
    const downloadUrl = await documentStorage.getSignedDownloadURL(objectPath, 900, ALLOWED_DOCUMENT_TYPES, clientId);
    return res.json({ downloadUrl, fileName });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "File not found" });
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: "File is not available for this account" });
    if (err instanceof ObjectContentError) return res.status(409).json({ error: "File failed its content check" });
    return respondObjectStorageDownloadUnavailable(req, res, err, "register document download", { recordId, clientId });
  }
}

/**
 * Resolves the document fields for a create/update. An unchanged path keeps
 * the stored file; null detaches it (the stored object is kept); a new path
 * must be a fresh upload for this client and is verified and finalised.
 */
export async function resolveDocument(
  req: Request, res: Response, clientId: number,
  input: { objectPath?: string | null; fileName?: string | null },
  existing: StoredDocument | null,
): Promise<StoredDocument | "kept" | null> {
  if (input.objectPath === undefined) return existing ? "kept" : { objectPath: null, fileName: null, fileSize: null, mimeType: null };
  if (input.objectPath === null) return { objectPath: null, fileName: null, fileSize: null, mimeType: null };
  if (existing && input.objectPath === existing.objectPath) return "kept";
  const finalized = await finalizeDocument(req, res, input.objectPath, clientId);
  if (!finalized) return null;
  let size = NaN;
  try {
    const [metadata] = await (await documentStorage.getObjectEntityFile(finalized.objectPath)).getMetadata();
    size = Number(metadata.size);
  } catch {
    // The size is display-only; the file itself is already secured.
  }
  return {
    objectPath: finalized.objectPath,
    fileName: input.fileName ?? "document",
    fileSize: Number.isSafeInteger(size) && size > 0 ? size : null,
    mimeType: finalized.contentType,
  };
}
