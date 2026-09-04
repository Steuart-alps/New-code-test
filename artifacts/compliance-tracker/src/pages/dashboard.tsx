import React, { useEffect, useState, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { useListSites } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import {
  ChevronDown, ChevronRight, ArrowRight, AlertCircle, AlertTriangle,
  CheckCircle2, MinusCircle, SlidersHorizontal,
  UtensilsCrossed, MapPin, UserPlus, Mail, Settings2,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAuth, useCanAdmin } from "@/context/auth-context";

// ── Types ─────────────────────────────────────────────────────────────────────

type TrackStatus = "ok" | "attention" | "overdue" | "no_data";
type TrackHealth = "action_required" | "clear";

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
  health: TrackHealth;
  badge: string;
  items: TrackItem[];
}

interface ChecklistTotals {
  date: string;
  totalSites: number;
  submittedAll: number;
  inProgress: number;
  notStarted: number;
}

interface DailyChecklistRecord {
  checklistType: string;
  siteId?: number | null;
  submittedAt?: string | null;
}

interface DailySignoffRecord {
  siteId?: number | null;
  submittedAt?: string | null;
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

function StatusIcon({ status, health, className }: { status: TrackStatus; health: TrackHealth; className?: string }) {
  if (health === "action_required") return <AlertCircle className={cn("text-rose-500", className)} />;
  if (status === "attention") return <AlertTriangle className={cn("text-amber-500", className)} />;
  if (health === "clear") return <CheckCircle2 className={cn("text-emerald-500", className)} />;
  return                             <MinusCircle    className={cn("text-muted-foreground/50",    className)} />;
}

// ── Track row ─────────────────────────────────────────────────────────────────

function TrackRow({ track, kitchenOverdueBadge }: { track: TrackSummary; kitchenOverdueBadge?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const hasItems = track.items.length > 0;
  const canExpand = hasItems;

  return (
    <div
      className={cn(
        "border-l-4 rounded-r-md border border-border/60 transition-colors",
        track.health === "action_required" ? "border-l-rose-500" : "border-l-emerald-500",
        STATUS_BG[track.status],
      )}
    >
      {/* Header row */}
      <div className="flex items-center gap-1 px-4 py-3">
        <Link
          href={track.path}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label={`Open ${track.label}: ${track.health === "action_required" ? "action required" : "clear"}`}
        >
          <StatusIcon status={track.status} health={track.health} className="w-4 h-4 shrink-0" />

          <span className={cn(
            "font-medium text-sm flex-1",
            track.health === "action_required" ? "text-rose-700" : "text-emerald-700",
          )}>{track.label}</span>

          {kitchenOverdueBadge}

          <span
            className={cn(
              "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
              STATUS_BADGE[track.status],
            )}
          >
            {track.badge}
          </span>
        </Link>

        {canExpand ? (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`${open ? "Collapse" : "Show"} ${track.label} checks`}
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        ) : (
          <Link
            href={track.path}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`Open ${track.label}: ${track.health === "action_required" ? "action required" : "clear"}`}
          >
            <ArrowRight className="w-4 h-4" />
          </Link>
        )}
      </div>

      {/* Expanded items */}
      {open && hasItems && (
        <div className="border-t border-border/40 divide-y divide-border/30">
          {track.items.map((item, idx) => (
            <Link
              key={idx}
              href={item.path}
              className="group flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground truncate">{item.label}</p>
                <p className="text-xs text-muted-foreground truncate">{item.detail}</p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
            </Link>
          ))}
          {/* Link to full track page */}
          <Link
            href={track.path}
            className="flex items-center gap-1 px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
          >
            <span>Open {track.label}</span>
            <ArrowRight className="w-3 h-3" />
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
  const actionRequired = enabled.filter((t) => t.health === "action_required").length;
  const clear = enabled.filter((t) => t.health === "clear").length;

  if (enabled.length === 0) return null;

  return (
    <div className="flex items-center gap-4 text-sm flex-wrap">
      {actionRequired > 0 && (
        <span className="flex items-center gap-1.5 text-rose-600 font-medium">
          <AlertCircle className="w-4 h-4" />
          {actionRequired} track{actionRequired > 1 ? "s" : ""} require action
        </span>
      )}
      {clear > 0 && (
        <span className="flex items-center gap-1.5 text-emerald-600">
          <CheckCircle2 className="w-4 h-4" />
          {clear} clear
        </span>
      )}
    </div>
  );
}

// ── Setup checklist ──────────────────────────────────────────────────────────

function SetupChecklist({
  siteCount,
  teamCount,
  notificationEmail,
  hasModules,
}: {
  siteCount: number;
  teamCount: number;
  notificationEmail: string;
  hasModules: boolean;
}) {
  const steps = [
    {
      label: "Add your first site",
      detail: "Create the place where checks and records will be tracked.",
      done: siteCount > 0,
      href: "/sites",
      icon: MapPin,
    },
    {
      label: "Invite your team",
      detail: "Give staff and managers their own access to ComplyTrack.",
      done: teamCount > 1,
      href: "/users",
      icon: UserPlus,
    },
    {
      label: "Set the admin alert email",
      detail: "Choose where overdue and compliance alerts should be sent.",
      done: Boolean(notificationEmail.trim()),
      href: "/settings",
      icon: Mail,
    },
    {
      label: "Review your modules",
      detail: "Make sure the tracks you need are enabled for this account.",
      done: hasModules,
      href: "/settings",
      icon: Settings2,
    },
  ];
  const completed = steps.filter((step) => step.done).length;
  if (completed === steps.length) return null;

  return (
    <section className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/10 via-background to-amber-50/60 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary mb-1">
            Getting started
          </p>
          <h2 className="text-lg font-display font-semibold text-foreground">
            Finish setting up your account
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Complete these steps so your team can start recording compliance confidently.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-background/80 border border-primary/20 px-2.5 py-1 text-xs font-semibold text-primary">
          {completed}/{steps.length} complete
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-primary/10 overflow-hidden mb-4">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${(completed / steps.length) * 100}%` }}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <Link
              key={step.label}
              href={step.href}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                step.done
                  ? "border-emerald-200/70 bg-emerald-50/60"
                  : "border-border/70 bg-background/80 hover:border-primary/40 hover:bg-primary/5",
              )}
            >
              {step.done ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <Icon className="w-5 h-5 text-primary shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm font-medium", step.done && "text-emerald-800")}>
                  {step.label}
                </span>
                <span className="block text-xs text-muted-foreground mt-0.5">{step.detail}</span>
              </span>
              {!step.done && <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ── DailyTrack snapshot card ──────────────────────────────────────────────────

function DailyTrackSnapshotCard({ totals, loading }: { totals: ChecklistTotals | null; loading: boolean }) {
  if (!totals && !loading) return null;
  const allDone = Boolean(totals && totals.totalSites > 0 && totals.submittedAll === totals.totalSites);
  const dateLabel = totals
    ? new Date(`${totals.date}T12:00:00`).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";

  return (
    <div className={cn(
      "rounded-lg border border-border/60 bg-card px-4 py-3",
      allDone ? "border-l-4 border-l-emerald-500" : "border-l-4 border-l-amber-400",
    )}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-sm">Today's checklists</p>
          {dateLabel && <p className="text-xs text-muted-foreground mt-0.5">{dateLabel}</p>}
        </div>
        {loading ? (
          <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
        ) : (
          <span className={cn(
            "text-xs px-2 py-0.5 rounded-full font-medium",
            allDone ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
          )}>
            {totals?.submittedAll ?? 0}/{totals?.totalSites ?? 0} sites fully complete
          </span>
        )}
      </div>
      {!loading && (
        <div className="mt-3 flex items-center gap-x-4 gap-y-2 text-xs flex-wrap">
          <span className="text-emerald-700"><strong>{totals?.submittedAll ?? 0}</strong> Submitted all</span>
          <span className="text-amber-700"><strong>{totals?.inProgress ?? 0}</strong> In progress</span>
          <span className="text-muted-foreground"><strong className="text-foreground">{totals?.notStarted ?? 0}</strong> Not started</span>
          <Link
            href="/daily-track-status"
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            View full status <ArrowRight className="w-3 h-3" />
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
  const { hasService, services } = useAuth();
  const canAdmin = useCanAdmin();
  const hasDailytrackAm = hasService("dailytrack_am");
  const hasDailytrackPm = hasService("dailytrack_pm");
  const hasDailytrack = hasDailytrackAm || hasDailytrackPm;
  const hasKitchentrack = hasService("kitchentrack");
  const { data: sites = [] } = useListSites();
  const [teamCount, setTeamCount] = useState(0);
  const [notificationEmail, setNotificationEmail] = useState("");
  const [siteId, setSiteId] = useState<string>("all");
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [checklistTotals, setChecklistTotals] = useState<ChecklistTotals | null>(null);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    Promise.all([
      apiFetch("/users").then((res) => (res.ok ? res.json() : [])),
      apiFetch("/settings").then((res) => (res.ok ? res.json() : {})),
    ])
      .then(([users, settings]) => {
        if (cancelled) return;
        setTeamCount(Array.isArray(users) ? users.length : 0);
        const settingsRecord = settings as { notificationEmail?: unknown };
        setNotificationEmail(typeof settingsRecord.notificationEmail === "string" ? settingsRecord.notificationEmail : "");
      })
      .catch(() => {
        // The dashboard remains usable if setup metadata is unavailable.
      });
    return () => { cancelled = true; };
  }, [canAdmin]);

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

  useEffect(() => {
    if (!hasDailytrack) {
      setChecklistTotals(null);
      return;
    }

    let cancelled = false;
    const today = new Date().toISOString().slice(0, 10);
    const visibleSites = siteId === "all"
      ? sites
      : sites.filter((site: any) => String(site.id) === siteId);

    (async () => {
      setChecklistLoading(true);
      try {
        const params = new URLSearchParams({ date: today });
        if (siteId !== "all") params.set("siteId", siteId);
        const [amRes, pmRes, signoffRes] = await Promise.all([
          apiFetch(`/daily-track-am?${params}`),
          apiFetch(`/daily-track-pm?${params}`),
          apiFetch(`/daily-track-pm/signoffs?${params}`),
        ]);
        if (!amRes.ok || !pmRes.ok || !signoffRes.ok) throw new Error("Unable to load checklist status");

        const [amRows, pmRows, signoffs] = await Promise.all([
          amRes.json() as Promise<DailyChecklistRecord[]>,
          pmRes.json() as Promise<DailyChecklistRecord[]>,
          signoffRes.json() as Promise<DailySignoffRecord[]>,
        ]);
        const requiredTypes = [
          ...(hasDailytrackAm ? ["kitchen_opening", "premises_opening"] : []),
          ...(hasDailytrackPm ? ["kitchen_closing", "premises_closing"] : []),
        ];
        let submittedAll = 0;
        let inProgress = 0;
        let notStarted = 0;

        for (const site of visibleSites) {
          const records = [...amRows, ...pmRows].filter((row) => row.siteId === site.id);
          const signoff = signoffs.find((row) => row.siteId === site.id);
          const hasStarted = records.length > 0 || Boolean(signoff);
          const submittedTypes = new Set(
            records.filter((row) => row.submittedAt).map((row) => row.checklistType),
          );
          const isComplete = requiredTypes.every((type) => submittedTypes.has(type))
            && (!hasDailytrackPm || Boolean(signoff?.submittedAt));

          if (isComplete) submittedAll++;
          else if (hasStarted) inProgress++;
          else notStarted++;
        }

        if (!cancelled) {
          setChecklistTotals({
            date: today,
            totalSites: visibleSites.length,
            submittedAll,
            inProgress,
            notStarted,
          });
        }
      } catch {
        if (!cancelled) setChecklistTotals(null);
      } finally {
        if (!cancelled) setChecklistLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [hasDailytrack, hasDailytrackAm, hasDailytrackPm, siteId, sites]);

  const enabledTracks   = tracks.filter((t) => t.enabled);
  const disabledTracks  = tracks.filter((t) => !t.enabled);

  // Put actionable modules first; due-soon modules stay visible but follow them.
  const statusOrder: Record<TrackStatus, number> = {
    overdue: 0, attention: 1, ok: 2, no_data: 3,
  };
  const sorted = [...enabledTracks].sort(
    (a, b) =>
      (a.health === "action_required" ? 0 : 1) - (b.health === "action_required" ? 0 : 1) ||
      statusOrder[a.status] - statusOrder[b.status],
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

        {canAdmin && (
          <SetupChecklist
            siteCount={sites.length}
            teamCount={teamCount}
            notificationEmail={notificationEmail}
            hasModules={services === "all" || (Array.isArray(services) && services.length > 0)}
          />
        )}

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
        {hasDailytrack && <DailyTrackSnapshotCard totals={checklistTotals} loading={checklistLoading} />}

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
