import { useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Beaker, CalendarClock, Download, FileText, Info, Pencil, Plus, Trash2 } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { CoshhRegisterPanel, type CoshhSubstance } from "@/components/coshh-register-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth, useCanEdit } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ConfirmDelete, DocumentField, SiteFilter, SiteSelect, addMonthsIso, downloadCsv, downloadRegisterDocument,
  ensureOk, fmtDate, todayIso, useRegisterList, useRegisterSites, type DocumentValue,
} from "@/components/register-shared";
import { useSiteFilter } from "@/hooks/use-own-site";

// COSHHTrack (API: /api/coshh-track/*). Substances come from the COSHH
// register (/api/registers/coshh), which COSHHTrack shows as its Substances
// tab; assessments and checks link to them.

const EXPOSURE_ROUTES = [
  { key: "inhalation", label: "Breathing in" },
  { key: "skin", label: "Skin contact" },
  { key: "eyes", label: "Eyes" },
  { key: "ingestion", label: "Swallowing" },
  { key: "injection", label: "Cuts or needles" },
] as const;
const PPE = [
  { key: "gloves", label: "Gloves" },
  { key: "eye_protection", label: "Goggles or safety glasses" },
  { key: "face_shield", label: "Face shield" },
  { key: "respirator", label: "Mask or respirator" },
  { key: "apron_overalls", label: "Apron or overalls" },
  { key: "footwear", label: "Safety footwear" },
] as const;
const CHECK_TYPES = [
  { key: "lev_examination", label: "LEV thorough examination", short: "Extraction (LEV) tests", subject: "Extraction system", subjectHint: "For example: spray booth, welding fume arm, dust extractor", by: "Examiner or company", months: 14 },
  { key: "health_surveillance", label: "Health check", short: "Health checks", subject: "Person checked", subjectHint: "Name of the member of staff", by: "Checked by (e.g. occupational health)", months: 12 },
  { key: "exposure_monitoring", label: "Exposure monitoring", short: "Air monitoring", subject: "Area or task monitored", subjectHint: "For example: kitchen deep clean, workshop", by: "Carried out by", months: 12 },
  { key: "staff_briefing", label: "Staff briefing", short: "Staff briefings", subject: "Person briefed", subjectHint: "Name of the member of staff", by: "Briefed by", months: 12 },
] as const;
type CheckType = (typeof CHECK_TYPES)[number]["key"];
const CHECK_INFO = Object.fromEntries(CHECK_TYPES.map((type) => [type.key, type])) as Record<CheckType, (typeof CHECK_TYPES)[number]>;
const RISK_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
const RISK_STYLE: Record<string, string> = {
  low: "border-emerald-300 bg-emerald-50 text-emerald-700",
  medium: "border-amber-300 bg-amber-50 text-amber-800",
  high: "border-red-300 bg-red-50 text-red-700",
};

type Substance = CoshhSubstance;
const TABS = ["due", "substances", "assessments", "checks"];

interface Assessment {
  id: number;
  siteId: number | null;
  substanceId: number | null;
  task: string;
  whoAtRisk: string | null;
  exposureRoutes: string[];
  howOften: string | null;
  hazardStatements: string | null;
  signalWord: string | null;
  healthEffects: string | null;
  exposureLimits: string | null;
  controls: string | null;
  ppe: string[];
  ppeDetails: string | null;
  riskLevel: "low" | "medium" | "high";
  healthSurveillanceRequired: boolean;
  monitoringRequired: boolean;
  levRequired: boolean;
  storage: string | null;
  spillProcedure: string | null;
  firstAid: string | null;
  disposal: string | null;
  assessor: string | null;
  assessmentDate: string;
  reviewDue: string | null;
  status: "current" | "archived";
  documentObjectPath: string | null;
  documentFileName: string | null;
  notes: string | null;
  draftSource: string | null;
  checkedByName: string | null;
  checkedAt: string | null;
  revision: number;
  signOffDepartments: string[];
  reviewOverdue: boolean;
}

interface Check {
  id: number;
  siteId: number | null;
  assessmentId: number | null;
  checkType: CheckType;
  checkDate: string;
  subject: string | null;
  carriedOutBy: string | null;
  result: "pass" | "fail";
  actionRequired: string | null;
  nextDueDate: string | null;
  reportObjectPath: string | null;
  reportFileName: string | null;
  notes: string | null;
}

interface DueItem {
  kind: string;
  recordId: number;
  assessmentId: number | null;
  label: string;
  siteId: number | null;
  siteName: string | null;
  dueDate: string | null;
  daysUntilDue: number | null;
  status: "overdue" | "due_soon" | "ok" | "missing";
}

interface Status { overdue: number; dueSoon: number; missing: number; dueSoonDays: number; items: DueItem[] }

type AssessmentForm = {
  siteId: string; substanceId: string; task: string; whoAtRisk: string; exposureRoutes: string[]; howOften: string;
  hazardStatements: string; signalWord: string; healthEffects: string; exposureLimits: string; controls: string;
  ppe: string[]; ppeDetails: string; riskLevel: "low" | "medium" | "high";
  healthSurveillanceRequired: boolean; monitoringRequired: boolean; levRequired: boolean;
  storage: string; spillProcedure: string; firstAid: string; disposal: string;
  assessor: string; assessmentDate: string; reviewDue: string; reviewDueTouched: boolean;
  status: "current" | "archived"; notes: string; document: DocumentValue;
  draftSource: string | null; checkedAgainstSds: boolean; signOffDepartments: string[];
};

type CheckForm = {
  siteId: string; assessmentId: string; checkType: CheckType; checkDate: string; subject: string; carriedOutBy: string;
  result: "pass" | "fail"; actionRequired: string; nextDueDate: string; nextDueTouched: boolean; notes: string; document: DocumentValue;
};

const ASSESSMENTS = "/coshh-track/assessments";
const CHECKS = "/coshh-track/checks";
const NONE = "none";

function canWriteAssessments(user: { role?: string; isDepartmentManager?: boolean } | null | undefined) {
  if (!user) return false;
  return user.role === "client_admin" || user.role === "consultant" || user.role === "client_manager"
    || (user.role === "client_staff" && user.isDepartmentManager === true);
}

function DueBadge({ item }: { item: Pick<DueItem, "status" | "dueDate" | "daysUntilDue"> }) {
  const styles = {
    overdue: "border-red-300 bg-red-50 text-red-700",
    due_soon: "border-amber-300 bg-amber-50 text-amber-800",
    ok: "border-emerald-300 bg-emerald-50 text-emerald-700",
    missing: "border-amber-300 bg-amber-50 text-amber-800",
  }[item.status];
  const text = item.status === "missing" ? "Not recorded yet"
    : item.status === "overdue" ? `Overdue (${fmtDate(item.dueDate)})`
    : item.daysUntilDue === 0 ? "Due today"
    : item.status === "due_soon" ? `Due ${fmtDate(item.dueDate)}`
    : `Next ${fmtDate(item.dueDate)}`;
  return <Badge variant="outline" className={cn("text-[11px] whitespace-nowrap", styles)}>{text}</Badge>;
}

function TickList({ legend, options, value, onChange }: {
  legend: string; options: readonly { key: string; label: string }[]; value: string[]; onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {options.map((option) => (
          <label key={option.key} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm cursor-pointer hover:bg-muted/40">
            <Checkbox
              checked={value.includes(option.key)}
              onCheckedChange={(checked) => onChange(checked === true
                ? [...value.filter((key) => key !== option.key), option.key]
                : value.filter((key) => key !== option.key))}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TextField({ id, label, value, onChange, rows = 2, max = 2000, placeholder }: {
  id: string; label: string; value: string; onChange: (value: string) => void; rows?: number; max?: number; placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {rows <= 1
        ? <Input id={id} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <Textarea id={id} rows={rows} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export default function CoshhTrackPage() {
  const { user, activeClientId } = useAuth();
  const canEdit = useCanEdit();
  const canAssess = canWriteAssessments(user);
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sites, siteName } = useRegisterSites();

  const search = useSearch();
  const [tab, setTab] = useState(() => {
    const requested = new URLSearchParams(search).get("tab");
    return requested && TABS.includes(requested) ? requested : "due";
  });
  const [siteFilter, setSiteFilter] = useSiteFilter("all");
  const [checkFilter, setCheckFilter] = useState<"all" | CheckType>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editingAssessment, setEditingAssessment] = useState<Assessment | null>(null);
  const [assessmentForm, setAssessmentForm] = useState<AssessmentForm | null>(null);
  const [editingCheck, setEditingCheck] = useState<Check | null>(null);
  const [checkForm, setCheckForm] = useState<CheckForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "assessment"; item: Assessment } | { kind: "check"; item: Check } | null>(null);

  const siteQuery = siteFilter === "all" ? "" : `?siteId=${siteFilter}`;
  const { data: status } = useQuery<Status>({
    queryKey: ["/api/coshh-track/status", activeClientId, siteFilter],
    queryFn: async () => (await ensureOk(await api(`/coshh-track/status${siteQuery}`), "Could not load what is due")).json(),
  });
  const { data: assessments = [], isLoading: assessmentsLoading, error: assessmentsError } = useRegisterList<Assessment>(ASSESSMENTS);
  const { data: checks = [], isLoading: checksLoading, error: checksError } = useRegisterList<Check>(CHECKS);
  const { data: substances = [] } = useRegisterList<Substance>("/registers/coshh");
  const { data: departments = [] } = useQuery<{ id: number; name: string; siteId?: number | null }[]>({
    queryKey: ["/api/departments", activeClientId],
    queryFn: async () => (await ensureOk(await api("/departments"), "Could not load departments")).json(),
  });
  // Read-and-sign progress, shown on each assessment (the signing is in TrainTrack).
  const { data: signOffs } = useQuery<{ assessments: { id: number; staffTotal: number; signedCount: number }[] }>({
    queryKey: ["/api/coshh-track/sign-offs", activeClientId, "all"],
    queryFn: async () => (await ensureOk(await api("/coshh-track/sign-offs"), "Could not load sign-offs")).json(),
  });
  const signOffById = new Map((signOffs?.assessments ?? []).map((a) => [a.id, a]));

  const substanceName = (id: number | null) => (id == null ? null : substances.find((s) => s.id === id)?.productName ?? "Removed substance");
  const assessmentName = (id: number | null) => (id == null ? null : assessments.find((a) => a.id === id)?.task ?? "Removed assessment");
  const inSite = (siteId: number | null) => siteFilter === "all" || String(siteId) === siteFilter;

  const visibleAssessments = useMemo(() => assessments.filter((a) => inSite(a.siteId) && (showArchived || a.status === "current")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assessments, siteFilter, showArchived]);
  const visibleChecks = useMemo(() => checks.filter((c) => inSite(c.siteId) && (checkFilter === "all" || c.checkType === checkFilter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [checks, siteFilter, checkFilter]);
  const actionItems = (status?.items ?? []).filter((item) => item.status !== "ok");
  const upcoming = (status?.items ?? []).filter((item) => item.status === "ok").slice(0, 10);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/api${ASSESSMENTS}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${CHECKS}`] }),
      queryClient.invalidateQueries({ queryKey: ["/api/coshh-track/status"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/coshh-track/sign-offs"] }),
    ]);
  }

  // ── Assessments ──────────────────────────────────────────────────────────
  function newAssessment(substance?: Substance) {
    const today = todayIso();
    setEditingAssessment(null);
    setAssessmentForm({
      siteId: substance?.siteId != null ? String(substance.siteId) : siteFilter !== "all" ? siteFilter : sites.length === 1 ? String(sites[0].id) : "",
      substanceId: substance ? String(substance.id) : NONE,
      task: "", whoAtRisk: "", exposureRoutes: [], howOften: "", hazardStatements: "", signalWord: NONE,
      healthEffects: "", exposureLimits: "", controls: substance?.controls ?? "", ppe: [], ppeDetails: "", riskLevel: "medium",
      healthSurveillanceRequired: false, monitoringRequired: false, levRequired: false,
      storage: "", spillProcedure: "", firstAid: "", disposal: "", assessor: user?.name ?? "",
      assessmentDate: today, reviewDue: addMonthsIso(today, 12), reviewDueTouched: false,
      status: "current", notes: "", document: { objectPath: null, fileName: null },
      draftSource: null, checkedAgainstSds: false, signOffDepartments: [],
    });
  }

  function editAssessment(item: Assessment) {
    setEditingAssessment(item);
    setAssessmentForm({
      siteId: item.siteId == null ? "" : String(item.siteId),
      substanceId: item.substanceId == null ? NONE : String(item.substanceId),
      task: item.task, whoAtRisk: item.whoAtRisk ?? "", exposureRoutes: [...item.exposureRoutes], howOften: item.howOften ?? "",
      hazardStatements: item.hazardStatements ?? "", signalWord: item.signalWord ?? NONE,
      healthEffects: item.healthEffects ?? "", exposureLimits: item.exposureLimits ?? "", controls: item.controls ?? "",
      ppe: [...item.ppe], ppeDetails: item.ppeDetails ?? "", riskLevel: item.riskLevel,
      healthSurveillanceRequired: item.healthSurveillanceRequired, monitoringRequired: item.monitoringRequired, levRequired: item.levRequired,
      storage: item.storage ?? "", spillProcedure: item.spillProcedure ?? "", firstAid: item.firstAid ?? "", disposal: item.disposal ?? "",
      assessor: item.assessor ?? "", assessmentDate: item.assessmentDate, reviewDue: item.reviewDue ?? "", reviewDueTouched: true,
      status: item.status, notes: item.notes ?? "", document: { objectPath: item.documentObjectPath, fileName: item.documentFileName },
      draftSource: item.draftSource, checkedAgainstSds: false, signOffDepartments: [...(item.signOffDepartments ?? [])],
    });
  }

  async function saveAssessment() {
    const f = assessmentForm;
    if (!f) return;
    if (!f.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    if (!f.task.trim()) { toast({ title: "Describe the task or activity", variant: "destructive" }); return; }
    if (!f.assessmentDate) { toast({ title: "Enter the assessment date", variant: "destructive" }); return; }
    if (f.draftSource === "ai" && !f.checkedAgainstSds) {
      toast({ title: "Tick that you have checked this draft against the safety data sheet", variant: "destructive" });
      return;
    }
    const text = (value: string) => value.trim() || null;
    setSaving(true);
    try {
      await ensureOk(await api(editingAssessment ? `${ASSESSMENTS}/${editingAssessment.id}` : ASSESSMENTS, {
        method: editingAssessment ? "PUT" : "POST",
        body: JSON.stringify({
          siteId: Number(f.siteId),
          substanceId: f.substanceId === NONE ? null : Number(f.substanceId),
          task: f.task, whoAtRisk: text(f.whoAtRisk), exposureRoutes: f.exposureRoutes, howOften: text(f.howOften),
          hazardStatements: text(f.hazardStatements), signalWord: f.signalWord === NONE ? null : f.signalWord,
          healthEffects: text(f.healthEffects), exposureLimits: text(f.exposureLimits), controls: text(f.controls),
          ppe: f.ppe, ppeDetails: text(f.ppeDetails), riskLevel: f.riskLevel,
          healthSurveillanceRequired: f.healthSurveillanceRequired, monitoringRequired: f.monitoringRequired, levRequired: f.levRequired,
          storage: text(f.storage), spillProcedure: text(f.spillProcedure), firstAid: text(f.firstAid), disposal: text(f.disposal),
          assessor: text(f.assessor), assessmentDate: f.assessmentDate, reviewDue: f.reviewDue || null,
          status: f.status, notes: text(f.notes), signOffDepartments: f.signOffDepartments,
          objectPath: f.document.objectPath, fileName: f.document.fileName,
          ...(f.draftSource === "ai" ? { draftSource: "ai", checkedAgainstSds: f.checkedAgainstSds } : {}),
        }),
      }), "Could not save");
      toast({ title: editingAssessment ? "Assessment updated" : "Assessment saved" });
      setAssessmentForm(null);
      setEditingAssessment(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Checks ───────────────────────────────────────────────────────────────
  function newCheck(checkType: CheckType, assessment?: Assessment) {
    const today = todayIso();
    setEditingCheck(null);
    setCheckForm({
      siteId: assessment?.siteId != null ? String(assessment.siteId) : siteFilter !== "all" ? siteFilter : sites.length === 1 ? String(sites[0].id) : "",
      assessmentId: assessment ? String(assessment.id) : NONE,
      checkType, checkDate: today, subject: "", carriedOutBy: checkType === "staff_briefing" ? user?.name ?? "" : "",
      result: "pass", actionRequired: "", nextDueDate: addMonthsIso(today, CHECK_INFO[checkType].months), nextDueTouched: false,
      notes: "", document: { objectPath: null, fileName: null },
    });
  }

  function editCheck(item: Check) {
    setEditingCheck(item);
    setCheckForm({
      siteId: item.siteId == null ? "" : String(item.siteId),
      assessmentId: item.assessmentId == null ? NONE : String(item.assessmentId),
      checkType: item.checkType, checkDate: item.checkDate, subject: item.subject ?? "", carriedOutBy: item.carriedOutBy ?? "",
      result: item.result, actionRequired: item.actionRequired ?? "", nextDueDate: item.nextDueDate ?? "", nextDueTouched: true,
      notes: item.notes ?? "", document: { objectPath: item.reportObjectPath, fileName: item.reportFileName },
    });
  }

  async function saveCheck() {
    const f = checkForm;
    if (!f) return;
    if (!f.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    if (!f.checkDate) { toast({ title: "Enter the date", variant: "destructive" }); return; }
    if (f.result === "fail" && !f.actionRequired.trim()) { toast({ title: "Say what needs to be done", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await ensureOk(await api(editingCheck ? `${CHECKS}/${editingCheck.id}` : CHECKS, {
        method: editingCheck ? "PUT" : "POST",
        body: JSON.stringify({
          siteId: Number(f.siteId),
          assessmentId: f.assessmentId === NONE ? null : Number(f.assessmentId),
          checkType: f.checkType, checkDate: f.checkDate,
          subject: f.subject.trim() || null, carriedOutBy: f.carriedOutBy.trim() || null,
          result: f.result, actionRequired: f.actionRequired.trim() || null,
          nextDueDate: f.nextDueDate || null, notes: f.notes.trim() || null,
          objectPath: f.document.objectPath, fileName: f.document.fileName,
        }),
      }), "Could not save");
      toast({ title: editingCheck ? "Record updated" : "Record saved" });
      setCheckForm(null);
      setEditingCheck(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      const path = target.kind === "assessment" ? `${ASSESSMENTS}/${target.item.id}` : `${CHECKS}/${target.item.id}`;
      await ensureOk(await api(path, { method: "DELETE" }), "Could not remove");
      toast({ title: "Removed" });
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function download(path: string, fallback: string) {
    try {
      await downloadRegisterDocument(api, path, fallback);
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  function openDueItem(item: DueItem) {
    const assessment = item.assessmentId == null ? undefined : assessments.find((a) => a.id === item.assessmentId);
    if (item.kind === "assessment_review") {
      if (assessment && canAssess) editAssessment(assessment);
      else setTab("assessments");
      return;
    }
    if (!canEdit) { setTab("checks"); return; }
    newCheck(item.kind as CheckType, assessment);
    if (item.status !== "missing") {
      const previous = checks.find((c) => c.id === item.recordId);
      if (previous) setCheckForm((f) => f && { ...f, subject: previous.subject ?? "", carriedOutBy: previous.carriedOutBy ?? "" });
    }
  }

  function exportAssessments() {
    downloadCsv(`coshh-assessments-${todayIso()}.csv`,
      ["Site", "Task", "Substance", "Risk", "Who is at risk", "Exposure routes", "Controls", "PPE", "Health checks needed", "Monitoring needed", "LEV needed", "Assessor", "Assessed", "Review due", "Status"],
      visibleAssessments.map((a) => [
        siteName(a.siteId), a.task, substanceName(a.substanceId) ?? "", RISK_LABEL[a.riskLevel] ?? a.riskLevel, a.whoAtRisk ?? "",
        a.exposureRoutes.map((k) => EXPOSURE_ROUTES.find((r) => r.key === k)?.label ?? k).join("; "),
        a.controls ?? "", [...a.ppe.map((k) => PPE.find((p) => p.key === k)?.label ?? k), a.ppeDetails ?? ""].filter(Boolean).join("; "),
        a.healthSurveillanceRequired ? "Yes" : "No", a.monitoringRequired ? "Yes" : "No", a.levRequired ? "Yes" : "No",
        a.assessor ?? "", fmtDate(a.assessmentDate), fmtDate(a.reviewDue), a.status === "current" ? "Current" : "Archived",
      ]));
  }

  function exportChecks() {
    downloadCsv(`coshh-checks-${todayIso()}.csv`,
      ["Site", "Type", "Date", "Subject", "Carried out by", "Result", "Action required", "Next due", "Assessment", "Report"],
      visibleChecks.map((c) => [
        siteName(c.siteId), CHECK_INFO[c.checkType]?.label ?? c.checkType, fmtDate(c.checkDate), c.subject ?? "", c.carriedOutBy ?? "",
        c.result === "pass" ? "Satisfactory" : "Action needed", c.actionRequired ?? "", fmtDate(c.nextDueDate),
        assessmentName(c.assessmentId) ?? "", c.reportFileName ?? (c.reportObjectPath ? "Attached" : ""),
      ]));
  }

  const siteSubstances = assessmentForm
    ? substances.filter((s) => String(s.siteId) === assessmentForm.siteId && (s.status === "in_use" || String(s.id) === assessmentForm.substanceId))
    : [];
  const siteAssessments = checkForm
    ? assessments.filter((a) => String(a.siteId) === checkForm.siteId && (a.status === "current" || String(a.id) === checkForm.assessmentId))
    : [];
  const checkInfo = checkForm ? CHECK_INFO[checkForm.checkType] : null;
  // Departments whose staff can be asked to sign: those at the chosen site or
  // spanning every site, plus any already chosen.
  const siteDepartments = assessmentForm
    ? [...new Set([
      ...departments.filter((d) => d.siteId == null || String(d.siteId) === assessmentForm.siteId).map((d) => d.name),
      ...assessmentForm.signOffDepartments,
    ])].sort((a, b) => a.localeCompare(b)).map((name) => ({ key: name, label: name }))
    : [];
  const substancesWithoutAssessment = substances.filter((s) => s.status === "in_use" && inSite(s.siteId)
    && !assessments.some((a) => a.substanceId === s.id && a.status === "current"));

  return (
    <AppLayout title="COSHHTrack">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-orange-50 border border-orange-200 flex items-center justify-center shrink-0">
            <Beaker className="w-4 h-4 text-orange-700" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">COSHHTrack</h1>
            <p className="text-xs text-muted-foreground">COSHH assessments, extraction (LEV) tests, health checks, air monitoring and staff briefings</p>
          </div>
        </div>

        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            Under the COSHH Regulations 2002 you assess the risks from hazardous substances, put controls in place, keep
            them working (extraction systems are examined at least every 14 months), provide health checks where the
            assessment calls for them, and tell staff about the risks. List your products and safety data sheets in
            the <button type="button" className="underline font-medium" onClick={() => setTab("substances")}>Substances</button> tab
            (your COSHH register), then assess each one.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className={cn("border rounded-sm p-3", status?.overdue ? "border-red-300 bg-red-50" : "border-border")}>
            <p className={cn("text-xs", status?.overdue ? "text-red-700" : "text-muted-foreground")}>Overdue</p>
            <p className={cn("text-xl font-bold", status?.overdue ? "text-red-700" : "")}>{status?.overdue ?? "–"}</p>
          </div>
          <div className={cn("border rounded-sm p-3", status?.dueSoon ? "border-amber-300 bg-amber-50" : "border-border")}>
            <p className={cn("text-xs", status?.dueSoon ? "text-amber-800" : "text-muted-foreground")}>Due in the next {status?.dueSoonDays ?? 30} days</p>
            <p className={cn("text-xl font-bold", status?.dueSoon ? "text-amber-800" : "")}>{status?.dueSoon ?? "–"}</p>
          </div>
          <div className={cn("border rounded-sm p-3", status?.missing ? "border-amber-300 bg-amber-50" : "border-border")}>
            <p className={cn("text-xs", status?.missing ? "text-amber-800" : "text-muted-foreground")}>Needed, not recorded</p>
            <p className={cn("text-xl font-bold", status?.missing ? "text-amber-800" : "")}>{status?.missing ?? "–"}</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <SiteFilter value={siteFilter} onChange={setSiteFilter} />
          <div className="flex flex-wrap gap-2">
            {canAssess && (
              <Button size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={() => newAssessment()}>
                <Plus className="w-3.5 h-3.5" /> New assessment
              </Button>
            )}
            {canEdit && (
              <Select value="" onValueChange={(value) => newCheck(value as CheckType)}>
                <SelectTrigger className="h-8 text-xs rounded-sm w-48" aria-label="Record a check">
                  <SelectValue placeholder="Record a check…" />
                </SelectTrigger>
                <SelectContent>
                  {CHECK_TYPES.map((type) => <SelectItem key={type.key} value={type.key}>{type.label}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="due">What's due</TabsTrigger>
            <TabsTrigger value="substances">Substances</TabsTrigger>
            <TabsTrigger value="assessments">Assessments ({visibleAssessments.length})</TabsTrigger>
            <TabsTrigger value="checks">Checks ({visibleChecks.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="due" className="space-y-4 pt-3">
            {actionItems.length === 0 ? (
              <div className="rounded-xl border-2 border-dashed border-muted py-10 text-center text-sm text-muted-foreground">
                {(status?.items.length ?? 0) === 0 ? "Nothing recorded yet. Start with a COSHH assessment." : "Nothing overdue or due in the next 30 days."}
              </div>
            ) : (
              <div className="border border-border rounded-xl divide-y divide-border">
                {actionItems.map((item) => (
                  <div key={`${item.kind}-${item.recordId}-${item.status}`} className="flex flex-col sm:flex-row sm:items-center gap-2 p-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium break-words">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.siteName ?? "No site"}</p>
                    </div>
                    <DueBadge item={item} />
                    {(item.kind === "assessment_review" ? canAssess : canEdit) && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openDueItem(item)}>
                        {item.kind === "assessment_review" ? "Review" : "Record"}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {substancesWithoutAssessment.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
                <p className="text-sm font-medium text-amber-900 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> {substancesWithoutAssessment.length} substance{substancesWithoutAssessment.length === 1 ? "" : "s"} in the register with no assessment
                </p>
                <div className="flex flex-wrap gap-2">
                  {substancesWithoutAssessment.slice(0, 12).map((s) => (
                    canAssess
                      ? <Button key={s.id} variant="outline" size="sm" className="h-7 text-xs bg-white" onClick={() => newAssessment(s)}>Assess {s.productName}</Button>
                      : <Badge key={s.id} variant="outline" className="bg-white">{s.productName}</Badge>
                  ))}
                </div>
              </div>
            )}
            {upcoming.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5" /> Coming up later</p>
                <div className="border border-border rounded-xl divide-y divide-border">
                  {upcoming.map((item) => (
                    <div key={`${item.kind}-${item.recordId}`} className="flex items-center gap-2 p-2.5 text-sm">
                      <span className="flex-1 min-w-0 break-words">{item.label}<span className="text-xs text-muted-foreground"> · {item.siteName ?? "No site"}</span></span>
                      <DueBadge item={item} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="substances" className="pt-3">
            <CoshhRegisterPanel
              track={{
                assessments,
                siteFilter,
                onAssess: canAssess ? (substance) => newAssessment(substance) : undefined,
                onOpenAssessment: (id) => {
                  const assessment = assessments.find((a) => a.id === id);
                  if (assessment && canAssess) editAssessment(assessment);
                  else setTab("assessments");
                },
              }}
            />
          </TabsContent>

          <TabsContent value="assessments" className="space-y-3 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked === true)} />
                Show archived
              </label>
              <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={exportAssessments} disabled={visibleAssessments.length === 0}>
                <Download className="w-3.5 h-3.5" /> Export CSV
              </Button>
            </div>
            {assessmentsLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {assessmentsError && <p className="text-sm text-destructive">{(assessmentsError as Error).message}</p>}
            {!assessmentsLoading && !assessmentsError && visibleAssessments.length === 0 && (
              <div className="rounded-xl border-2 border-dashed border-muted py-10 text-center text-sm text-muted-foreground">No assessments yet.</div>
            )}
            {visibleAssessments.map((a) => (
              <div key={a.id} className={cn("rounded-xl border p-3 space-y-2", a.reviewOverdue ? "border-red-300" : "border-border")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{a.task}</p>
                    <p className="text-xs text-muted-foreground">
                      {[substanceName(a.substanceId), siteName(a.siteId), a.assessor ? `Assessed by ${a.assessor}` : null, `on ${fmtDate(a.assessmentDate)}`].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {a.documentObjectPath && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Download the document for ${a.task}`}
                        onClick={() => download(`${ASSESSMENTS}/${a.id}/document-url`, "coshh-assessment")}>
                        <FileText className="w-4 h-4" />
                      </Button>
                    )}
                    {canAssess && (
                      <>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${a.task}`} onClick={() => editAssessment(a)}><Pencil className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Remove ${a.task}`} onClick={() => setDeleteTarget({ kind: "assessment", item: a })}><Trash2 className="w-4 h-4" /></Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className={cn("text-[11px]", RISK_STYLE[a.riskLevel])}>{RISK_LABEL[a.riskLevel]} risk</Badge>
                  {a.status === "archived"
                    ? <Badge variant="outline" className="text-[11px]">Archived</Badge>
                    : a.reviewDue && <DueBadge item={{ status: a.reviewOverdue ? "overdue" : "ok", dueDate: a.reviewDue, daysUntilDue: null }} />}
                  {a.healthSurveillanceRequired && <Badge variant="outline" className="text-[11px]">Health checks needed</Badge>}
                  {a.monitoringRequired && <Badge variant="outline" className="text-[11px]">Monitoring needed</Badge>}
                  {a.levRequired && <Badge variant="outline" className="text-[11px]">Uses extraction (LEV)</Badge>}
                  {a.status === "current" && signOffById.has(a.id) && (() => {
                    const progress = signOffById.get(a.id)!;
                    const done = progress.staffTotal > 0 && progress.signedCount === progress.staffTotal;
                    return (
                      <Link href="/train-track" className="inline-flex">
                        <Badge variant="outline" className={cn("text-[11px] cursor-pointer", done ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-amber-300 bg-amber-50 text-amber-800")}>
                          {progress.staffTotal === 0 ? "No staff to sign" : `${progress.signedCount} of ${progress.staffTotal} staff signed`}
                        </Badge>
                      </Link>
                    );
                  })()}
                  {a.draftSource === "ai" && (
                    <Badge variant="outline" className="text-[11px] border-violet-200 bg-violet-50 text-violet-800">
                      AI draft{a.checkedByName ? `, checked by ${a.checkedByName}` : ""}
                    </Badge>
                  )}
                </div>
                {(a.controls || a.ppe.length > 0) && (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {[a.controls, a.ppe.length ? `PPE: ${[...a.ppe.map((k) => PPE.find((p) => p.key === k)?.label ?? k), a.ppeDetails].filter(Boolean).join(", ")}` : null].filter(Boolean).join("\n")}
                  </p>
                )}
                {canEdit && a.status === "current" && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => newCheck("staff_briefing", a)}>Record a staff briefing</Button>
                    {a.healthSurveillanceRequired && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => newCheck("health_surveillance", a)}>Record a health check</Button>}
                    {a.monitoringRequired && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => newCheck("exposure_monitoring", a)}>Record monitoring</Button>}
                    {a.levRequired && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => newCheck("lev_examination", a)}>Record an LEV test</Button>}
                  </div>
                )}
              </div>
            ))}
          </TabsContent>

          <TabsContent value="checks" className="space-y-3 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Select value={checkFilter} onValueChange={(value) => setCheckFilter(value as typeof checkFilter)}>
                <SelectTrigger className="h-8 text-xs rounded-sm w-48" aria-label="Filter by type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All checks</SelectItem>
                  {CHECK_TYPES.map((type) => <SelectItem key={type.key} value={type.key}>{type.short}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={exportChecks} disabled={visibleChecks.length === 0}>
                <Download className="w-3.5 h-3.5" /> Export CSV
              </Button>
            </div>
            {checksLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {checksError && <p className="text-sm text-destructive">{(checksError as Error).message}</p>}
            {!checksLoading && !checksError && visibleChecks.length === 0 && (
              <div className="rounded-xl border-2 border-dashed border-muted py-10 text-center text-sm text-muted-foreground">No checks recorded yet.</div>
            )}
            {visibleChecks.length > 0 && (
              <div className="border border-border rounded-xl divide-y divide-border">
                {visibleChecks.map((c) => (
                  <div key={c.id} className={cn("flex flex-col sm:flex-row sm:items-start gap-2 p-3", c.result === "fail" && "bg-red-50/40")}>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <p className="text-sm font-medium break-words">{CHECK_INFO[c.checkType]?.label ?? c.checkType}{c.subject ? `: ${c.subject}` : ""}</p>
                      <p className="text-xs text-muted-foreground">
                        {[fmtDate(c.checkDate), siteName(c.siteId), c.carriedOutBy, assessmentName(c.assessmentId)].filter(Boolean).join(" · ")}
                      </p>
                      {c.result === "fail" && c.actionRequired && <p className="text-xs text-red-700">Action: {c.actionRequired}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="outline" className={cn("text-[11px]", c.result === "pass" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-red-300 bg-red-50 text-red-700")}>
                        {c.result === "pass" ? "Satisfactory" : "Action needed"}
                      </Badge>
                      {c.nextDueDate && <span className="text-xs text-muted-foreground whitespace-nowrap">Next {fmtDate(c.nextDueDate)}</span>}
                      {c.reportObjectPath && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Download the report"
                          onClick={() => download(`${CHECKS}/${c.id}/report-url`, "coshh-report")}>
                          <FileText className="w-4 h-4" />
                        </Button>
                      )}
                      {canEdit && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit this record" onClick={() => editCheck(c)}><Pencil className="w-4 h-4" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label="Remove this record" onClick={() => setDeleteTarget({ kind: "check", item: c })}><Trash2 className="w-4 h-4" /></Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={assessmentForm !== null} onOpenChange={(open) => { if (!open) { setAssessmentForm(null); setEditingAssessment(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingAssessment ? "Edit COSHH assessment" : "New COSHH assessment"}</DialogTitle>
            <DialogDescription>Use the supplier's safety data sheet for the hazards, exposure limits, first aid and spill steps.</DialogDescription>
          </DialogHeader>
          {assessmentForm && (() => {
            const f = assessmentForm;
            const set = (patch: Partial<AssessmentForm>) => setAssessmentForm({ ...f, ...patch });
            return (
              <div className="space-y-4">
                {f.draftSource === "ai" && (
                  <label className="flex items-start gap-2 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
                    <Checkbox className="mt-0.5" checked={f.checkedAgainstSds} onCheckedChange={(checked) => set({ checkedAgainstSds: checked === true })} />
                    This was drafted automatically from the safety data sheet. I have checked every section against the sheet and our own work.
                  </label>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <SiteSelect id="coshh-assessment-site" value={f.siteId} onChange={(siteId) => set({ siteId, substanceId: NONE })} />
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-assessment-substance">Substance (from the Substances tab)</Label>
                    <Select value={f.substanceId} onValueChange={(substanceId) => set({ substanceId })}>
                      <SelectTrigger id="coshh-assessment-substance"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None (a task or process)</SelectItem>
                        {siteSubstances.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.productName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <TextField id="coshh-task" label="Task or activity *" rows={1} max={300} value={f.task} onChange={(task) => set({ task })}
                  placeholder="For example: daily kitchen cleaning with degreaser" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField id="coshh-who" label="Who could be harmed" value={f.whoAtRisk} max={1000} onChange={(whoAtRisk) => set({ whoAtRisk })}
                    placeholder="Kitchen staff, cleaners, contractors, guests nearby" />
                  <TextField id="coshh-often" label="How often and for how long" value={f.howOften} max={500} onChange={(howOften) => set({ howOften })}
                    placeholder="Daily, about 20 minutes" />
                </div>
                <TickList legend="How it could harm people" options={EXPOSURE_ROUTES} value={f.exposureRoutes} onChange={(exposureRoutes) => set({ exposureRoutes })} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField id="coshh-hazards" label="Hazard statements (H-codes)" value={f.hazardStatements} onChange={(hazardStatements) => set({ hazardStatements })}
                    placeholder="H314 Causes severe skin burns and eye damage" />
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-signal">Signal word</Label>
                    <Select value={f.signalWord} onValueChange={(signalWord) => set({ signalWord })}>
                      <SelectTrigger id="coshh-signal"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not recorded</SelectItem>
                        <SelectItem value="danger">Danger</SelectItem>
                        <SelectItem value="warning">Warning</SelectItem>
                        <SelectItem value="none">None on the label</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <TextField id="coshh-effects" label="Health effects" value={f.healthEffects} onChange={(healthEffects) => set({ healthEffects })}
                    placeholder="Burns, dermatitis, breathing problems" />
                  <TextField id="coshh-wel" label="Workplace exposure limits" value={f.exposureLimits} max={1000} onChange={(exposureLimits) => set({ exposureLimits })}
                    placeholder="From section 8 of the safety data sheet" />
                </div>
                <TextField id="coshh-controls" label="Controls in place" rows={3} max={4000} value={f.controls} onChange={(controls) => set({ controls })}
                  placeholder="Use diluted from the dispenser, good ventilation, never mix with bleach, store locked away" />
                <TickList legend="PPE needed" options={PPE} value={f.ppe} onChange={(ppe) => set({ ppe })} />
                <TextField id="coshh-ppe" label="PPE details" rows={1} max={1000} value={f.ppeDetails} onChange={(ppeDetails) => set({ ppeDetails })}
                  placeholder="For example: nitrile gloves EN 374, splash goggles" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField id="coshh-storage" label="Storage" value={f.storage} onChange={(storage) => set({ storage })} />
                  <TextField id="coshh-spill" label="Spills" value={f.spillProcedure} onChange={(spillProcedure) => set({ spillProcedure })} />
                  <TextField id="coshh-first-aid" label="First aid" value={f.firstAid} onChange={(firstAid) => set({ firstAid })} />
                  <TextField id="coshh-disposal" label="Disposal" value={f.disposal} onChange={(disposal) => set({ disposal })} />
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">What follows from this assessment</legend>
                  {([
                    ["healthSurveillanceRequired", "Health checks are needed (for example skin checks)"],
                    ["monitoringRequired", "Air or exposure monitoring is needed"],
                    ["levRequired", "Extraction (LEV) is used to control exposure"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={f[key]} onCheckedChange={(checked) => set({ [key]: checked === true } as Partial<AssessmentForm>)} />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-risk">Risk level after controls</Label>
                    <Select value={f.riskLevel} onValueChange={(riskLevel) => set({ riskLevel: riskLevel as AssessmentForm["riskLevel"] })}>
                      <SelectTrigger id="coshh-risk"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <TextField id="coshh-assessor" label="Assessed by" rows={1} max={200} value={f.assessor} onChange={(assessor) => set({ assessor })} />
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-assessed">Assessment date *</Label>
                    <Input id="coshh-assessed" type="date" value={f.assessmentDate} onChange={(e) => set({
                      assessmentDate: e.target.value,
                      reviewDue: f.reviewDueTouched || !e.target.value ? f.reviewDue : addMonthsIso(e.target.value, 12),
                    })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-review">Review due</Label>
                    <Input id="coshh-review" type="date" value={f.reviewDue} onChange={(e) => set({ reviewDue: e.target.value, reviewDueTouched: true })} />
                    <p className="text-[11px] text-muted-foreground">Suggested: 12 months. Review sooner if the work, the product or the people change.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-status">Status</Label>
                    <Select value={f.status} onValueChange={(value) => set({ status: value as AssessmentForm["status"] })}>
                      <SelectTrigger id="coshh-status"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="current">Current</SelectItem>
                        <SelectItem value="archived">Archived (replaced or no longer used)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {siteDepartments.length > 0 ? (
                  <div className="space-y-1">
                    <TickList legend="Who must read and sign it in TrainTrack" options={siteDepartments} value={f.signOffDepartments}
                      onChange={(signOffDepartments) => set({ signOffDepartments })} />
                    <p className="text-[11px] text-muted-foreground">Leave all unticked for everyone on the staff list at this site.</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Everyone on the staff list at this site will be asked to read and sign it in TrainTrack.</p>
                )}
                {editingAssessment && (
                  <p className="text-xs text-muted-foreground">If you change the hazards, controls, PPE or emergency steps, staff are asked to sign it again.</p>
                )}
                <DocumentField label="Signed assessment or supporting document" value={f.document} onChange={(document) => set({ document })} />
                <TextField id="coshh-notes" label="Notes" value={f.notes} max={4000} onChange={(notes) => set({ notes })} />
              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setAssessmentForm(null); setEditingAssessment(null); }} disabled={saving}>Cancel</Button>
            <Button onClick={saveAssessment} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={checkForm !== null} onOpenChange={(open) => { if (!open) { setCheckForm(null); setEditingCheck(null); } }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingCheck ? "Edit record" : `Record: ${checkInfo?.label ?? ""}`}</DialogTitle>
            <DialogDescription>
              {checkForm?.checkType === "health_surveillance"
                ? "Record the outcome only. Medical details stay with the occupational health provider."
                : checkForm?.checkType === "lev_examination"
                ? "Attach the examiner's report. Keep it for at least 5 years."
                : "Attach any report or signed sheet."}
            </DialogDescription>
          </DialogHeader>
          {checkForm && checkInfo && (() => {
            const f = checkForm;
            const set = (patch: Partial<CheckForm>) => setCheckForm({ ...f, ...patch });
            return (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-check-type">Type</Label>
                    <Select value={f.checkType} onValueChange={(value) => {
                      const checkType = value as CheckType;
                      set({ checkType, nextDueDate: f.nextDueTouched || !f.checkDate ? f.nextDueDate : addMonthsIso(f.checkDate, CHECK_INFO[checkType].months) });
                    }}>
                      <SelectTrigger id="coshh-check-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CHECK_TYPES.map((type) => <SelectItem key={type.key} value={type.key}>{type.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <SiteSelect id="coshh-check-site" value={f.siteId} onChange={(siteId) => set({ siteId, assessmentId: NONE })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-check-assessment">COSHH assessment</Label>
                  <Select value={f.assessmentId} onValueChange={(assessmentId) => set({ assessmentId })}>
                    <SelectTrigger id="coshh-check-assessment"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not linked</SelectItem>
                      {siteAssessments.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.task}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField id="coshh-check-subject" label={checkInfo.subject} rows={1} max={300} value={f.subject}
                    placeholder={checkInfo.subjectHint} onChange={(subject) => set({ subject })} />
                  <TextField id="coshh-check-by" label={checkInfo.by} rows={1} max={300} value={f.carriedOutBy} onChange={(carriedOutBy) => set({ carriedOutBy })} />
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-check-date">Date *</Label>
                    <Input id="coshh-check-date" type="date" value={f.checkDate} max={todayIso()} onChange={(e) => set({
                      checkDate: e.target.value,
                      nextDueDate: f.nextDueTouched || !e.target.value ? f.nextDueDate : addMonthsIso(e.target.value, checkInfo.months),
                    })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="coshh-check-next">Next due</Label>
                    <Input id="coshh-check-next" type="date" value={f.nextDueDate} onChange={(e) => set({ nextDueDate: e.target.value, nextDueTouched: true })} />
                    <p className="text-[11px] text-muted-foreground">Suggested: {checkInfo.months} months. Leave blank if none is needed.</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coshh-check-result">Result</Label>
                  <Select value={f.result} onValueChange={(value) => set({ result: value as CheckForm["result"] })}>
                    <SelectTrigger id="coshh-check-result"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pass">Satisfactory</SelectItem>
                      <SelectItem value="fail">Action needed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {f.result === "fail" && (
                  <TextField id="coshh-check-action" label="What needs to be done *" value={f.actionRequired} onChange={(actionRequired) => set({ actionRequired })}
                    placeholder="This also opens an action on the track so it is followed up" />
                )}
                <DocumentField label="Report or certificate" value={f.document} onChange={(document) => set({ document })} />
                <TextField id="coshh-check-notes" label="Notes" value={f.notes} max={4000} onChange={(notes) => set({ notes })} />
              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setCheckForm(null); setEditingCheck(null); }} disabled={saving}>Cancel</Button>
            <Button onClick={saveCheck} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDelete
        open={deleteTarget !== null}
        title={deleteTarget?.kind === "assessment" ? "Remove this assessment?" : "Remove this record?"}
        description={deleteTarget?.kind === "assessment"
          ? `"${deleteTarget.item.task}" will be removed. If it has been replaced or is no longer used, set its status to Archived instead.`
          : "This record will be removed. It stays in the change history and the data export."}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
    </AppLayout>
  );
}
