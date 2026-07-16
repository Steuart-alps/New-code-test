import type { Request, Response, NextFunction } from "express";
import { getClientId } from "./requireAuth";
import { isClientBillingLocked } from "../lib/trialLock";
import { logger } from "../lib/logger";

// Route prefixes (relative to the /api mount) that stay reachable while a
// client is billing-locked: auth (login/logout/me), everything under billing
// (config, checkout, portal, invoices — the paths needed to pay), and health.
const ALLOWED_PREFIXES = ["/auth", "/billing", "/healthz"];

/**
 * Global guard mounted on the API router: once a client's free trial has
 * expired without a live subscription, every data endpoint returns
 * 402 { code: "trial_expired" }. Billing and auth endpoints stay open so
 * consultants/admins can still pay, and paying restores access immediately.
 */
export async function enforceTrialLock(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  if (!user) {
    next();
    return;
  }
  if (ALLOWED_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
    next();
    return;
  }

  const clientId = getClientId(req);
  if (clientId == null) {
    next();
    return;
  }

  try {
    if (await isClientBillingLocked(clientId)) {
      res.status(402).json({
        error: "Your free trial has ended. Set up billing to restore access.",
        code: "trial_expired",
      });
      return;
    }
  } catch (err) {
    // Fail open: a lock-check failure must never take the whole app down.
    logger.error({ err, clientId }, "Trial lock check failed; allowing request");
  }
  next();
}
