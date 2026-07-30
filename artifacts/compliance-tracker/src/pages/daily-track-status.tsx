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
    </AppLayout>
  );
}
