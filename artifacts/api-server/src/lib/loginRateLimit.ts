import type { Request, Response, NextFunction } from "express";
import { digestBearerToken } from "./bearerTokens";

type Entry = { count: number; resetAt: number };

const failures = new Map<string, Entry>();
let productionSharedStore: SharedRateLimitStore | undefined;

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1";
}

/** Configure the database-backed store before the API begins serving requests. */
export function configureProductionLoginRateLimitStore(store: SharedRateLimitStore) {
  productionSharedStore = store;
}

const productionStoreProxy: SharedRateLimitStore = {
  async consume(key, windowMs, max) {
    if (!productionSharedStore) {
      throw new Error("Shared authentication rate-limit store is not configured");
    }
    return productionSharedStore.consume(key, windowMs, max);
  },
  async release(key, windowId) {
    if (!productionSharedStore?.release) {
      throw new Error("Shared authentication rate-limit store cannot release attempts");
    }
    return productionSharedStore.release(key, windowId);
  },
};

export interface SharedRateLimitStore {
  /**
   * Atomically consume an attempt and return the count and remaining window.
   * Implementations must share counters across API processes.
   */
  consume(key: string, windowMs: number, max: number): Promise<{
    count: number;
    retryAfterSeconds: number;
    /** Identifies the window the attempt was counted in (needed by release). */
    windowId?: string;
  }>;
  /**
   * Give back one attempt consumed in `windowId`, for limiters that only count
   * failed responses. A no-op when that window has already expired or reset.
   */
  release?(key: string, windowId: string): Promise<void>;
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
  storeOnlyInProduction?: boolean;
}) {
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  const max = opts?.max ?? 10;
  const namespace = opts?.namespace ?? "login";
  const failureStatuses = opts?.failureStatuses ? new Set(opts.failureStatuses) : null;

  if (failureStatuses && opts?.store && typeof opts.store.release !== "function") {
    throw new Error("Response-based failure counters need a shared store that can release attempts");
  }

  return async function loginRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = `${namespace}:${opts?.key ? opts.key(req) : `ip:${clientIp(req)}`}`;
    const useStore = Boolean(opts?.store)
      && (!opts?.storeOnlyInProduction || isProductionRuntime());
    const requireStore = Boolean(opts?.requireStore
      && (!opts?.storeOnlyInProduction || isProductionRuntime()));

    if (useStore || requireStore) {
      try {
        const store = opts?.store;
        if (!store) throw new Error("Shared authentication rate-limit store is not configured");
        const result = await store.consume(key, windowMs, max);
        if (!Number.isSafeInteger(result.count) || result.count < 1
          || !Number.isSafeInteger(result.retryAfterSeconds) || result.retryAfterSeconds < 0
          || (failureStatuses && (typeof result.windowId !== "string" || !result.windowId))) {
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
        if (failureStatuses) {
          // Every attempt is reserved before the handler runs, so concurrent
          // guesses across instances can never exceed the cap. Responses that
          // are not failures (e.g. a successful reset) hand their attempt back.
          // If the release fails, or the response never finishes, the attempt
          // stays counted: the limiter errs towards blocking, never allowing.
          const windowId = result.windowId!;
          res.on("finish", () => {
            if (failureStatuses.has(res.statusCode)) return;
            Promise.resolve().then(() => store.release!(key, windowId)).catch((error) => {
              req.log?.warn({ err: error }, "Could not release a shared authentication rate-limit attempt");
            });
          });
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

/** Ten credential attempts per source IP in each shared 15-minute window in production. */
export const loginRateLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  namespace: "login",
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

/** Five registration attempts per source IP in each shared one-hour window in production. */
export const registrationRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  namespace: "register",
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

/**
 * Ten failed reset-link attempts (invalid/expired token or bad request) per
 * source IP in each 15-minute window. Production shares the counter across API
 * instances; successful resets do not count. Development stays in-memory.
 */
export const resetPasswordRateLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  namespace: "reset-password",
  failureStatuses: [400, 401],
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

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
