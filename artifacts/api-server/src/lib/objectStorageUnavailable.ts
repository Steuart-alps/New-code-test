import type { Request, Response } from "express";

export const OBJECT_STORAGE_UNAVAILABLE_CODE = "OBJECT_STORAGE_UNAVAILABLE";
export const OBJECT_STORAGE_UNAVAILABLE_MESSAGE = "File uploads are temporarily unavailable. Please try again later.";
export const OBJECT_STORAGE_DOWNLOAD_UNAVAILABLE_MESSAGE = "File downloads are temporarily unavailable. Please try again later.";

export function respondObjectStorageUnavailable(
  req: Request,
  res: Response,
  error: unknown,
  operation: string,
) {
  req.log.error({ err: error, operation }, "Object storage upload signing unavailable");
  return res.status(503).json({
    error: OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
    code: OBJECT_STORAGE_UNAVAILABLE_CODE,
  });
}

/**
 * Download counterpart of respondObjectStorageUnavailable. The provider error
 * (which can name buckets, service accounts or credential problems) only goes
 * to the structured server log; the response body is fixed.
 */
export function respondObjectStorageDownloadUnavailable(
  req: Request,
  res: Response,
  error: unknown,
  operation: string,
  context: Record<string, unknown> = {},
) {
  req.log.error({ ...context, err: error, operation }, "Object storage download signing unavailable");
  if (res.headersSent) return res;
  return res.status(503).json({
    error: OBJECT_STORAGE_DOWNLOAD_UNAVAILABLE_MESSAGE,
    code: OBJECT_STORAGE_UNAVAILABLE_CODE,
  });
}
