/**
 * Sentry error monitoring initialisation.
 *
 * The bootstrap entry calls initSentry() before dynamically importing the
 * application, so Express and HTTP load after instrumentation is installed.
 */
import * as Sentry from "@sentry/node";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (process.env.NODE_ENV === "production") {
      console.warn("Sentry monitoring is disabled: SENTRY_DSN is not configured");
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    sendDefaultPii: false,
    beforeSend(event) {
      // Keep method, status and route context, not bearer links, query
      // parameters, cookies or request bodies.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
        if (event.request.url) {
          try {
            const url = new URL(event.request.url, "https://redacted.invalid");
            event.request.url = url.origin === "https://redacted.invalid"
              ? url.pathname
              : `${url.origin}${url.pathname}`;
            event.request.url = event.request.url.replace(
              /(\/(?:sign-off|contractor-portal|fix-track\/action|fix-track\/quotes\/public)\/)[^/]+/g,
              "$1[redacted]",
            );
          } catch {
            event.request.url = "[redacted]";
          }
        }
      }
      return event;
    },
    // Capture 10 % of transactions for performance tracing — enough to spot
    // slow endpoints without meaningfully increasing quota usage.
    tracesSampleRate: 0.1,
  });
}

// Re-export so callers can attach the Express error handler without an extra
// import at the call site.
export { Sentry };
