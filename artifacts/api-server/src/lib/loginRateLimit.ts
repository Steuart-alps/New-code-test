import type { Request, Response, NextFunction } from "express";
import { digestBearerToken } from "./bearerTokens";

type Entry = { count: number; resetAt: number };

const failures = new Map<string, Entry>();

export interface SharedRateLimitStore {
  /**
   * Atomically consume an attempt and return the count and remaining window.
   * Implementations must share counters across API processes.
   */
  consume(key: string, windowMs: number, max: number): Promise<{
    count: number;
    retryAfterSeconds: number;
  }>;
}

// Periodically drop expired entries so the map can't grow unbounded even if
// keys are never revisited. .unref() so it never keeps the process alive.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) if (now >= entry.resetAt) failures.delete(key);
}, 60 * 1000);
cleanupTimer.unref();

/**
 * Derive the caller's IP. Express's `req.ip` already honours the app's
 * `trust proxy` setting (set to 1 in app.ts) so it reflects the first hop of
 * X-Forwarded-For behind Replit's proxy. If trust-proxy weren't configured we
 * fall back to parsing the first hop of X-Forwarded-For ourselves.
 */
function clientIp(req: Request): string {
  if (req.ip) return req.ip;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const first = raw?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

function blockedSeconds(key: string, max: number, now: number): number {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (now >= entry.resetAt) {
    failures.delete(key);
    return 0;
  }
  if (entry.count < max) return 0;
  return Math.ceil((entry.resetAt - now) / 1000);
}

function recordAttempt(key: string, windowMs: number, now: number) {
  const entry = failures.get(key);
  if (!entry || now >= entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    entry.count += 1;
  }
}

/**
 * Build an in-memory fixed-window limiter. Counters are namespaced so login,
 * registration, and password-reset traffic cannot consume one another's quota.
 */
export function makeLoginRateLimit(opts?: {
  windowMs?: number;
  max?: number;
  namespace?: string;
  failureStatuses?: number[];
  key?: (req: Request) => string;
  store?: SharedRateLimitStore;
  requireStore?: boolean;
}) {
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  const max = opts?.max ?? 10;
  const namespace = opts?.namespace ?? "login";
  const failureStatuses = opts?.failureStatuses ? new Set(opts.failureStatuses) : null;

  if (failureStatuses && (opts?.store || opts?.requireStore)) {
    throw new Error("Shared rate-limit stores cannot be used with response-based failure counters");
  }

  return async function loginRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = `${namespace}:${opts?.key ? opts.key(req) : `ip:${clientIp(req)}`}`;

    if (opts?.store || opts?.requireStore) {
      try {
        if (!opts.store) throw new Error("Shared authentication rate-limit store is not configured");
        const result = await opts.store.consume(key, windowMs, max);
        if (!Number.isSafeInteger(result.count) || result.count < 1
          || !Number.isSafeInteger(result.retryAfterSeconds) || result.retryAfterSeconds < 0) {
          throw new Error("Shared authentication rate-limit store returned an invalid result");
        }
        if (result.count > max) {
          const retryAfter = Math.max(1, result.retryAfterSeconds);
          res.setHeader("Retry-After", String(retryAfter));
          res.status(429).json({
            error: "Too many attempts. Please try again later.",
            retryAfterSeconds: retryAfter,
          });
          return;
        }
        next();
      } catch (error) {
        req.log?.error({ err: error }, "Shared authentication rate-limit store unavailable");
        res.status(503).json({
          error: "Authentication is temporarily unavailable. Please try again shortly.",
        });
      }
      return;
    }

    const retryAfter = blockedSeconds(key, max, now);
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Too many attempts. Please try again later.",
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    if (failureStatuses) {
      res.on("finish", () => {
        if (failureStatuses.has(res.statusCode)) recordAttempt(key, windowMs, Date.now());
      });
    } else {
      recordAttempt(key, windowMs, now);
    }

    next();
  };
}

/** Public token links are intentionally usable without login, but are still
 * bounded per source IP to slow token enumeration and abusive scraping. */
export const publicLinkRateLimit = makeLoginRateLimit({
  windowMs: 60 * 1000,
  max: 120,
  namespace: "public-link",
});

/** Bound repeated use of any one public-link credential, across source IPs. */
export const publicLinkTokenRateLimit = makeLoginRateLimit({
  windowMs: 60 * 1000,
  max: 60,
  namespace: "public-link-token",
  key: (req) => {
    const firstPathSegment = req.path.split("/").filter(Boolean)[0];
    if (firstPathSegment) return `token:${digestBearerToken(firstPathSegment)}`;
    return `ip:${clientIp(req)}`;
  },
});

/** Test-only helper: reset all counters. */
export function _resetLoginRateLimit() {
  failures.clear();
}
