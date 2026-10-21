import * as Sentry from "@sentry/react";
import { createDeliveryLog, scrubErrorReport, type ErrorReportDelivery } from "@workspace/api-zod/error-report-scrub";

// Set at build time by vite.config.ts from the server's SENTRY_DSN (the DSN is
// public by design), SENTRY_ENVIRONMENT (else the build mode) and the deployed
// commit. A site built without SENTRY_DSN sends nothing and says so.
const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined) || "";
export const errorReportEnvironment = (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) || import.meta.env.MODE;
const release = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined;

const deliveries = createDeliveryLog();

/** Initialise Sentry before the React tree mounts. Does nothing without a DSN. */
export function initErrorReports(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: errorReportEnvironment,
    release,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    // Links and API calls may carry bearer tokens in their path or query
    // string, and messages may hold email addresses: none of it leaves.
    beforeSend: (event) => scrubErrorReport(event),
    beforeSendTransaction: (event) => scrubErrorReport(event),
    transport: (options) => deliveries.wrap(Sentry.makeFetchTransport(options)),
    // Capture 10 % of page-load / navigation transactions for performance.
    tracesSampleRate: 0.1,
  });
}

/** True only when this build has a DSN and the SDK accepted it. */
export function errorReportsEnabled(): boolean {
  return Boolean(Sentry.getClient()?.getDsn());
}

export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  if (errorReportsEnabled()) Sentry.captureException(error, extra ? { extra } : undefined);
}

export type TestErrorReportResult = {
  configured: boolean;
  environment: string;
  eventId: string | null;
  delivery: ErrorReportDelivery | null;
};

/** Send one deliberate error report from the browser and wait for Sentry's answer. */
export async function sendTestErrorReport(): Promise<TestErrorReportResult> {
  if (!errorReportsEnabled()) return { configured: false, environment: errorReportEnvironment, eventId: null, delivery: null };
  const eventId = Sentry.captureException(new Error("ComplyTrack test error report (website)"), {
    tags: { test_report: "true" },
  });
  await Sentry.flush(5_000).catch(() => false);
  return { configured: true, environment: errorReportEnvironment, eventId, delivery: deliveries.outcome(eventId) };
}
