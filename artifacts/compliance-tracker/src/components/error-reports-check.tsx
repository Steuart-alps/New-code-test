import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { errorReportEnvironment, errorReportsEnabled, sendTestErrorReport } from "@/lib/error-reports";
import type { ErrorReportDelivery } from "@workspace/api-zod/error-report-scrub";

type CheckResult = {
  configured: boolean;
  environment: string;
  eventId: string | null;
  delivery: ErrorReportDelivery | null;
};

function describe(result: CheckResult | string, missing: string): string {
  if (typeof result === "string") return result;
  if (!result.configured) return missing;
  const where = `environment "${result.environment}"`;
  switch (result.delivery?.outcome) {
    case "accepted":
      return `Sentry accepted the test report (${where}, event ${result.eventId}).`;
    case "rejected":
      return `Sentry refused the test report with HTTP ${result.delivery.statusCode}. Check that SENTRY_DSN is the project's DSN.`;
    case "failed":
      return "The test report could not reach Sentry (network error or rate limit).";
    default:
      return `The test report was sent but Sentry had not answered after 5 seconds (${where}, event ${result.eventId}).`;
  }
}

/**
 * Platform operators only: send one deliberate error report from the website
 * and one from the server, and show what Sentry answered for each.
 */
export function ErrorReportsCheck() {
  const [sending, setSending] = useState(false);
  const [web, setWeb] = useState<CheckResult | string | null>(null);
  const [api, setApi] = useState<CheckResult | string | null>(null);

  const run = async () => {
    setSending(true);
    setWeb(null);
    setApi(null);
    try {
      const [webResult, apiResult] = await Promise.all([
        sendTestErrorReport().catch(() => "The website could not send a test report."),
        apiFetch("/admin/error-reports/test", { method: "POST", body: "{}" })
          .then(async (res) => (res.ok ? (await res.json()) as CheckResult : getApiErrorMessage(res, "The server could not send a test report.")))
          .catch(() => "The server could not be reached."),
      ]);
      setWeb(webResult);
      setApi(apiResult);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-xl border bg-card p-5" aria-label="Error reports">
      <h2 className="font-semibold">Error reports</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {errorReportsEnabled()
          ? `This website build sends errors to Sentry (environment "${errorReportEnvironment}").`
          : "This website build has no Sentry DSN, so website errors are not reported."}{" "}
        Sending a test creates one "ComplyTrack test error report" issue in Sentry from each side.
      </p>
      <Button className="mt-3" type="button" size="sm" variant="outline" disabled={sending} onClick={run}>
        {sending ? "Sending…" : "Send test error reports"}
      </Button>
      {(web || api) && (
        <ul className="mt-3 space-y-1 text-sm" role="status">
          {web && <li><strong>Website:</strong> {describe(web, "Not set up: SENTRY_DSN was not set when this website was built.")}</li>}
          {api && <li><strong>Server:</strong> {describe(api, "Not set up: SENTRY_DSN is not set on the server.")}</li>}
        </ul>
      )}
    </section>
  );
}
