import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";
import { loadUser, enforceClientAccess } from "./middleware/requireAuth";
import { enforceTrialLock } from "./middleware/trialLock";
import { WebhookHandlers } from "./lib/webhookHandlers";

const app: Express = express();

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

const replitDeploymentOrigins = (process.env.REPLIT_DOMAINS ?? "")
  .split(",")
  .map(d => d.trim())
  .filter(Boolean)
  .flatMap(d => [`https://${d}`, `http://${d}`]);

const allowedOrigins = [
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : []),
  ...replitDeploymentOrigins,
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

app.use(cookieParser());

// Webhook endpoints MUST be registered before express.json() — they need raw Buffer bodies
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).json({ error: "Missing stripe-signature" });
    const sig = Array.isArray(signature) ? signature[0] : signature;
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: any) {
      logger.error({ err }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(loadUser);
app.use(enforceClientAccess);
app.use("/api", enforceTrialLock);

app.use("/api", router);

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

export default app;
