import { createHash } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pool } from "@workspace/db";
import { queryAnalyticsSummary, validateAnalyticsSummaryQuery } from "@workspace/db/analytics";
import {
  ANALYTICS_EVENT_REGISTRY,
  checkAnalyticsReadToken,
  recordAnalyticsEvent,
  validateAnalyticsEvent,
} from "../lib/analytics";
import { makeLoginRateLimit } from "../lib/loginRateLimit";

/**
 * Browser ingest for first-party analytics, mounted in the normal /api chain
 * (session, CSRF, 2FA enrolment, trial lock).
 *
 * Only cookie sessions may record events: the web app sends them through the
 * shared apiFetch, which adds the CSRF token. Bearer (mobile) requests skip
 * CSRF, so they are refused here rather than becoming a CSRF-free write path.
 *
 * denyViewers is intentionally NOT applied. Recording an event changes no
 * tenant data: the row carries no client, user or record reference, and
 * client_viewer usage (e.g. a training-matrix download) is real product usage
 * we want counted. Abuse is bounded by the allowlist and the per-session rate
 * limit. (Documented exception in tests/viewer-route-policy.mjs.)
 */
const router: IRouter = Router();

function requireCookieSession(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId || !req.currentUser || req.headers.authorization) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/** 60 events per session per minute; the key is a digest of the session id. */
export const analyticsEventRateLimit = makeLoginRateLimit({
  windowMs: 60 * 1000,
  max: 60,
  namespace: "analytics-events",
  key: (req) => `session:${createHash("sha256").update(req.sessionID ?? "").digest("hex")}`,
});

router.post("/analytics/events", requireCookieSession, analyticsEventRateLimit, async (req, res) => {
  const event = validateAnalyticsEvent(req.body);
  if (!event) {
    // Fixed message: never echo the rejected input.
    res.status(400).json({ error: "Unrecognised analytics event" });
    return;
  }
  await recordAnalyticsEvent(event);
  res.status(204).end();
});

export default router;

/**
 * Read-only aggregate endpoint for operators (and Claude):
 *   GET /api/internal/analytics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD[&event=][&groupBy=]
 * Authorised only by `Authorization: Bearer $ANALYTICS_READ_TOKEN`; 404 when
 * that variable is unset. app.ts mounts this before the session, cookie and
 * user middleware, so a session cookie can never authorise it and the token
 * never reaches the mobile-session lookup. Neither the token nor the
 * Authorization header is logged (pino-http logs only method, path, status).
 */
export const internalAnalyticsRouter: IRouter = Router();

/** Per source IP; bounds token guessing and accidental tight polling loops. */
const analyticsReadRateLimit = makeLoginRateLimit({
  windowMs: 60 * 1000,
  max: 60,
  namespace: "analytics-read",
});

internalAnalyticsRouter.get("/api/internal/analytics/summary", analyticsReadRateLimit, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const access = checkAnalyticsReadToken(req.headers.authorization);
    if (access === "disabled") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (access !== "ok") {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const pick = (value: unknown) => (Array.isArray(value) ? undefined : value);
    const parsed = validateAnalyticsSummaryQuery({
      from: pick(req.query.from),
      to: pick(req.query.to),
      event: pick(req.query.event),
      groupBy: pick(req.query.groupBy),
    });
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { event, groupBy } = parsed.query;
    if (event !== null && !Object.hasOwn(ANALYTICS_EVENT_REGISTRY, event)) {
      res.status(400).json({ error: "Unknown event" });
      return;
    }
    if (groupBy !== null) {
      const known = event !== null
        ? Object.hasOwn(ANALYTICS_EVENT_REGISTRY[event]!, groupBy)
        : Object.values(ANALYTICS_EVENT_REGISTRY).some((dims) => Object.hasOwn(dims, groupBy));
      if (!known) {
        res.status(400).json({ error: "Unknown dimension for groupBy" });
        return;
      }
    }
    res.json({
      ...(await queryAnalyticsSummary(pool, parsed.query)),
      events: Object.fromEntries(
        Object.entries(ANALYTICS_EVENT_REGISTRY).map(([name, dims]) => [name, Object.keys(dims)]),
      ),
    });
  } catch (err) {
    next(err);
  }
});
