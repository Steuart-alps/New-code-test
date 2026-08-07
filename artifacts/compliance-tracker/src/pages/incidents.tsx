import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import {
  useGetIncidentConfig,
  getGetIncidentConfigQueryKey,
  useUpdateIncidentConfig,
} from "@workspace/api-client-react";
import {
  AlertOctagon, Plus, AlertTriangle, CheckCircle2, Clock,
  Pencil, Trash2, Lock, Search, Filter, FileWarning,
  ShieldAlert, UserX, Activity, Settings, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

const INCIDENT_TYPES = ["accident", "near_miss", "dangerous_occurrence", "occupational_disease"] as const;
const SEVERITIES = ["minor", "moderate", "serious", "fatal"] as const;
const STATUSES = ["open", "under_investigation", "closed"] as const;
const EMPLOYMENT_TYPES = ["employee", "contractor", "visitor", "member_of_public"] as const;

type IncidentType = (typeof INCIDENT_TYPES)[number];
type Severity = (typeof SEVERITIES)[number];
type Status = (typeof STATUSES)[number];
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

interface Incident {
  id: number;
  clientId: number;
  siteId: number | null;
  incidentType: IncidentType;
  severity: Severity;
  status: Status;
  incidentDate: string;
  incidentTime: string | null;
  location: string;
  description: string;
  involvedName: string;
  involvedJobTitle: string | null;
  involvedEmploymentType: EmploymentType;
  injuriesSustained: string | null;
  firstAidGiven: boolean;
  firstAiderName: string | null;
  witnesses: string | null;
  riddorReportable: boolean;
  reportedToHse: boolean;
  hseReference: string | null;
  hseReportDate: string | null;
  immediateActions: string | null;
  correctiveActions: string | null;
  reportedBy: string;
  createdAt: string;
}

interface Summary {
  total: number;
  openCount: number;
  investigatingCount: number;
  riddorCount: number;
  riddorOutstanding: number;
  thisMonth: number;
  seriousCount: number;
}

interface Site { id: number; name: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<IncidentType, string> = {
  accident:              "Accident",
  near_miss:             "Near Miss",
  dangerous_occurrence:  "Dangerous Occurrence",
  occupational_disease:  "Occupational Disease",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  minor:    "Minor",
  moderate: "Moderate",
  serious:  "Serious",
  fatal:    "Fatal",
};

const STATUS_LABELS: Record<Status, string> = {
  open:                "Open",
  under_investigation: "Under Investigation",
  closed:              "Closed",
};

const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  employee:         "Employee",
  contractor:       "Contractor",
  visitor:          "Visitor",
  member_of_public: "Member of Public",
};

const TYPE_COLORS: Record<IncidentType, string> = {
  accident:             "bg-rose-50 text-rose-700 border-rose-200",
  near_miss:            "bg-amber-50 text-amber-700 border-amber-200",
  dangerous_occurrence: "bg-orange-50 text-orange-700 border-orange-200",
  occupational_disease: "bg-sky-50 text-sky-700 border-sky-200",
};

const SEVERITY_COLORS: Record<Severity, string> = {
  minor:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  moderate: "bg-amber-50 text-amber-700 border-amber-200",
  serious:  "bg-orange-50 text-orange-700 border-orange-200",
  fatal:    "bg-rose-50 text-rose-700 border-rose-200",
};

const STATUS_COLORS: Record<Status, string> = {
  open:                "bg-rose-50 text-rose-700 border-rose-200",
  under_investigation: "bg-amber-50 text-amber-700 border-amber-200",
  closed:              "bg-slate-50 text-slate-500 border-slate-200",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error ?? `${res.status}`); }
  if (res.status === 204) return null;
  return res.json();
}

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ─── Incident Config Dialog ───────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T[]; } catch { return fallback; }
}

function IncidentConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetIncidentConfig();
  const { toast } = useToast();
  const qc = useQueryClient();
  const updateConfig = useUpdateIncidentConfig();

  const [defaultReporter, setDefaultReporter] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [showInvestigation, setShowInvestigation] = useState(true);

  useEffect(() => {
    if (!config || !open) return;
    setDefaultReporter(config.incident_default_reporter ?? "");
    setLocations(parseJsonArray<string>(config.incident_locations));
    setDepartments(parseJsonArray<string>(config.incident_departments));
    setShowInvestigation(config.incident_show_investigation !== "false");
  }, [config, open]);

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          incident_default_reporter: defaultReporter,
          incident_locations: JSON.stringify(locations.filter(Boolean)),
          incident_departments: JSON.stringify(departments.filter(Boolean)),
          incident_show_investigation: showInvestigation ? "true" : "false",
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetIncidentConfigQueryKey() });
          toast({ title: "Template saved", description: "New incidents will use these defaults." });
          setOpen(false);
        },
        onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
      }
    );
  };

  const StringListEditor = ({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) => (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 items-center">
          <Input value={item} placeholder={placeholder} className="h-8 text-sm rounded-sm"
            onChange={e => { const n = [...items]; n[i] = e.target.value; onChange(n); }} />
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
            onClick={() => onChange(items.filter((_, x) => x !== i))}>
            <X className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...items, ""])}>
        <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-sm">
          <Settings className="w-4 h-4 mr-2" />
          Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>IncidentTrack Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure defaults for new incident reports.</p>
        </DialogHeader>

        <Tabs defaultValue="defaults" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0 w-full grid grid-cols-3">
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
            <TabsTrigger value="locations">Locations</TabsTrigger>
            <TabsTrigger value="depts">Departments</TabsTrigger>
          </TabsList>

          <TabsContent value="defaults" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <div className="space-y-1.5">
              <Label>Default reported by</Label>
              <Input value={defaultReporter} onChange={e => setDefaultReporter(e.target.value)}
                placeholder="e.g. Health & Safety Manager" className="rounded-sm" />
              <p className="text-xs text-muted-foreground">Pre-fills the "Reported by" field on every new incident.</p>
            </div>
            <div className="flex items-center justify-between rounded-sm border border-border p-3">
              <div>
                <p className="text-sm font-medium">Investigation section</p>
                <p className="text-xs text-muted-foreground">Show corrective actions / investigation fields</p>
              </div>
              <Switch checked={showInvestigation} onCheckedChange={setShowInvestigation} />
            </div>
          </TabsContent>

          <TabsContent value="locations" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              Your site locations — these appear as suggestions when logging an incident location.
            </p>
            <StringListEditor items={locations} onChange={setLocations} placeholder='e.g. "Main kitchen"' />
          </TabsContent>

          <TabsContent value="depts" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              Your departments — these appear as suggestions on the department field.
            </p>
            <StringListEditor items={departments} onChange={setDepartments} placeholder='e.g. "Front of house"' />
          </TabsContent>
        </Tabs>

        <DialogFooter className="shrink-0 pt-2 border-t border-border mt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateConfig.isPending}>
            {updateConfig.isPending ? "Saving…" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Empty form ───────────────────────────────────────────────────────────────

const emptyForm = () => ({
  incidentType: "accident" as IncidentType,
  severity: "minor" as Severity,
  status: "open" as Status,
  incidentDate: new Date().toISOString().slice(0, 10),
  incidentTime: "",
  location: "",
  description: "",
  involvedName: "",
  involvedJobTitle: "",
  involvedEmploymentType: "employee" as EmploymentType,
  injuriesSustained: "",
  firstAidGiven: false,
  firstAiderName: "",
  witnesses: "",
  riddorReportable: false,
  reportedToHse: false,
  hseReference: "",
  hseReportDate: "",
  immediateActions: "",
  correctiveActions: "",
  reportedBy: "",
  siteId: "",
});

// ─── Main page ────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { toast } = useToast();
  const { activeClientId, hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const qc = useQueryClient();
  const hasIncidentTrack = hasService("incidenttrack");

  const [filterStatus, setFilterStatus] = useState<Status | "all">("all");
  const [filterSeverity, setFilterSeverity] = useState<Severity | "all">("all");
  const [filterType, setFilterType] = useState<IncidentType | "all">("all");
  const [filterRiddor, setFilterRiddor] = useState(false);
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<Incident | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [formSection, setFormSection] = useState<"details" | "actions">("details");

  const { data: incidentConfig } = useGetIncidentConfig();

  // ── Data ───────────────────────────────────────────────────────────────────

  const { data: incidents = [], isLoading } = useQuery<Incident[]>({
    queryKey: ["incidents", activeClientId],
    queryFn: () => apiFetch("/incidents"),
    enabled: !!activeClientId && hasIncidentTrack,
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ["incidents-summary", activeClientId],
    queryFn: () => apiFetch("/incidents/summary"),
    enabled: !!activeClientId && hasIncidentTrack,
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: () => apiFetch("/sites"),
    enabled: !!activeClientId,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let rows = incidents;
    if (filterStatus !== "all") rows = rows.filter(r => r.status === filterStatus);
    if (filterSeverity !== "all") rows = rows.filter(r => r.severity === filterSeverity);
    if (filterType !== "all") rows = rows.filter(r => r.incidentType === filterType);
    if (filterRiddor) rows = rows.filter(r => r.riddorReportable);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.involvedName.toLowerCase().includes(q) ||
        r.location.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.reportedBy.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [incidents, filterStatus, filterSeverity, filterType, filterRiddor, search]);

  const riddorOutstanding = summary?.riddorOutstanding ?? 0;

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["incidents"] });
    qc.invalidateQueries({ queryKey: ["incidents-summary"] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/incidents/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Record deleted" }); setDeleteId(null); },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ── Dialog ─────────────────────────────────────────────────────────────────

  function openAdd() {
    setEditItem(null);
    const f = emptyForm();
    if (incidentConfig?.incident_default_reporter) f.reportedBy = incidentConfig.incident_default_reporter;
    setForm(f);
    setFormSection("details");
    setShowDialog(true);
  }

  function openEdit(r: Incident) {
    setEditItem(r);
    setForm({
      incidentType: r.incidentType,
      severity: r.severity,
      status: r.status,
      incidentDate: r.incidentDate?.slice(0, 10) ?? "",
      incidentTime: r.incidentTime ?? "",
      location: r.location,
      description: r.description,
      involvedName: r.involvedName,
      involvedJobTitle: r.involvedJobTitle ?? "",
      involvedEmploymentType: r.involvedEmploymentType,
      injuriesSustained: r.injuriesSustained ?? "",
      firstAidGiven: r.firstAidGiven,
      firstAiderName: r.firstAiderName ?? "",
      witnesses: r.witnesses ?? "",
      riddorReportable: r.riddorReportable,
      reportedToHse: r.reportedToHse,
      hseReference: r.hseReference ?? "",
      hseReportDate: r.hseReportDate?.slice(0, 10) ?? "",
      immediateActions: r.immediateActions ?? "",
      correctiveActions: r.correctiveActions ?? "",
      reportedBy: r.reportedBy,
      siteId: r.siteId ? String(r.siteId) : "",
    });
    setFormSection("details");
    setShowDialog(true);
  }

  async function handleSave() {
    if (!form.incidentDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    if (!form.location.trim()) { toast({ title: "Location is required", variant: "destructive" }); return; }
    if (!form.involvedName.trim()) { toast({ title: "Person involved is required", variant: "destructive" }); return; }
    if (!form.description.trim()) { toast({ title: "Description is required", variant: "destructive" }); return; }
    if (!form.reportedBy.trim()) { toast({ title: "Reported by is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body: any = {
        incidentType: form.incidentType,
        severity: form.severity,
        status: form.status,
        incidentDate: form.incidentDate,
        incidentTime: form.incidentTime.trim() || null,
        location: form.location.trim(),
        description: form.description.trim(),
        involvedName: form.involvedName.trim(),
        involvedJobTitle: form.involvedJobTitle.trim() || null,
        involvedEmploymentType: form.involvedEmploymentType,
        injuriesSustained: form.injuriesSustained.trim() || null,
        firstAidGiven: form.firstAidGiven,
        firstAiderName: form.firstAiderName.trim() || null,
        witnesses: form.witnesses.trim() || null,
        riddorReportable: form.riddorReportable,
        reportedToHse: form.reportedToHse,
        hseReference: form.hseReference.trim() || null,
        hseReportDate: form.hseReportDate || null,
        immediateActions: form.immediateActions.trim() || null,
        correctiveActions: form.correctiveActions.trim() || null,
        reportedBy: form.reportedBy.trim(),
        siteId: form.siteId ? Number(form.siteId) : null,
      };
      if (editItem) {
        await apiFetch(`/incidents/${editItem.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Record updated" });
      } else {
        await apiFetch("/incidents", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Incident recorded" });
      }
      invalidate();
      setShowDialog(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Locked / upsell ────────────────────────────────────────────────────────

  if (!hasIncidentTrack) {
    return (
      <AppLayout title="IncidentTrack">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">IncidentTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital accident & incident logbook — log accidents, near misses, dangerous occurrences and occupational diseases with built-in RIDDOR reporting for HSE compliance.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button className="rounded-sm">Activate IncidentTrack</Button>
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">Ask your administrator to activate this module.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <AppLayout title="IncidentTrack">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground mt-1">
          Accident & incident logbook — accidents, near misses, dangerous occurrences and RIDDOR reporting
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canAdmin && <IncidentConfigDialog />}
          <Button onClick={openAdd} className="gap-2 rounded-sm">
            <Plus className="w-4 h-4" /> Log Incident
          </Button>
        </div>
      </div>

      {/* RIDDOR outstanding alert */}
      {riddorOutstanding > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-rose-50 border-rose-200 text-rose-800 text-sm">
          <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{riddorOutstanding} RIDDOR-reportable incident{riddorOutstanding !== 1 ? "s have" : " has"} not yet been reported to the HSE.</strong>{" "}
            RIDDOR reports must be submitted within the statutory timeframe.
          </span>
        </div>
      )}

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Total",         value: summary.total,              icon: Activity,     color: "text-slate-600" },
            { label: "Open",          value: summary.openCount,          icon: AlertOctagon, color: "text-rose-600" },
            { label: "Investigating", value: summary.investigatingCount, icon: Clock,        color: "text-amber-600" },
            { label: "This Month",    value: summary.thisMonth,          icon: AlertTriangle, color: "text-sky-600" },
            { label: "RIDDOR",        value: summary.riddorCount,        icon: ShieldAlert,  color: "text-orange-600" },
            { label: "Serious/Fatal", value: summary.seriousCount,       icon: UserX,        color: "text-rose-700" },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="rounded-sm">
              <CardContent className="p-4">
                <div className={cn("flex items-center gap-1.5 mb-1", color)}>
                  <Icon className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">{label}</span>
                </div>
                <div className="text-2xl font-semibold">{value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {sites.length > 0 && (
          <Select value={filterStatus} onValueChange={v => setFilterStatus(v as Status | "all")}>
            <SelectTrigger className="w-44 rounded-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterStatus} onValueChange={v => setFilterStatus(v as Status | "all")}>
          <SelectTrigger className="w-44 rounded-sm">
            <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterSeverity} onValueChange={v => setFilterSeverity(v as Severity | "all")}>
          <SelectTrigger className="w-36 rounded-sm">
            <SelectValue placeholder="All severities" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITIES.map(s => <SelectItem key={s} value={s}>{SEVERITY_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={v => setFilterType(v as IncidentType | "all")}>
          <SelectTrigger className="w-48 rounded-sm">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {INCIDENT_TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <button
          onClick={() => setFilterRiddor(r => !r)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-sm border transition-colors",
            filterRiddor
              ? "bg-orange-500 text-white border-orange-500"
              : "bg-background text-muted-foreground border-border hover:border-orange-400"
          )}
        >
          <ShieldAlert className="w-3.5 h-3.5" /> RIDDOR only
        </button>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search name, location, description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 rounded-sm"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border rounded-sm">
          <AlertOctagon className="w-9 h-9 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {incidents.length === 0
              ? "No incidents recorded yet. Use the button above to log your first incident."
              : "No records match the current filters."}
          </p>
          {incidents.length === 0 && (
            <Button onClick={openAdd} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
              <Plus className="w-4 h-4" /> Log Incident
            </Button>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Type / Severity</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Person Involved</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider hidden md:table-cell">Location</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider hidden lg:table-cell">Description</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider hidden sm:table-cell">RIDDOR</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(r => (
                <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {fmt(r.incidentDate)}
                    {r.incidentTime && <div className="text-xs text-muted-foreground/60">{r.incidentTime}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <Badge variant="outline" className={cn("text-xs w-fit", TYPE_COLORS[r.incidentType])}>
                        {TYPE_LABELS[r.incidentType]}
                      </Badge>
                      <Badge variant="outline" className={cn("text-xs w-fit", SEVERITY_COLORS[r.severity])}>
                        {SEVERITY_LABELS[r.severity]}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.involvedName}</div>
                    {r.involvedJobTitle && <div className="text-xs text-muted-foreground">{r.involvedJobTitle}</div>}
                    <div className="text-xs text-muted-foreground">{EMPLOYMENT_LABELS[r.involvedEmploymentType]}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell max-w-[180px] truncate">{r.location}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell max-w-[240px]">
                    <span className="line-clamp-2">{r.description}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={cn("text-xs", STATUS_COLORS[r.status])}>
                      {STATUS_LABELS[r.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    {r.riddorReportable ? (
                      r.reportedToHse ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Reported
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-rose-700 font-medium">
                          <ShieldAlert className="w-3.5 h-3.5" /> Outstanding
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <CheckPhotoUploader entityType="incident" entityId={r.id} compact />
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={() => openEdit(r)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(r.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
            Showing {filtered.length} of {incidents.length} record{incidents.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* Legal footer */}
      <div className="bg-rose-50 border border-rose-200 rounded-sm p-4 text-xs text-rose-900">
        <p className="font-semibold mb-1">RIDDOR 2013 — Reporting requirements</p>
        <p>
          Under the Reporting of Injuries, Diseases and Dangerous Occurrences Regulations 2013 you must report certain workplace incidents to the HSE.
          This includes: deaths, specified injuries (fractures, amputations, loss of sight, crush injuries), over-7-day incapacitation, occupational diseases, and dangerous occurrences.
          Most reports must be submitted within 10 days (15 days for over-7-day injuries). Report online at <span className="font-medium">riddor.hse.gov.uk</span> or by phone on 0345 300 9923.
        </p>
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={showDialog} onOpenChange={v => { if (!saving) setShowDialog(v); }}>
        <DialogContent className="max-w-2xl rounded-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertOctagon className="w-5 h-5 text-rose-600" />
              {editItem ? "Edit Incident Record" : "Log Incident / Accident"}
            </DialogTitle>
          </DialogHeader>

          {/* Section tabs */}
          <div className="flex gap-1 border-b border-border pb-2">
            {(["details", "actions"] as const).map(s => (
              <button
                key={s}
                onClick={() => setFormSection(s)}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-sm transition-colors",
                  formSection === s
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {s === "details" ? "Incident Details" : "Actions & RIDDOR"}
              </button>
            ))}
          </div>

          <div className="space-y-4 py-1 max-h-[60vh] overflow-y-auto pr-1">

            {formSection === "details" && (
              <>
                {/* Type & Severity */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Incident Type *</Label>
                    <Select value={form.incidentType} onValueChange={v => setForm(f => ({ ...f, incidentType: v as IncidentType }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {INCIDENT_TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Severity *</Label>
                    <Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v as Severity }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SEVERITIES.map(s => <SelectItem key={s} value={s}>{SEVERITY_LABELS[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Date, Time, Status */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>Date *</Label>
                    <Input type="date" value={form.incidentDate}
                      onChange={e => setForm(f => ({ ...f, incidentDate: e.target.value }))}
                      className="mt-1 rounded-sm" />
                  </div>
                  <div>
                    <Label>Time</Label>
                    <Input type="time" value={form.incidentTime}
                      onChange={e => setForm(f => ({ ...f, incidentTime: e.target.value }))}
                      className="mt-1 rounded-sm" />
                  </div>
                  <div>
                    <Label>Status *</Label>
                    <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v as Status }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Location & Site */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Location / Area *</Label>
                    {(() => {
                      const locs = parseJsonArray<string>(incidentConfig?.incident_locations);
                      return (
                        <>
                          {locs.length > 0 && <datalist id="incident-locations-list">{locs.map(l => <option key={l} value={l} />)}</datalist>}
                          <Input placeholder="e.g. Kitchen, Car park, Reception"
                            value={form.location}
                            list={locs.length > 0 ? "incident-locations-list" : undefined}
                            onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                            className="mt-1 rounded-sm" />
                        </>
                      );
                    })()}
                  </div>
                  {sites.length > 0 && (
                    <div>
                      <Label>Site</Label>
                      <Select value={form.siteId} onValueChange={v => setForm(f => ({ ...f, siteId: v }))}>
                        <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">No specific site</SelectItem>
                          {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* Description */}
                <div>
                  <Label>Description of what happened *</Label>
                  <Textarea placeholder="Describe exactly what happened, the sequence of events leading up to the incident…"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    className="mt-1 rounded-sm" rows={3} />
                </div>

                {/* Person involved */}
                <div className="border border-border rounded-sm p-3 space-y-3 bg-muted/20">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Person Involved</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Full Name *</Label>
                      <Input placeholder="Name of person involved"
                        value={form.involvedName}
                        onChange={e => setForm(f => ({ ...f, involvedName: e.target.value }))}
                        className="mt-1 rounded-sm" />
                    </div>
                    <div>
                      <Label>Job Title</Label>
                      <Input placeholder="Role / position"
                        value={form.involvedJobTitle}
                        onChange={e => setForm(f => ({ ...f, involvedJobTitle: e.target.value }))}
                        className="mt-1 rounded-sm" />
                    </div>
                  </div>
                  <div>
                    <Label>Employment Status *</Label>
                    <Select value={form.involvedEmploymentType} onValueChange={v => setForm(f => ({ ...f, involvedEmploymentType: v as EmploymentType }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {EMPLOYMENT_TYPES.map(t => <SelectItem key={t} value={t}>{EMPLOYMENT_LABELS[t]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Injuries */}
                <div>
                  <Label>Injuries Sustained</Label>
                  <Textarea placeholder="Describe any injuries, or 'None' if a near miss with no injuries…"
                    value={form.injuriesSustained}
                    onChange={e => setForm(f => ({ ...f, injuriesSustained: e.target.value }))}
                    className="mt-1 rounded-sm" rows={2} />
                </div>

                {/* First aid */}
                <div className="flex items-start gap-3">
                  <Checkbox id="firstAid" checked={form.firstAidGiven}
                    onCheckedChange={v => setForm(f => ({ ...f, firstAidGiven: !!v }))}
                    className="mt-0.5" />
                  <div className="flex-1">
                    <Label htmlFor="firstAid" className="cursor-pointer">First aid was given</Label>
                    {form.firstAidGiven && (
                      <Input placeholder="Name of first aider"
                        value={form.firstAiderName}
                        onChange={e => setForm(f => ({ ...f, firstAiderName: e.target.value }))}
                        className="mt-2 rounded-sm" />
                    )}
                  </div>
                </div>

                {/* Witnesses */}
                <div>
                  <Label>Witnesses</Label>
                  <Input placeholder="Names of any witnesses (optional)"
                    value={form.witnesses}
                    onChange={e => setForm(f => ({ ...f, witnesses: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>

                {/* Reported by */}
                <div>
                  <Label>Reported By *</Label>
                  <Input placeholder="Name of person completing this form"
                    value={form.reportedBy}
                    onChange={e => setForm(f => ({ ...f, reportedBy: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>
              </>
            )}

            {formSection === "actions" && (
              <>
                {/* Immediate actions */}
                <div>
                  <Label>Immediate Actions Taken</Label>
                  <Textarea placeholder="What immediate steps were taken at the time of the incident?"
                    value={form.immediateActions}
                    onChange={e => setForm(f => ({ ...f, immediateActions: e.target.value }))}
                    className="mt-1 rounded-sm" rows={3} />
                </div>

                {/* Corrective actions */}
                <div>
                  <Label>Corrective / Preventive Actions</Label>
                  <Textarea placeholder="What actions have been or will be taken to prevent recurrence?"
                    value={form.correctiveActions}
                    onChange={e => setForm(f => ({ ...f, correctiveActions: e.target.value }))}
                    className="mt-1 rounded-sm" rows={3} />
                </div>

                {/* RIDDOR section */}
                <div className="border border-orange-200 bg-orange-50/50 rounded-sm p-3 space-y-3">
                  <p className="text-xs font-semibold text-orange-800 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" /> RIDDOR Reporting
                  </p>
                  <div className="flex items-start gap-3">
                    <Checkbox id="riddor" checked={form.riddorReportable}
                      onCheckedChange={v => setForm(f => ({ ...f, riddorReportable: !!v, reportedToHse: !!v ? f.reportedToHse : false }))}
                      className="mt-0.5" />
                    <div>
                      <Label htmlFor="riddor" className="cursor-pointer">This incident is RIDDOR reportable</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Deaths, specified injuries, over-7-day incapacitation, occupational diseases, dangerous occurrences
                      </p>
                    </div>
                  </div>

                  {form.riddorReportable && (
                    <>
                      <div className="flex items-start gap-3">
                        <Checkbox id="hseReported" checked={form.reportedToHse}
                          onCheckedChange={v => setForm(f => ({ ...f, reportedToHse: !!v }))}
                          className="mt-0.5" />
                        <Label htmlFor="hseReported" className="cursor-pointer">Reported to HSE (riddor.hse.gov.uk)</Label>
                      </div>

                      {form.reportedToHse && (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label>HSE Reference Number</Label>
                            <Input placeholder="e.g. RIDDOR-2024-12345"
                              value={form.hseReference}
                              onChange={e => setForm(f => ({ ...f, hseReference: e.target.value }))}
                              className="mt-1 rounded-sm" />
                          </div>
                          <div>
                            <Label>Date Reported to HSE</Label>
                            <Input type="date" value={form.hseReportDate}
                              onChange={e => setForm(f => ({ ...f, hseReportDate: e.target.value }))}
                              className="mt-1 rounded-sm" />
                          </div>
                        </div>
                      )}

                      {!form.reportedToHse && (
                        <div className="flex items-start gap-2 text-xs text-orange-800 bg-orange-100 rounded-sm px-3 py-2">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>
                            This incident must be reported to the HSE. Most reports must be submitted within 10 days (15 days for over-7-day injuries). Report at <strong>riddor.hse.gov.uk</strong> or call 0345 300 9923.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving} className="rounded-sm">Cancel</Button>
            {formSection === "details" && (
              <Button onClick={() => setFormSection("actions")} variant="outline" className="rounded-sm">
                Next: Actions & RIDDOR →
              </Button>
            )}
            <Button onClick={handleSave} disabled={saving} className="rounded-sm">
              {saving ? "Saving…" : editItem ? "Save Changes" : "Log Incident"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete incident record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the incident record. This cannot be undone. Ensure you have a physical copy if required for compliance purposes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-sm bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </AppLayout>
  );
}
