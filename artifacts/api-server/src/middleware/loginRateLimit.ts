import type { Request, Response, NextFunction } from "express";

/**
 * In-memory brute-force protection for credential endpoints.
 *
 * Tracks failed attempts (401 responses) per client IP and per submitted
 * email. After MAX_FAILURES failures within WINDOW_MS the endpoint returns
 * 429 until the window expires. A successful login clears both counters.
 *
 * In-memory state is per-process — good enough for a single API server;
 * restarting the server resets counters, which is an acceptable trade-off.
 */
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 5;

type Entry = { count: number; firstAt: number };
const failures = new Map<string, Entry>();

// Periodically drop expired entries so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) {
    if (now - entry.firstAt > WINDOW_MS) failures.delete(key);
  }
}, 60 * 1000).unref();

function keysFor(req: Request): string[] {
  const keys = [`ip:${req.ip ?? "unknown"}`];
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (email) keys.push(`email:${email}`);
  return keys;
}

function isBlocked(key: string, now: number): number {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return 0;
  }
  if (entry.count < MAX_FAILURES) return 0;
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

export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const keys = keysFor(req);

  const retryAfter = Math.max(...keys.map((k) => isBlocked(k, now)));
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "Too many failed sign-in attempts. Please try again later.",
      retryAfterSeconds: retryAfter,
    });
    return;
  }

  // Observe the outcome: 401 counts as a failure, 2xx clears the counters.
  res.on("finish", () => {
    if (res.statusCode === 401) {
      const at = Date.now();
      for (const key of keys) recordFailure(key, at);
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      for (const key of keys) failures.delete(key);
    }
  });

  next();
}

/** Test-only helper: reset all counters. */
export function _resetLoginRateLimit() {
  failures.clear();
}
