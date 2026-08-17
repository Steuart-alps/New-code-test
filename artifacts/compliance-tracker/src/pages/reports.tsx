import { useState, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Download, RefreshCw, BarChart2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

function prevMonth() {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const to   = new Date(d.getFullYear(), d.getMonth(), 0);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

function pctColour(pct: number) {
  if (pct >= 90) return "text-green-700 bg-green-50";
  if (pct >= 70) return "text-amber-700 bg-amber-50";
  return "text-red-700 bg-red-50";
}

function barColour(pct: number) {
  if (pct >= 90) return "#16a34a";
  if (pct >= 70) return "#d97706";
  return "#dc2626";
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Site { id: number; name: string; }

interface DailyRow {
  siteId: number; siteName: string;
  type: "am" | "pm";
  submitted: number; expected: number; missed: number; pct: number;
}

interface ModuleRow {
  module: string; siteId: number; siteName: string; count: number;
}

interface ReportData {
  from: string; to: string; totalDays: number;
  sites: Site[];
  dailyChecklists: DailyRow[];
  moduleActivity: ModuleRow[];
}

// ─── CSV export ─────────────────────────────────────────────────────────────

function exportCsv(data: ReportData) {
  const lines: string[] = [];

  lines.push("DAILY CHECKLISTS COMPLIANCE");
  lines.push("Site,Type,Expected,Submitted,Missed,%");
  for (const r of data.dailyChecklists) {
    lines.push(`"${r.siteName}",${r.type.toUpperCase()},${r.expected},${r.submitted},${r.missed},${r.pct}%`);
  }

  lines.push("");
  lines.push("MODULE ACTIVITY");

  const modules = [...new Set(data.moduleActivity.map(r => r.module))].sort();
  const sites   = [...new Set(data.moduleActivity.map(r => r.siteName))].sort();
  lines.push(`Site,${modules.join(",")}`);
  const lookup = new Map(data.moduleActivity.map(r => [`${r.siteId}::${r.module}`, r.count]));
  for (const siteName of sites) {
    const site = data.sites.find(s => s.name === siteName);
    if (!site) continue;
    const vals = modules.map(m => lookup.get(`${site.id}::${m}`) ?? 0);
    lines.push(`"${siteName}",${vals.join(",")}`);
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `compliance-report-${data.from}-to-${data.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const defaults = prevMonth();

  const [from,   setFrom]   = useState(defaults.from);
  const [to,     setTo]     = useState(defaults.to);
  const [siteId, setSiteId] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [data,    setData]    = useState<ReportData | null>(null);

  // Site list is fetched once separately so the filter works before the report runs
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);

  const loadSites = useCallback(async () => {
    if (sitesLoaded) return;
    try {
      const res = await apiFetch("/sites");
      if (res.ok) {
        const json = await res.json() as { sites?: Site[] } | Site[];
        const list = Array.isArray(json) ? json : (json as any).sites ?? [];
        setSites(list);
      }
    } finally {
      setSitesLoaded(true);
    }
  }, [sitesLoaded]);

  const runReport = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (siteId !== "all") params.set("siteId", siteId);
      const res = await apiFetch(`/reports/compliance?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as any;
        throw new Error(json.error ?? `Server error ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message ?? "Failed to load report");
    } finally {
      setLoading(false);
    }
  }, [from, to, siteId]);

  // ── Derived data ────────────────────────────────────────────────────────────

  // Daily checklists: one bar per site — AM% and PM%
  const chartData = (() => {
    if (!data) return [];
    const bySite: Record<number, { name: string; amPct: number; pmPct: number }> = {};
    for (const r of data.dailyChecklists) {
      if (!bySite[r.siteId]) bySite[r.siteId] = { name: r.siteName, amPct: 0, pmPct: 0 };
      if (r.type === "am") bySite[r.siteId].amPct = r.pct;
      if (r.type === "pm") bySite[r.siteId].pmPct = r.pct;
    }
    return Object.values(bySite);
  })();

  // Module pivot: sites × modules
  const { modules, pivotSites } = (() => {
    if (!data) return { modules: [], pivotSites: [] };
    const modulesSet = new Set(data.moduleActivity.map(r => r.module));
    const modules = [...modulesSet].sort();
    const siteNames = [...new Set(data.moduleActivity.map(r => r.siteName))].sort();
    const lookup = new Map(data.moduleActivity.map(r => [`${r.siteId}::${r.module}`, r.count]));

    const pivotSites = siteNames.map(siteName => {
      const site = data.sites.find(s => s.name === siteName);
      const counts: Record<string, number> = {};
      for (const m of modules) counts[m] = site ? (lookup.get(`${site.id}::${m}`) ?? 0) : 0;
      return { siteName, counts };
    });

    return { modules, pivotSites };
  })();

  // Format date label for display
  const dateLabel = data
    ? `${new Date(data.from + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} – ${new Date(data.to + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
    : null;

  return (
    <AppLayout title="Reports">
      {/* ── Filter bar ────────────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" type="date" value={to} onChange={e => setTo(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Site</Label>
          <Select value={siteId} onValueChange={setSiteId} onOpenChange={loadSites}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All sites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map(s => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={runReport} disabled={loading} className="self-end">
          {loading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <BarChart2 className="h-4 w-4 mr-2" />}
          {loading ? "Running…" : "Run Report"}
        </Button>
        {data && (
          <Button variant="outline" onClick={() => exportCsv(data)} className="self-end">
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        )}
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────────── */}
      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────────── */}
      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-muted py-20 text-center">
          <BarChart2 className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium text-muted-foreground">Choose a date range and run the report</p>
          <p className="text-sm text-muted-foreground mt-1">Default is the previous calendar month</p>
        </div>
      )}

      {data && (
        <>
          <p className="text-sm text-muted-foreground mb-6">
            Showing data for <span className="font-medium text-foreground">{dateLabel}</span>
            {" "}({data.totalDays} days, {data.sites.length} site{data.sites.length !== 1 ? "s" : ""})
          </p>

          {/* ── Section 1: Daily checklists ───────────────────────────────────── */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Daily Checklists — AM &amp; PM Compliance</CardTitle>
              <p className="text-xs text-muted-foreground">
                Percentage of days in the period where a checklist was submitted per site.
                Green ≥ 90 % · Amber ≥ 70 % · Red &lt; 70 %
              </p>
            </CardHeader>
            <CardContent>
              {/* Chart */}
              {chartData.length > 0 ? (
                <div className="mb-6">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 12 }} width={42} />
                      <Tooltip formatter={(v: any) => `${v}%`} />
                      <Legend />
                      <Bar dataKey="amPct" name="AM" radius={[4, 4, 0, 0]}>
                        {chartData.map((d, i) => <Cell key={i} fill={barColour(d.amPct)} />)}
                      </Bar>
                      <Bar dataKey="pmPct" name="PM" radius={[4, 4, 0, 0]} fill="#6366f1" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : null}

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Site</th>
                      <th className="pb-2 pr-4 font-medium">Type</th>
                      <th className="pb-2 pr-4 font-medium text-right">Expected</th>
                      <th className="pb-2 pr-4 font-medium text-right">Submitted</th>
                      <th className="pb-2 pr-4 font-medium text-right">Missed</th>
                      <th className="pb-2 font-medium text-right">Compliance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dailyChecklists.length === 0 ? (
                      <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No daily checklist data for this period</td></tr>
                    ) : data.dailyChecklists.map((r, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-medium">{r.siteName}</td>
                        <td className="py-2 pr-4 uppercase text-xs font-semibold tracking-wide text-muted-foreground">{r.type}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.expected}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.submitted}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {r.missed > 0 ? (
                            <span className="font-semibold text-red-600">{r.missed}</span>
                          ) : (
                            <span className="text-green-600">0</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <span className={cn("inline-block rounded px-2 py-0.5 text-xs font-semibold tabular-nums", pctColour(r.pct))}>
                            {r.pct}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Section 2: Module activity pivot ─────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Module Activity by Site</CardTitle>
              <p className="text-xs text-muted-foreground">
                Count of records logged per module during the period. Zero means no records were entered.
              </p>
            </CardHeader>
            <CardContent>
              {modules.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No module records found for this period</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-4 font-medium sticky left-0 bg-background">Site</th>
                        {modules.map(m => (
                          <th key={m} className="pb-2 px-3 font-medium text-right whitespace-nowrap">{m}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pivotSites.map((row, i) => (
                        <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="py-2 pr-4 font-medium sticky left-0 bg-background">{row.siteName}</td>
                          {modules.map(m => {
                            const n = row.counts[m] ?? 0;
                            return (
                              <td key={m} className="py-2 px-3 text-right tabular-nums">
                                {n === 0 ? (
                                  <span className="text-muted-foreground/40">—</span>
                                ) : (
                                  <span className="font-medium">{n}</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </AppLayout>
  );
}
