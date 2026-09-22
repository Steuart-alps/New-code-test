import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  GetStorageUsageResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { ObjectPermission } from "../lib/objectAcl";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, denyViewers } from "../middleware/requireAuth";
import { listTenantAttachmentObjectPaths } from "../lib/attachmentReferences";
import { createDownloadMeter } from "../lib/downloadUsage";
import { getMonthlyDownloadBytes, utcMonth } from "../lib/downloadUsage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024;
const GIB = 1024 ** 3;

function rateMinor(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw || !/^(?:\d+)(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

router.get("/storage/usage", requireAuth, requireClientAdmin, async (req: Request, res: Response): Promise<void> => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "No client context" });
    return;
  }

  try {
    const [referencedPaths, thresholdSetting] = await Promise.all([
      listTenantAttachmentObjectPaths(db, clientId),
      db.query.appSettingsTable.findFirst({
        where: and(
          eq(appSettingsTable.clientId, clientId),
          eq(appSettingsTable.key, "storageWarningThresholdBytes"),
        ),
      }),
    ]);
    const { usedBytes, objectCount } = await objectStorageService.getTenantStorageUsage(clientId, referencedPaths);
    const month = utcMonth();
    const monthlyDownloadBytes = await getMonthlyDownloadBytes(clientId, month);
    const storageRate = rateMinor("STORAGE_PRICE_GBP_PER_GIB_MONTH");
    const downloadRate = rateMinor("DOWNLOAD_PRICE_GBP_PER_GIB");
    const estimatedCost = storageRate !== null && downloadRate !== null ? {
      currency: "GBP" as const,
      storageMinorUnits: Math.round(storageRate * usedBytes / GIB),
      downloadMinorUnits: Math.round(downloadRate * monthlyDownloadBytes / GIB),
      totalMinorUnits: Math.round(storageRate * usedBytes / GIB) + Math.round(downloadRate * monthlyDownloadBytes / GIB),
    } : null;
    const configuredThreshold = Number(thresholdSetting?.value);
    const warningThresholdBytes = Number.isSafeInteger(configuredThreshold) && configuredThreshold > 0
      ? configuredThreshold
      : DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES;

    res.json(GetStorageUsageResponse.parse({
      usedBytes,
      objectCount,
      warningThresholdBytes,
      warning: usedBytes >= warningThresholdBytes,
      monthlyDownloadBytes,
      monthlyDownloadTrackingAvailable: true,
      month,
      estimatedCost,
    }));
  } catch (error) {
    req.log.error({ err: error, operation: "account storage usage" }, "Object storage usage unavailable");
    res.status(503).json({
      error: "Storage usage is temporarily unavailable. Please try again later.",
      code: "OBJECT_STORAGE_UNAVAILABLE",
    });
  }
});

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", requireAuth, denyViewers, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;
    const clientId = getClientId(req);
    if (!clientId) {
      res.status(400).json({ error: "No client context" });
      return;
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(clientId);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    respondObjectStorageUnavailable(req, res, error, "generic document upload");
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from GCS_PUBLIC_PREFIXES.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from the configured private GCS bucket and prefix.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // Ownership is tagged per-tenant (owner = clientId as a string), not
    // per-user, since e.g. FixTrack photos should be visible to every user
    // of the client that uploaded them, not just the uploader. See
    // fix-track.ts's request-upload handler for where this gets set.
    const clientId = getClientId(req);
    const canAccess = clientId
      ? await objectStorageService.canAccessObjectEntity({
          userId: String(clientId),
          objectFile,
          requestedPermission: ObjectPermission.READ,
        })
      : false;
    if (!canAccess) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      const meter = createDownloadMeter(clientId!);
      nodeStream.on("data", (chunk) => meter.add(chunk));
      const commit = () => { void meter.commit().catch((error) => req.log.error({ err: error }, "Could not record download usage")); };
      nodeStream.once("end", commit);
      nodeStream.once("close", commit);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
