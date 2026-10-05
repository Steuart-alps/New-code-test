import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getPublicAppUrl } from "./lib/email";
import { sessionMiddleware } from "./lib/session";
import { loadUser, enforceClientAccess, enforceTwoFactorEnrollment } from "./middleware/requireAuth";
import { enforceTrialLock } from "./middleware/trialLock";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { Sentry } from "./lib/sentry";
import { sendCancellationWarningEmail } from "./lib/offboarding";
import { recordAlpsDiscountCheckoutEvent } from "./lib/alpsDiscount";

const app: Express = express();
let applicationReady = false;
let readinessBlocker: string | null = null;

/**
 * Keep the process alive for diagnostics while accurately withholding readiness
 * when a launch-critical dependency could not be verified.
 */
export function markApplicationReady(blocker: string | null = null): void {
  readinessBlocker = blocker;
  applicationReady = blocker === null;
}

// Trust the Replit/proxy chain so express-session sees HTTPS and sets secure cookies
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
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
  getPublicAppUrl(),
  "http://localhost:3000",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.some(o => origin.startsWith(o)) || process.env.NODE_ENV !== "production") {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

// HTTP security headers — applied to all responses.
// crossOriginEmbedderPolicy is disabled because Replit's proxy/iframe chain
// sets its own COEP headers; enabling ours would conflict and break previews.
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false, // The web app sets no CSP; see the static serving below.
  }),
);

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
app.use(loadUser);
app.use(enforceTwoFactorEnrollment);
app.use(enforceClientAccess);
app.use("/api", enforceTrialLock);

// Root-level health check — matches the deployment probe path and is exempt
// from the /api prefix so load balancers / Replit can reach it directly.
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/readyz", (_req, res) => {
  if (!applicationReady) {
    return res.status(503).json({
      status: readinessBlocker ? "degraded" : "starting",
      ...(readinessBlocker ? { blocker: readinessBlocker } : {}),
    });
  }
  res.json({ status: "ok" });
});

app.use("/api", router);

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

  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e?.status ?? e?.statusCode ?? 500;
  const message = status >= 500 ? "Something went wrong on our end. Please try again." : (e?.message ?? "Request failed");
  logger.error({ err }, "Unhandled API error");
  res.status(status).json({ error: message });
});

// Serve the built web app (compliance-tracker) from the same origin as the API
// so production is a single process. WEB_DIST_DIR overrides the default
// location next to this bundle; nothing is served when the build is absent.
const webDistDir =
  process.env.WEB_DIST_DIR ??
  fileURLToPath(new URL("../../compliance-tracker/dist/public/", import.meta.url));
if (existsSync(webDistDir)) {
  app.use(express.static(webDistDir, { index: false }));
  // Client-side routes fall back to index.html; /api paths never do.
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile("index.html", { root: webDistDir });
  });
}

export default app;
