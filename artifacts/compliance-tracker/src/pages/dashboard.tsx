import React, { useEffect, useState, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { useListSites } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Link, useLocation } from "wouter";
import {
  ChevronDown, ChevronRight, ArrowRight, AlertCircle, AlertTriangle,
  CheckCircle2, MinusCircle, SlidersHorizontal, Sunrise, Sunset,
  UtensilsCrossed,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/context/auth-context";

// ── Types ─────────────────────────────────────────────────────────────────────

type TrackStatus = "ok" | "attention" | "overdue" | "no_data";

interface TrackItem {
  label: string;
  detail: string;
  path: string;
}

interface TrackSummary {
  trackId: string;
  label: string;
  path: string;
  enabled: boolean;
  status: TrackStatus;
  badge: string;
  items: TrackItem[];
}

// ── Status styling ─────────────────────────────────────────────────────────────

const STATUS_BORDER: Record<TrackStatus, string> = {
  overdue:   "border-l-rose-500",
  attention: "border-l-amber-400",
  ok:        "border-l-emerald-500",
  no_data:   "border-l-muted-foreground/30",
};

const STATUS_BG: Record<TrackStatus, string> = {
  overdue:   "bg-rose-50/60",
  attention: "bg-amber-50/60",
  ok:        "bg-background",
  no_data:   "bg-muted/20",
};

const STATUS_BADGE: Record<TrackStatus, string> = {
  overdue:   "bg-rose-100 text-rose-700",
  attention: "bg-amber-100 text-amber-700",
  ok:        "bg-emerald-100 text-emerald-700",
  no_data:   "bg-muted text-muted-foreground",
};

function StatusIcon({ status, className }: { status: TrackStatus; className?: string }) {
  if (status === "overdue")   return <AlertCircle   className={cn("text-rose-500",               className)} />;
  if (status === "attention") return <AlertTriangle  className={cn("text-amber-500",              className)} />;
  if (status === "ok")        return <CheckCircle2   className={cn("text-emerald-500",            className)} />;
  return                             <MinusCircle    className={cn("text-muted-foreground/50",    className)} />;
}

// ── Track row ─────────────────────────────────────────────────────────────────

function TrackRow({ track, kitchenOverdueBadge }: { track: TrackSummary; kitchenOverdueBadge?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const hasItems = track.items.length > 0;
  const canExpand = hasItems;

  return (
    <div
      className={cn(
        "border-l-4 rounded-r-md border border-border/60 transition-colors",
        STATUS_BORDER[track.status],
        STATUS_BG[track.status],
      )}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => canExpand && setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-3 text-left",
          canExpand ? "cursor-pointer" : "cursor-default",
        )}
      >
        <StatusIcon status={track.status} className="w-4 h-4 shrink-0" />

        <span className="font-medium text-sm flex-1">{track.label}</span>

        {kitchenOverdueBadge}

        <span
          className={cn(
            "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
            STATUS_BADGE[track.status],
          )}
        >
          {track.badge}
        </span>

        {canExpand ? (
          open ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          )
        ) : (
          /* Spacer so badge stays aligned */
          <span className="w-4 shrink-0" />
        )}
      </button>

      {/* Expanded items */}
      {open && hasItems && (
        <div className="border-t border-border/40 divide-y divide-border/30">
          {track.items.map((item, idx) => (
            <Link key={idx} href={item.path}>
              <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-black/5 cursor-pointer group text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">{item.label}</p>
                  <p className="text-xs text-muted-foreground truncate">{item.detail}</p>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
              </div>
            </Link>
          ))}
          {/* Link to full track page */}
          <Link href={track.path}>
            <div className="px-4 py-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 cursor-pointer">
              <span>Open {track.label}</span>
              <ArrowRight className="w-3 h-3" />
            </div>
          </Link>
        </div>
      )}
    </div>
  );
}

// ── Disabled track stub ────────────────────────────────────────────────────────

function DisabledTrack({ track }: { track: TrackSummary }) {
  return (
    <div className="border-l-4 border-l-muted-foreground/20 rounded-r-md border border-border/40 bg-muted/10 opacity-60">
      <div className="flex items-center gap-3 px-4 py-3">
        <MinusCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
        <span className="text-sm text-muted-foreground flex-1">{track.label}</span>
        <span className="text-xs text-muted-foreground">Not enabled</span>
      </div>
    </div>
  );
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ tracks }: { tracks: TrackSummary[] }) {
  const enabled = tracks.filter((t) => t.enabled);
  const overdue   = enabled.filter((t) => t.status === "overdue").length;
  const attention = enabled.filter((t) => t.status === "attention").length;
  const ok        = enabled.filter((t) => t.status === "ok").length;

  if (enabled.length === 0) return null;

  return (
    <div className="flex items-center gap-4 text-sm flex-wrap">
      {overdue > 0 && (
        <span className="flex items-center gap-1.5 text-rose-600 font-medium">
          <AlertCircle className="w-4 h-4" />
          {overdue} track{overdue > 1 ? "s" : ""} overdue
        </span>
      )}
      {attention > 0 && (
        <span className="flex items-center gap-1.5 text-amber-600 font-medium">
          <AlertTriangle className="w-4 h-4" />
          {attention} need{attention === 1 ? "s" : ""} attention
        </span>
      )}
      {ok > 0 && (
        <span className="flex items-center gap-1.5 text-emerald-600">
          <CheckCircle2 className="w-4 h-4" />
          {ok} all OK
        </span>
      )}
    </div>
  );
}

// ── DailyTrack snapshot card ──────────────────────────────────────────────────

function DailyTrackSnapshotCard() {
  const { data: allSites = [] } = useListSites();
  const [amRows, setAmRows] = useState<{ siteId: number | null; submittedAt: string | null }[]>([]);
  const [pmRows, setPmRows] = useState<{ siteId: number | null; submittedAt: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const today = new Date().toISOString().slice(0, 10);
    (async () => {
      setLoading(true);
      try {
        const [amRes, pmRes] = await Promise.all([
          apiFetch(`/daily-track-am?date=${today}`),
          apiFetch(`/daily-track-pm?date=${today}`),
        ]);
        if (!cancelled) {
          setAmRows(amRes.ok ? await amRes.json() : []);
          setPmRows(pmRes.ok ? await pmRes.json() : []);
        }
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const totalSites = allSites.length;
  if (totalSites === 0 && !loading) return null;

  // Count sites where a "premises_opening" AM checklist was submitted
  const amComplete = allSites.filter(s =>
    amRows.some(r => r.siteId === s.id && r.submittedAt)
  ).length;
  const pmComplete = allSites.filter(s =>
    pmRows.some(r => r.siteId === s.id && r.submittedAt)
  ).length;
  const totalComplete = allSites.filter(s =>
    amRows.some(r => r.siteId === s.id && r.submittedAt) &&
    pmRows.some(r => r.siteId === s.id && r.submittedAt)
  ).length;

  const allDone = totalComplete === totalSites;

  return (
    <div className={cn(
      "rounded-lg border border-border/60 bg-card px-4 py-3 flex items-center gap-4 flex-wrap",
      allDone ? "border-l-4 border-l-emerald-500" : "border-l-4 border-l-amber-400",
    )}>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="font-medium text-sm">Today's Checklists</span>
        {loading ? (
          <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
        ) : (
          <span className={cn(
            "text-xs px-2 py-0.5 rounded-full font-medium",
            allDone ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
          )}>
            {totalComplete}/{totalSites} sites complete
          </span>
        )}
      </div>
      {!loading && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Sunrise className="w-3.5 h-3.5 text-amber-500" />
            AM: <span className={cn("ml-0.5 font-medium", amComplete === totalSites ? "text-emerald-600" : "text-foreground")}>{amComplete}/{totalSites}</span>
          </span>
          <span className="flex items-center gap-1">
            <Sunset className="w-3.5 h-3.5 text-violet-500" />
            PM: <span className={cn("ml-0.5 font-medium", pmComplete === totalSites ? "text-emerald-600" : "text-foreground")}>{pmComplete}/{totalSites}</span>
          </span>
          <Link href="/daily-track-status">
            <span className="text-primary hover:underline cursor-pointer flex items-center gap-0.5">
              View <ArrowRight className="w-3 h-3" />
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

// ── KitchenTrack overdue indicator ────────────────────────────────────────────

function KitchenTrackOverdueBadge() {
  const [missing, setMissing] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const today = new Date().toISOString().slice(0, 10);
    (async () => {
      try {
        const res = await apiFetch("/food-safety");
        if (!cancelled && res.ok) {
          const records: { recordDate: string; submittedAt: string | null }[] = await res.json();
          const todayRecord = records.find(r => r.recordDate === today && r.submittedAt);
          setMissing(!todayRecord);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (missing === null || !missing) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium shrink-0">
      <UtensilsCrossed className="w-3 h-3" />
      Today's record missing
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { hasService } = useAuth();
  const hasDailytrack = hasService("dailytrack_am");
  const hasKitchentrack = hasService("kitchentrack");
  const { data: sites = [] } = useListSites();
  const [siteId, setSiteId] = useState<string>("all");
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = siteId !== "all" ? `?siteId=${siteId}` : "";
      const res = await apiFetch(`/dashboard/summary${params}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setTracks(json.tracks ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  const enabledTracks   = tracks.filter((t) => t.enabled);
  const disabledTracks  = tracks.filter((t) => !t.enabled);

  // Sort: overdue first, then attention, then ok, then no_data
  const statusOrder: Record<TrackStatus, number> = {
    overdue: 0, attention: 1, ok: 2, no_data: 3,
  };
  const sorted = [...enabledTracks].sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status],
  );

  return (
    <AppLayout title="Dashboard">
      <div className="space-y-6 max-w-3xl mx-auto py-6 px-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Today's compliance status across all tracks
            </p>
          </div>

          {/* Site filter */}
          {sites.length > 1 && (
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-muted-foreground" />
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger className="w-44 h-8 text-sm">
                  <SelectValue placeholder="All sites" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sites</SelectItem>
                  {sites.map((s: any) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            Failed to load dashboard: {error}
          </div>
        )}

        {/* DailyTrack snapshot */}
        {hasDailytrack && <DailyTrackSnapshotCard />}

        {/* Summary bar */}
        {!loading && !error && tracks.length > 0 && (
          <SummaryBar tracks={tracks} />
        )}

        {/* Track list */}
        {!loading && !error && sorted.length > 0 && (
          <div className="space-y-2">
            {sorted.map((track) => (
              <TrackRow
                key={track.trackId}
                track={track}
                kitchenOverdueBadge={hasKitchentrack && track.trackId === "kitchentrack" ? <KitchenTrackOverdueBadge /> : null}
              />
            ))}
          </div>
        )}

        {/* Disabled tracks (collapsed section) */}
        {!loading && !error && disabledTracks.length > 0 && (
          <details className="group">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none list-none flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" />
              {disabledTracks.length} disabled track{disabledTracks.length > 1 ? "s" : ""}
            </summary>
            <div className="mt-2 space-y-1.5">
              {disabledTracks.map((track) => (
                <DisabledTrack key={track.trackId} track={track} />
              ))}
            </div>
          </details>
        )}
      </div>
    </AppLayout>
  );
}
