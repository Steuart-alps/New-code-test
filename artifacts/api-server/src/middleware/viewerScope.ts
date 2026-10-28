import type { NextFunction, Request, Response } from "express";

/**
 * A Viewer is a member of staff who signs in only to see, and sign off, their
 * own training records (the staff roster entry their account is linked to).
 * Everything else in the API is closed to them, reads included, so a new
 * route is never open to Viewers by accident. Sign-in and account routes
 * (/auth) and analytics are mounted before this guard.
 */
const VIEWER_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/train-track\/my-records\/?$/ },
  { method: "POST", path: /^\/train-track\/my-records\/\d+\/sign\/?$/ },
  { method: "GET", path: /^\/train-track\/my-coshh\/?$/ },
  { method: "POST", path: /^\/train-track\/my-coshh\/\d+\/sign\/?$/ },
  { method: "GET", path: /^\/train-track\/my-documents\/?$/ },
  { method: "GET", path: /^\/train-track\/my-documents\/\d+\/download-url\/?$/ },
  { method: "POST", path: /^\/train-track\/my-documents\/\d+\/sign\/?$/ },
  { method: "POST", path: /^\/feedback\/?$/ },
  { method: "POST", path: /^\/feedback\/screenshot\/request-upload\/?$/ },
  { method: "POST", path: /^\/mobile\/push-token\/?$/ },
  { method: "DELETE", path: /^\/mobile\/push-token\/?$/ },
];

/**
 * Links that carry their own token work for anyone holding them, signed in
 * or not (a Viewer may be sent a document sign-off link, for example).
 */
const TOKEN_LINK_PREFIXES = [
  "/storage/download/",
  "/contractor-portal/",
  "/fix-track/action/",
  "/fix-track/quotes/public/",
  "/notifications/public/schedule/",
  "/certificate-upload/",
  "/sign-off/",
];

export function viewerMayUse(method: string, path: string): boolean {
  const lower = path.toLowerCase();
  if (TOKEN_LINK_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  const verb = method === "HEAD" ? "GET" : method;
  return VIEWER_ROUTES.some((route) => route.method === verb && route.path.test(lower));
}

export function limitViewers(req: Request, res: Response, next: NextFunction) {
  if (req.currentUser?.role !== "client_viewer" || viewerMayUse(req.method, req.path)) {
    next();
    return;
  }
  res.status(403).json({ error: "Viewers can only see and sign their own training records", code: "VIEWER_OWN_TRAINING_ONLY" });
}
