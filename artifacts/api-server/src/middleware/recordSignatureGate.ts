import type { NextFunction, Request, Response } from "express";
import { canonicalTrackPath } from "./dailyEntryCutoff";
import { getClientId } from "./requireAuth";
import {
  SIGNATURE_HEADER,
  SIGNATURE_REQUIRED_CODE,
  claimSignature,
  linkSignature,
  matchSignedRoute,
  releaseSignature,
  saveNeedsSignature,
} from "../lib/recordSignatures";
import { logger } from "../lib/logger";

/**
 * Asks for a drawn signature on every recorded check saved from the web app
 * (see lib/recordSignatures.ts). Integration tests that predate signatures run
 * without it unless ENFORCE_RECORD_SIGNATURES=1, like the CSRF check.
 */
export function recordSignaturesEnforced(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.ENFORCE_RECORD_SIGNATURES === "1";
}

export async function requireRecordSignature(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  // Only signed-in web sessions are asked: the phone app (bearer) comes later,
  // and Viewers are refused by the route itself.
  if (!recordSignaturesEnforced() || !user || !req.session?.userId || user.role === "client_viewer") return next();
  const match = matchSignedRoute(req.method, canonicalTrackPath(req.path));
  if (!match) return next();
  const clientId = getClientId(req);
  if (!clientId) return next();

  let token: string | undefined;
  let signatureId: number | null = null;
  try {
    if (!(await saveNeedsSignature(match, req.body, clientId))) return next();
    const header = req.headers[SIGNATURE_HEADER];
    token = (Array.isArray(header) ? header[0] : header)?.trim() || undefined;
    if (token) signatureId = await claimSignature(token, clientId, user.id);
  } catch (err) {
    logger.error({ err }, "Record signature check failed");
    return void res.status(500).json({ error: "Unable to check the signature for this record" });
  }
  if (signatureId === null) {
    return void res.status(428).json({
      error: token ? "Your signature has expired. Please sign again." : "Sign to save this record.",
      code: SIGNATURE_REQUIRED_CODE,
      signedBy: user.name,
    });
  }

  const claimed = signatureId;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    res.json = originalJson;
    const recordId = Number(match.route.id === "path" ? match.pathId : match.route.id(body));
    if (res.statusCode >= 200 && res.statusCode < 300 && Number.isSafeInteger(recordId) && recordId > 0) {
      linkSignature(claimed, match.route, recordId, clientId)
        .then(linked => {
          if (!linked) logger.warn({ recordType: match.route.recordType, recordId }, "Record signature was not linked");
        })
        .catch(err => logger.error({ err, recordType: match.route.recordType, recordId }, "Record signature could not be linked"))
        .finally(() => originalJson(body));
      return res;
    }
    releaseSignature(claimed).catch(err => logger.error({ err }, "Record signature could not be released"));
    return originalJson(body);
  }) as typeof res.json;
  next();
}
