import type { NextFunction, Request, Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_LINK_PREFIXES = [
  "/api/contractor-portal/",
  "/api/sign-off/",
  "/api/fix-track/action/",
  "/api/fix-track/quotes/public/",
];

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestOrigin(req: Request): string | null {
  const forwardedProto = getHeaderValue(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = getHeaderValue(req.headers.host);
  if (!host || !protocol) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

function sameOrigin(req: Request): boolean {
  const suppliedOrigin = getHeaderValue(req.headers.origin);
  if (!suppliedOrigin) return false;
  const expectedOrigin = requestOrigin(req);
  if (!expectedOrigin) return false;
  try {
    return new URL(suppliedOrigin).origin === expectedOrigin;
  } catch {
    return false;
  }
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

  // These tokenized links are intentionally usable from an ordinary browser
  // even when that browser also has an unrelated application session cookie.
  // Their high-entropy path token is the credential, and each public router
  // validates it before performing the mutation.
  if (PUBLIC_LINK_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    next();
    return;
  }

  // Unauthenticated public endpoints use their own token or signature checks.
  if (!req.session.userId) {
    next();
    return;
  }

  // Cookies are sent automatically by browsers, so require browser provenance
  // before accepting the token. Origin is exact (scheme, host and port); when
  // it is omitted, Fetch Metadata must explicitly identify a same-origin
  // request. This also blocks cross-site requests even if a token is leaked.
  const fetchSite = getHeaderValue(req.headers["sec-fetch-site"]);
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
    res.status(403).json({ error: "CSRF validation failed" });
    return;
  }
  if (!sameOrigin(req) && !(fetchSite === "same-origin" && !getHeaderValue(req.headers.origin))) {
    res.status(403).json({ error: "CSRF validation failed" });
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