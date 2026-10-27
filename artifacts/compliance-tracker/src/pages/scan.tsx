import { useEffect } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { EquipmentScan, EquipmentScanState } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { clearScanPath } from "@/lib/scan-return";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Info, Loader2, QrCode, XCircle } from "lucide-react";

const STATE_STYLE: Record<EquipmentScanState, { className: string; icon: typeof CheckCircle2; word: string }> = {
  ok: { className: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: CheckCircle2, word: "In date" },
  due_soon: { className: "border-amber-200 bg-amber-50 text-amber-900", icon: Clock, word: "Due soon" },
  overdue: { className: "border-red-200 bg-red-50 text-red-900", icon: XCircle, word: "Overdue" },
  never: { className: "border-slate-200 bg-slate-50 text-slate-800", icon: CircleDashed, word: "Not recorded" },
  problem: { className: "border-red-200 bg-red-50 text-red-900", icon: AlertTriangle, word: "Needs attention" },
  info: { className: "border-slate-200 bg-white text-slate-800", icon: Info, word: "" },
};

class ScanUnavailable extends Error {}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export default function ScanPage() {
  const { code = "" } = useParams<{ code: string }>();
  const { user, activeClientId, setActiveClientId } = useAuth();

  useEffect(() => { clearScanPath(); }, []);

  const scan = useQuery({
    queryKey: ["equipment-scan", code.toUpperCase()],
    retry: false,
    queryFn: async () => {
      // The server finds the business from the label itself.
      const res = await apiFetch(`/equipment-labels/scan/${encodeURIComponent(code)}`);
      if (res.status === 404 || res.status === 403) throw new ScanUnavailable();
      if (!res.ok) throw new Error("The label could not be checked just now. Please try again.");
      return await res.json() as EquipmentScan;
    },
  });

  // A consultant scanning another business's label switches to that business,
  // so the buttons below open the right records.
  useEffect(() => {
    if (scan.data && user?.role === "consultant" && activeClientId !== scan.data.clientId) {
      setActiveClientId(scan.data.clientId);
    }
  }, [scan.data, user?.role, activeClientId]);

  const switching = !!scan.data && user?.role === "consultant" && activeClientId !== scan.data.clientId;

  return (
    <AppLayout title="Scanned label">
      <div className="mx-auto w-full max-w-xl space-y-4">
        {scan.isLoading && (
          <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking label {code.toUpperCase()}…
          </Card>
        )}

        {scan.error && (
          <Card className="space-y-3 p-6">
            <div className="flex items-center gap-2 font-semibold">
              <QrCode className="h-5 w-5 text-muted-foreground" />
              {scan.error instanceof ScanUnavailable ? "This label isn't available to you" : "Something went wrong"}
            </div>
            <p className="text-sm text-muted-foreground">
              {scan.error instanceof ScanUnavailable
                ? "The label may have been replaced, the item may belong to another business or department, or your account may not include this track. Ask your manager if you think you should see it."
                : scan.error.message}
            </p>
            {!(scan.error instanceof ScanUnavailable) && (
              <Button variant="outline" onClick={() => scan.refetch()}>Try again</Button>
            )}
          </Card>
        )}

        {scan.data && (
          <>
            <Card className="space-y-1 p-5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{scan.data.track}</Badge>
                {scan.data.siteName && <span>{scan.data.siteName}</span>}
                <span className="ml-auto font-mono tracking-widest">{scan.data.code}</span>
              </div>
              <h1 className="text-xl font-bold leading-tight">{scan.data.name}</h1>
              {scan.data.detail && <p className="text-sm text-muted-foreground">{scan.data.detail}</p>}
              {!scan.data.active && (
                <p className="pt-1 text-sm font-medium text-amber-700">This item is archived and no longer in use.</p>
              )}
            </Card>

            {scan.data.statuses.length > 0 && (
              <div className="space-y-2">
                {scan.data.statuses.map((status, index) => {
                  const style = STATE_STYLE[status.state];
                  const Icon = style.icon;
                  return (
                    <div key={`${status.label}-${index}`} className={cn("flex items-start gap-3 rounded-lg border p-3", style.className)}>
                      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <span className="font-medium">{status.label}</span>
                          {style.word && <span className="text-xs font-semibold uppercase tracking-wide">{style.word}</span>}
                        </div>
                        <p className="text-sm">{status.text}</p>
                        {status.note && <p className="text-xs opacity-80">{status.note}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {scan.data.actions.length > 0 && (
              <div className="grid gap-2">
                {scan.data.actions.map((action) => (
                  <Button key={action.href} asChild size="lg" variant={action.primary ? "default" : "outline"} className="h-12 justify-start text-base">
                    <Link href={action.href}>{action.label}</Link>
                  </Button>
                ))}
              </div>
            )}

            {scan.data.history.length > 0 && (
              <Card className="p-4">
                <h2 className="mb-2 text-sm font-bold">Recent records</h2>
                <ul className="divide-y text-sm">
                  {scan.data.history.map((entry, index) => (
                    <li key={`${entry.date}-${index}`} className="flex items-start gap-3 py-2">
                      <span className="w-24 shrink-0 text-muted-foreground">{formatDate(entry.date)}</span>
                      <span className={cn("min-w-0 flex-1", (entry.state === "problem" || entry.state === "overdue") && "text-red-700")}>{entry.text}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
