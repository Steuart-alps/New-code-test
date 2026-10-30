import type { NextFunction, Request, Response } from "express";
import { canonicalTrackPath } from "./dailyEntryCutoff";
import { getClientId } from "./requireAuth";
import { matchSignedRoute, saveNeedsSignature } from "../lib/recordSignatures";
import {
  CORRECTIVE_ACTIONS_HEADER,
  CORRECTIVE_ACTION_REQUIRED_CODE,
  correctiveCheckFor,
  parseCorrectiveAnswers,
  recordCorrectiveActions,
  unansweredFailures,
} from "../lib/correctiveActions";
import { logger } from "../lib/logger";

/**
 * Integration tests that predate this run without it unless
 * ENFORCE_CORRECTIVE_ACTIONS=1, as with signatures.
 */
export function correctiveActionsEnforced(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.ENFORCE_CORRECTIVE_ACTIONS === "1";
}

/**
 * Asks for a corrective action against each fail on a recorded check saved
 * from the web app (see lib/correctiveActions.ts). Runs before the signature
 * gate, so the person says what they did and then signs.
 */
export async function requireCorrectiveActions(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  // Only signed-in web sessions are asked, like signatures: the phone app
  // (bearer) comes later, and Viewers are refused by the route itself.
  if (!correctiveActionsEnforced() || !user || !req.session?.userId || user.role === "client_viewer") return next();
  const path = canonicalTrackPath(req.path);
  const match = matchSignedRoute(req.method, path);
  if (!match) return next();
  const clientId = getClientId(req);
  if (!clientId) return next();

  let check;
  let answers: Record<string, string> = {};
  try {
    if (!(await saveNeedsSignature(match, req.body, clientId))) return next();
    check = await correctiveCheckFor(req.method, path, match, req.body, clientId);
    if (!check) return next();
    answers = parseCorrectiveAnswers(req.headers[CORRECTIVE_ACTIONS_HEADER]);
  } catch (err) {
    logger.error({ err }, "Corrective action check failed");
    return void res.status(500).json({ error: "Unable to check this record for fails" });
  }
  const missing = unansweredFailures(check, answers);
  if (missing.length) {
    return void res.status(428).json({
      error: missing.length === 1
        ? "Something failed on this check. Say what you did about it before saving."
        : `${missing.length} things failed on this check. Say what you did about each one before saving.`,
      code: CORRECTIVE_ACTION_REQUIRED_CODE,
      failures: missing.map(({ key, label }) => ({ key, label })),
    });
  }

  const found = check;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    res.json = originalJson;
    const recordId = Number(match.route.id === "path" ? match.pathId : match.route.id(body));
    const actionRecordId = found.rule.actionRecordId ? Number(found.rule.actionRecordId(body)) : recordId;
    if (res.statusCode >= 200 && res.statusCode < 300 && Number.isSafeInteger(recordId) && recordId > 0
      && Number.isSafeInteger(actionRecordId) && actionRecordId > 0) {
      recordCorrectiveActions({
        check: found, match, recordId, actionRecordId, clientId, userId: user.id, userName: user.name, answers,
      })
        .catch(err => logger.error({ err, recordType: match.route.recordType, recordId }, "Corrective action could not be recorded"))
        .finally(() => originalJson(body));
      return res;
    }
    return originalJson(body);
  }) as typeof res.json;
  next();
}
