import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";

export function CancellationBanner() {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const [status, setStatus] = useState<{ clientId: number; accessEndsAt: string | null } | null>(null);

  useEffect(() => {
    if (!canAdmin || activeClientId === null) {
      setStatus(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const response = await apiFetch("/billing/cancellation-status");
        if (!response.ok) throw new Error("Cancellation status unavailable");
        const data = await response.json() as { accessEndsAt: string | null };
        if (active) setStatus({ clientId: activeClientId, accessEndsAt: data.accessEndsAt });
      } catch {
        // Never show a stale cancellation after switching accounts or after
        // Stripe's reversal update has replaced a previously shown status.
        if (active) setStatus({ clientId: activeClientId, accessEndsAt: null });
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [activeClientId, canAdmin]);

  if (!canAdmin || status?.clientId !== activeClientId || !status.accessEndsAt) return null;
  const date = new Date(status.accessEndsAt);
  if (!Number.isFinite(date.getTime())) return null;
  const label = date.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London",
  });

  return (
    <div role="status" className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="text-sm">
          <strong>Your subscription is set to end on {label}.</strong>{" "}
          Export your compliance records before access ends.
        </p>
      </div>
      <a href="/settings#data-export" className="shrink-0 text-sm font-semibold underline underline-offset-2">
        Go to Data Export
      </a>
    </div>
  );
}