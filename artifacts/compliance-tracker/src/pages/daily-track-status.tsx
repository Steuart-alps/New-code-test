import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { useListSites } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Link } from "wouter";
import {
  LayoutGrid, RotateCcw, CheckCircle2, Clock, Circle,
  Building2, UtensilsCrossed, Building, PenLine, Sunrise, Sunset, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  monthDayStatuses, parseDailyTrackHistory, siteDayStatuses,
  type DailyTrackHistory, type DailyTrackRequirement, type RecordStatus,
} from "@/lib/daily-track-month-status";

// ── History loading ───────────────────────────────────────────────────────────

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DailyTrackHistory };

/**
 * Loads /daily-track-status/history for a date range. A failed request is an
 * error state, never an empty history: an empty one would paint every day as
 * "nothing started" during an outage.
 */
function useDailyTrackHistory(from: string, to: string, refreshMs?: number) {
  const { activeClientId } = useAuth();
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = async (showSpinner: boolean) => {
      if (showSpinner) setState({ status: "loading" });
      let next: HistoryState;
      try {
        const res = await apiFetch(`/daily-track-status/history?from=${from}&to=${to}`);
        next = res.ok
          ? { status: "ready", data: parseDailyTrackHistory(await res.json()) }
          : { status: "error", message: await getApiErrorMessage(res, `The server responded with ${res.status}.`) };
      } catch {
        next = { status: "error", message: "Check your connection and try again." };
      }
      if (!cancelled) setState(next);
    };
    load(true);
    const timer = refreshMs ? setInterval(() => load(false), refreshMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [from, to, refreshMs, attempt, activeClientId]);

  return { state, reload };
}

function HistoryError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center">
      <AlertTriangle className="w-6 h-6 text-destructive" />
      <div>
        <p className="text-sm font-medium">Couldn't load {what}</p>
        <p className="text-xs text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RotateCcw className="w-3.5 h-3.5" /> Try again
      </Button>
    </div>
  );
}

// ── Column config ─────────────────────────────────────────────────────────────

const COLUMNS = [
  {
    key: "kitchen_opening",
    group: "am",
    label: "Kitchen Opening",
    short: "Kit. Open",
    route: "/kitchen",
    routeQuery: "tab=checks",
    Icon: UtensilsCrossed,
    iconClass: "text-amber-500",
    headerClass: "text-amber-700 bg-amber-50",
  },
  {
    key: "premises_opening",
    group: "am",
    label: "Premises Opening",
    short: "Prem. Open",
    route: "/daily-track-am",
    Icon: Building,
    iconClass: "text-sky-500",
    headerClass: "text-sky-700 bg-sky-50",
  },
  {
    key: "kitchen_closing",
    group: "pm",
    label: "Kitchen Closing",
    short: "Kit. Close",
    route: "/kitchen",
    routeQuery: "tab=checks",
    Icon: UtensilsCrossed,
    iconClass: "text-orange-500",
    headerClass: "text-orange-700 bg-orange-50",
  },
  {
    key: "premises_closing",
    group: "pm",
    label: "Premises Closing",
    short: "Prem. Close",
    route: "/daily-track-pm",
    Icon: Building,
    iconClass: "text-violet-500",
    headerClass: "text-violet-700 bg-violet-50",
  },
  {
    key: "signoff",
    group: "signoff",
    label: "Manager Sign-off",
    short: "Sign-off",
    route: "/daily-track-pm",
    Icon: PenLine,
    iconClass: "text-emerald-500",
    headerClass: "text-emerald-700 bg-emerald-50",
  },
] as const;

/** The columns for the checks the client's services enable, in display order. */
function enabledColumns(requirements: DailyTrackRequirement[]) {
  return COLUMNS.filter(col => requirements.includes(col.key));
}

// ── Status cell ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: RecordStatus }) {
  if (status === "submitted") {
    return (
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-emerald-100">
        <CheckCircle2 className="w-4.5 h-4.5 text-emerald-600" />
      </span>
    );
  }
  if (status === "draft") {
    return (
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-amber-100">
        <Clock className="w-4 h-4 text-amber-600" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-muted/50">
      <Circle className="w-4 h-4 text-muted-foreground/30" />
    </span>
  );
}

function StatusCell({
  status, route, routeQuery, date, siteId,
}: { status: RecordStatus; route: string; routeQuery?: string; date: string; siteId: number }) {
  const qs = routeQuery ? `${routeQuery}&date=${date}&siteId=${siteId}` : `date=${date}&siteId=${siteId}`;
  return (
    <Link href={`${route}?${qs}`}>
      <div
        className={cn(
          "flex items-center justify-center cursor-pointer transition-transform hover:scale-110",
          status === "none" && "opacity-60 hover:opacity-100",
        )}
        title={status === "submitted" ? "Submitted" : status === "draft" ? "Draft saved" : "Not started — click to open"}
      >
        <StatusDot status={status} />
      </div>
    </Link>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100">
          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
        </span>
        Submitted
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100">
          <Clock className="w-3 h-3 text-amber-600" />
        </span>
        Draft saved
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted/50">
          <Circle className="w-3 h-3 text-muted-foreground/30" />
        </span>
        Not started
      </span>
    </div>
  );
}

// ── Month overview ────────────────────────────────────────────────────────────

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function MonthOverview({ sites, onPickDay }: { sites: { id: number; name: string }[]; onPickDay: (date: string) => void }) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const lastMonth = shiftMonth(today.slice(0, 7), -1);
  const [month, setMonth] = useState(lastMonth);
  const [siteId, setSiteId] = useState<"all" | number>("all");

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const from = `${month}-01`;
  const to = `${month}-${String(daysInMonth).padStart(2, "0")}`;

  const { state, reload } = useDailyTrackHistory(from, to);

  const selectedSites = siteId === "all" ? sites : sites.filter(site => site.id === siteId);
  const dayStatuses = state.status === "ready" ? monthDayStatuses(month, today, selectedSites, state.data) : [];

  const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0
  const incompleteDays = dayStatuses.filter(d => d.status === "partial" || d.status === "missing").length;

  return (
    <Card className="mt-8 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-bold text-sm">Month overview</h3>
          <p className="text-xs text-muted-foreground">
            Spot patterns — days where checklists were incomplete or missing. Click a day to inspect it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label className="sr-only" htmlFor="month-overview-site">Site</Label>
          <select
            id="month-overview-site"
            value={siteId}
            onChange={event => setSiteId(event.target.value === "all" ? "all" : Number(event.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="all">All sites</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => setMonth(shiftMonth(month, -1))}>←</Button>
            <span className="text-sm font-medium min-w-[130px] text-center">{monthLabel(month)}</span>
            <Button variant="outline" size="sm" className="h-8 px-2"
              disabled={month >= today.slice(0, 7)}
              onClick={() => setMonth(shiftMonth(month, 1))}>→</Button>
          </div>
        </div>
      </div>

      {state.status === "loading" ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : state.status === "error" ? (
        <HistoryError what={`checklist history for ${monthLabel(month)}`} message={state.message} onRetry={reload} />
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1.5 max-w-xl">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
              <div key={d} className="text-[10px] text-muted-foreground text-center font-medium">{d}</div>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
            {dayStatuses.map(({ date, status, submitted, started, expected }) => (
              <button
                key={date}
                disabled={status === "future"}
                onClick={() => onPickDay(date)}
                title={status === "future" ? "" : `${date} — ${submitted}/${expected} submitted, ${started} started`}
                className={cn(
                  "aspect-square rounded-md text-xs font-medium flex items-center justify-center transition-transform",
                  status === "complete" && "bg-emerald-100 text-emerald-700 hover:scale-105",
                  status === "partial" && "bg-amber-100 text-amber-700 hover:scale-105",
                  status === "missing" && "bg-muted text-muted-foreground hover:scale-105",
                  status === "future" && "bg-muted/30 text-muted-foreground/40",
                )}
              >
                {parseInt(date.slice(8), 10)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" /> All submitted</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-100 border border-amber-300" /> Partially complete</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-muted border border-border" /> Nothing started</span>
            {sites.length > 0 && (
              <span className="ml-auto font-medium text-foreground">
                {incompleteDays} day{incompleteDays !== 1 ? "s" : ""} with gaps in {monthLabel(month)}
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DailyTrackStatusPage() {
  const { data: sites = [], isLoading: sitesLoading } = useListSites();

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  // Refreshes every 60 s so the grid stays live.
  const { state, reload } = useDailyTrackHistory(date, date, 60_000);

  const isToday = date === today;
  const history = state.status === "ready" ? state.data : null;
  const columns = history ? enabledColumns(history.requirements) : [];
  const statuses = history ? siteDayStatuses(date, sites, history) : new Map();
  // Each period's first column starts a bordered group.
  const groupStarts = new Set(columns.filter((col, i) => i === 0 || columns[i - 1].group !== col.group).map(col => col.key));
  const groupSpan = (group: string) => columns.filter(col => col.group === group).length;
  const siteStatuses = sites.map(site => {
    const status: Partial<Record<DailyTrackRequirement, RecordStatus>> = statuses.get(site.id) ?? {};
    const submitted = columns.filter(col => status[col.key] === "submitted").length;
    return { site, status, submitted };
  });
  const allGreen = siteStatuses.filter(({ submitted }) => columns.length > 0 && submitted === columns.length).length;
  const totalSites = sites.length;

  return (
    <AppLayout title="Daily Checklist Status">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">
          At-a-glance completion status for all sites — click any cell to open that checklist.
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LayoutGrid className="w-4 h-4" />
          <span>Status Overview</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-6 p-4 bg-card border border-border rounded-xl">
        <div className="space-y-1 flex-1 min-w-[160px] max-w-[220px]">
          <Label className="text-xs">Date</Label>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="h-9 flex-1"
            />
            {!isToday && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-2 text-xs text-primary"
                onClick={() => setDate(today)}
              >
                Today
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Button variant="outline" size="sm" onClick={reload} className="h-9 gap-1.5">
            <RotateCcw className={cn("w-3.5 h-3.5", state.status === "loading" && "animate-spin")} /> Refresh
          </Button>
        </div>

        {/* Summary pill */}
        {history && !sitesLoading && totalSites > 0 && (
          <div className="flex items-end ml-auto">
            <div className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border",
              allGreen === totalSites
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-muted/50 border-border text-muted-foreground",
            )}>
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{allGreen}/{totalSites} sites fully complete</span>
            </div>
          </div>
        )}
      </div>

      {state.status === "loading" || sitesLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : sites.length === 0 ? (
        <Card className="p-12 text-center">
          <Building2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-muted-foreground text-sm">No sites configured yet.</p>
        </Card>
      ) : state.status === "error" ? (
        <Card>
          <HistoryError what="checklist status for this day" message={state.message} onRetry={reload} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {/* Scrollable table container */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground min-w-[160px] w-48">
                    Site
                  </th>
                  {groupSpan("am") > 0 && (
                    <th colSpan={groupSpan("am")} className="px-2 py-2 text-center border-l border-border/50">
                      <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-amber-700 uppercase tracking-wider">
                        <Sunrise className="w-3.5 h-3.5" />
                        AM
                      </div>
                    </th>
                  )}
                  {groupSpan("pm") > 0 && (
                    <th colSpan={groupSpan("pm")} className="px-2 py-2 text-center border-l border-border/50">
                      <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-orange-700 uppercase tracking-wider">
                        <Sunset className="w-3.5 h-3.5" />
                        PM
                      </div>
                    </th>
                  )}
                  {groupSpan("signoff") > 0 && (
                    <th className="px-2 py-2 text-center border-l border-border/50">
                      <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                        <PenLine className="w-3.5 h-3.5" />
                        Sign-off
                      </div>
                    </th>
                  )}
                  {/* Progress */}
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground border-l border-border/50 min-w-[80px]">
                    Done
                  </th>
                </tr>
                {/* Sub-headers */}
                <tr className="border-b border-border bg-muted/10">
                  <th className="px-4 py-2" />
                  {columns.map(col => (
                    <th
                      key={col.key}
                      className={cn(
                        "px-2 py-2 text-center text-xs font-normal text-muted-foreground whitespace-nowrap w-24",
                        groupStarts.has(col.key) && "border-l border-border/50",
                      )}
                    >
                      <div className="flex flex-col items-center gap-1">
                        <col.Icon className={cn("w-3.5 h-3.5", col.iconClass)} />
                        <span className="hidden sm:inline">{col.short}</span>
                      </div>
                    </th>
                  ))}
                  <th className="border-l border-border/50" />
                </tr>
              </thead>
              <tbody>
                {siteStatuses.map(({ site, status, submitted }, rowIdx) => {
                  const total = columns.length;
                  const pct = total > 0 ? Math.round((submitted / total) * 100) : 0;

                  return (
                    <tr
                      key={site.id}
                      className={cn(
                        "border-b border-border/50 transition-colors hover:bg-muted/20",
                        rowIdx % 2 === 0 ? "bg-card" : "bg-muted/5",
                      )}
                    >
                      {/* Site name */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Building2 className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
                          <span className="font-medium truncate" title={site.name}>{site.name}</span>
                        </div>
                      </td>

                      {/* Status cells */}
                      {columns.map(col => (
                        <td
                          key={col.key}
                          className={cn(
                            "px-2 py-3 text-center",
                            groupStarts.has(col.key) && "border-l border-border/50",
                          )}
                        >
                          <StatusCell
                            status={status[col.key] ?? "none"}
                            route={col.route}
                            routeQuery={"routeQuery" in col ? col.routeQuery : undefined}
                            date={date}
                            siteId={site.id}
                          />
                        </td>
                      ))}

                      {/* Progress */}
                      <td className="px-4 py-3 border-l border-border/50">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden hidden sm:block">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                pct === 100 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-400" : "bg-muted-foreground/20",
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={cn(
                            "text-xs font-medium tabular-nums",
                            submitted === total ? "text-emerald-600" : "text-muted-foreground",
                          )}>
                            {submitted}/{total}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="px-4 py-3 border-t border-border/50 bg-muted/10">
            <Legend />
          </div>
        </Card>
      )}

      {sites.length > 0 && (
        <MonthOverview sites={sites} onPickDay={d => { setDate(d); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      )}
    </AppLayout>
  );
}
