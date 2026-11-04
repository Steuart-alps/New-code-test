/**
 * Sentry error monitoring initialisation.
 *
 * The bootstrap entry calls initSentry() before dynamically importing the
 * application, so Express and HTTP load after instrumentation is installed.
 *
 * SENTRY_DSN switches reports on (unset = off, and nothing claims otherwise).
 * Events are tagged with SENTRY_ENVIRONMENT, else NODE_ENV ("production" on
 * Render), and with the deployed commit (SENTRY_RELEASE, else Render's
 * RENDER_GIT_COMMIT). Every event and trace is scrubbed by
 * scrubErrorReport (@workspace/api-zod/error-report-scrub) before it leaves.
 */
import * as Sentry from "@sentry/node";
import { createDeliveryLog, scrubErrorReport, type ErrorReportDelivery } from "@workspace/api-zod/error-report-scrub";

export function errorReportEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "development";
}

export function errorReportRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SENTRY_RELEASE?.trim() || env.RENDER_GIT_COMMIT?.trim() || undefined;
}

const deliveries = createDeliveryLog();

export function initSentry() {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    if (process.env.NODE_ENV === "production") {
      console.warn("Sentry monitoring is disabled: SENTRY_DSN is not configured");
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: errorReportEnvironment(),
    release: errorReportRelease(),
    sendDefaultPii: false,
    // Keep method, status, path shape and stack; drop bodies, headers,
    // cookies, query strings, bearer links and email addresses.
    beforeSend: (event) => scrubErrorReport(event),
    beforeSendTransaction: (event) => scrubErrorReport(event),
    transport: (options) => deliveries.wrap(Sentry.makeNodeTransport(options)),
    // Capture 10 % of transactions for performance tracing — enough to spot
    // slow endpoints without meaningfully increasing quota usage.
    tracesSampleRate: 0.1,
  });

  if (isErrorReportingEnabled()) {
    console.info(`Sentry error reports are configured (environment "${errorReportEnvironment()}")`);
  } else {
    console.warn("Sentry monitoring is disabled: SENTRY_DSN is not a valid Sentry DSN");
  }
}

/** True only when SENTRY_DSN was set and accepted by the SDK. */
export function isErrorReportingEnabled(): boolean {
  return Boolean(Sentry.getClient()?.getDsn());
}

export type TestErrorReportResult = {
  configured: boolean;
  environment: string;
  release: string | null;
  eventId: string | null;
  delivery: ErrorReportDelivery | null;
};

/**
 * Send one deliberate error report and wait (up to 5 s) for Sentry's answer,
 * so an operator can confirm the DSN, project and environment end to end.
 */
export async function sendTestErrorReport(): Promise<TestErrorReportResult> {
  const base = { environment: errorReportEnvironment(), release: errorReportRelease() ?? null };
  if (!isErrorReportingEnabled()) return { ...base, configured: false, eventId: null, delivery: null };
  const eventId = Sentry.captureException(new Error("ComplyTrack test error report (API)"), {
    tags: { test_report: "true" },
  });
  await Sentry.flush(5_000).catch(() => false);
  return { ...base, configured: true, eventId, delivery: deliveries.outcome(eventId) };
}

// Re-export so callers can attach the Express error handler without an extra
// import at the call site.
export { Sentry };
