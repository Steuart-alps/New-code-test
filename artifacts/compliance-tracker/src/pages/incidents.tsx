import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditLog } from "@/components/audit-log";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { apiFetch as sharedApiFetch } from "@/lib/api";
import { PickOrTypeSelect, usePeopleAndContractors } from "@/components/pick-or-type-select";
import { CorrectiveActionUpdate } from "@/components/corrective-action-update";
import { useFormOptions, pickOptions } from "@/hooks/use-form-options";
import { FormOptionsEditor } from "@/components/form-options-editor";
import { DocumentField, downloadRegisterDocument, type DocumentValue } from "@/components/register-shared";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import {
  useGetIncidentConfig,
  getGetIncidentConfigQueryKey,
  useUpdateIncidentConfig,
} from "@workspace/api-client-react";
import {
  AlertOctagon, Plus, AlertTriangle, CheckCircle2, Clock,
  Pencil, Lock, Search, Filter, FileWarning,
  ShieldAlert, UserX, Activity, Settings, Printer, FileText, Download, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { printHtmlDocument } from "@/lib/download";
import { StringListEditor } from "@/components/string-list-editor";
import { useSayItFill } from "@/lib/say-it-fill";
import { sortByLabel } from "@/lib/sort-options";
import { localDate } from "@/lib/voice-log";
import { useManagedBy } from "@/components/managed-by-badge";
import { takeLinkParams } from "@/lib/deep-link";

// ─── Types ────────────────────────────────────────────────────────────────────

const INCIDENT_TYPES = ["accident", "near_miss", "dangerous_occurrence", "occupational_disease"] as const;
const SEVERITIES = ["minor", "moderate", "serious", "fatal"] as const;
const STATUSES = ["open", "under_investigation", "closed"] as const;
const EMPLOYMENT_TYPES = ["employee", "contractor", "visitor", "member_of_public"] as const;

type IncidentType = (typeof INCIDENT_TYPES)[number];
type Severity = (typeof SEVERITIES)[number];
type Status = (typeof STATUSES)[number];
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

// RIDDOR 2013 categories. Over-3-day injuries are recorded, not reported.
const RIDDOR_CATEGORY_LABELS = {
  death:                  "Death",
  specified_injury:       "Specified injury",
  over_7_day_injury:      "Over-7-day injury",
  non_worker_hospital:    "Non-worker taken to hospital",
  occupational_disease:   "Occupational disease",
  dangerous_occurrence:   "Dangerous occurrence",
  over_3_day_record_only: "Over-3-day injury (record only)",
} as const;
type RiddorCategory = keyof typeof RIDDOR_CATEGORY_LABELS;
interface RiddorDeadline {
  category: RiddorCategory;
  reportBy: string | null;
  notifyWithoutDelay: boolean;
  state: "reported" | "overdue" | "due" | "on_diagnosis" | "record_only";
}
// Report windows in days from the incident (RIDDOR 2013); mirrors the API.
const RIDDOR_REPORT_DAYS: Partial<Record<RiddorCategory, number>> = {
  death: 10, specified_injury: 10, non_worker_hospital: 10, dangerous_occurrence: 10, over_7_day_injury: 15,
};
const RIDDOR_NOTIFY_NOW = new Set<RiddorCategory>(["death", "specified_injury", "non_worker_hospital", "dangerous_occurrence", "occupational_disease"]);

/** Plain-English reporting deadline for a category and incident date. */
function riddorDeadlineText(category: RiddorCategory, incidentDate: string): string {
  if (category === "over_3_day_record_only") return "Record in your accident book; not reportable to the HSE.";
  if (category === "occupational_disease") return "Report without delay once you receive a written diagnosis.";
  const days = RIDDOR_REPORT_DAYS[category]!;
  const reportBy = incidentDate ? new Date(`${incidentDate.slice(0, 10)}T00:00:00Z`) : null;
  reportBy?.setUTCDate(reportBy.getUTCDate() + days);
  const by = reportBy ? ` (by ${reportBy.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })})` : "";
  return `${RIDDOR_NOTIFY_NOW.has(category) ? "Notify the HSE without delay, and report" : "Report"} within ${days} days of the incident${by}.`;
}

// HSE's "How to make a RIDDOR report" page (online forms and phone line).
const HSE_RIDDOR_REPORT_URL = "https://www.hse.gov.uk/riddor/report.htm";

/** Link to the HSE RIDDOR reporting page, opening in a new tab. */
function HseRiddorLink({ className, children = "Report on the HSE RIDDOR website" }: { className?: string; children?: ReactNode }) {
  return (
    <a href={HSE_RIDDOR_REPORT_URL} target="_blank" rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-1 font-medium underline underline-offset-2", className)}
      data-testid="link-hse-riddor">
      {children} <ExternalLink className="w-3 h-3" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** "Speak to your adviser first" note with the HSE link, shown wherever RIDDOR is decided. */
function RiddorAdviserNote({ className }: { className?: string }) {
  const { data: managedBy } = useManagedBy();
  const adviser = managedBy?.practiceName
    ? <>your health and safety adviser at <strong>{managedBy.practiceName}</strong></>
    : "your health and safety adviser";
  return (
    <div className={cn("text-xs space-y-1", className)} data-testid="riddor-adviser-note">
      <p>
        Not sure whether this needs reporting? We recommend you speak to {adviser} before
        you report. They can help you decide and fill in the HSE form.
      </p>
      <HseRiddorLink />
    </div>
  );
}

interface Incident {
  id: number;
  clientId: number;
  siteId: number | null;
  incidentType: string;
  severity: string;
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
  riddorCategory: RiddorCategory | null;
  /** Computed by the API from the category and incident date. */
  riddorDeadline: RiddorDeadline | null;
  reportedToHse: boolean;
  hseReference: string | null;
  hseReportDate: string | null;
  immediateActions: string | null;
  investigationFindings: string | null;
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
interface RiddorHistoryEvent {
  id: number; eventType: "decision" | "submission"; riddorReportable: boolean; riddorCategory: RiddorCategory | null;
  reportedToHse: boolean; rationale: string | null; hseReference: string | null;
  hseReportDate: string | null; decisionMaker: string | null; decisionAt: string;
  submittedAt: string | null; submissionEvidence: string | null;
  receiptFileName: string | null; receiptContentType: string | null;
  receiptSource: "upload" | "incident_attachment" | null;
  createdAt: string; actorName: string | null; actorEmail: string | null;
}
interface IncidentAttachment { id: number; caption: string | null; created_at: string; }
interface IncidentAction {
  id: number; title: string; status: string; ownerName: string;
  correctiveAction: string; evidenceReference: string | null;
  verificationNotes: string | null; verifiedAt: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Turn an unknown option value (e.g. a client's custom entry) into a readable
// label: snake_case → Title Case, leaving already-cased strings untouched.
function humanize(value: string): string {
  if (/[A-Z ]/.test(value) && !value.includes("_")) return value;
  return value.split("_").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

const TYPE_LABELS: Record<string, string> = {
  accident:              "Accident",
  near_miss:             "Near Miss",
  dangerous_occurrence:  "Dangerous Occurrence",
  occupational_disease:  "Occupational Disease",
};
const typeLabel = (v: string) => TYPE_LABELS[v] ?? humanize(v);

const SEVERITY_LABELS: Record<string, string> = {
  minor:    "Minor",
  moderate: "Moderate",
  serious:  "Serious",
  fatal:    "Fatal",
};
const severityLabel = (v: string) => SEVERITY_LABELS[v] ?? humanize(v);

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

const DEFAULT_BADGE_COLOR = "bg-slate-50 text-slate-600 border-slate-200";

const TYPE_COLORS: Record<string, string> = {
  accident:             "bg-rose-50 text-rose-700 border-rose-200",
  near_miss:            "bg-amber-50 text-amber-700 border-amber-200",
  dangerous_occurrence: "bg-orange-50 text-orange-700 border-orange-200",
  occupational_disease: "bg-sky-50 text-sky-700 border-sky-200",
};
const typeColor = (v: string) => TYPE_COLORS[v] ?? DEFAULT_BADGE_COLOR;

const SEVERITY_COLORS: Record<string, string> = {
  minor:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  moderate: "bg-amber-50 text-amber-700 border-amber-200",
  serious:  "bg-orange-50 text-orange-700 border-orange-200",
  fatal:    "bg-rose-50 text-rose-700 border-rose-200",
};
const severityColor = (v: string) => SEVERITY_COLORS[v] ?? DEFAULT_BADGE_COLOR;

const STATUS_COLORS: Record<Status, string> = {
  open:                "bg-rose-50 text-rose-700 border-rose-200",
  under_investigation: "bg-amber-50 text-amber-700 border-amber-200",
  closed:              "bg-slate-50 text-slate-500 border-slate-200",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Route every request through the shared apiFetch and attach the consultant's
// currently-selected clientId to BOTH reads and writes, so a consultant viewing
// another client never reads or writes the wrong tenant. Matches the pattern
// used by the other module pages (e.g. PremisesTrack).
function useIncidentsApi() {
  const { activeClientId } = useAuth();
  return async function call<T = any>(path: string, opts?: RequestInit): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const suffix = activeClientId ? `${sep}clientId=${activeClientId}` : "";
    const res = await sharedApiFetch(`${path}${suffix}`, opts);
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error((b as any)?.error ?? `${res.status}`); }
    if (res.status === 204) return null as T;
    return res.json();
  };
}

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
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
          <TabsList className="shrink-0 w-full grid grid-cols-4">
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
            <TabsTrigger value="locations">Locations</TabsTrigger>
            <TabsTrigger value="depts">Departments</TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-incidents-audit">Audit log</TabsTrigger>
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
          <TabsContent value="audit" className="flex-1 overflow-y-auto pt-4 px-1"><AuditLog module="incidents" /></TabsContent>
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
  incidentType: "" as string,
  severity: "" as string,
  status: "open" as Status,
  // Today on this device (not UTC, which is yesterday after midnight in summer).
  incidentDate: localDate(),
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
  riddorCategory: "" as RiddorCategory | "",
  reportedToHse: false,
  hseReference: "",
  hseReportDate: "",
  submittedAt: "",
  submissionEvidence: "",
  // HSE receipt for the submission being recorded: a new upload, or one of
  // the incident's attachments (receiptAttachmentId, editing only).
  receiptUpload: { objectPath: null, fileName: null } as DocumentValue,
  receiptAttachmentId: "",
  riddorRationale: "",
  immediateActions: "",
  investigationFindings: "",
  correctiveActions: "",
  reportedBy: "",
  siteId: "",
});

// ─── Main page ────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { toast } = useToast();
  const { activeClientId, hasService, client, user } = useAuth();
  const canAdmin = useCanAdmin();
  const clientApi = useActiveClientApi();
  // Managers read injury details, so they attach and download HSE receipts.
  const isManager = user?.role === "client_admin" || user?.role === "consultant" || user?.role === "client_manager"
    || (user?.role === "client_staff" && user.isDepartmentManager === true);
  const qc = useQueryClient();
  const apiFetch = useIncidentsApi();
  const hasIncidentTrack = hasService("incidenttrack");

  const [filterStatus, setFilterStatus] = useState<Status | "all">("all");
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterSite, setFilterSite] = useState("all");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterRiddor, setFilterRiddor] = useState(false);
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<Incident | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyIncident, setHistoryIncident] = useState<Incident | null>(null);
  const [actionDraft, setActionDraft] = useState({ title: "", ownerName: "", correctiveAction: "" });
  const [editingActionId, setEditingActionId] = useState<number | null>(null);
  const canRecordActions = user?.role !== "client_viewer";
  const actionOwnerGroups = usePeopleAndContractors(canAdmin && !!historyIncident);
  const [savingAction, setSavingAction] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [formSection, setFormSection] = useState<"details" | "actions">("details");

  const { data: incidentConfig, isFetched: incidentConfigFetched } = useGetIncidentConfig();
  const { data: formOptions } = useFormOptions();
  const incidentTypeOptions = pickOptions(formOptions, "incident_types");
  const severityOptions: readonly string[] = SEVERITIES;
  // When editing a record whose stored value has since been removed from the
  // effective list, keep that value selectable so other fields can be edited
  // without being forced to change the type.
  const withCurrent = (opts: readonly string[], current: string | undefined) =>
    current && !opts.includes(current) ? [...opts, current] : [...opts];
  const formTypeOptions = withCurrent(incidentTypeOptions, editItem ? form.incidentType : undefined);
  const formSeverityOptions = withCurrent(severityOptions, editItem ? form.severity : undefined);

  useEffect(() => {
    if (!showDialog || editItem) return;
    setForm(current => ({
      ...current,
      incidentType: incidentTypeOptions.includes(current.incidentType)
        ? current.incidentType
        : (incidentTypeOptions[0] ?? ""),
      severity: severityOptions.includes(current.severity)
        ? current.severity
        : (severityOptions[0] ?? ""),
    }));
  }, [showDialog, editItem, incidentTypeOptions, severityOptions]);

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
  const { data: riddorHistory = [], isLoading: isLoadingHistory } = useQuery<RiddorHistoryEvent[]>({
    queryKey: ["incident-riddor-history", historyIncident?.id, activeClientId],
    queryFn: () => apiFetch(`/incidents/${historyIncident!.id}/riddor-history`),
    enabled: !!historyIncident && !!activeClientId,
  });
  const { data: linkedActions = [], isLoading: isLoadingActions } = useQuery<IncidentAction[]>({
    queryKey: ["incident-actions", historyIncident?.id, activeClientId],
    queryFn: () => apiFetch(`/incidents/${historyIncident!.id}/actions`),
    enabled: !!historyIncident && !!activeClientId,
    refetchOnWindowFocus: true,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let rows = incidents;
    if (filterStatus !== "all") rows = rows.filter(r => r.status === filterStatus);
    if (filterSeverity !== "all") rows = rows.filter(r => r.severity === filterSeverity);
    if (filterType !== "all") rows = rows.filter(r => r.incidentType === filterType);
    if (filterSite !== "all") rows = rows.filter(r => String(r.siteId) === filterSite);
    if (filterFrom) rows = rows.filter(r => r.incidentDate.slice(0, 10) >= filterFrom);
    if (filterTo) rows = rows.filter(r => r.incidentDate.slice(0, 10) <= filterTo);
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
  }, [incidents, filterStatus, filterSeverity, filterType, filterSite, filterFrom, filterTo, filterRiddor, search]);

  const riddorOutstanding = summary?.riddorOutstanding ?? 0;
  const riddorOverdue = incidents.filter(r => r.riddorDeadline?.state === "overdue").length;

  // ── Export register (for HSE audits / insurance) ─────────────────────────────

  const siteName = (id: number | null) =>
    id == null ? "All sites" : sites.find(s => s.id === id)?.name ?? `Site #${id}`;

  const esc = (s: string | null | undefined) =>
    (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const handleExportRegister = () => {
    if (filterFrom && filterTo && filterFrom > filterTo) {
      toast({
        title: "Invalid date range",
        description: "The from date must be on or before the to date.",
        variant: "destructive",
      });
      return;
    }
    const rows = [...filtered].sort((a, b) => (a.incidentDate < b.incidentDate ? 1 : -1));
    const filteredRiddorOutstanding = rows.filter(r => r.riddorReportable && !r.reportedToHse).length;
    const selectedSite = filterSite === "all" ? "All sites" : siteName(Number(filterSite));
    const dateRange = `${filterFrom ? fmt(filterFrom) : "Earliest record"} to ${filterTo ? fmt(filterTo) : "Latest record"}`;
    const filterParts = [
      filterStatus !== "all" ? `Status: ${STATUS_LABELS[filterStatus]}` : "",
      filterSeverity !== "all" ? `Severity: ${severityLabel(filterSeverity)}` : "",
      filterType !== "all" ? `Type: ${typeLabel(filterType)}` : "",
      filterRiddor ? "RIDDOR only" : "",
      search.trim() ? `Search: "${search.trim()}"` : "",
    ].filter(Boolean).join(" · ");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Incident Register</title>
<style>
  body { font-family: Georgia, serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-top: 10px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0ede2; font-weight: bold; }
  .empty { font-size: 11px; color: #777; font-style: italic; }
  .riddor { color: #b91c1c; font-weight: bold; }
  .footer { margin-top: 12px; padding-top: 8px; border-top: 1px solid #999; font-size: 10.5px; }
  @page { size: landscape; margin: 10mm; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>Incident &amp; Accident Register</h1>
<div class="meta"><strong>Organisation:</strong> ${esc(client?.name ?? "Organisation")} · <strong>Site:</strong> ${esc(selectedSite)}</div>
<div class="meta"><strong>Date range:</strong> ${esc(dateRange)} · Generated ${esc(fmt(new Date().toISOString()))}</div>
<div class="meta">${filterParts ? `Filters applied — ${esc(filterParts)} · ` : ""}${rows.length} record${rows.length !== 1 ? "s" : ""}</div>
${rows.length === 0 ? `<p class="empty">No incidents match the current filters.</p>` : `<table>
<tr><th>Date</th><th>Type</th><th>Severity</th><th>Person</th><th>Location</th><th>RIDDOR status</th></tr>
${rows.map(r => `<tr>
  <td>${fmt(r.incidentDate)}${r.incidentTime ? ` ${esc(r.incidentTime)}` : ""}</td>
  <td>${esc(typeLabel(r.incidentType))}</td>
  <td>${esc(severityLabel(r.severity))}</td>
  <td>${esc(r.involvedName)}${r.involvedJobTitle ? `<br><span style="color:#666">${esc(r.involvedJobTitle)}</span>` : ""}<br><span style="color:#666">${esc(EMPLOYMENT_LABELS[r.involvedEmploymentType] ?? r.involvedEmploymentType)}</span></td>
  <td>${esc(r.location)}${r.siteId ? `<br><span style="color:#666">${esc(siteName(r.siteId))}</span>` : ""}</td>
  <td>${r.riddorReportable ? `<span class="riddor">Yes${r.reportedToHse ? ` (reported${r.hseReference ? ` ${esc(r.hseReference)}` : ""})` : " — outstanding"}</span>` : "No"}</td>
</tr>`).join("")}
</table>`}
<div class="footer"><strong>RIDDOR outstanding:</strong> ${filteredRiddorOutstanding === 0
  ? "None in the exported records."
  : `${filteredRiddorOutstanding} item${filteredRiddorOutstanding === 1 ? "" : "s"} require${filteredRiddorOutstanding === 1 ? "s" : ""} HSE reporting.`}</div>
</body></html>`;
    printHtmlDocument(html);
  };

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["incidents"] });
    qc.invalidateQueries({ queryKey: ["incidents-summary"] });
  };


  // ── Dialog ─────────────────────────────────────────────────────────────────

  function openAdd(spoken?: Partial<ReturnType<typeof emptyForm>>) {
    setEditItem(null);
    const f = emptyForm();
    // The person logging it, unless the template names a default reporter.
    f.reportedBy = user?.name ?? "";
    f.incidentType = incidentTypeOptions[0] ?? "";
    f.severity = severityOptions[0] ?? "";
    if (incidentConfig?.incident_default_reporter) f.reportedBy = incidentConfig.incident_default_reporter;
    setForm({ ...f, ...spoken });
    setFormSection("details");
    setShowDialog(true);
  }

  // Say it: what happened and where opens a new incident with them filled in.
  useSayItFill(["incident"], fill => {
    const said = (key: string) => (typeof fill.values[key] === "string" ? fill.values[key] as string : "");
    openAdd({
      description: said("description") || fill.text.trim(),
      location: said("location"),
      ...(fill.siteId ? { siteId: String(fill.siteId) } : {}),
    });
  }, incidentConfigFetched);

  // The "Report an accident or incident" QR label opens a new report, once
  // the incident settings (the default reporter) have loaded.
  const reportFromLink = useRef<boolean | null>(null);
  useEffect(() => {
    if (reportFromLink.current === null) reportFromLink.current = takeLinkParams(["report"] as const)?.report === "1";
    if (!reportFromLink.current || !hasIncidentTrack || !incidentConfigFetched) return;
    reportFromLink.current = false;
    openAdd();
  }, [hasIncidentTrack, incidentConfigFetched]);

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
      riddorCategory: r.riddorCategory ?? "",
      reportedToHse: r.reportedToHse,
      hseReference: r.hseReference ?? "",
      hseReportDate: r.hseReportDate?.slice(0, 10) ?? "",
      submittedAt: "",
      submissionEvidence: "",
      receiptUpload: { objectPath: null, fileName: null },
      receiptAttachmentId: "",
      riddorRationale: "",
      immediateActions: r.immediateActions ?? "",
      investigationFindings: r.investigationFindings ?? "",
      correctiveActions: r.correctiveActions ?? "",
      reportedBy: r.reportedBy,
      siteId: r.siteId ? String(r.siteId) : "",
    });
    setFormSection("details");
    setShowDialog(true);
  }

  // This save records a new or corrected HSE submission (a new history event).
  const submissionChanged = form.reportedToHse &&
    (!editItem?.reportedToHse || form.hseReference.trim() !== (editItem.hseReference ?? "") ||
      form.hseReportDate !== (editItem.hseReportDate?.slice(0, 10) ?? ""));
  const receiptChosen = isManager && (!!form.receiptUpload.objectPath || !!form.receiptAttachmentId);
  const { data: incidentAttachments = [] } = useQuery<IncidentAttachment[]>({
    queryKey: ["incident-attachments", editItem?.id, activeClientId],
    queryFn: () => apiFetch(`/photos?entityType=incident&entityId=${editItem!.id}`),
    enabled: showDialog && !!editItem && isManager && submissionChanged,
  });

  async function downloadReceipt(event: RiddorHistoryEvent) {
    if (!historyIncident) return;
    try {
      await downloadRegisterDocument(clientApi, `/incidents/${historyIncident.id}/riddor-history/${event.id}/receipt`,
        event.receiptFileName ?? "hse-receipt");
    } catch (e: any) {
      toast({ title: "Could not download the receipt", description: e.message, variant: "destructive" });
    }
  }

  async function handleSave() {
    if (!form.incidentDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    if (!form.location.trim()) { toast({ title: "Location is required", variant: "destructive" }); return; }
    if (!form.involvedName.trim()) { toast({ title: "Person involved is required", variant: "destructive" }); return; }
    if (!form.description.trim()) { toast({ title: "Description is required", variant: "destructive" }); return; }
    if (!form.reportedBy.trim()) { toast({ title: "Reported by is required", variant: "destructive" }); return; }
    const assessmentChanged = !editItem || form.riddorReportable !== editItem.riddorReportable ||
      (form.riddorCategory || null) !== (editItem.riddorCategory ?? null) ||
      form.reportedToHse !== editItem.reportedToHse ||
      form.hseReference.trim() !== (editItem.hseReference ?? "") ||
      form.hseReportDate !== (editItem.hseReportDate?.slice(0, 10) ?? "");
    if (assessmentChanged && !form.riddorRationale.trim()) {
      setFormSection("actions");
      toast({ title: "Explain the RIDDOR decision", variant: "destructive" });
      return;
    }
    if (submissionChanged &&
      (!form.hseReference.trim() || !form.hseReportDate || !form.submittedAt ||
        (!form.submissionEvidence.trim() && !receiptChosen))) {
      setFormSection("actions");
      toast({ title: "Record the HSE reference, date, time and submission evidence or receipt", variant: "destructive" });
      return;
    }
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
        riddorCategory: form.riddorCategory || null,
        reportedToHse: form.reportedToHse,
        hseReference: form.hseReference.trim() || null,
        hseReportDate: form.hseReportDate || null,
        // Empty audit fields are omitted while editing: they are append-only,
        // not a request to overwrite an earlier decision or submission.
        submittedAt: form.submittedAt ? new Date(form.submittedAt).toISOString() : undefined,
        submissionEvidence: form.submissionEvidence.trim() || (editItem ? undefined : null),
        // Bound to the submission event this save records; never changed later.
        submissionReceipt: !submissionChanged || !isManager ? undefined
          : form.receiptUpload.objectPath
            ? { objectPath: form.receiptUpload.objectPath, fileName: form.receiptUpload.fileName ?? "HSE receipt" }
            : form.receiptAttachmentId ? { attachmentId: Number(form.receiptAttachmentId) } : undefined,
        riddorRationale: form.riddorRationale.trim() || undefined,
        immediateActions: form.immediateActions.trim() || null,
        investigationFindings: form.investigationFindings.trim() || null,
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

  async function createIncidentAction() {
    if (!historyIncident || !actionDraft.title.trim() || !actionDraft.ownerName.trim() || !actionDraft.correctiveAction.trim()) {
      toast({ title: "Title, owner and corrective action are required", variant: "destructive" });
      return;
    }
    setSavingAction(true);
    try {
      await apiFetch("/compliance-hub/actions", {
        method: "POST",
        body: JSON.stringify({
          sourceTrack: "IncidentTrack", sourceRecordId: String(historyIncident.id),
          title: actionDraft.title.trim(), ownerName: actionDraft.ownerName.trim(),
          correctiveAction: actionDraft.correctiveAction.trim(),
        }),
      });
      setActionDraft({ title: "", ownerName: "", correctiveAction: "" });
      await qc.invalidateQueries({ queryKey: ["incident-actions", historyIncident.id, activeClientId] });
      toast({ title: "Corrective action linked to incident" });
    } catch (e: any) {
      toast({ title: "Could not link action", description: e.message, variant: "destructive" });
    } finally {
      setSavingAction(false);
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
                <h2 className="text-2xl font-display font-bold text-foreground mb-2">IncidentTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital accident and incident logbook — record investigation, reportability decisions, HSE references and follow-up actions. Confirm RIDDOR duties for each event.
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
          <Button variant="outline" size="sm" className="gap-2 rounded-sm"
            onClick={handleExportRegister}
            title="Print or save the incident register for HSE audits / insurance">
            <Printer className="w-4 h-4" /> Export PDF
          </Button>
          {canAdmin && <IncidentConfigDialog />}
          <FormOptionsEditor
            optionKey="incident_types"
            title="Incident types"
            triggerLabel="Customise types"
            labelFor={typeLabel}
          />
          <Button onClick={() => openAdd()} className="gap-2 rounded-sm">
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
            {riddorOverdue > 0
              ? <><strong>{riddorOverdue} {riddorOverdue === 1 ? "is" : "are"} past the RIDDOR reporting deadline.</strong> Report now.</>
              : "RIDDOR reports must be submitted within the statutory timeframe."}{" "}
            <HseRiddorLink className="text-rose-900" />
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
          <Select value={filterSite} onValueChange={setFilterSite}>
            <SelectTrigger aria-label="Filter incidents by site" className="w-44 rounded-sm">
              <SelectValue placeholder="All sites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterStatus} onValueChange={v => setFilterStatus(v as Status | "all")}>
          <SelectTrigger aria-label="Filter incidents by status" className="w-44 rounded-sm">
            <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterSeverity} onValueChange={v => setFilterSeverity(v)}>
          <SelectTrigger aria-label="Filter incidents by severity" className="w-36 rounded-sm">
            <SelectValue placeholder="All severities" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {severityOptions.map(s => <SelectItem key={s} value={s}>{severityLabel(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={v => setFilterType(v)}>
          <SelectTrigger aria-label="Filter incidents by type" className="w-48 rounded-sm">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {sortByLabel(incidentTypeOptions, typeLabel).map(t => <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          type="date"
          aria-label="Incidents from date"
          value={filterFrom}
          onChange={e => setFilterFrom(e.target.value)}
          className="w-40 rounded-sm"
        />
        <Input
          type="date"
          aria-label="Incidents to date"
          value={filterTo}
          onChange={e => setFilterTo(e.target.value)}
          className="w-40 rounded-sm"
        />
        <button
          type="button"
          aria-pressed={filterRiddor}
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
            <Button onClick={() => openAdd()} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
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
                      <Badge variant="outline" className={cn("text-xs w-fit", typeColor(r.incidentType))}>
                        {typeLabel(r.incidentType)}
                      </Badge>
                      <Badge variant="outline" className={cn("text-xs w-fit", severityColor(r.severity))}>
                        {severityLabel(r.severity)}
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
                        <span className="inline-flex flex-col text-xs text-rose-700 font-medium">
                          <span className="inline-flex items-center gap-1">
                            <ShieldAlert className="w-3.5 h-3.5" />
                            {r.riddorDeadline?.state === "overdue" ? "Overdue" : "Outstanding"}
                          </span>
                          {r.riddorDeadline?.reportBy && (
                            <span className={cn("font-normal", r.riddorDeadline.state === "overdue" ? "text-rose-700" : "text-muted-foreground")}>
                              Report by {fmt(r.riddorDeadline.reportBy)}
                            </span>
                          )}
                          {r.riddorDeadline?.state === "on_diagnosis" && (
                            <span className="font-normal text-muted-foreground">Report on diagnosis</span>
                          )}
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <CheckPhotoUploader entityType="incident" entityId={r.id} compact />
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" title="View RIDDOR history" onClick={() => setHistoryIncident(r)}>
                        <Activity className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={() => openEdit(r)}>
                        <Pencil className="w-3.5 h-3.5" />
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
          Most reports must be submitted within 10 days (15 days for over-7-day injuries). Report online through the HSE website; deaths and specified injuries can also be reported by phone on 0345 300 9923.
        </p>
        <RiddorAdviserNote className="mt-2" />
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={showDialog} onOpenChange={v => { if (!saving) setShowDialog(v); }}>
        <DialogContent className="max-w-2xl rounded-sm max-h-[90vh] overflow-y-auto">
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
                    <Select value={form.incidentType} onValueChange={v => setForm(f => ({ ...f, incidentType: v }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {sortByLabel(formTypeOptions, typeLabel).map(t => <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Severity *</Label>
                    <Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {formSeverityOptions.map(s => <SelectItem key={s} value={s}>{severityLabel(s)}</SelectItem>)}
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
                      <Select value={form.siteId || "none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "none" ? "" : v }))}>
                        <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No specific site</SelectItem>
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
                        {sortByLabel(EMPLOYMENT_TYPES, t => EMPLOYMENT_LABELS[t]).map(t => <SelectItem key={t} value={t}>{EMPLOYMENT_LABELS[t]}</SelectItem>)}
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
                  <Label>Investigation findings</Label>
                  <Textarea placeholder="Findings, contributing factors and conclusions"
                    value={form.investigationFindings}
                    onChange={e => setForm(f => ({ ...f, investigationFindings: e.target.value }))}
                    className="mt-1 rounded-sm" rows={3} />
                </div>
                <div>
                  <Label>Corrective / Preventive Actions</Label>
                  <Textarea placeholder="What actions have been or will be taken to prevent recurrence?"
                    value={form.correctiveActions}
                    onChange={e => setForm(f => ({ ...f, correctiveActions: e.target.value }))}
                    className="mt-1 rounded-sm" rows={3} />
                  <p className="mt-1 text-xs text-muted-foreground">This is a working note, not verified closure. Link follow-up actions from the incident history after saving.</p>
                </div>

                {/* RIDDOR section */}
                <div className="border border-orange-200 bg-orange-50/50 rounded-sm p-3 space-y-3">
                  <p className="text-xs font-semibold text-orange-800 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" /> RIDDOR Reporting
                  </p>
                  <RiddorAdviserNote className="text-orange-900" />
                  <div className="flex items-start gap-3">
                    <Checkbox id="riddor" checked={form.riddorReportable}
                      onCheckedChange={v => setForm(f => ({
                        ...f, riddorReportable: !!v, reportedToHse: !!v ? f.reportedToHse : false,
                        // Drop a category that no longer matches the reportability decision.
                        riddorCategory: f.riddorCategory && (f.riddorCategory !== "over_3_day_record_only") !== !!v ? "" : f.riddorCategory,
                        hseReference: !!v ? f.hseReference : "", hseReportDate: !!v ? f.hseReportDate : "",
                      }))}
                      className="mt-0.5" />
                    <div>
                      <Label htmlFor="riddor" className="cursor-pointer">This incident is RIDDOR reportable</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Deaths, specified injuries, over-7-day incapacitation, occupational diseases, dangerous occurrences
                      </p>
                    </div>
                  </div>
                  <div>
                    <Label>RIDDOR category <span className="text-muted-foreground text-xs">optional</span></Label>
                    <Select
                      value={form.riddorCategory || "none"}
                      onValueChange={v => setForm(f => {
                        const riddorCategory = v === "none" ? "" : v as RiddorCategory;
                        // A category decides reportability; keep the tick box consistent with it.
                        if (!riddorCategory) return { ...f, riddorCategory };
                        const reportable = riddorCategory !== "over_3_day_record_only";
                        return {
                          ...f, riddorCategory, riddorReportable: reportable,
                          reportedToHse: reportable ? f.reportedToHse : false,
                          hseReference: reportable ? f.hseReference : "", hseReportDate: reportable ? f.hseReportDate : "",
                        };
                      })}
                    >
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Not categorised" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not categorised</SelectItem>
                        {(Object.keys(RIDDOR_CATEGORY_LABELS) as RiddorCategory[]).map(c => (
                          <SelectItem key={c} value={c}>{RIDDOR_CATEGORY_LABELS[c]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {form.riddorCategory && (
                      <p className="mt-1 text-xs text-orange-800">{riddorDeadlineText(form.riddorCategory, form.incidentDate)}</p>
                    )}
                  </div>
                  <div>
                    <Label>RIDDOR decision rationale *</Label>
                    <Textarea
                      placeholder="Record why this incident is or is not RIDDOR reportable."
                      value={form.riddorRationale}
                      onChange={e => setForm(f => ({ ...f, riddorRationale: e.target.value }))}
                      className="mt-1 rounded-sm" rows={2}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">The decision maker and time are recorded automatically in the immutable audit history.</p>
                  </div>

                  {form.riddorReportable && (
                    <>
                      <div className="flex items-start gap-3">
                        <Checkbox id="hseReported" checked={form.reportedToHse}
                          onCheckedChange={v => setForm(f => ({ ...f, reportedToHse: !!v }))}
                          className="mt-0.5" />
                        <Label htmlFor="hseReported" className="cursor-pointer">Reported to HSE</Label>
                      </div>

                      {form.reportedToHse && (
                        <>
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
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label>Submission time *</Label>
                            <Input type="datetime-local" value={form.submittedAt}
                              onChange={e => setForm(f => ({ ...f, submittedAt: e.target.value }))}
                              className="mt-1 rounded-sm" />
                          </div>
                          <div>
                            <Label>Submission evidence / secure location{receiptChosen ? "" : " *"}</Label>
                            <Input placeholder="Receipt ID, document reference or secure URL"
                              value={form.submissionEvidence}
                              onChange={e => setForm(f => ({ ...f, submissionEvidence: e.target.value }))}
                              className="mt-1 rounded-sm" />
                          </div>
                        </div>
                        {submissionChanged && isManager && (
                          <div className="space-y-2">
                            <DocumentField
                              label="HSE receipt (PDF, JPEG or PNG)"
                              requestUrlPath="/incidents/riddor-receipts/request-upload"
                              value={form.receiptUpload}
                              disabled={saving}
                              onChange={receiptUpload => setForm(f => ({
                                ...f, receiptUpload, receiptAttachmentId: receiptUpload.objectPath ? "" : f.receiptAttachmentId,
                              }))}
                            />
                            {editItem && incidentAttachments.length > 0 && !form.receiptUpload.objectPath && (
                              <div>
                                <Label>Or use one of this incident's attachments</Label>
                                <Select value={form.receiptAttachmentId || "none"}
                                  onValueChange={v => setForm(f => ({ ...f, receiptAttachmentId: v === "none" ? "" : v }))}>
                                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="No attachment" /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">No attachment</SelectItem>
                                    {incidentAttachments.map((a, i) => (
                                      <SelectItem key={a.id} value={String(a.id)}>
                                        {a.caption?.trim() || `Attachment ${i + 1}`} · added {fmtDateTime(a.created_at)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">The receipt is saved with this submission in the history and can't be changed or removed afterwards.</p>
                          </div>
                        )}
                        </>
                      )}

                      {!form.reportedToHse && (
                        <div className="flex items-start gap-2 text-xs text-orange-800 bg-orange-100 rounded-sm px-3 py-2">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>
                            This incident must be reported to the HSE. Most reports must be submitted within 10 days (15 days for over-7-day injuries).{" "}
                            <HseRiddorLink>Report it on the HSE website</HseRiddorLink>{" "}
                            (deaths and specified injuries can also be phoned in on 0345 300 9923).
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

      <Dialog open={historyIncident !== null} onOpenChange={v => { if (!v) setHistoryIncident(null); }}>
        <DialogContent className="max-w-2xl rounded-sm">
          <DialogHeader>
            <DialogTitle>RIDDOR decision & submission history</DialogTitle>
            <DialogDescription>Decision, submission, investigation and follow-up for {historyIncident?.involvedName ?? "this incident"}.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto space-y-3">
            {isLoadingHistory ? <p className="text-sm text-muted-foreground">Loading history…</p> :
              riddorHistory.length === 0 ? <p className="text-sm text-muted-foreground">No RIDDOR decisions recorded.</p> :
              riddorHistory.map(event => (
                <div key={event.id} className="border rounded-sm p-3 text-sm space-y-1">
                  <div className="flex justify-between gap-2 font-medium">
                    <span>{event.eventType === "submission" ? "HSE submission" : "RIDDOR decision"}: {event.riddorReportable ? "Reportable" : "Not reportable"}{event.riddorCategory ? ` · ${RIDDOR_CATEGORY_LABELS[event.riddorCategory]}` : ""}</span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(event.decisionAt)}</span>
                  </div>
                  <p className="text-muted-foreground">{event.reportedToHse ? "Reported to HSE" : "Not reported to HSE"}{event.hseReference ? ` · ${event.hseReference}` : ""}</p>
                  <p className="text-xs text-muted-foreground">Decision by {event.decisionMaker ?? event.actorName ?? event.actorEmail ?? "System"} · {fmtDateTime(event.decisionAt)}</p>
                  {event.rationale && <p>{event.rationale}</p>}
                  {event.submittedAt && <p className="text-xs text-muted-foreground">Submitted {fmtDateTime(event.submittedAt)}{event.submissionEvidence ? ` · Evidence: ${event.submissionEvidence}` : ""}</p>}
                  {event.receiptFileName && (
                    <div className="flex items-center gap-2 text-xs">
                      <FileText className="w-3.5 h-3.5 text-primary shrink-0" aria-hidden="true" />
                      <span className="truncate">HSE receipt: {event.receiptFileName}{event.receiptSource === "incident_attachment" ? " (from incident attachments)" : ""}</span>
                      {isManager ? (
                        <Button type="button" variant="outline" size="sm" className="h-6 text-xs gap-1"
                          onClick={() => downloadReceipt(event)}>
                          <Download className="w-3 h-3" aria-hidden="true" /> Download
                        </Button>
                      ) : <span className="text-muted-foreground">Managers can download it.</span>}
                    </div>
                  )}
                </div>
              ))}
            <div className="border-t pt-3 space-y-2 text-sm">
              <h3 className="font-bold">Investigation & evidence</h3>
              <p>{historyIncident?.investigationFindings || "No investigation findings recorded yet."}</p>
              {historyIncident?.correctiveActions && <p className="text-muted-foreground">Proposed actions: {historyIncident.correctiveActions}</p>}
              {historyIncident && <CheckPhotoUploader entityType="incident" entityId={historyIncident.id} compact />}
              <h3 className="font-bold pt-2">Linked corrective actions</h3>
              {isLoadingActions ? <p>Loading actions…</p> : linkedActions.length === 0 ?
                <p className="text-muted-foreground">No linked corrective actions yet.</p> :
                linkedActions.map(action => (
                  <div key={action.id} className="rounded-sm border p-3 space-y-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="font-medium">{action.title} · {action.status.replaceAll("_", " ")}</p>
                      {canRecordActions && action.status !== "verified" && editingActionId !== action.id && (
                        <Button variant="outline" size="sm" onClick={() => setEditingActionId(action.id)}>Update / verify</Button>
                      )}
                    </div>
                    <p>{action.correctiveAction} · Owner: {action.ownerName}</p>
                    {action.evidenceReference && <p>Evidence: {action.evidenceReference}</p>}
                    {action.verifiedAt && <p className="text-emerald-700">Verified closed {fmtDateTime(action.verifiedAt)}{action.verificationNotes ? ` · ${action.verificationNotes}` : ""}</p>}
                    {editingActionId === action.id && (
                      <CorrectiveActionUpdate action={action} onCancel={() => setEditingActionId(null)} onSaved={async () => {
                        setEditingActionId(null);
                        await qc.invalidateQueries({ queryKey: ["incident-actions", historyIncident?.id, activeClientId] });
                      }} />
                    )}
                  </div>
                ))}
              {canAdmin && <div className="space-y-2 border-t pt-3">
                <h4 className="font-bold">Add a linked action</h4>
                <Input aria-label="Action title" dictation placeholder="Action title" value={actionDraft.title} onChange={e => setActionDraft(d => ({ ...d, title: e.target.value }))} />
                <PickOrTypeSelect value={actionDraft.ownerName} groups={actionOwnerGroups} placeholder="Action owner"
                  otherLabel="Someone else (type the name)" typedPlaceholder="Action owner"
                  onChange={ownerName => setActionDraft(d => ({ ...d, ownerName }))} />
                <Textarea aria-label="Corrective action" placeholder="Corrective action to complete" value={actionDraft.correctiveAction} onChange={e => setActionDraft(d => ({ ...d, correctiveAction: e.target.value }))} />
                <Button size="sm" disabled={savingAction} onClick={createIncidentAction}>Link corrective action</Button>
              </div>}
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </AppLayout>
  );
}
