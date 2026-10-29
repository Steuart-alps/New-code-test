import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";
import { loadUser, enforceClientAccess, enforceTwoFactorEnrollment } from "./middleware/requireAuth";
import { enforceTrialLock } from "./middleware/trialLock";
import { enforceDailyEntryCutoff } from "./middleware/dailyEntryCutoff";
import { WebhookHandlers } from "./lib/webhookHandlers";
import {
  certificateInboxDomain, inboundWebhookSecret, processInboundEmail, recordInboundEmail, verifyInboundWebhook,
} from "./lib/certificateInbox";
import { Sentry, isErrorReportingEnabled } from "./lib/sentry";
import { recordAlpsDiscountCheckoutEvent } from "./lib/alpsDiscount";
import { csrfProtection } from "./middleware/csrf";
import { computeReadiness, getBillingReadiness } from "./lib/stripeStartup";
import { withReadinessDetails } from "./lib/readinessDetails";
import { internalAnalyticsRouter } from "./routes/analytics";

const app: Express = express();
let applicationReady = false;

/**
 * Mark the core application (runtime migrations) ready. Billing readiness is
 * reported separately by lib/stripeStartup.ts, which keeps the process alive
 * for diagnostics while withholding readiness when Stripe cannot be verified.
 */
export function markApplicationReady(): void {
  applicationReady = true;
}

// Trust the hosting proxy (Render's load balancer) so express-session sees HTTPS and sets secure cookies
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        const requestPath = req.url?.split("?")[0] ?? "";
        const redactedPath = requestPath.replace(
          /(\/(?:sign-off|contractor-portal|fix-track\/action|fix-track\/quotes\/public|privacy-intake|privacy-request|site-sign-in)\/)[^/]+/g,
          "$1[redacted]",
        );
        return {
          id: req.id,
          method: req.method,
          url: redactedPath,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const allowedOrigins = [
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : []),
  ...(process.env.PUBLIC_APP_URL ? [process.env.PUBLIC_APP_URL.replace(/\/+$/, "")] : []),
  // Render sets this to the service's own onrender.com address.
  ...(process.env.RENDER_EXTERNAL_URL ? [process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")] : []),
  "http://localhost:3000",
  "http://localhost:5173",
].flatMap((origin) => {
  try {
    return [new URL(origin.trim()).origin];
  } catch {
    return [];
  }
});

app.use(
  cors({
    origin: (origin, callback) => {
      let parsedOrigin: string | null = null;
      try {
        parsedOrigin = origin ? new URL(origin).origin : null;
      } catch {
        parsedOrigin = null;
      }
      if (!origin || (parsedOrigin !== null && allowedOrigins.includes(parsedOrigin))) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

// HTTP security headers — applied to all responses.
// crossOriginEmbedderPolicy stays disabled as before:
// enabling it would require every cross-origin resource the app loads to opt
// in via CORP/CORS.
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false, // API-only server — no HTML is served here.
  }),
);

// Production: serve the compliance-tracker build from this process, with an
// index.html fallback for client-side routes. Mounted before the session and
// auth middleware so static files never touch the database. WEB_DIST_DIR
// overrides the location; when no build exists (development) this is skipped
// and Vite serves the web app instead.
const webDistDir = process.env.WEB_DIST_DIR
  ? path.resolve(process.env.WEB_DIST_DIR)
  : path.resolve(import.meta.dirname, "../../compliance-tracker/dist/public");
const webIndexHtml = path.join(webDistDir, "index.html");

if (fs.existsSync(webIndexHtml)) {
  logger.info({ webDistDir }, "Serving web app build");
  const isServerPath = (p: string) =>
    p === "/api" || p.startsWith("/api/") || p === "/healthz" || p === "/readyz";

  // Public pages the web build prerendered as <path>/index.html (see
  // compliance-tracker scripts/seo-pages.mjs). Every other client route gets
  // the home page's HTML, so it is marked noindex: otherwise search engines
  // would index app, token and unknown URLs as copies of the home page.
  // Pages can be nested one level, such as /features/fire-safety-logbook.
  const publicPageFiles = new Map<string, string>();
  const addPublicPages = (dir: string, urlPrefix: string, depth: number) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "assets") continue;
      const pageDir = path.join(dir, entry.name);
      const pageFile = path.join(pageDir, "index.html");
      if (fs.existsSync(pageFile)) publicPageFiles.set(`${urlPrefix}/${entry.name}`, pageFile);
      if (depth > 0) addPublicPages(pageDir, `${urlPrefix}/${entry.name}`, depth - 1);
    }
  };
  addPublicPages(webDistDir, "", 1);

  const serveWebFiles = express.static(webDistDir, {
    index: false,
    // A prerendered page lives in a directory; without this /signup would
    // redirect to /signup/ instead of falling through to the handler below.
    redirect: false,
    setHeaders(res, filePath) {
      // Vite fingerprints everything under assets/, so it can be cached forever.
      if (filePath.startsWith(path.join(webDistDir, "assets") + path.sep)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });

  // Once the site has its own domain (PUBLIC_SITE_URL), send web page
  // requests that arrive on Render's onrender.com address there, so people
  // and search engines see one copy of the site. API paths are left alone:
  // the mobile app and webhooks may still call the onrender.com address.
  const canonicalOrigin = process.env.PUBLIC_SITE_URL
    ? new URL(process.env.PUBLIC_SITE_URL).origin
    : null;
  const renderHost = process.env.RENDER_EXTERNAL_URL
    ? new URL(process.env.RENDER_EXTERNAL_URL).host.toLowerCase()
    : null;
  if (canonicalOrigin && renderHost && new URL(canonicalOrigin).host !== renderHost) {
    app.use((req, res, next) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || isServerPath(req.path)) return next();
      if (req.headers.host?.toLowerCase() !== renderHost) return next();
      res.redirect(301, canonicalOrigin + req.originalUrl);
    });
  }

  app.use((req, res, next) => (isServerPath(req.path) ? next() : serveWebFiles(req, res, next)));

  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || isServerPath(req.path)) return next();
    res.setHeader("Cache-Control", "no-cache");
    // A missing script or style file (usually one from before the latest
    // release, asked for by a tab opened earlier) is a 404, never the app's
    // HTML: browsers cannot run HTML as a script, and the web app reloads
    // itself when a page file fails to load.
    if (req.path.startsWith("/assets/")) {
      return void res.status(404).type("text/plain").send("Not found");
    }
    const pagePath = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
    const pageFile = publicPageFiles.get(pagePath);
    if (pageFile) return void res.sendFile(pageFile);
    if (pagePath !== "/") res.setHeader("X-Robots-Tag", "noindex");
    res.sendFile(webIndexHtml);
  });
}

// Token-only, read-only analytics aggregates. Mounted before cookies,
// sessions and user loading so a session cookie can never authorise it.
app.use(internalAnalyticsRouter);

app.use(cookieParser());

// Webhook endpoints MUST be registered before express.json() — they need raw Buffer bodies
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) return void res.status(400).json({ error: "Missing stripe-signature" });
    const sig = Array.isArray(signature) ? signature[0] : signature;
    let event: {
      type?: string;
      data?: { object?: Record<string, any> };
    };
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      event = JSON.parse((req.body as Buffer).toString("utf8")) as {
        type?: string;
        data?: { object?: Record<string, any> };
      };
      await recordAlpsDiscountCheckoutEvent(event);
      res.status(200).json({ received: true });
    } catch (err: any) {
      logger.error({ err }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
      return;
    }

    // Best-effort follow-up once the synced tables are updated: local plan
    // status, retention-clock reset on resubscription, cancellation and
    // failed-payment emails, and billing changes for ALPS's digest. Never
    // throws — the 200 has already been sent.
    WebhookHandlers.afterSync(event).catch((err) => logger.warn({ err }, "Stripe webhook follow-up failed"));
  }
);

// Emails received for certificate addresses (lib/certificateInbox.ts). Resend
// signs each delivery; the email is recorded and answered at once, and its
// attachments are fetched afterwards. Off (404) until the inbox domain and
// webhook secret are set.
app.post(
  "/api/inbound/certificate-email",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    const secret = inboundWebhookSecret();
    if (!secret || !certificateInboxDomain()) return void res.status(404).json({ error: "Not found" });
    const payload = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const signed = verifyInboundWebhook(payload, {
      id: header("svix-id"), timestamp: header("svix-timestamp"), signature: header("svix-signature"),
    }, secret);
    if (!signed) return void res.status(401).json({ error: "Invalid signature" });
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return void res.status(400).json({ error: "Invalid JSON" });
    }
    let emailRowId: number | null;
    try {
      emailRowId = await recordInboundEmail(event as Parameters<typeof recordInboundEmail>[0]);
    } catch (err) {
      logger.error({ err }, "Received certificate email could not be recorded");
      return void res.status(500).json({ error: "Could not record the email" });
    }
    res.status(200).json({ received: true });
    if (emailRowId !== null) {
      processInboundEmail(emailRowId).catch((err) => logger.error({ err, emailRowId }, "Received certificate email failed"));
    }
  },
);

// Register CSV imports send up to 1,000 rows, and a PAT register photo or PDF
// is sent as base64 (8 MB file at most); every other route keeps the default limit.
app.use("/api/imports/pat-appliances/read", express.json({ limit: "12mb" }));
// Certificates read by ComplyTrack's AI arrive as base64 (20 MB at most before
// encoding, all files together).
app.use("/api/certificates/read", express.json({ limit: "28mb" }));
app.use("/api/certificates/read-files", express.json({ limit: "28mb" }));
// A contractor's certificate upload arrives as base64 (10 MB at most before encoding).
app.use("/api/certificate-upload", express.json({ limit: "14mb" }));
// A contractor's drawn signature arrives as a PNG data URL when they sign in at a site.
app.use("/api/site-sign-in", express.json({ limit: "1mb" }));
app.use("/api/imports", express.json({ limit: "2mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(csrfProtection);
app.use(loadUser);
app.use(enforceTwoFactorEnrollment);
app.use(enforceClientAccess);
app.use("/api", enforceDailyEntryCutoff);
app.use("/api", enforceTrialLock);

// Root-level health check — matches the deployment probe path and is exempt
// from the /api prefix so load balancers can reach it directly. It is 503
// until runtime migrations finish, so Render never promotes an instance whose
// migrations are still running (or failed: the process then exits).
app.get("/healthz", (_req, res) => {
  if (!applicationReady) return void res.status(503).json({ status: "starting" });
  res.json({ status: "ok" });
});
app.get("/readyz", (_req, res) => {
  const report = withReadinessDetails(computeReadiness(applicationReady, getBillingReadiness()));
  res.status(report.httpStatus).json(report.body);
});

app.use("/api", router);

// Unknown /api paths get a JSON 404 rather than Express's HTML page.
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry error handler — must come after all routes and before other error
// handlers so it has access to the full request context and error details.
if (isErrorReportingEnabled()) {
  Sentry.setupExpressErrorHandler(app);
}

// JSON error handler for /api/* — keeps responses copy-pasteable for users
// instead of returning Express's default HTML stack page.
app.use("/api", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return _next(err);

  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const path = issue?.path?.join(".") || "input";
    logger.warn({ err }, "Validation error");
    return res.status(400).json({ error: `Validation error on '${path}': ${issue?.message ?? "invalid value"}` });
  }

  // Malformed JSON: body-parser's message quotes the request body, so neither
  // return nor log it (it may hold personal data).
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    logger.warn("Rejected a request body that is not valid JSON");
    return res.status(400).json({ error: "Request body is not valid JSON" });
  }

  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e?.status ?? e?.statusCode ?? 500;
  const message = status >= 500 ? "Something went wrong on our end. Please try again." : (e?.message ?? "Request failed");
  logger.error({ err }, "Unhandled API error");
  res.status(status).json({ error: message });
});

export default app;
