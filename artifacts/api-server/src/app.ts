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
import { Sentry } from "./lib/sentry";
import { sendCancellationWarningEmail } from "./lib/offboarding";
import { recordAlpsDiscountCheckoutEvent } from "./lib/alpsDiscount";
import { csrfProtection } from "./middleware/csrf";
import { computeReadiness, getBillingReadiness } from "./lib/stripeStartup";
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
          /(\/(?:sign-off|contractor-portal|fix-track\/action|fix-track\/quotes\/public)\/)[^/]+/g,
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

  const serveWebFiles = express.static(webDistDir, {
    index: false,
    setHeaders(res, filePath) {
      // Vite fingerprints everything under assets/, so it can be cached forever.
      if (filePath.startsWith(path.join(webDistDir, "assets") + path.sep)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });

  app.use((req, res, next) => (isServerPath(req.path) ? next() : serveWebFiles(req, res, next)));

  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || isServerPath(req.path)) return next();
    res.setHeader("Cache-Control", "no-cache");
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

    // Best-effort: send a cancellation warning email when a subscription is
    // cancelled immediately or scheduled to cancel at period end.
    // Must happen AFTER processWebhook so the DB is already updated.
    // Never throws — a failure must not affect the 200 already sent.
    try {
      const sub = event?.data?.object ?? {};
      const isCancelled = event.type === "customer.subscription.deleted";
      const isCancelAtPeriodEnd =
        event.type === "customer.subscription.updated" &&
        sub.cancel_at_period_end === true;

      if ((isCancelled || isCancelAtPeriodEnd) && sub.customer) {
        const accessEndsAt: string | number | null =
          typeof sub.cancel_at === "number" ? sub.cancel_at :
          typeof sub.current_period_end === "number" ? sub.current_period_end :
          null;
        sendCancellationWarningEmail({
          stripeCustomerId: String(sub.customer),
          accessEndsAt,
        }).catch((err) => logger.warn({ err }, "Cancellation warning email failed"));
      }
    } catch (err) {
      logger.warn({ err }, "Could not parse Stripe event for cancellation warning");
    }
  }
);

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
// from the /api prefix so load balancers can reach it directly.
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/readyz", (_req, res) => {
  const report = computeReadiness(applicationReady, getBillingReadiness());
  res.status(report.httpStatus).json(report.body);
});

app.use("/api", router);

// Unknown /api paths get a JSON 404 rather than Express's HTML page.
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry error handler — must come after all routes and before other error
// handlers so it has access to the full request context and error details.
if (process.env.SENTRY_DSN) {
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
