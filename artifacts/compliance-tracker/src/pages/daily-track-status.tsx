import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { useListSites, type Site } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Link } from "wouter";
import {
  LayoutGrid, RotateCcw, CheckCircle2, Clock, Circle,
  Building2, UtensilsCrossed, Building, PenLine, Sunrise, Sunset,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type RecordStatus = "submitted" | "draft" | "none";

interface ChecklistRecord {
  id: number;
  checklistType: string;
  checkDate: string;
  siteId?: number | null;
  submittedAt?: string | null;
}

interface SignoffRecord {
  id: number;
  signoffDate: string;
  siteId?: number | null;
  submittedAt?: string | null;
}

// ── Column config ─────────────────────────────────────────────────────────────

const COLUMNS = [
  {
    key: "kitchen_opening",
    label: "Kitchen Opening",
    short: "Kit. Open",
    route: "/daily-track-am",
    Icon: UtensilsCrossed,
    iconClass: "text-amber-500",
    headerClass: "text-amber-700 bg-amber-50",
  },
  {
    key: "premises_opening",
    label: "Premises Opening",
    short: "Prem. Open",
    route: "/daily-track-am",
    Icon: Building,
    iconClass: "text-sky-500",
    headerClass: "text-sky-700 bg-sky-50",
  },
  {
    key: "kitchen_closing",
    label: "Kitchen Closing",
    short: "Kit. Close",
    route: "/daily-track-pm",
    Icon: UtensilsCrossed,
    iconClass: "text-orange-500",
    headerClass: "text-orange-700 bg-orange-50",
  },
  {
    key: "premises_closing",
    label: "Premises Closing",
    short: "Prem. Close",
    route: "/daily-track-pm",
    Icon: Building,
    iconClass: "text-violet-500",
    headerClass: "text-violet-700 bg-violet-50",
  },
  {
    key: "signoff",
    label: "Manager Sign-off",
    short: "Sign-off",
    route: "/daily-track-pm",
    Icon: PenLine,
    iconClass: "text-emerald-500",
    headerClass: "text-emerald-700 bg-emerald-50",
  },
] as const;

type ColKey = typeof COLUMNS[number]["key"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toStatus(found: boolean, submittedAt: string | null | undefined): RecordStatus {
  if (!found) return "none";
  return submittedAt ? "submitted" : "draft";
}

function buildSiteStatus(
  site: Site,
  amRows: ChecklistRecord[],
  pmRows: ChecklistRecord[],
  signoffs: SignoffRecord[],
): Record<ColKey, RecordStatus> {
  const id = site.id;
  const am = (type: string) => {
    const r = amRows.find(c => c.checklistType === type && c.siteId === id);
    return toStatus(!!r, r?.submittedAt);
  };
  const pm = (type: string) => {
    const r = pmRows.find(c => c.checklistType === type && c.siteId === id);
    return toStatus(!!r, r?.submittedAt);
  };
  const so = () => {
    const r = signoffs.find(s => s.siteId === id);
    return toStatus(!!r, r?.submittedAt);
  };
  return {
    kitchen_opening: am("kitchen_opening"),
    premises_opening: am("premises_opening"),
    kitchen_closing: pm("kitchen_closing"),
    premises_closing: pm("premises_closing"),
    signoff: so(),
  };
}

function countSubmitted(row: Record<ColKey, RecordStatus>): number {
  return Object.values(row).filter(s => s === "submitted").length;
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
  status, route, date, siteId,
}: { status: RecordStatus; route: string; date: string; siteId: number }) {
  return (
    <Link href={`${route}?date=${date}&siteId=${siteId}`}>
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

interface HistoryChecklist { checkDate: string; siteId: number | null; checklistType: string; submittedAt: string | null }
interface HistorySignoff { signoffDate: string; siteId: number | null; submittedAt: string | null }

type DayStatus = "complete" | "partial" | "missing" | "future";

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function MonthOverview({ sites, onPickDay }: { sites: Site[]; onPickDay: (date: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const lastMonth = shiftMonth(today.slice(0, 7), -1);
  const [month, setMonth] = useState(lastMonth);
  const [rows, setRows] = useState<{ checklists: HistoryChecklist[]; signoffs: HistorySignoff[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const from = `${month}-01`;
  const to = `${month}-${String(daysInMonth).padStart(2, "0")}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await apiFetch(`/daily-track-am/history?from=${from}&to=${to}`);
      if (!cancelled) {
        setRows(res.ok ? await res.json() : { checklists: [], signoffs: [] });
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to]);

  const expectedPerDay = sites.length * COLUMNS.length;
  const siteIds = new Set(sites.map(s => s.id));

  const dayStatuses: { date: string; status: DayStatus; submitted: number }[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (date >= today) { dayStatuses.push({ date, status: "future", submitted: 0 }); continue; }
    // Count distinct (site, requirement) pairs so duplicate or site-less rows
    // can't make an incomplete day look complete.
    const done = new Set<string>();
    for (const c of rows?.checklists ?? []) {
      if (c.checkDate === date && c.submittedAt && c.siteId != null && siteIds.has(c.siteId)) {
        done.add(`${c.siteId}:${c.checklistType}`);
      }
    }
    for (const s of rows?.signoffs ?? []) {
      if (s.signoffDate === date && s.submittedAt && s.siteId != null && siteIds.has(s.siteId)) {
        done.add(`${s.siteId}:signoff`);
      }
    }
    const submitted = done.size;
    const status: DayStatus =
      expectedPerDay === 0 ? "missing"
      : submitted >= expectedPerDay ? "complete"
      : submitted > 0 ? "partial"
      : "missing";
    dayStatuses.push({ date, status, submitted });
  }

  const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0
  const incompleteDays = dayStatuses.filter(d => d.status === "partial" || d.status === "missing").length;

  return (
    <Card className="mt-8 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-sm">Month overview</h3>
          <p className="text-xs text-muted-foreground">
            Spot patterns — days where checklists were incomplete or missing. Click a day to inspect it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => setMonth(shiftMonth(month, -1))}>←</Button>
          <span className="text-sm font-medium min-w-[130px] text-center">{monthLabel(month)}</span>
          <Button variant="outline" size="sm" className="h-8 px-2"
            disabled={month >= today.slice(0, 7)}
            onClick={() => setMonth(shiftMonth(month, 1))}>→</Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1.5 max-w-xl">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
              <div key={d} className="text-[10px] text-muted-foreground text-center font-medium">{d}</div>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
            {dayStatuses.map(({ date, status, submitted }) => (
              <button
                key={date}
                disabled={status === "future"}
                onClick={() => onPickDay(date)}
                title={status === "future" ? "" : `${date} — ${submitted}/${expectedPerDay} submitted`}
                className={cn(
                  "aspect-square rounded-md text-xs font-medium flex items-center justify-center transition-transform",
                  status === "complete" && "bg-emerald-100 text-emerald-700 hover:scale-105",
                  status === "partial" && "bg-amber-100 text-amber-700 hover:scale-105",
                  status === "missing" && "bg-red-100 text-red-700 hover:scale-105",
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
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 border border-red-300" /> Nothing submitted</span>
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
  const { activeClientId } = useAuth();
  const { data: sites = [], isLoading: sitesLoading } = useListSites();

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [amRows, setAmRows] = useState<ChecklistRecord[]>([]);
  const [pmRows, setPmRows] = useState<ChecklistRecord[]>([]);
  const [signoffs, setSignoffs] = useState<SignoffRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ date });
    const [amRes, pmRes, soRes] = await Promise.all([
      apiFetch(`/daily-track-am?${params}`),
      apiFetch(`/daily-track-pm?${params}`),
      apiFetch(`/daily-track-pm/signoffs?${params}`),
    ]);
    if (amRes.ok) setAmRows(await amRes.json());
    if (pmRes.ok) setPmRows(await pmRes.json());
    if (soRes.ok) setSignoffs(await soRes.json());
    setLoading(false);
  }, [date, activeClientId]);

  // Initial load + auto-refresh every 60 s so the grid stays live
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const isLoading = loading || sitesLoading;

  // Compute per-site status rows
  const siteStatuses = sites.map(site => ({
    site,
    status: buildSiteStatus(site, amRows, pmRows, signoffs),
  }));

  // Summary counts across all sites
  const totalSites = sites.length;
  const allGreen = siteStatuses.filter(({ status }) =>
    Object.values(status).every(s => s === "submitted")
  ).length;

  const isToday = date === today;

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
          <Button variant="outline" size="sm" onClick={load} className="h-9 gap-1.5">
            <RotateCcw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>

        {/* Summary pill */}
        {!isLoading && totalSites > 0 && (
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

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : sites.length === 0 ? (
        <Card className="p-12 text-center">
          <Building2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-muted-foreground text-sm">No sites configured yet.</p>
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
                  {/* AM group header */}
                  <th colSpan={2} className="px-2 py-2 text-center border-l border-border/50">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-amber-700 uppercase tracking-wider">
                      <Sunrise className="w-3.5 h-3.5" />
                      AM
                    </div>
                  </th>
                  {/* PM group header */}
                  <th colSpan={2} className="px-2 py-2 text-center border-l border-border/50">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-orange-700 uppercase tracking-wider">
                      <Sunset className="w-3.5 h-3.5" />
                      PM
                    </div>
                  </th>
                  {/* Sign-off header */}
                  <th className="px-2 py-2 text-center border-l border-border/50">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                      <PenLine className="w-3.5 h-3.5" />
                      Sign-off
                    </div>
                  </th>
                  {/* Progress */}
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground border-l border-border/50 min-w-[80px]">
                    Done
                  </th>
                </tr>
                {/* Sub-headers */}
                <tr className="border-b border-border bg-muted/10">
                  <th className="px-4 py-2" />
                  {COLUMNS.map((col, i) => (
                    <th
                      key={col.key}
                      className={cn(
                        "px-2 py-2 text-center text-xs font-normal text-muted-foreground whitespace-nowrap w-24",
                        (i === 0 || i === 2 || i === 4) && "border-l border-border/50",
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
                {siteStatuses.map(({ site, status }, rowIdx) => {
                  const submitted = countSubmitted(status);
                  const total = COLUMNS.length;
                  const pct = Math.round((submitted / total) * 100);

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
                      {COLUMNS.map((col, i) => (
                        <td
                          key={col.key}
                          className={cn(
                            "px-2 py-3 text-center",
                            (i === 0 || i === 2 || i === 4) && "border-l border-border/50",
                          )}
                        >
                          <StatusCell
                            status={status[col.key]}
                            route={col.route}
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
