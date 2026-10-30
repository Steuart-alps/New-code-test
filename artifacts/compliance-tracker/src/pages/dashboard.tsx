import React, { useEffect, useState, useCallback, type ReactNode } from "react";
import { AppLayout } from "@/components/layout";
import { SayItButton } from "@/components/say-it-button";
import { useListSites } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { type KitchenCheckState } from "@/lib/kitchen-dashboard-status";
import { KitchenStatusPill } from "@/components/kitchen-status-pill";
import { ComplianceChecksDue } from "@/components/compliance-checks-due";
import { TodayByDepartmentCard } from "@/components/today-by-department";
import { RegisterReviewsDue } from "@/components/register-reviews-due";
import { DashboardStartCards } from "@/components/dashboard-start-cards";
import { useBillingReturn } from "@/lib/billing-return";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { useCertificateInbox } from "@/components/certificate-inbox-card";
import {
  ChevronDown, ChevronRight, ArrowRight, AlertCircle, AlertTriangle,
  CheckCircle2, Circle, MinusCircle, SlidersHorizontal,
  MapPin, UserPlus, Mail, Settings2, MailWarning, Inbox,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAuth, useCanAdmin, useIsMaintenanceManager } from "@/context/auth-context";
import { useSiteFilter } from "@/hooks/use-working-site";

// ── Types ─────────────────────────────────────────────────────────────────────

type TrackStatus = "ok" | "attention" | "overdue" | "no_data";
// not_started: nothing recorded yet and nothing overdue — neutral, not a failure.
type TrackHealth = "action_required" | "not_started" | "clear";

const HEALTH_LABEL: Record<TrackHealth, string> = {
  action_required: "action required",
  not_started: "not started",
  clear: "clear",
};

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
  /** Not picked in the setup wizard and not started: listed under "Other modules". */
  otherModule?: boolean;
}

interface ChecklistTotals {
  date: string;
  available: boolean;
  expectedAmPairs: number;
  completedAmPairs: number;
  expectedPmPairs: number;
  completedPmPairs: number;
  completedSitePairs: number;
  /** Sites with a checklist still to submit today; `am` / `pm` true = still to do. */
  /** amDue / pmDue: when the site's opening / closing checks are due ("HH:MM"); *Overdue once that has passed. */
  outstanding?: Array<{
    siteId: number; siteName: string; am: boolean; pm: boolean;
    amDue?: string; pmDue?: string; amOverdue?: boolean; pmOverdue?: boolean;
  }>;
}

/** Most sites listed under "Still to do today"; the rest are on the full status page. */
const MAX_OUTSTANDING_SITES = 6;

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
  if (health === "not_started") return <Circle className={cn("text-muted-foreground/60", className)} />;
  if (status === "attention") return <AlertTriangle className={cn("text-amber-500", className)} />;
  if (health === "clear") return <CheckCircle2 className={cn("text-emerald-500", className)} />;
  return                             <MinusCircle    className={cn("text-muted-foreground/50",    className)} />;
}

// ── Track row ─────────────────────────────────────────────────────────────────

function TrackRow({ track, kitchenOverdueBadge, defaultOpen = false }: {
  track: TrackSummary;
  kitchenOverdueBadge?: React.ReactNode;
  /** Start with the checks listed, e.g. when picked from the summary bar. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
      <div className="flex items-center gap-1 px-4 py-3">
        <Link
          href={track.path}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label={`Open ${track.label}: ${HEALTH_LABEL[track.health] ?? "clear"}`}
        >
          <StatusIcon status={track.status} health={track.health} className="w-4 h-4 shrink-0" />

          <span className={cn(
            "font-medium text-sm flex-1",
            track.health === "action_required"
              ? "text-rose-700"
              : track.health === "not_started"
              ? "text-muted-foreground"
              : track.status === "attention"
              ? "text-amber-700"
              : track.status === "no_data"
              ? "text-muted-foreground"
              : "text-emerald-700",
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
            aria-label={`Open ${track.label}: ${HEALTH_LABEL[track.health] ?? "clear"}`}
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

type SummaryFilter = "action_required" | "due" | "complete" | "not_started";

// These buckets are deliberately ordered so every module is counted once:
// an overdue or failed module is action-needed even when its status is not
// "attention", while future due items remain a separate, non-urgent state.
// Modules with nothing recorded yet are "not started", a neutral state.
const SUMMARY_FILTERS: Record<SummaryFilter, (t: TrackSummary) => boolean> = {
  action_required: (t) => t.health === "action_required",
  due: (t) => t.health === "clear" && t.status === "attention",
  complete: (t) => t.health === "clear" && t.status === "ok",
  not_started: (t) => t.health === "not_started",
};

const SUMMARY_FILTER_LABEL: Record<SummaryFilter, string> = {
  action_required: "that require action",
  due: "due soon",
  complete: "complete",
  not_started: "not started",
};

/**
 * Counts of modules by state. Each count is a button that narrows the module
 * list below to those modules with their checks listed, so anything still to
 * do is one more click away. "Not applicable" opens the disabled list.
 */
function SummaryBar({ tracks, filter, onFilter, onShowDisabled }: {
  tracks: TrackSummary[];
  filter: SummaryFilter | null;
  onFilter: (filter: SummaryFilter | null) => void;
  onShowDisabled: () => void;
}) {
  const enabled = tracks.filter((t) => t.enabled);
  const count = (key: SummaryFilter) => enabled.filter(SUMMARY_FILTERS[key]).length;
  const actionRequired = count("action_required");
  const due = count("due");
  const complete = count("complete");
  const notStarted = count("not_started");
  const notApplicable = tracks.filter((t) => !t.enabled).length;

  if (enabled.length === 0) return null;

  const chip = (key: SummaryFilter, className: string, icon: ReactNode, label: string) => (
    <button
      type="button"
      aria-pressed={filter === key}
      onClick={() => onFilter(filter === key ? null : key)}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        filter === key ? "border-current bg-muted/60" : "border-transparent",
        className,
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-x-2 gap-y-1 text-sm flex-wrap -mx-2.5">
      {actionRequired > 0 && chip("action_required", "text-rose-600 font-medium", <AlertCircle className="w-4 h-4" />,
        `${actionRequired} track${actionRequired > 1 ? "s require" : " requires"} action`)}
      {due > 0 && chip("due", "text-amber-700", <AlertTriangle className="w-4 h-4" />, `${due} due soon`)}
      {complete > 0 && chip("complete", "text-emerald-600", <CheckCircle2 className="w-4 h-4" />, `${complete} complete`)}
      {notStarted > 0 && chip("not_started", "text-muted-foreground", <Circle className="w-4 h-4" />, `${notStarted} not started`)}
      {notApplicable > 0 && (
        <button
          type="button"
          onClick={onShowDisabled}
          className="flex cursor-pointer items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <MinusCircle className="w-4 h-4" />
          {notApplicable} not applicable
        </button>
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
      href: "/settings#admin-alert-email",
      icon: Mail,
    },
    {
      label: "Review your modules",
      detail: "Make sure the tracks you need are enabled for this account.",
      done: hasModules,
      href: "/settings#services",
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
          <h2 className="text-lg font-display font-bold text-foreground">
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

/** A checklist still to do today: opens that site's checklist ready to fill in. */
function ChecklistLink({ href, label, overdue, children }: { href: string; label: string; overdue?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        overdue
          ? "border-rose-300 bg-rose-50 text-rose-800 hover:border-rose-400 hover:bg-rose-100"
          : "border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400 hover:bg-amber-100",
      )}
    >
      {children} <ArrowRight className="w-3 h-3" />
    </Link>
  );
}

function DailyTrackSnapshotCard({ totals, loading, siteId }: { totals: ChecklistTotals | null; loading: boolean; siteId: string }) {
  const siteQuery = siteId === "all" ? "" : `?siteId=${siteId}`;
  if (!totals && !loading) return null;
  const requiredPairs = (totals?.expectedAmPairs ?? 0) + (totals?.expectedPmPairs ?? 0);
  const completedPairs = (totals?.completedAmPairs ?? 0) + (totals?.completedPmPairs ?? 0);
  const allDone = Boolean(totals && totals.available && requiredPairs > 0 && completedPairs === requiredPairs);
  const outstanding = totals?.outstanding ?? [];
  const dateLabel = totals
    ? new Date(`${totals.date}T12:00:00`).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";

  return (
    <section aria-label="Today's checklists" className={cn(
      "rounded-lg border border-border/60 bg-card px-4 py-3",
      // While a site's totals load, show no status colour: the previous
      // site's colour would read as the new site's result.
      loading
        ? "border-l-4 border-l-muted-foreground/30"
        : allDone
        ? "border-l-4 border-l-emerald-500"
        : !totals?.available
        ? "border-l-4 border-l-rose-500"
        : requiredPairs === 0
        ? "border-l-4 border-l-muted-foreground/30"
        : "border-l-4 border-l-amber-400",
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
            allDone
              ? "bg-emerald-100 text-emerald-700"
              : !totals?.available
              ? "bg-rose-100 text-rose-700"
              : requiredPairs === 0
              ? "bg-muted text-muted-foreground"
              : "bg-amber-100 text-amber-700",
          )}>
            {!totals?.available
              ? "Status unavailable"
              : requiredPairs === 0
              ? "Not applicable"
              : `${completedPairs}/${requiredPairs} checklists complete`}
          </span>
        )}
      </div>
      {!loading && totals?.available && outstanding.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted-foreground mb-1.5">Still to do today</p>
          <ul className="space-y-1.5">
            {outstanding.slice(0, MAX_OUTSTANDING_SITES).map((site) => (
              <li key={site.siteId} className="flex items-center gap-2 flex-wrap">
                <span className="min-w-0 flex-1 truncate text-sm">{site.siteName}</span>
                {site.am && (
                  <ChecklistLink href={`/daily-track-am?siteId=${site.siteId}`} label={`Open ${site.siteName} AM checklist`} overdue={site.amOverdue}>
                    AM checklist{site.amDue ? (site.amOverdue ? ` · overdue (${site.amDue})` : ` · due ${site.amDue}`) : ""}
                  </ChecklistLink>
                )}
                {site.pm && (
                  <ChecklistLink href={`/daily-track-pm?siteId=${site.siteId}`} label={`Open ${site.siteName} PM checklist`} overdue={site.pmOverdue}>
                    PM checklist{site.pmDue ? (site.pmOverdue ? ` · overdue (${site.pmDue})` : ` · due ${site.pmDue}`) : ""}
                  </ChecklistLink>
                )}
              </li>
            ))}
          </ul>
          {outstanding.length > MAX_OUTSTANDING_SITES && (
            <p className="text-xs text-muted-foreground mt-1.5">
              and {outstanding.length - MAX_OUTSTANDING_SITES} more {outstanding.length - MAX_OUTSTANDING_SITES === 1 ? "site" : "sites"}
            </p>
          )}
        </div>
      )}
      {!loading && (
        <div className="mt-3 flex items-center gap-x-4 gap-y-2 text-xs flex-wrap">
          {totals?.expectedAmPairs ? (
            <Link href={`/daily-track-am${siteQuery}`} className="cursor-pointer rounded-sm text-emerald-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
              <strong>{totals.completedAmPairs}/{totals.expectedAmPairs}</strong> AM complete
            </Link>
          ) : (
            <span className="text-muted-foreground">AM not applicable</span>
          )}
          {totals?.expectedPmPairs ? (
            <Link href={`/daily-track-pm${siteQuery}`} className="cursor-pointer rounded-sm text-emerald-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
              <strong>{totals.completedPmPairs}/{totals.expectedPmPairs}</strong> PM complete
            </Link>
          ) : (
            <span className="text-muted-foreground">PM not applicable</span>
          )}
          <Link
            href="/daily-track-status"
            className="ml-auto flex cursor-pointer items-center gap-1 rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            View full status <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </section>
  );
}

// ── KitchenTrack status indicator ─────────────────────────────────────────────

type KitchenCheckStatus = {
  status: KitchenCheckState;
};

function KitchenTrackStatusPill({ siteId }: { siteId: string }) {
  const [statuses, setStatuses] = useState<KitchenCheckStatus[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatuses(null);
    (async () => {
      try {
        const res = await apiFetch(`/food-safety/status${siteId !== "all" ? `?siteId=${siteId}` : ""}`);
        if (!cancelled && res.ok) {
          const json: unknown = await res.json();
          setStatuses(Array.isArray(json) ? json as KitchenCheckStatus[] : []);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [siteId]);

  if (!statuses) return null;

  return <KitchenStatusPill statuses={statuses.map(({ status }) => status)} />;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { hasService, services, user } = useAuth();
  useBillingReturn();
  const canAdmin = useCanAdmin();
  const canManageContractorEmails = canAdmin || useIsMaintenanceManager();
  const certificateInbox = useCertificateInbox(canAdmin);
  const certificatesToConfirm = certificateInbox.data?.items.filter((item) => item.status !== "reading").length ?? 0;
  const hasStandaloneDailytrackAm = hasService("dailytrack_am");
  const hasStandaloneDailytrackPm = hasService("dailytrack_pm");
  const hasKitchentrack = hasService("kitchentrack");
  const hasPremisestrack = hasService("premisestrack");
  const hasDailytrackAm = hasStandaloneDailytrackAm || hasKitchentrack || hasPremisestrack;
  const hasDailytrackPm = hasStandaloneDailytrackPm || hasKitchentrack || hasPremisestrack;
  const hasDailytrack = hasDailytrackAm || hasDailytrackPm;
  const { data: sites = [] } = useListSites();
  const [teamCount, setTeamCount] = useState(0);
  const [notificationEmail, setNotificationEmail] = useState("");
  const [siteId, setSiteId, siteReady] = useSiteFilter("all");
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [checklistTotals, setChecklistTotals] = useState<ChecklistTotals | null>(null);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [pendingEmailsCount, setPendingEmailsCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry so a retry goes through the effect below and is cancelled
  // like any other summary request when the site changes.
  const [reloadKey, setReloadKey] = useState(0);
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter | null>(null);
  const [disabledOpen, setDisabledOpen] = useState(false);

  useEffect(() => {
    if (!canManageContractorEmails) return;
    let cancelled = false;
    Promise.all([
      apiFetch("/users").then((res) => (res.ok ? res.json() : [])),
      apiFetch("/settings").then((res) => (res.ok ? res.json() : {})),
      apiFetch("/fix-track/contractor-email-queue?status=pending").then((res) => res.ok ? res.json() : []),
    ])
      .then(([users, settings, emails]) => {
        if (cancelled) return;
        setTeamCount(Array.isArray(users) ? users.length : 0);
        const settingsRecord = settings as { notificationEmail?: unknown };
        setNotificationEmail(typeof settingsRecord.notificationEmail === "string" ? settingsRecord.notificationEmail : "");
        setPendingEmailsCount(Array.isArray(emails) ? emails.length : 0);
      })
      .catch(() => {
        // The dashboard remains usable if setup metadata is unavailable.
      });
    return () => { cancelled = true; };
  }, [canManageContractorEmails]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setChecklistLoading(true);
    setError(null);
    // Drop the previous site's results so nothing on the page describes it
    // while this site loads.
    setTracks([]);
    setChecklistTotals(null);
    try {
      const params = siteId !== "all" ? `?siteId=${siteId}` : "";
      const res = await apiFetch(`/dashboard/summary${params}`, { signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${res.status})`);
      }
      const json = await res.json();
      if (signal.aborted) return;
      setTracks(json.tracks ?? []);
      setChecklistTotals(json.checklistTotals ?? null);
    } catch (e) {
      if (signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setChecklistTotals(null);
      setTracks([]);
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setChecklistLoading(false);
      }
    }
  }, [siteId]);

  useEffect(() => {
    if (!siteReady) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey, siteReady]);

  const enabledTracks   = tracks.filter((t) => t.enabled && !t.otherModule);
  const otherTracks     = tracks.filter((t) => t.enabled && t.otherModule);
  const disabledTracks  = tracks.filter((t) => !t.enabled);

  // Put actionable modules first; due-soon modules stay visible but follow
  // them, and modules not started yet come last.
  const statusOrder: Record<TrackStatus, number> = {
    overdue: 0, attention: 1, ok: 2, no_data: 3,
  };
  const healthOrder: Record<TrackHealth, number> = { action_required: 0, clear: 1, not_started: 2 };
  const sorted = [...enabledTracks].sort(
    (a, b) =>
      (healthOrder[a.health] ?? 1) - (healthOrder[b.health] ?? 1) ||
      statusOrder[a.status] - statusOrder[b.status],
  );
  // A count picked in the summary bar narrows the list; it lifts itself once
  // nothing matches (e.g. after switching site).
  const filtered = summaryFilter ? sorted.filter(SUMMARY_FILTERS[summaryFilter]) : [];
  const activeFilter = filtered.length > 0 ? summaryFilter : null;
  const listed = activeFilter ? filtered : sorted;

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

        <SayItButton siteId={siteId === "all" ? null : Number(siteId)} className="w-full sm:w-auto h-11" />

        <DashboardStartCards />
        <ComplianceChecksDue siteId={siteId === "all" ? null : Number(siteId)} />
        <RegisterReviewsDue siteId={siteId === "all" ? null : Number(siteId)} />

        {canAdmin && (
          <SetupChecklist
            siteCount={sites.length}
            teamCount={teamCount}
            notificationEmail={notificationEmail}
            hasModules={services === "all" || (Array.isArray(services) && services.length > 0)}
          />
        )}

        {canAdmin && certificatesToConfirm > 0 && (
          <Link
            href="/external-checks"
            className="flex items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 transition-colors hover:bg-emerald-100/50"
          >
            <div className="flex items-center gap-3 text-emerald-800">
              <Inbox className="h-5 w-5" />
              <div>
                <p className="font-semibold text-sm">Certificates to confirm</p>
                <p className="text-xs text-emerald-700/80">
                  {certificatesToConfirm} certificate{certificatesToConfirm === 1 ? "" : "s"} or message{certificatesToConfirm === 1 ? "" : "s"} from contractors {certificatesToConfirm === 1 ? "is" : "are"} waiting for you to check.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 text-sm font-medium text-emerald-700">
              Check <ArrowRight className="h-4 w-4" />
            </div>
          </Link>
        )}

        {canManageContractorEmails && pendingEmailsCount !== null && pendingEmailsCount > 0 && (
          <Link
            href="/contractor-approvals"
            className="flex items-center justify-between gap-4 rounded-xl border border-blue-200 bg-blue-50 p-4 transition-colors hover:bg-blue-100/50"
          >
            <div className="flex items-center gap-3 text-blue-800">
              <MailWarning className="h-5 w-5" />
              <div>
                <p className="font-semibold text-sm">Contractor emails await approval</p>
                <p className="text-xs text-blue-700/80">You have {pendingEmailsCount} message{pendingEmailsCount === 1 ? "" : "s"} waiting in the queue.</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 text-sm font-medium text-blue-700">
              Review <ArrowRight className="h-4 w-4" />
            </div>
          </Link>
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
        {!loading && error && user?.role === "consultant" && error === "No client context" ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
            <p className="font-medium">Choose a business</p>
            <p className="mt-1 text-muted-foreground">Pick the business you want to work in to see its dashboard.</p>
            <Link href="/clients" className="mt-3 inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2">
              Choose a business <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : !loading && error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <span>We couldn't load the dashboard: {error}</span>
            <button type="button" className="rounded-sm border border-rose-300 bg-white px-3 py-1 font-medium hover:bg-rose-100"
              onClick={() => setReloadKey((key) => key + 1)}>Retry</button>
          </div>
        )}

        {/* DailyTrack snapshot */}
        {hasDailytrack && <DailyTrackSnapshotCard totals={checklistTotals} loading={checklistLoading} siteId={siteId} />}

        {/* Today by department (Owners; other roles as chosen in Settings) */}
        <TodayByDepartmentCard siteId={siteId === "all" ? null : Number(siteId)} />

        {/* Summary bar */}
        {!loading && !error && tracks.length > 0 && (
          <SummaryBar
            tracks={tracks.filter((t) => !t.otherModule)}
            filter={activeFilter}
            onFilter={setSummaryFilter}
            onShowDisabled={() => {
              setDisabledOpen(true);
              requestAnimationFrame(() => document.getElementById("dashboard-disabled-tracks")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
            }}
          />
        )}

        {/* Track list */}
        {!loading && !error && activeFilter && (
          <p className="-mt-3 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            Showing {filtered.length} track{filtered.length === 1 ? "" : "s"} {SUMMARY_FILTER_LABEL[activeFilter]}.
            <button
              type="button"
              onClick={() => setSummaryFilter(null)}
              className="cursor-pointer rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Show all tracks
            </button>
          </p>
        )}
        {!loading && !error && listed.length > 0 && (
          <div className="space-y-2">
            {listed.map((track) => (
              <TrackRow
                // Remounts when a summary count is picked so its checks open.
                key={`${track.trackId}:${activeFilter ?? ""}`}
                defaultOpen={Boolean(activeFilter)}
                track={track}
                kitchenOverdueBadge={hasKitchentrack && track.trackId === "kitchen" ? <KitchenTrackStatusPill siteId={siteId} /> : null}
              />
            ))}
          </div>
        )}

        {/* Modules not picked in setup and not started yet (collapsed section) */}
        {!loading && !error && otherTracks.length > 0 && (
          <details className="group">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none list-none flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" />
              Other modules ({otherTracks.length})
            </summary>
            <div className="mt-2 space-y-2">
              {otherTracks.map((track) => (
                <TrackRow key={track.trackId} track={track} />
              ))}
            </div>
          </details>
        )}

        {/* Disabled tracks (collapsed section) */}
        {!loading && !error && disabledTracks.length > 0 && (
          <details
            id="dashboard-disabled-tracks"
            className="group"
            open={disabledOpen}
            onToggle={(event) => setDisabledOpen(event.currentTarget.open)}
          >
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
