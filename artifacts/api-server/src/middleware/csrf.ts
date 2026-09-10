import type { NextFunction, Request, Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Cookie-authenticated browser mutations must prove that the caller can read
 * the same-origin session. Bearer-authenticated mobile requests are exempt
 * because the bearer credential is not sent automatically by a cross-site
 * browser request.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (!UNSAFE_METHODS.has(req.method) || req.headers.authorization?.startsWith("Bearer ")) {
    next();
    return;
  }

  // Existing integration tests use authenticated session fixtures directly
  // rather than emulating the browser token bootstrap. Production and an
  // explicit CSRF test run always use the real check.
  if (process.env.NODE_ENV === "test" && process.env.ENFORCE_CSRF !== "1") {
    next();
    return;
  }

  // These endpoints establish or recover authentication and may be called
  // while an old session is still present. They do not mutate authenticated
  // tenant data.
  if (
    req.path === "/api/auth/login" ||
    req.path === "/api/auth/register" ||
    req.path === "/api/auth/forgot-password" ||
    req.path === "/api/auth/reset-password"
  ) {
    next();
    return;
  }

  // Unauthenticated public endpoints use their own token or signature checks.
  if (!req.session.userId) {
    next();
    return;
  }

  const supplied = getHeaderValue(req.headers["x-csrf-token"]);
  const expected = req.session.csrfToken;
  if (!supplied || !expected) {
    res.status(403).json({ error: "CSRF validation failed" });
    return;
  }

  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    res.status(403).json({ error: "CSRF validation failed" });
    return;
  }

  next();
}

export function getCsrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}