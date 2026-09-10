import type { Request, Response, NextFunction } from "express";

type Entry = { count: number; resetAt: number };

const failures = new Map<string, Entry>();

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
}) {
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  const max = opts?.max ?? 10;
  const namespace = opts?.namespace ?? "login";
  const failureStatuses = opts?.failureStatuses ? new Set(opts.failureStatuses) : null;

  return function loginRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = `${namespace}:${opts?.key ? opts.key(req) : `ip:${clientIp(req)}`}`;

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

/** Ten credential attempts per source IP in each 15-minute window. */
export const loginRateLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  namespace: "login",
});

/** Five registration attempts per source IP in each one-hour window. */
export const registrationRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  namespace: "register",
});

/** Test-only helper: reset all counters. */
export function _resetLoginRateLimit() {
  failures.clear();
}
