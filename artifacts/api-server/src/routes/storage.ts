import { Router, type IRouter, type Request, type Response } from "express";
import { Readable, pipeline } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  GetStorageUsageResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { ObjectPermission } from "../lib/objectAcl";
import { db } from "@workspace/db";
import { appSettingsTable, clientsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, denyViewers, getActiveDepartmentId } from "../middleware/requireAuth";
import { objectPathTenantMismatch, patPhotoObjectAccess } from "../lib/patLegacyHistoryScope";
import { listTenantAttachmentObjectPaths } from "../lib/attachmentReferences";
import { findLiveSubscription } from "../lib/billing";
import { createDownloadMeter, getMonthlyDownloadBytes, utcMonth, resolveDownloadToken } from "../lib/downloadUsage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024;
const GIB = 1024 ** 3;
const DEFAULT_PROVIDER_STORAGE_USD_PER_GIB_MONTH = 0.015;
const DEFAULT_ALPS_STORAGE_MARKUP_PERCENT = 20;
const DEFAULT_STORAGE_INCLUDED_GIB_BY_SERVICE: Record<string, number> = {
  core: 1,
  bundle: 1,
};

function requestRange(raw: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!raw) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return "invalid";
  end = Math.min(end, size - 1);
  return { start, end };
}

router.get("/storage/download/:token", async (req: Request, res: Response) => {
  try {
    const rawToken = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const resolved = await resolveDownloadToken(rawToken);
    if (!resolved) { res.status(404).json({ error: "Download link expired or invalid" }); return; }
    const file = await objectStorageService.getObjectEntityFile(resolved.objectPath);
    const acl = await objectStorageService.canAccessObjectEntity({ userId: String(resolved.clientId), objectFile: file, requestedPermission: ObjectPermission.READ });
    if (!acl) { res.status(404).json({ error: "Download link expired or invalid" }); return; }
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    const range = requestRange(req.header("range"), size);
    if (range === "invalid") { res.status(416).setHeader("Content-Range", `bytes */${size}`).end(); return; }
    const response = await objectStorageService.downloadObject(file, 0, range);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (!response.body) { res.end(); return; }
    const stream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
    const meter = createDownloadMeter(resolved.clientId);
    stream.on("data", (chunk) => meter.add(chunk));
    streamMetered(req, stream, res, meter);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "Download link expired or invalid" }); return; }
    req.log.error({ err: error }, "Error serving token download");
    if (!res.headersSent) res.status(500).json({ error: "Failed to serve download" });
  }
});

async function estimateStorageCost(clientId: number, usedBytes: number, monthlyDownloadBytes: number) {
  const rawRate = process.env.STORAGE_PROVIDER_USD_PER_GIB_MONTH?.trim();
  const providerRate = rawRate ? Number(rawRate) : DEFAULT_PROVIDER_STORAGE_USD_PER_GIB_MONTH;
  const rawMarkup = process.env.STORAGE_ALPS_MARKUP_PERCENT?.trim();
  const markupPercent = rawMarkup ? Number(rawMarkup) : DEFAULT_ALPS_STORAGE_MARKUP_PERCENT;
  if (!Number.isFinite(providerRate) || providerRate < 0 || !Number.isFinite(markupPercent) || markupPercent < 0) return null;
  const rawAllowances = process.env.STORAGE_INCLUDED_GIB_BY_SERVICE;
  let allowanceMap: Record<string, unknown>;
  try {
    allowanceMap = rawAllowances ? JSON.parse(rawAllowances) : DEFAULT_STORAGE_INCLUDED_GIB_BY_SERVICE;
  } catch {
    return null;
  }
  if (!allowanceMap || typeof allowanceMap !== "object" || Array.isArray(allowanceMap)) return null;
  const configuredValues = Object.values(allowanceMap);
  if (!configuredValues.length || configuredValues.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / GIB)) return null;
  const [client] = await db.select({ stripeCustomerId: clientsTable.stripeCustomerId })
    .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client?.stripeCustomerId) return null;
  const subscription = await findLiveSubscription(client.stripeCustomerId).catch(() => null);
  if (!subscription) return null;
  const allowances = subscription.items.data
    .map((item) => String(item.price?.metadata?.service_key ?? ""))
    .map((key) => Number(allowanceMap[key]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!allowances.length) return null;
  const includedBytes = Math.max(...allowances) * GIB;
  const excess = Math.max(0, usedBytes - includedBytes);
  const providerMinorUnits = Math.round(providerRate * 100 * excess / GIB);
  const storageMinorUnits = Math.round(
    providerRate * 100 * (1 + markupPercent / 100) * excess / GIB,
  );
  const markupMinorUnits = storageMinorUnits - providerMinorUnits;
  return {
    currency: "USD" as const,
    storageMinorUnits,
    downloadMinorUnits: 0,
    totalMinorUnits: storageMinorUnits,
    includedStorageBytes: includedBytes,
    excessStorageBytes: excess,
    providerMinorUnits,
    markupMinorUnits,
    markupPercent,
  };
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
    const estimatedCost = await estimateStorageCost(clientId, usedBytes, monthlyDownloadBytes);
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
      pipeline(nodeStream, res, (error) => {
        if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") req.log.warn({ err: error }, "Public object stream ended early");
      });
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
    const clientId = getClientId(req);
    // The tenant ACL below is per client. A retained PAT test photo is also
    // limited to the department/site recorded with its test, so another
    // department cannot fetch it by path. Checked before touching storage.
    if (!clientId || objectPathTenantMismatch(objectPath, clientId)
      || !await patPhotoObjectAccess(db, clientId, objectPath, getActiveDepartmentId(req))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // Ownership is tagged per-tenant (owner = clientId as a string), not
    // per-user, since e.g. FixTrack photos should be visible to every user
    // of the client that uploaded them, not just the uploader. See
    // fix-track.ts's request-upload handler for where this gets set.
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

    const [metadata] = await objectFile.getMetadata();
    const range = requestRange(req.header("range"), Number(metadata.size));
    if (range === "invalid") { res.status(416).setHeader("Content-Range", `bytes */${metadata.size}`).end(); return; }
    const response = await objectStorageService.downloadObject(objectFile, 3600, range);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      const meter = createDownloadMeter(clientId!);
      nodeStream.on("data", (chunk) => meter.add(chunk));
      streamMetered(req, nodeStream, res, meter);
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

/**
 * Streams a download and records the bytes it actually sent. pipeline() stops
 * the provider read when the client disconnects and turns a provider stream
 * error into a closed response (instead of an unhandled 'error' event), and its
 * callback runs once in every case, so partial downloads are still metered.
 */
function streamMetered(req: Request, stream: Readable, res: Response, meter: ReturnType<typeof createDownloadMeter>): void {
  pipeline(stream, res, (error) => {
    if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") req.log.warn({ err: error }, "Download stream ended early");
    void meter.commit().catch((commitError) => req.log.error({ err: commitError }, "Could not record download usage"));
  });
}

export default router;
