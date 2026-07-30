import { useEffect, useState, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { useGetDashboardStats, useListSites } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from "recharts";
import {
  FileWarning, Clock, ShieldAlert, Building, Briefcase, Activity, Building2,
  CheckCircle2, Circle, LayoutGrid, ArrowRight, Sunrise, Sunset,
  Flame, UtensilsCrossed, Droplets, GraduationCap, AlertTriangle,
} from "lucide-react";
import { useAuth, useIsConsultant } from "@/context/auth-context";
import { Link, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Module track summary cards ────────────────────────────────────────────────

type CheckStatus = "ok" | "due_soon" | "overdue" | "never";

function statusPill(overdue: number, dueSoon: number, ok: number, never: number) {
  if (overdue > 0) return { label: `${overdue} overdue`, cls: "bg-red-100 text-red-700" };
  if (dueSoon > 0) return { label: `${dueSoon} due soon`, cls: "bg-amber-100 text-amber-700" };
  if (ok > 0) return { label: "All checks OK", cls: "bg-emerald-100 text-emerald-700" };
  return { label: "No records yet", cls: "bg-muted text-muted-foreground" };
}

function CheckStatusBar({ items }: { items: { status: CheckStatus }[] }) {
  const counts = { ok: 0, due_soon: 0, overdue: 0, never: 0 };
  items.forEach(i => { counts[i.status]++; });
  const total = items.length || 1;
  return (
    <div className="space-y-2">
      <div className="flex h-2 rounded-full overflow-hidden gap-px">
        {counts.ok > 0 && <div className="bg-emerald-500" style={{ width: `${(counts.ok / total) * 100}%` }} />}
        {counts.due_soon > 0 && <div className="bg-amber-400" style={{ width: `${(counts.due_soon / total) * 100}%` }} />}
        {counts.overdue > 0 && <div className="bg-red-500" style={{ width: `${(counts.overdue / total) * 100}%` }} />}
        {counts.never > 0 && <div className="bg-muted" style={{ width: `${(counts.never / total) * 100}%` }} />}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
        {counts.ok > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />{counts.ok} ok</span>}
        {counts.due_soon > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />{counts.due_soon} due soon</span>}
        {counts.overdue > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{counts.overdue} overdue</span>}
        {counts.never > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/30 inline-block" />{counts.never} never</span>}
      </div>
    </div>
  );
}

function FireTrackCard() {
  const [statuses, setStatuses] = useState<{ checkType: string; status: CheckStatus }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/fire-safety/status")
      .then(r => r.ok ? r.json() : [])
      .then(setStatuses)
      .finally(() => setLoading(false));
  }, []);

  const counts = { ok: 0, due_soon: 0, overdue: 0, never: 0 };
  statuses.forEach(s => { counts[s.status]++; });
  const pill = statusPill(counts.overdue, counts.due_soon, counts.ok, counts.never);

  return (
    <Link href="/fire-safety">
      <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl h-full">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-orange-50 rounded-lg"><Flame className="w-4 h-4 text-orange-600" /></div>
              <span className="text-sm font-semibold">FireTrack</span>
            </div>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", pill.cls)}>{pill.label}</span>
          </div>
          {loading ? <div className="h-2 bg-muted rounded-full animate-pulse" /> : <CheckStatusBar items={statuses} />}
        </CardContent>
      </Card>
    </Link>
  );
}

function LegionellaTrackCard() {
  const [statuses, setStatuses] = useState<{ checkType: string; status: CheckStatus }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/legionella/status")
      .then(r => r.ok ? r.json() : [])
      .then(setStatuses)
      .finally(() => setLoading(false));
  }, []);

  const counts = { ok: 0, due_soon: 0, overdue: 0, never: 0 };
  statuses.forEach(s => { counts[s.status]++; });
  const pill = statusPill(counts.overdue, counts.due_soon, counts.ok, counts.never);

  return (
    <Link href="/legionella">
      <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl h-full">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-sky-50 rounded-lg"><Droplets className="w-4 h-4 text-sky-600" /></div>
              <span className="text-sm font-semibold">LegionellaTrack</span>
            </div>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", pill.cls)}>{pill.label}</span>
          </div>
          {loading ? <div className="h-2 bg-muted rounded-full animate-pulse" /> : <CheckStatusBar items={statuses} />}
        </CardContent>
      </Card>
    </Link>
  );
}

function KitchenTrackCard() {
  const [records, setRecords] = useState<{ id: number; recordDate: string; submittedAt: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/food-safety/")
      .then(r => r.ok ? r.json() : [])
      .then(setRecords)
      .finally(() => setLoading(false));
  }, []);

  const today = new Date();
  const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const recentSubmitted = records.filter(r => r.submittedAt && r.recordDate >= fmt(sevenDaysAgo)).length;
  const lastRecord = records.filter(r => r.submittedAt).sort((a, b) => b.recordDate.localeCompare(a.recordDate))[0];
  const todayRecord = records.find(r => r.recordDate === fmt(today));

  const pill = !lastRecord
    ? { label: "No records yet", cls: "bg-muted text-muted-foreground" }
    : todayRecord?.submittedAt
      ? { label: "Today submitted", cls: "bg-emerald-100 text-emerald-700" }
      : { label: "Today pending", cls: "bg-amber-100 text-amber-700" };

  return (
    <Link href="/kitchen">
      <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl h-full">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-amber-50 rounded-lg"><UtensilsCrossed className="w-4 h-4 text-amber-600" /></div>
              <span className="text-sm font-semibold">KitchenTrack</span>
            </div>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", pill.cls)}>{pill.label}</span>
          </div>
          {loading ? (
            <div className="h-2 bg-muted rounded-full animate-pulse" />
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Last 7 days submitted</span>
                <span className="font-semibold tabular-nums">{recentSubmitted}/7</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-amber-400 rounded-full" style={{ width: `${(recentSubmitted / 7) * 100}%` }} />
              </div>
              {lastRecord && (
                <p className="text-[11px] text-muted-foreground pt-0.5">
                  Last submitted: {lastRecord.recordDate}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function SafeTrackCard() {
  const [records, setRecords] = useState<{ id: number; expiryDate?: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/safe-track/training-records")
      .then(r => r.ok ? r.json() : [])
      .then(setRecords)
      .finally(() => setLoading(false));
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(); in30.setDate(in30.getDate() + 30);
  const in30Iso = in30.toISOString().slice(0, 10);

  const withExpiry = records.filter(r => r.expiryDate);
  const expired = withExpiry.filter(r => r.expiryDate! < today).length;
  const expiringSoon = withExpiry.filter(r => r.expiryDate! >= today && r.expiryDate! <= in30Iso).length;

  const pill = expired > 0
    ? { label: `${expired} expired`, cls: "bg-red-100 text-red-700" }
    : expiringSoon > 0
      ? { label: `${expiringSoon} expiring soon`, cls: "bg-amber-100 text-amber-700" }
      : { label: records.length > 0 ? "All current" : "No records yet", cls: records.length > 0 ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground" };

  return (
    <Link href="/safe-track">
      <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl h-full">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-violet-50 rounded-lg"><GraduationCap className="w-4 h-4 text-violet-600" /></div>
              <span className="text-sm font-semibold">SafeTrack</span>
            </div>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", pill.cls)}>{pill.label}</span>
          </div>
          {loading ? (
            <div className="h-2 bg-muted rounded-full animate-pulse" />
          ) : (
            <div className="flex items-center gap-4 text-xs">
              <div className="text-center">
                <p className={cn("text-lg font-display font-bold", expired > 0 ? "text-red-600" : "text-foreground")}>{expired}</p>
                <p className="text-muted-foreground">Expired</p>
              </div>
              <div className="text-center">
                <p className={cn("text-lg font-display font-bold", expiringSoon > 0 ? "text-amber-600" : "text-foreground")}>{expiringSoon}</p>
                <p className="text-muted-foreground">Due in 30d</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-display font-bold">{records.length}</p>
                <p className="text-muted-foreground">Total records</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function ModuleTrackRow({ hasService }: { hasService: (key: string) => boolean }) {
  const cards = [
    { key: "firetrack",       node: <FireTrackCard /> },
    { key: "kitchentrack",    node: <KitchenTrackCard /> },
    { key: "legionellatrack", node: <LegionellaTrackCard /> },
    { key: "safetrack",       node: <SafeTrackCard /> },
  ].filter(c => hasService(c.key));

  if (cards.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5" /> Module Status
      </h2>
      <div className={cn(
        "grid gap-4",
        cards.length === 1 && "grid-cols-1 max-w-xs",
        cards.length === 2 && "grid-cols-1 sm:grid-cols-2",
        cards.length === 3 && "grid-cols-1 sm:grid-cols-3",
        cards.length >= 4 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
      )}>
        {cards.map(c => <div key={c.key}>{c.node}</div>)}
      </div>
    </div>
  );
}

// ── Daily checklist snapshot ──────────────────────────────────────────────────

type RecordStatus = "submitted" | "draft" | "none";

const CHECKLIST_COLS = [
  { key: "kitchen_opening",  source: "am", label: "Kitchen Open",   Icon: Sunrise },
  { key: "premises_opening", source: "am", label: "Premises Open",  Icon: Building },
  { key: "kitchen_closing",  source: "pm", label: "Kitchen Close",  Icon: Sunset },
  { key: "premises_closing", source: "pm", label: "Premises Close", Icon: Building },
  { key: "signoff",          source: "so", label: "Sign-off",       Icon: CheckCircle2 },
] as const;

type ColKey = typeof CHECKLIST_COLS[number]["key"];

function miniStatus(rows: any[], type: string, siteId: number, isSignoff = false): RecordStatus {
  const r = isSignoff
    ? rows.find((s: any) => s.siteId === siteId)
    : rows.find((c: any) => c.checklistType === type && c.siteId === siteId);
  if (!r) return "none";
  return r.submittedAt ? "submitted" : "draft";
}

function MiniDot({ status }: { status: RecordStatus }) {
  if (status === "submitted")
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
  if (status === "draft")
    return <Clock className="w-3.5 h-3.5 text-amber-500" />;
  return <Circle className="w-3.5 h-3.5 text-muted-foreground/25" />;
}

function DailyChecklistSnapshot({ activeClientId }: { activeClientId: number | null }) {
  const { data: sites = [] } = useListSites();
  const [amRows, setAmRows] = useState<any[]>([]);
  const [pmRows, setPmRows] = useState<any[]>([]);
  const [signoffs, setSignoffs] = useState<any[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ date: today });
    const [amRes, pmRes, soRes] = await Promise.all([
      apiFetch(`/daily-track-am?${params}`),
      apiFetch(`/daily-track-pm?${params}`),
      apiFetch(`/daily-track-pm/signoffs?${params}`),
    ]);
    if (amRes.ok) setAmRows(await amRes.json());
    if (pmRes.ok) setPmRows(await pmRes.json());
    if (soRes.ok) setSignoffs(await soRes.json());
    setLastUpdated(new Date());
  }, [activeClientId, today]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (!sites.length) return null;

  // Per-site status
  const siteRows = sites.map(site => {
    const statuses: Record<ColKey, RecordStatus> = {
      kitchen_opening:  miniStatus(amRows, "kitchen_opening",  site.id),
      premises_opening: miniStatus(amRows, "premises_opening", site.id),
      kitchen_closing:  miniStatus(pmRows, "kitchen_closing",  site.id),
      premises_closing: miniStatus(pmRows, "premises_closing", site.id),
      signoff:          miniStatus(signoffs, "signoff",        site.id, true),
    };
    const submitted = Object.values(statuses).filter(s => s === "submitted").length;
    return { site, statuses, submitted };
  });

  const fullyDone  = siteRows.filter(r => r.submitted === 5).length;
  const inProgress = siteRows.filter(r => r.submitted > 0 && r.submitted < 5).length;
  const notStarted = siteRows.filter(r => r.submitted === 0).length;

  return (
    <Card className="mb-8 shadow-lg shadow-black/5 border-border/50 overflow-hidden">
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LayoutGrid className="w-4 h-4 text-primary" />
          <CardTitle className="text-base font-display">Today's Daily Checklists</CardTitle>
          <span className="text-xs text-muted-foreground ml-1">
            {new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
          </span>
          {lastUpdated && (
            <span className="text-[10px] text-muted-foreground/60 hidden sm:inline">
              · updated {lastUpdated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        <Link href="/daily-track-status">
          <span className="flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer font-medium">
            Full status <ArrowRight className="w-3 h-3" />
          </span>
        </Link>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Summary pills */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
            fullyDone > 0 ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground",
          )}>
            <CheckCircle2 className="w-3 h-3" />
            {fullyDone} complete
          </span>
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
            inProgress > 0 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground",
          )}>
            <Clock className="w-3 h-3" />
            {inProgress} in progress
          </span>
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
            notStarted > 0 && fullyDone < sites.length ? "bg-red-50 text-red-600" : "bg-muted text-muted-foreground",
          )}>
            <Circle className="w-3 h-3" />
            {notStarted} not started
          </span>
        </div>

        {/* Column headers */}
        <div className="mb-1 pl-[140px] sm:pl-[200px] flex items-center gap-1">
          {CHECKLIST_COLS.map(col => (
            <div key={col.key} className="w-9 flex justify-center" title={col.label}>
              <col.Icon className="w-3 h-3 text-muted-foreground/50" />
            </div>
          ))}
          <div className="w-10 text-right text-[10px] text-muted-foreground/50 pr-1">Done</div>
        </div>

        {/* Site rows */}
        <div className="space-y-1">
          {siteRows.map(({ site, statuses, submitted }) => (
            <Link key={site.id} href={`/daily-track-status?date=${today}`}>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/40 transition-colors cursor-pointer group">
                <span className="w-[124px] sm:w-[184px] text-sm truncate font-medium text-foreground/80 group-hover:text-foreground flex-shrink-0">
                  {site.name}
                </span>
                <div className="flex items-center gap-1">
                  {CHECKLIST_COLS.map(col => (
                    <div key={col.key} className="w-9 flex justify-center">
                      <MiniDot status={statuses[col.key]} />
                    </div>
                  ))}
                </div>
                <div className="w-10 text-right flex-shrink-0">
                  <span className={cn(
                    "text-xs font-medium tabular-nums",
                    submitted === 5 ? "text-emerald-600" : submitted > 0 ? "text-amber-600" : "text-muted-foreground/40",
                  )}>
                    {submitted}/5
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { activeClientId, hasService } = useAuth();
  const isConsultant = useIsConsultant();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success") {
      toast({ title: "Payment successful!", description: "Welcome to ComplyTrack. Your subscription is now active." });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const { data: stats, isLoading } = useGetDashboardStats({ query: { enabled: !!activeClientId } });

  if (isConsultant && !activeClientId) {
    return (
      <AppLayout title="Overview">
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
          <div className="bg-primary/10 p-4 rounded-2xl">
            <Building2 className="w-10 h-10 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-1">No client selected</h2>
            <p className="text-muted-foreground text-sm mb-4">
              Go to the Clients page and click "View" on a client to see their dashboard.
            </p>
            <Link href="/clients">
              <span className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                Go to Clients
              </span>
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (isLoading || !stats) {
    return (
      <AppLayout title="Overview">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </AppLayout>
    );
  }

  const statusData = [
    { name: "Pending", value: stats.pending, color: "#94a3b8", filter: "status-pending" },
    { name: "In Progress", value: stats.inProgress, color: "#3b82f6", filter: "status-in_progress" },
    { name: "Completed", value: stats.completed, color: "#10b981", filter: "status-completed" },
    { name: "Overdue", value: stats.overdue, color: "#ef4444", filter: "overdue" },
  ];

  return (
    <AppLayout title="Overview">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Link href="/external-checks">
          <Card className="shadow-lg shadow-black/5 border-border/50 bg-gradient-to-br from-card to-card/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Compliance Rate</p>
                  <p className="text-3xl font-display font-bold">{(stats as any).complianceRate ?? 0}%</p>
                </div>
                <div className="p-3 bg-primary/10 rounded-xl">
                  <Activity className="w-5 h-5 text-primary" />
                </div>
              </div>
              <div className="mt-4 h-2 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${(stats as any).complianceRate ?? 0}%` }} />
              </div>
              <p className="text-xs text-muted-foreground mt-2">In date vs overdue or due ≤7 days</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/external-checks?filter=action-needed">
          <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Action Needed</p>
                  <p className="text-3xl font-display font-bold text-destructive">{stats.overdue + stats.criticalItems}</p>
                </div>
                <div className="p-3 bg-destructive/10 rounded-xl">
                  <ShieldAlert className="w-5 h-5 text-destructive" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                {stats.overdue} overdue, {stats.criticalItems} critical
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/external-checks?filter=due-soon">
          <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Due Soon (30d)</p>
                  <p className="text-3xl font-display font-bold text-amber-500">{stats.dueSoon}</p>
                </div>
                <div className="p-3 bg-amber-500/10 rounded-xl">
                  <Clock className="w-5 h-5 text-amber-500" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">Approaching deadlines</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/external-checks?filter=expired-certs">
          <Card className="shadow-lg shadow-black/5 border-border/50 hover:-translate-y-1 transition-transform duration-300 cursor-pointer hover:shadow-xl">
            <CardContent className="p-6">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Expired Certs</p>
                  <p className="text-3xl font-display font-bold text-red-600">{(stats as any).certificatesExpired ?? 0}</p>
                </div>
                <div className="p-3 bg-red-600/10 rounded-xl">
                  <FileWarning className="w-5 h-5 text-red-600" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">Contractor certificates past expiry</p>
            </CardContent>
          </Card>
        </Link>
      </div>

      <ModuleTrackRow hasService={hasService} />

      {hasService("dailytrack_pm") && (
        <DailyChecklistSnapshot activeClientId={activeClientId} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 shadow-lg shadow-black/5 border-border/50">
          <CardHeader>
            <CardTitle className="text-lg font-display">Compliance Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                  <Tooltip 
                    cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} 
                  />
                  <Bar
                    dataKey="value"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={60}
                    cursor="pointer"
                    onClick={(payload: any) => {
                      const f = payload?.payload?.filter ?? payload?.filter;
                      if (f) navigate(`/external-checks?filter=${f}`);
                    }}
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="shadow-lg shadow-black/5 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-display">Compliance by Site</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">Click a site to view its checks. In date = not overdue and not due in the next 7 days.</p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <Link
                  href="/external-checks"
                  className="block p-3 bg-muted/50 rounded-xl border border-border/50 hover:bg-muted hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                  aria-label="View compliance rate across all sites"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-primary" />
                      <span className="text-sm font-semibold">All sites</span>
                    </div>
                    <span className="text-sm font-display font-bold">{(stats as any).complianceRate ?? 0}%</span>
                  </div>
                  <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full ${((stats as any).complianceRate ?? 0) >= 80 ? "bg-emerald-500" : ((stats as any).complianceRate ?? 0) >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                      style={{ width: `${(stats as any).complianceRate ?? 0}%` }}
                    />
                  </div>
                </Link>
                {((stats as any).complianceRateBySite ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No sites configured yet.</p>
                ) : (
                  ((stats as any).complianceRateBySite as any[]).map((s) => {
                    const href = s.siteId == null
                      ? "/external-checks?siteId=none"
                      : `/external-checks?siteId=${s.siteId}`;
                    return (
                      <Link
                        key={s.siteId ?? "none"}
                        href={href}
                        className="block p-3 bg-muted/30 rounded-xl border border-border/40 hover:bg-muted hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-label={`View checks at ${s.siteName}`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <Building className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm font-medium truncate">{s.siteName}</span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <span className="text-xs text-muted-foreground">{s.inDate}/{s.total}</span>
                            <span className="text-sm font-display font-semibold">{s.rate}%</span>
                          </div>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div
                            className={`h-full ${s.rate >= 80 ? "bg-emerald-500" : s.rate >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                            style={{ width: `${s.rate}%` }}
                          />
                        </div>
                      </Link>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-lg shadow-black/5 border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-display">Volume Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <Link
                  href="/external-checks"
                  className="flex items-center p-3 bg-muted/50 rounded-xl border border-border/50 hover:bg-muted hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                  aria-label="View all compliance checks"
                >
                  <div className="bg-emerald-500/20 p-2.5 rounded-lg mr-4">
                    <Briefcase className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold">Compliance Checks</h4>
                    <p className="text-xs text-muted-foreground">Contractor requirements</p>
                  </div>
                  <span className="text-xl font-display font-bold">{stats.total}</span>
                </Link>

                <Link
                  href="/contractors"
                  className="flex items-center p-3 bg-muted/50 rounded-xl border border-border/50 hover:bg-muted hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                  aria-label="View all contractors"
                >
                  <div className="bg-indigo-500/20 p-2.5 rounded-lg mr-4">
                    <Building className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold">Contractors</h4>
                    <p className="text-xs text-muted-foreground">Active in system</p>
                  </div>
                  <span className="text-xl font-display font-bold">{stats.contractorsCount}</span>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
