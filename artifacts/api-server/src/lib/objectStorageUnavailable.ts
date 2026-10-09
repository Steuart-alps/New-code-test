import type { Request, Response } from "express";

export const OBJECT_STORAGE_UNAVAILABLE_CODE = "OBJECT_STORAGE_UNAVAILABLE";
export const OBJECT_STORAGE_UNAVAILABLE_MESSAGE = "File uploads are temporarily unavailable. Please try again later.";

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