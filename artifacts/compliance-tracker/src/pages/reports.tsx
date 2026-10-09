import { useState, useCallback, useEffect, useMemo } from "react";
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
import { Download, RefreshCw, BarChart2, TrendingUp, AlertCircle, FileCheck, ShieldAlert, CheckCircle2, XCircle, Clock, Printer } from "lucide-react";
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

interface Site       { id: number; name: string; departmentId?: number | null; }
interface Department { id: number; name: string; }

interface DailyRow {
  siteId: number; siteName: string;
  departmentName?: string;
  type: "am" | "pm";
  submitted: number; expected: number; missed: number; pct: number;
}
interface ModuleRow { module: string; siteId: number; siteName: string; departmentName?: string; count: number; }
interface ReportData {
  from: string; to: string; totalDays: number;
  departmentName?: string;
  sites: Site[];
  dailyChecklists: DailyRow[];
  moduleActivity: ModuleRow[];
}

interface TrendPoint {
  month: string; daysInMonth: number;
  amSubmitted: number; pmSubmitted: number;
  moduleRecordCount: number;
  amPct: number; pmPct: number; combinedPct: number;
}
interface TrendSeries { siteId: number; siteName: string; data: TrendPoint[]; }
interface TrendData {
  from: string; to: string; months: string[];
  sites: Site[];
  series: TrendSeries[];
  monthlyTotals: Array<{ month: string; moduleRecordCount: number }>;
}

interface RiskReportData {
  generatedAt: string;
  scope: { siteId: number | null; departmentId: number | null; departmentName?: string | null };
  summary: {
    staffTotal: number;
    documentTotal: number;
    relevantTotal: number;
    acknowledged: number;
    pending: number;
    expired: number;
    missing: number;
    completionPct: number;
  };
  documents: Array<{
    id: number;
    title: string;
    siteId: number | null;
    siteName?: string;
    department: string | null;
    annualAcknowledgement: boolean;
  }>;
  staff: Array<{
    id: number;
    name: string;
    jobTitle: string;
    department: string | null;
    siteId: number | null;
    siteName?: string;
    totals: {
      relevant: number;
      acknowledged: number;
      pending: number;
      expired: number;
      missing: number;
    };
    cells: Array<{
      documentId: number;
      status: 'acknowledged' | 'pending' | 'expired' | 'missing';
      acknowledgedAt?: string;
      signature?: string;
      acknowledgedByName?: string;
      expiryDate?: string;
    }>;
  }>;
}

// ─── CSV export ─────────────────────────────────────────────────────────────

function exportComplianceCsv(data: ReportData) {
  const lines: string[] = [];
  const csv = (text: string) => `"${text.replace(/"/g, '""')}"`;
  lines.push("DAILY CHECKLISTS COMPLIANCE");
  lines.push("Department,Site,Type,Expected,Submitted,Missed,%");
  for (const r of data.dailyChecklists) {
    lines.push(`${csv(r.departmentName ?? "")},${csv(r.siteName)},${r.type.toUpperCase()},${r.expected},${r.submitted},${r.missed},${r.pct}%`);
  }
  lines.push("");
  lines.push("MODULE ACTIVITY");
  const modules = [...new Set(data.moduleActivity.map(r => r.module))].sort();
  lines.push(`Department,Site,${modules.map(csv).join(",")}`);
  const lookup = new Map(data.moduleActivity.map(r => [`${r.siteId}::${r.module}`, r.count]));
  for (const site of data.sites) {
    const vals = modules.map(m => lookup.get(`${site.id}::${m}`) ?? 0);
    lines.push(`${csv(data.departmentName ?? "")},${csv(site.name)},${vals.join(",")}`);
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
  lines.push(`Site,Month,AM %,PM %,Combined %,Days in Month,Module records`);
  for (const s of data.series) {
    for (const p of s.data) {
      lines.push(`"${s.siteName.replace(/"/g, '""')}",${p.month},${p.amPct}%,${p.pmPct}%,${p.combinedPct}%,${p.daysInMonth},${p.moduleRecordCount}`);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `compliance-trend-${data.from}-to-${data.to}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function exportRiskCsv(data: RiskReportData) {
  const lines: string[] = [];
  lines.push("RISK ASSESSMENT SIGN-OFF REGISTER");
  lines.push(`Generated at,${new Date(data.generatedAt).toLocaleString()}`);
  lines.push("");

  const header = ["Staff Member", "Job Title", "Department", "Site", "Relevant", "Acknowledged", "Completion", "Status"];
  for (const doc of data.documents) {
    header.push(`"${doc.title.replace(/"/g, '""')}"`);
  }
  lines.push(header.join(","));

  for (const s of data.staff) {
    const pct = s.totals.relevant > 0 ? Math.round((s.totals.acknowledged / s.totals.relevant) * 100) : 0;
    let overallStatus = "COMPLIANT";
    if (s.totals.expired > 0) overallStatus = "EXPIRED";
    else if (s.totals.missing > 0) overallStatus = "MISSING";
    else if (s.totals.pending > 0) overallStatus = "PENDING";
    else if (s.totals.relevant === 0) overallStatus = "N/A";

    const row = [
      `"${s.name}"`,
      `"${s.jobTitle || ""}"`,
      `"${s.department || ""}"`,
      `"${s.siteName || ""}"`,
      s.totals.relevant,
      s.totals.acknowledged,
      s.totals.relevant > 0 ? `${pct}%` : "N/A",
      overallStatus
    ];

    for (const doc of data.documents) {
      const cell = s.cells.find(c => c.documentId === doc.id);
      if (!cell) {
        row.push("N/A");
      } else {
        if (cell.status === "acknowledged") {
          row.push(`"Ack: ${new Date(cell.acknowledgedAt!).toLocaleDateString()}"`);
        } else if (cell.status === "expired") {
          row.push('"Expired"');
        } else if (cell.status === "missing") {
          row.push('"Missing"');
        } else {
          row.push('"Pending"');
        }
      }
    }
    lines.push(row.join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `risk-signoff-report.csv`; a.click();
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
    const lookup      = new Map(data.moduleActivity.map(r => [`${r.siteId}::${r.module}`, r.count]));
    const pivotSites  = data.sites.map(site => {
      const counts: Record<string, number> = {};
      for (const m of mods) counts[m] = lookup.get(`${site.id}::${m}`) ?? 0;
      return { siteId: site.id, siteName: site.name, counts };
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
            {data.departmentName && <> · Department: <span className="font-medium text-foreground">{data.departmentName}</span></>}
          </p>
          {data.departmentName && (
            <p className="mb-4 text-xs text-muted-foreground">
              Counts use the submitting account’s current department assignment. Records without
              an identifiable submitting account are excluded; sites with no attributed records
              are omitted unless a site is selected.
            </p>
          )}

          {/* Daily checklists */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Daily Checklists — AM &amp; PM Compliance</CardTitle>
              <p className="text-xs text-muted-foreground">
                Percentage of days in the period where a checklist was submitted per site{data.departmentName ? " by a member of the selected department" : ""}.
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
                      {data.departmentName && <th className="pb-2 pr-4 font-medium">Department</th>}
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
                      <tr><td colSpan={data.departmentName ? 7 : 6} className="py-6 text-center text-muted-foreground">No daily checklist data for this period</td></tr>
                    ) : data.dailyChecklists.map((r, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                        {data.departmentName && <td className="py-2 pr-4">{r.departmentName}</td>}
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
              <CardTitle className="text-base">Module Activity by {data.departmentName ? "Department and Site" : "Site"}</CardTitle>
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
                        {data.departmentName && <th className="pb-2 pr-4 font-medium">Department</th>}
                        <th className="pb-2 pr-4 font-medium sticky left-0 bg-background">Site</th>
                        {modules.map(m => (
                          <th key={m} className="pb-2 px-3 font-medium text-right whitespace-nowrap">{m}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pivotSites.map(row => (
                        <tr key={row.siteId} className="border-b last:border-0 hover:bg-muted/30">
                          {data.departmentName && <td className="py-2 pr-4">{data.departmentName}</td>}
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
  const filteredSites = useMemo(
    () => departmentId === "all"
      ? sites
      : sites.filter(site => site.departmentId === Number(departmentId)),
    [sites, departmentId],
  );

  const selectDepartment = useCallback((value: string) => {
    setDepartmentId(value);
    if (
      value !== "all"
      && siteId !== "all"
      && sites.find(site => site.id === Number(siteId))?.departmentId !== Number(value)
    ) {
      setSiteId("all");
    }
  }, [siteId, sites]);

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
          <Select value={departmentId} onValueChange={selectDepartment}>
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
            {filteredSites.map(s => (
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
                {data.months.length} completed months ending {fmtMonth(data.months[data.months.length - 1] ?? "")}.
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
              <p className="text-xs text-muted-foreground">Checklist completion by site; module records count activity across the other tracked modules.</p>
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
                    <tr className="border-b bg-muted/20">
                      <td className="py-2 pr-4 font-medium sticky left-0 bg-muted/20">Module records (shown sites)</td>
                      {data.months.map(month => (
                        <td key={month} className="py-2 px-3 text-right tabular-nums">
                          {data.monthlyTotals.find(total => total.month === month)?.moduleRecordCount ?? 0}
                        </td>
                      ))}
                    </tr>
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

// ─── Risk tab ────────────────────────────────────────────────────────────────

function RiskTab({
  sites, departments,
}: {
  sites: Site[]; departments: Department[];
}) {
  const [siteId,       setSiteId]       = useState("all");
  const [departmentId, setDepartmentId] = useState("all");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [data,         setData]         = useState<RiskReportData | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const filteredSites = useMemo(
    () => departmentId === "all"
      ? sites
      : sites.filter(site => site.departmentId === Number(departmentId)),
    [sites, departmentId],
  );

  const selectDepartment = useCallback((value: string) => {
    setDepartmentId(value);
    if (
      value !== "all"
      && siteId !== "all"
      && sites.find(site => site.id === Number(siteId))?.departmentId !== Number(value)
    ) {
      setSiteId("all");
    }
  }, [siteId, sites]);

  const visibleStaff = useMemo(() => {
    if (!data || statusFilter === "all") return data?.staff ?? [];
    return data.staff.filter(staff => staff.cells.some(cell => cell.status === statusFilter));
  }, [data, statusFilter]);

  const runReport = useCallback(async () => {
    setError(null); setLoading(true);
    try {
      const params = new URLSearchParams();
      if (siteId       !== "all") params.set("siteId",       siteId);
      if (departmentId !== "all") params.set("departmentId", departmentId);
      const res = await apiFetch(`/reports/risk-acknowledgements?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as any;
        throw new Error(json.error ?? `Server error ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message ?? "Failed to load report");
    } finally { setLoading(false); }
  }, [siteId, departmentId]);

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-3 items-end print:hidden">
        <div className="flex flex-col gap-1">
          <Label>Department</Label>
          <Select value={departmentId} onValueChange={selectDepartment}>
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
            {filteredSites.map(s => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label>Sign-off status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="acknowledged">Signed</SelectItem>
              <SelectItem value="missing">Missing</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={runReport} disabled={loading} className="self-end bg-[#2B4B6F] hover:bg-[#1A2E44] text-white">
          {loading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <FileCheck className="h-4 w-4 mr-2" />}
          {loading ? "Running…" : "Run Report"}
        </Button>

        {data && (
          <>
            <Button
              variant="outline"
              onClick={() => exportRiskCsv({ ...data, staff: visibleStaff })}
              className="self-end"
            >
              <Download className="h-4 w-4 mr-2" />Export CSV
            </Button>
            <Button variant="outline" onClick={() => window.print()} className="self-end">
              <Printer className="h-4 w-4 mr-2" />Print
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 print:hidden">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-muted py-20 text-center print:hidden">
          <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium text-foreground">Risk Assessment Compliance</p>
          <p className="text-sm text-muted-foreground mt-1">Select filters and run the report to view staff acknowledgement status</p>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-[#162D42]">Risk Acknowledgement Register</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Generated {new Date(data.generatedAt).toLocaleString()}
              </p>
            </div>

            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col bg-muted/50 px-4 py-2 rounded-lg border">
                <span className="text-xs text-muted-foreground uppercase font-semibold">Staff Count</span>
                <span className="text-xl font-bold">{data.summary.staffTotal}</span>
              </div>
              <div className="flex flex-col bg-muted/50 px-4 py-2 rounded-lg border">
                <span className="text-xs text-muted-foreground uppercase font-semibold">Exceptions</span>
                <span className={cn("text-xl font-bold", data.summary.expired + data.summary.missing > 0 ? "text-red-600" : "text-muted-foreground")}>
                  {data.summary.expired + data.summary.missing}
                </span>
              </div>
              <div className="flex flex-col bg-[#F4F7FA] px-4 py-2 rounded-lg border border-[#2B4B6F]/20">
                <span className="text-xs text-[#2B4B6F] uppercase font-semibold">Completion</span>
                <span className={cn(
                  "text-xl font-bold",
                  data.summary.completionPct >= 90 ? "text-green-600" :
                  data.summary.completionPct >= 70 ? "text-amber-600" : "text-red-600"
                )}>
                  {data.summary.completionPct.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          <Card className="overflow-hidden border-border/50 shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-left text-muted-foreground">
                    <th className="py-3 px-4 font-semibold sticky left-0 bg-background z-10 w-56 min-w-[14rem] shadow-[1px_0_0_0_var(--border)]">Staff Member</th>
                    <th className="py-3 px-4 font-semibold whitespace-nowrap min-w-[10rem]">Site / Dept</th>
                    <th className="py-3 px-4 font-semibold text-center whitespace-nowrap">Status</th>
                    {data.documents.map(doc => (
                      <th key={doc.id} className="py-3 px-3 font-medium text-center text-xs whitespace-nowrap min-w-[6rem] max-w-[10rem] truncate border-l border-border/50" title={doc.title}>
                        {doc.title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {visibleStaff.length === 0 ? (
                    <tr><td colSpan={3 + data.documents.length} className="py-8 text-center text-muted-foreground">No staff matched the filters</td></tr>
                  ) : visibleStaff.map(s => {
                    const pct = s.totals.relevant > 0 ? (s.totals.acknowledged / s.totals.relevant) * 100 : 0;
                    return (
                      <tr key={s.id} className="hover:bg-muted/10 transition-colors group">
                        <td className="py-2.5 px-4 sticky left-0 bg-background group-hover:bg-muted/30 transition-colors z-10 shadow-[1px_0_0_0_var(--border)]">
                          <div className="font-medium text-foreground truncate" title={s.name}>{s.name}</div>
                          <div className="text-xs text-muted-foreground truncate mt-0.5" title={s.jobTitle}>{s.jobTitle || "—"}</div>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="text-sm font-medium">{s.siteName || "—"}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{s.department || "—"}</div>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-center">
                          {s.totals.relevant === 0 ? (
                            <span className="inline-block rounded px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">N/A</span>
                          ) : (
                            <span className={cn(
                              "inline-block rounded-full px-2 py-0.5 text-xs font-bold tabular-nums border",
                              pct >= 100 ? "bg-green-50 text-green-700 border-green-200" :
                              s.totals.expired > 0 ? "bg-red-50 text-red-700 border-red-200" :
                              "bg-amber-50 text-amber-700 border-amber-200"
                            )}>
                              {pct.toFixed(0)}%
                            </span>
                          )}
                        </td>
                        {data.documents.map(doc => {
                          const cell = s.cells.find(c => c.documentId === doc.id);
                          if (!cell) {
                            return <td key={doc.id} className="py-2.5 px-3 text-center text-muted-foreground/30 border-l border-border/50">—</td>;
                          }

                          let icon, colorClass, titleText;
                           if (cell.status === "acknowledged") {
                            icon = <CheckCircle2 className="h-4 w-4" strokeWidth={2.5} />;
                            colorClass = "text-green-600";
                            titleText = `Acknowledged on ${new Date(cell.acknowledgedAt!).toLocaleDateString()}`;
                          } else if (cell.status === "expired") {
                            icon = <XCircle className="h-4 w-4" strokeWidth={2.5} />;
                            colorClass = "text-red-600";
                            titleText = `Expired on ${new Date(cell.expiryDate!).toLocaleDateString()}`;
                           } else if (cell.status === "missing") {
                             icon = <XCircle className="h-4 w-4" strokeWidth={2.5} />;
                             colorClass = "text-red-600";
                             titleText = "No acknowledgement recorded";
                          } else {
                            icon = <Clock className="h-4 w-4" strokeWidth={2.5} />;
                            colorClass = "text-amber-500";
                            titleText = "Pending acknowledgement";
                          }

                          return (
                            <td key={doc.id} className="py-2.5 px-3 text-center align-middle border-l border-border/50" title={titleText}>
                              <div className={cn("flex justify-center", colorClass)}>
                                {icon}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}


// ─── Page ────────────────────────────────────────────────────────────────────

type ActiveTab = "compliance" | "trend" | "risk";

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
      <div className="mb-6 flex gap-1 border-b print:hidden">
        {([
          ["compliance", BarChart2, "Compliance"],
          ["trend", TrendingUp, "Trend"],
          ["risk", FileCheck, "Risk Sign-off"]
        ] as const).map(([tab, Icon, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab
                ? "border-[#2B4B6F] text-[#2B4B6F]"
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
      ) : activeTab === "trend" ? (
        <TrendTab sites={sites} departments={departments} />
      ) : (
        <RiskTab sites={sites} departments={departments} />
      )}
    </AppLayout>
  );
}
