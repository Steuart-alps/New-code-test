/**
 * Sentry error monitoring initialisation.
 *
 * Call initSentry() as the very first thing in the server entry-point so that
 * all Express instrumentation is active before any routes are registered.
 * Skips silently when SENTRY_DSN is not set (e.g. local dev without a DSN).
 */
import * as Sentry from "@sentry/node";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Capture 10 % of transactions for performance tracing — enough to spot
    // slow endpoints without meaningfully increasing quota usage.
    tracesSampleRate: 0.1,
  });
}

// Re-export so callers can attach the Express error handler without an extra
// import at the call site.
export { Sentry };
