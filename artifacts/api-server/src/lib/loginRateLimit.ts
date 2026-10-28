import type { Request, Response, NextFunction } from "express";
import { digestBearerToken } from "./bearerTokens";

type Entry = { count: number; resetAt: number };

const failures = new Map<string, Entry>();
let productionSharedStore: SharedRateLimitStore | undefined;

function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
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
  async consumeMany(entries) {
    if (!productionSharedStore?.consumeMany) {
      throw new Error("Shared rate-limit store is not configured");
    }
    return productionSharedStore.consumeMany(entries);
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
  /**
   * Consume one attempt from each of several distinct keys in one call, in
   * input order. Used where one request is checked against several limits.
   */
  consumeMany?(entries: Array<{ key: string; windowMs: number; max: number }>): Promise<Array<{
    count: number;
    retryAfterSeconds: number;
    windowId?: string;
  }>>;
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
 * X-Forwarded-For behind the hosting proxy. If trust-proxy weren't configured we
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

/**
 * Wrong second-factor codes per account (web pending sign-in or mobile login
 * challenge), across all source IPs, in each shared 15-minute window. Only
 * rejected codes (401) count. Without a resolvable account the source IP is
 * the key instead.
 */
export const totpAccountRateLimit = makeLoginRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  namespace: "totp-account",
  failureStatuses: [401],
  key: (req) => {
    const accountId = (req as Request & { totpAccountId?: number }).totpAccountId
      ?? (req.session as { pending2faUserId?: number } | undefined)?.pending2faUserId;
    return Number.isSafeInteger(accountId) ? `user:${accountId}` : `ip:${clientIp(req)}`;
  },
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

/** Ten password-reset email requests per source IP in each shared hour. */
export const forgotPasswordRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  namespace: "forgot-password",
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

/** Three password-reset emails per requested address in each shared hour. */
/**
 * Verification-email resends: five per source IP and three per requested
 * address each hour, kept apart from the registration quota so retries never
 * use up sign-ups from a shared office connection. The per-address cap stops
 * the endpoint being used to flood one inbox.
 */
export const resendVerificationRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  namespace: "resend-verification",
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

export const resendVerificationEmailRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  namespace: "resend-verification-email",
  key: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return email ? `email:${email}` : `ip:${clientIp(req)}`;
  },
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

export const forgotPasswordEmailRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  namespace: "forgot-password-email",
  key: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return email ? `email:${email}` : `ip:${clientIp(req)}`;
  },
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

type PublicLinkLimit = {
  namespace: string;
  windowMs: number;
  max: number;
  key: (req: Request) => string;
};

const PUBLIC_LINK_STORE_TIMEOUT_MS = 1_000;
const PUBLIC_LINK_FALLBACK_WARN_MS = 60_000;
let lastPublicLinkFallbackWarning = 0;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Shared rate-limit store timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function tooMany(res: Response, retryAfterSeconds: number) {
  const retryAfter = Math.max(1, retryAfterSeconds);
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({
    error: "Too many attempts. Please try again later.",
    retryAfterSeconds: retryAfter,
  });
}

/**
 * Several fixed-window limits checked together against the shared database
 * store in one upsert, in every environment, so all API processes and restarts
 * see the same counters. Link keys are SHA-256 fingerprints and the store
 * HMACs every key, so no bearer token or IP is ever written.
 *
 * Fails safe: if the store is missing, errors or is slower than one second,
 * this process's own in-memory counters enforce the same limits instead. Links
 * keep working and stay bounded per process; they are never left unlimited.
 */
export function makePublicLinkRateLimit(limits: PublicLinkLimit[], store: SharedRateLimitStore = productionStoreProxy) {
  return async function publicLinkRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const keyed = limits.map((limit) => ({ ...limit, fullKey: `${limit.namespace}:${limit.key(req)}` }));
    let results: Array<{ count: number; retryAfterSeconds: number }> | null = null;
    try {
      if (!store.consumeMany) throw new Error("Shared rate-limit store cannot consume several keys");
      results = await withTimeout(store.consumeMany(keyed.map((limit) => ({
        key: limit.fullKey, windowMs: limit.windowMs, max: limit.max,
      }))), PUBLIC_LINK_STORE_TIMEOUT_MS);
      if (results.length !== keyed.length || results.some((result) =>
        !Number.isSafeInteger(result.count) || result.count < 1
        || !Number.isSafeInteger(result.retryAfterSeconds) || result.retryAfterSeconds < 0)) {
        throw new Error("Shared rate-limit store returned an invalid result");
      }
    } catch (error) {
      results = null;
      const now = Date.now();
      if (now - lastPublicLinkFallbackWarning >= PUBLIC_LINK_FALLBACK_WARN_MS) {
        lastPublicLinkFallbackWarning = now;
        req.log?.warn({ err: error }, "Public-link rate limits fell back to per-process counters");
      }
    }

    if (results) {
      const blocked = results
        .map((result, index) => (result.count > keyed[index].max ? result.retryAfterSeconds : -1))
        .filter((seconds) => seconds >= 0);
      if (blocked.length > 0) return tooMany(res, Math.max(...blocked));
      return next();
    }

    const now = Date.now();
    const blocked = keyed.map((limit) => blockedSeconds(limit.fullKey, limit.max, now)).filter((seconds) => seconds > 0);
    if (blocked.length > 0) return tooMany(res, Math.max(...blocked));
    for (const limit of keyed) recordAttempt(limit.fullKey, limit.windowMs, now);
    next();
  };
}

/**
 * Public token links are intentionally usable without login, but are bounded
 * per source IP (120 a minute across every public link) to slow token
 * enumeration and scraping, and per link credential (60 a minute across
 * source IPs) to bound repeated use of any one link.
 */
export const publicLinkRateLimits = makePublicLinkRateLimit([
  { namespace: "public-link", windowMs: 60 * 1000, max: 120, key: (req) => `ip:${clientIp(req)}` },
  {
    namespace: "public-link-token",
    windowMs: 60 * 1000,
    max: 60,
    key: (req) => {
      const firstPathSegment = req.path.split("/").filter(Boolean)[0];
      if (firstPathSegment) return `token:${digestBearerToken(firstPathSegment)}`;
      return `ip:${clientIp(req)}`;
    },
  },
]);

/**
 * Online privacy-request submissions (the public rights-request form). Five per
 * source IP and twenty per form link in each hour; production keeps both
 * counters in Postgres so a restart does not reset them.
 */
export const privacyIntakeSubmitRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  namespace: "privacy-intake-ip",
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

export const privacyIntakeLinkSubmitRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  namespace: "privacy-intake-link",
  key: (req) => `token:${digestBearerToken(String(req.params.token ?? ""))}`,
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

/**
 * Contractor sign-ins at a site (the public site sign-in link). A reception
 * tablet signs everyone in from one address, so the per-address limit allows
 * a busy morning; each site's link is capped separately.
 */
export const siteSignInSubmitRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  namespace: "site-sign-in-ip",
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

export const siteSignInLinkSubmitRateLimit = makeLoginRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  namespace: "site-sign-in-link",
  key: (req) => `token:${digestBearerToken(String(req.params.token ?? ""))}`,
  store: productionStoreProxy,
  storeOnlyInProduction: true,
  requireStore: true,
});

/** Test-only helper: reset all counters. */
export function _resetLoginRateLimit() {
  failures.clear();
}
