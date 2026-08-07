import type { Request, Response, NextFunction } from "express";

/**
 * In-memory brute-force protection for credential-verification endpoints.
 *
 * Two independent sliding-window counters guard every protected request:
 *   • per-email — a low cap (EMAIL_MAX_FAILURES) so guessing one account's
 *     password is throttled quickly. A successful sign-in clears this counter.
 *   • per-IP    — a higher cap (IP_MAX_FAILURES) so a single host can't spray
 *     attempts across many different emails to sidestep the per-email limit.
 *
 * When either counter is over its cap within WINDOW_MS the request is rejected
 * with 429 + Retry-After until the oldest counted attempt ages out.
 *
 * The store is an in-process Map — good enough for the single API server
 * process. It is fully encapsulated here (no external deps) with periodic
 * cleanup so it can't grow unbounded. Restarting the server resets counters,
 * an acceptable trade-off for this deployment.
 *
 * IMPORTANT: this only guards explicit credential attempts. Session-cookie /
 * bearer loadUser checks are never routed through here.
 */
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes sliding window
const EMAIL_MAX_FAILURES = 5; // failures per email before 429
const IP_MAX_FAILURES = 30; // higher per-IP cap (guards email-spraying)

type Entry = { count: number; firstAt: number };

const failures = new Map<string, Entry>();

// Periodically drop expired entries so the map can't grow unbounded even if
// keys are never revisited. .unref() so it never keeps the process alive.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) {
    if (now - entry.firstAt > WINDOW_MS) failures.delete(key);
  }
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

/** Keys to check for a request, each paired with its own cap. */
function keysFor(req: Request): Array<{ key: string; cap: number }> {
  const out: Array<{ key: string; cap: number }> = [
    { key: `ip:${clientIp(req)}`, cap: IP_MAX_FAILURES },
  ];
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (email) out.push({ key: `email:${email}`, cap: EMAIL_MAX_FAILURES });
  return out;
}

/**
 * Returns the number of seconds to wait if the key is over its cap, else 0.
 * Expired entries are lazily dropped.
 */
function blockedSeconds(key: string, cap: number, now: number): number {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return 0;
  }
  if (entry.count < cap) return 0;
  return Math.ceil((entry.firstAt + WINDOW_MS - now) / 1000);
}

function recordFailure(key: string, now: number) {
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

/**
 * Build a rate-limiting middleware.
 *
 * @param opts.failureStatuses HTTP statuses that count as a failed attempt.
 *   Defaults to [401] (bad credentials / bad 2FA code). Pass extra codes for
 *   endpoints that signal a failed guess differently (e.g. reset-password
 *   returns 400 for an invalid/expired token).
 * @param opts.clearOnSuccess whether a 2xx response clears the counters
 *   (a successful login should reset the email counter). Defaults to true.
 */
export function makeLoginRateLimit(opts?: {
  failureStatuses?: number[];
  clearOnSuccess?: boolean;
}) {
  const failureStatuses = new Set(opts?.failureStatuses ?? [401]);
  const clearOnSuccess = opts?.clearOnSuccess ?? true;

  return function loginRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const keys = keysFor(req);

    const retryAfter = Math.max(0, ...keys.map(({ key, cap }) => blockedSeconds(key, cap, now)));
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Too many failed sign-in attempts. Please try again later.",
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    // Observe the outcome once the response is flushed.
    res.on("finish", () => {
      if (failureStatuses.has(res.statusCode)) {
        const at = Date.now();
        for (const { key } of keys) recordFailure(key, at);
      } else if (clearOnSuccess && res.statusCode >= 200 && res.statusCode < 300) {
        for (const { key } of keys) failures.delete(key);
      }
    });

    next();
  };
}

/** Default limiter for login / 2FA / mobile-login (counts 401s, clears on 2xx). */
export const loginRateLimit = makeLoginRateLimit();

/** Test-only helper: reset all counters. */
export function _resetLoginRateLimit() {
  failures.clear();
}
