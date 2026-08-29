import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, RefreshCw, CheckCircle2, Clock, XCircle, ShieldCheck } from "lucide-react";
import { Link } from "wouter";

interface SiteStatus {
  siteId: number;
  siteName: string;
  am: {
    submitted: boolean;
    submittedAt: string | null;
    submittedByName: string | null;
    checkedCount: number;
    totalCount: number;
  } | null;
  pm: {
    submitted: boolean;
    submittedAt: string | null;
    submittedByName: string | null;
    checkedCount: number;
    totalCount: number;
    signedOff: boolean;
    signedOffAt: string | null;
    signedOffByName: string | null;
  } | null;
}

interface OverviewData {
  date: string;
  sites: SiteStatus[];
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function offsetDate(date: string, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(date: string) {
  const today = todayDate();
  if (date === today) return "Today";
  const yesterday = offsetDate(today, -1);
  if (date === yesterday) return "Yesterday";
  return new Date(date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function AmCell({ status }: { status: SiteStatus["am"] }) {
  if (!status) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground/50">
        <XCircle className="w-4 h-4" />
        <span className="text-xs">Not submitted</span>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-emerald-700">
        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        <span className="text-xs font-medium">Submitted</span>
      </div>
      <div className="text-xs text-muted-foreground pl-5.5">
        {status.checkedCount}/{status.totalCount} items · {formatTime(status.submittedAt)}
      </div>
      {status.submittedByName && (
        <div className="text-xs text-muted-foreground pl-5.5 truncate max-w-[160px]">{status.submittedByName}</div>
      )}
    </div>
  );
}

function PmCell({ status, siteId, date, onSignOff }: { status: SiteStatus["pm"]; siteId: number; date: string; onSignOff: () => void }) {
  const [signing, setSigning] = useState(false);

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground/50">
        <XCircle className="w-4 h-4" />
        <span className="text-xs">Not submitted</span>
      </div>
    );
  }

  if (status.signedOff) {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-emerald-700">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <span className="text-xs font-medium">Signed off</span>
        </div>
        <div className="text-xs text-muted-foreground pl-5.5">
          {status.checkedCount}/{status.totalCount} items · {formatTime(status.submittedAt)}
        </div>
        {status.signedOffByName && (
          <div className="text-xs text-muted-foreground pl-5.5 truncate max-w-[160px]">by {status.signedOffByName}</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-amber-600">
        <Clock className="w-4 h-4 text-amber-400" />
        <span className="text-xs font-medium">Awaiting sign-off</span>
      </div>
      <div className="text-xs text-muted-foreground pl-5.5">
        {status.checkedCount}/{status.totalCount} items · {formatTime(status.submittedAt)}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-xs px-2 ml-5.5 border-amber-200 text-amber-700 hover:bg-amber-50"
        disabled={signing}
        onClick={async () => {
          setSigning(true);
          try {
            const res = await apiFetch(`/daily-checklists/${siteId}/${date}/pm/sign-off`, {
              method: "POST",
              body: JSON.stringify({ notes: "" }),
            });
            if (res.ok) onSignOff();
          } finally {
            setSigning(false);
          }
        }}
      >
        {signing ? "Signing…" : "Sign off"}
      </Button>
    </div>
  );
}

export default function DailyOverviewPage() {
  const [date, setDate] = useState(todayDate());
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/daily-checklists/overview?date=${date}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const today = todayDate();
  const isFuture = date > today;

  const amDone = data?.sites.filter(s => s.am).length ?? 0;
  const pmDone = data?.sites.filter(s => s.pm).length ?? 0;
  const pmSignedOff = data?.sites.filter(s => s.pm?.signedOff).length ?? 0;
  const total = data?.sites.length ?? 0;

  return (
    <AppLayout title="Daily Checklist Overview">
      <div className="space-y-6">
        {/* Date Nav + Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDate(d => offsetDate(d, -1))}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="text-center min-w-[120px]">
              <div className="font-medium text-sm">{formatDateLabel(date)}</div>
              <div className="text-xs text-muted-foreground">{new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</div>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={date >= today} onClick={() => setDate(d => offsetDate(d, 1))}>
              <ChevronRight className="w-4 h-4" />
            </Button>
            {date !== today && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDate(today)}>Today</Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Link href="/daily/am">
              <Button size="sm" variant="outline" className="h-8 text-xs border-sky-200 text-sky-700 hover:bg-sky-50">AM Checklist</Button>
            </Link>
            <Link href="/daily/pm">
              <Button size="sm" variant="outline" className="h-8 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50">PM Checklist</Button>
            </Link>
          </div>
        </div>

        {/* Summary row */}
        {!loading && data && total > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center ${amDone === total ? "bg-emerald-100" : "bg-muted"}`}>
                <CheckCircle2 className={`w-5 h-5 ${amDone === total ? "text-emerald-600" : "text-muted-foreground"}`} />
              </div>
              <div>
                <div className="text-2xl font-semibold">{amDone}<span className="text-sm text-muted-foreground font-normal">/{total}</span></div>
                <div className="text-xs text-muted-foreground">AM submitted</div>
              </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center ${pmDone === total ? "bg-emerald-100" : "bg-muted"}`}>
                <CheckCircle2 className={`w-5 h-5 ${pmDone === total ? "text-emerald-600" : "text-muted-foreground"}`} />
              </div>
              <div>
                <div className="text-2xl font-semibold">{pmDone}<span className="text-sm text-muted-foreground font-normal">/{total}</span></div>
                <div className="text-xs text-muted-foreground">PM submitted</div>
              </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center ${pmSignedOff === total ? "bg-emerald-100" : pmSignedOff > 0 ? "bg-amber-100" : "bg-muted"}`}>
                <ShieldCheck className={`w-5 h-5 ${pmSignedOff === total ? "text-emerald-600" : pmSignedOff > 0 ? "text-amber-600" : "text-muted-foreground"}`} />
              </div>
              <div>
                <div className="text-2xl font-semibold">{pmSignedOff}<span className="text-sm text-muted-foreground font-normal">/{total}</span></div>
                <div className="text-xs text-muted-foreground">PM signed off</div>
              </div>
            </div>
          </div>
        )}

        {/* Main table */}
        {loading ? (
          <div className="text-center py-20 text-muted-foreground text-sm">Loading…</div>
        ) : !data || data.sites.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground text-sm">
            <p className="font-medium mb-1">No sites found</p>
            <p className="text-xs">Add a site first, then staff can submit their daily checklists.</p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/50 border-b border-border">
                <tr>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Site</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-sky-400" />
                      AM · Opening
                    </div>
                  </th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-indigo-400" />
                      PM · Closing
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.sites.map((site) => (
                  <tr key={site.siteId} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-4 font-medium text-sm">{site.siteName}</td>
                    <td className="px-5 py-4">
                      <AmCell status={site.am} />
                    </td>
                    <td className="px-5 py-4">
                      <PmCell status={site.pm} siteId={site.siteId} date={date} onSignOff={load} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5 text-muted-foreground/40" /> Not submitted</div>
          <div className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> Submitted</div>
          <div className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-400" /> Awaiting sign-off</div>
          <div className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Manager signed off</div>
        </div>
      </div>
    </AppLayout>
  );
}
