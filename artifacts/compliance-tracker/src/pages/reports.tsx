import { useState, useCallback, useEffect } from "react";
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
  BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from "recharts";
import { Download, RefreshCw, BarChart2, TrendingUp, AlertCircle } from "lucide-react";
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

// Distinct colours for up to 12 sites on the trend chart
const SITE_COLOURS = [
  "#6366f1","#16a34a","#d97706","#dc2626","#0ea5e9","#ec4899",
  "#14b8a6","#f97316","#8b5cf6","#84cc16","#f43f5e","#06b6d4",
];

function fmtMonth(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Site       { id: number; name: string; }
interface Department { id: number; name: string; }

interface DailyRow {
  siteId: number; siteName: string;
  type: "am" | "pm";
  submitted: number; expected: number; missed: number; pct: number;
}
interface ModuleRow { module: string; siteId: number; siteName: string; count: number; }
interface ReportData {
  from: string; to: string; totalDays: number;
  sites: Site[];
  dailyChecklists: DailyRow[];
  moduleActivity: ModuleRow[];
}

interface TrendPoint {
  month: string; daysInMonth: number;
  amSubmitted: number; pmSubmitted: number;
  amPct: number; pmPct: number; combinedPct: number;
}
interface TrendSeries { siteId: number; siteName: string; data: TrendPoint[]; }
interface TrendData {
  from: string; to: string; months: string[];
  sites: Site[];
  series: TrendSeries[];
}

// ─── CSV export ─────────────────────────────────────────────────────────────

function exportComplianceCsv(data: ReportData) {
  const lines: string[] = [];
  lines.push("DAILY CHECKLISTS COMPLIANCE");
  lines.push("Site,Type,Expected,Submitted,Missed,%");
  for (const r of data.dailyChecklists) {
    lines.push(`"${r.siteName}",${r.type.toUpperCase()},${r.expected},${r.submitted},${r.missed},${r.pct}%`);
  }
  lines.push("");
  lines.push("MODULE ACTIVITY");
  const modules = [...new Set(data.moduleActivity.map(r => r.module))].sort();
  const siteNames = [...new Set(data.moduleActivity.map(r => r.siteName))].sort();
  lines.push(`Site,${modules.join(",")}`);
  const lookup = new Map(data.moduleActivity.map(r => [`${r.siteId}::${r.module}`, r.count]));
  for (const siteName of siteNames) {
    const site = data.sites.find(s => s.name === siteName);
    if (!site) continue;
    const vals = modules.map(m => lookup.get(`${site.id}::${m}`) ?? 0);
    lines.push(`"${siteName}",${vals.join(",")}`);
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `compliance-report-${data.from}-to-${data.to}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function exportTrendCsv(data: TrendData) {
  const lines: string[] = [];
  lines.push("COMPLIANCE TREND");
  lines.push(`Site,Month,AM %,PM %,Combined %,Days in Month`);
  for (const s of data.series) {
    for (const p of s.data) {
      lines.push(`"${s.siteName}",${p.month},${p.amPct}%,${p.pmPct}%,${p.combinedPct}%,${p.daysInMonth}`);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `compliance-trend-${data.from}-to-${data.to}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── Shared filter bar ───────────────────────────────────────────────────────

function FilterBar({
  from, to, siteId, departmentId,
  sites, departments,
  onFrom, onTo, onSite, onDept,
  onLoadSites, onLoadDepts,
  onRun, loading,
  extra,
}: {
  from: string; to: string; siteId: string; departmentId: string;
  sites: Site[]; departments: Department[];
  onFrom(v: string): void; onTo(v: string): void;
  onSite(v: string): void; onDept(v: string): void;
  onLoadSites(): void; onLoadDepts(): void;
  onRun(): void; loading: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap gap-3 items-end">
      <div className="flex flex-col gap-1">
        <Label htmlFor="from">From</Label>
        <Input id="from" type="date" value={from} onChange={e => onFrom(e.target.value)} className="w-40" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="to">To</Label>
        <Input id="to" type="date" value={to} onChange={e => onTo(e.target.value)} className="w-40" />
      </div>

      <div className="flex flex-col gap-1">
        <Label>Department</Label>
        <Select value={departmentId} onValueChange={onDept} onOpenChange={onLoadDepts}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map(d => (
              <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label>Site</Label>
        <Select value={siteId} onValueChange={onSite} onOpenChange={onLoadSites}>
          <SelectTrigger className="w-44">
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

      {extra}

      <Button onClick={onRun} disabled={loading} className="self-end">
        {loading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <BarChart2 className="h-4 w-4 mr-2" />}
        {loading ? "Running…" : "Run Report"}
      </Button>
    </div>
  );
}

// ─── Compliance tab ──────────────────────────────────────────────────────────

function ComplianceTab({
  sites, departments,
}: {
  sites: Site[]; departments: Department[];
}) {
  const defaults = prevMonth();
  const [from,         setFrom]         = useState(defaults.from);
  const [to,           setTo]           = useState(defaults.to);
  const [siteId,       setSiteId]       = useState("all");
  const [departmentId, setDepartmentId] = useState("all");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [data,         setData]         = useState<ReportData | null>(null);

  const runReport = useCallback(async () => {
    setError(null); setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (siteId       !== "all") params.set("siteId",       siteId);
      if (departmentId !== "all") params.set("departmentId", departmentId);
      const res = await apiFetch(`/reports/compliance?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as any;
        throw new Error(json.error ?? `Server error ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message ?? "Failed to load report");
    } finally { setLoading(false); }
  }, [from, to, siteId, departmentId]);

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

  const { modules, pivotSites } = (() => {
    if (!data) return { modules: [], pivotSites: [] };
    const modulesSet  = new Set(data.moduleActivity.map(r => r.module));
    const mods        = [...modulesSet].sort();
    const siteNames   = [...new Set(data.moduleActivity.map(r => r.siteName))].sort();
    const lookup      = new Map(data.moduleActivity.map(r => [`${r.siteId}::${r.module}`, r.count]));
    const pivotSites  = siteNames.map(siteName => {
      const site   = data.sites.find(s => s.name === siteName);
      const counts: Record<string, number> = {};
      for (const m of mods) counts[m] = site ? (lookup.get(`${site.id}::${m}`) ?? 0) : 0;
      return { siteName, counts };
    });
    return { modules: mods, pivotSites };
  })();

  const dateLabel = data
    ? `${new Date(data.from + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} – ${new Date(data.to + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
    : null;

  return (
    <>
      <FilterBar
        from={from} to={to} siteId={siteId} departmentId={departmentId}
        sites={sites} departments={departments}
        onFrom={setFrom} onTo={setTo} onSite={setSiteId} onDept={setDepartmentId}
        onLoadSites={() => {}} onLoadDepts={() => {}}
        onRun={runReport} loading={loading}
        extra={data ? (
          <Button variant="outline" onClick={() => exportComplianceCsv(data)} className="self-end">
            <Download className="h-4 w-4 mr-2" />Export CSV
          </Button>
        ) : undefined}
      />

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

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

          {/* Daily checklists */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Daily Checklists — AM &amp; PM Compliance</CardTitle>
              <p className="text-xs text-muted-foreground">
                Percentage of days in the period where a checklist was submitted per site.
                Green ≥ 90 % · Amber ≥ 70 % · Red &lt; 70 %
              </p>
            </CardHeader>
            <CardContent>
              {chartData.length > 0 && (
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
              )}
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
                          {r.missed > 0
                            ? <span className="font-semibold text-red-600">{r.missed}</span>
                            : <span className="text-green-600">0</span>}
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

          {/* Module activity pivot */}
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
                                {n === 0
                                  ? <span className="text-muted-foreground/40">—</span>
                                  : <span className="font-medium">{n}</span>}
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
    </>
  );
}

// ─── Trend tab ────────────────────────────────────────────────────────────────

type TrendMetric = "combined" | "am" | "pm";

function TrendTab({
  sites, departments,
}: {
  sites: Site[]; departments: Department[];
}) {
  const [trendMonths,  setTrendMonths]  = useState("6");
  const [siteId,       setSiteId]       = useState("all");
  const [departmentId, setDepartmentId] = useState("all");
  const [metric,       setMetric]       = useState<TrendMetric>("combined");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [data,         setData]         = useState<TrendData | null>(null);

  const runReport = useCallback(async () => {
    setError(null); setLoading(true);
    try {
      const params = new URLSearchParams({ months: trendMonths });
      if (siteId       !== "all") params.set("siteId",       siteId);
      if (departmentId !== "all") params.set("departmentId", departmentId);
      const res = await apiFetch(`/reports/compliance-trend?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as any;
        throw new Error(json.error ?? `Server error ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message ?? "Failed to load trend");
    } finally { setLoading(false); }
  }, [trendMonths, siteId, departmentId]);

  // Build chart data: one row per month, one key per site
  const chartData = (() => {
    if (!data) return [];
    return data.months.map(month => {
      const row: Record<string, any> = { month: fmtMonth(month) };
      for (const s of data.series) {
        const point = s.data.find(p => p.month === month);
        const key   = `${s.siteId}`;
        row[key] = point
          ? (metric === "am" ? point.amPct : metric === "pm" ? point.pmPct : point.combinedPct)
          : 0;
      }
      return row;
    });
  })();

  const metricLabel = metric === "am" ? "AM" : metric === "pm" ? "PM" : "Combined AM+PM";

  return (
    <>
      {/* Filter bar — reuse shared component but add months + metric selectors */}
      <div className="mb-6 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label>Months</Label>
          <Select value={trendMonths} onValueChange={setTrendMonths}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3">3 months</SelectItem>
              <SelectItem value="6">6 months</SelectItem>
              <SelectItem value="12">12 months</SelectItem>
              <SelectItem value="24">24 months</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label>Department</Label>
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map(d => (
                <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label>Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger className="w-44">
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

        <div className="flex flex-col gap-1">
          <Label>Metric</Label>
          <Select value={metric} onValueChange={v => setMetric(v as TrendMetric)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="combined">Combined AM+PM</SelectItem>
              <SelectItem value="am">AM only</SelectItem>
              <SelectItem value="pm">PM only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={runReport} disabled={loading} className="self-end">
          {loading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <TrendingUp className="h-4 w-4 mr-2" />}
          {loading ? "Running…" : "Run Trend"}
        </Button>

        {data && (
          <Button variant="outline" onClick={() => exportTrendCsv(data)} className="self-end">
            <Download className="h-4 w-4 mr-2" />Export CSV
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-muted py-20 text-center">
          <TrendingUp className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium text-muted-foreground">See how compliance changes month by month</p>
          <p className="text-sm text-muted-foreground mt-1">Select a time range and click Run Trend</p>
        </div>
      )}

      {data && data.series.length > 0 && (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Daily Checklist Compliance — {metricLabel} Trend</CardTitle>
              <p className="text-xs text-muted-foreground">
                {data.months.length}-month view ending {fmtMonth(data.months[data.months.length - 1] ?? "")}.
                Each point is the % of days in that month with a submitted checklist.
              </p>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 12 }} width={42} />
                  <Tooltip formatter={(v: any) => `${v}%`} />
                  <Legend />
                  {/* Reference lines at 70% and 90% */}
                  {data.series.map((s, i) => (
                    <Line
                      key={s.siteId}
                      type="monotone"
                      dataKey={String(s.siteId)}
                      name={s.siteName}
                      stroke={SITE_COLOURS[i % SITE_COLOURS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Data table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium sticky left-0 bg-background">Site</th>
                      {data.months.map(m => (
                        <th key={m} className="pb-2 px-3 font-medium text-right whitespace-nowrap">{fmtMonth(m)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.series.map((s, i) => (
                      <tr key={s.siteId} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-medium sticky left-0 bg-background" style={{ color: SITE_COLOURS[i % SITE_COLOURS.length] }}>
                          {s.siteName}
                        </td>
                        {data.months.map(month => {
                          const point = s.data.find(p => p.month === month);
                          const pct   = point
                            ? (metric === "am" ? point.amPct : metric === "pm" ? point.pmPct : point.combinedPct)
                            : 0;
                          return (
                            <td key={month} className="py-2 px-3 text-right">
                              <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums", pctColour(pct))}>
                                {pct}%
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {data && data.series.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-muted py-16 text-center">
          <p className="text-muted-foreground">No checklist data found for this period</p>
        </div>
      )}
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

type ActiveTab = "compliance" | "trend";

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("compliance");

  // Shared data loaded once for both tabs
  const [sites,       setSites]       = useState<Site[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loaded,      setLoaded]      = useState(false);

  useEffect(() => {
    async function loadFilters() {
      try {
        const [sitesRes, deptsRes] = await Promise.all([
          apiFetch("/sites"),
          apiFetch("/departments"),
        ]);
        if (sitesRes.ok) {
          const json = await sitesRes.json() as { sites?: Site[] } | Site[];
          setSites(Array.isArray(json) ? json : (json as any).sites ?? []);
        }
        if (deptsRes.ok) {
          const json = await deptsRes.json() as Department[] | { departments?: Department[] };
          setDepartments(Array.isArray(json) ? json : (json as any).departments ?? []);
        }
      } finally {
        setLoaded(true);
      }
    }
    loadFilters();
  }, []);

  return (
    <AppLayout title="Reports">
      {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
      <div className="mb-6 flex gap-1 border-b">
        {([ ["compliance", BarChart2, "Compliance"], ["trend", TrendingUp, "Trend"] ] as const).map(([tab, Icon, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading filters…
        </div>
      ) : activeTab === "compliance" ? (
        <ComplianceTab sites={sites} departments={departments} />
      ) : (
        <TrendTab sites={sites} departments={departments} />
      )}
    </AppLayout>
  );
}
