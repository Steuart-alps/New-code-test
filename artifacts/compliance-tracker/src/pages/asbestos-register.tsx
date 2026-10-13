import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, FileText, Info, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCanEdit } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ConfirmDelete, DocumentField, SiteFilter, SiteSelect, addMonthsIso, downloadCsv, downloadRegisterDocument,
  ensureOk, fmtDate, todayIso, useRegisterList, useRegisterSites, type DocumentValue,
} from "@/components/register-shared";

const BUILT_LABELS = { yes: "Yes", no: "No (built in or after 2000)", unknown: "Not known" } as const;
const SURVEY_LABELS = { management: "Management survey", refurbishment_demolition: "Refurbishment and demolition survey" } as const;
const CONDITION_LABELS = { good: "Good", low_damage: "Low damage", medium_damage: "Medium damage", high_damage: "High damage" } as const;
const PRIORITY_LABELS = { low: "Low", medium: "Medium", high: "High" } as const;
const ACTION_LABELS = { manage: "Manage in place", encapsulate: "Encapsulate / repair", remove: "Remove" } as const;

type Built = keyof typeof BUILT_LABELS;
type SurveyType = keyof typeof SURVEY_LABELS;
type Condition = keyof typeof CONDITION_LABELS;
type Priority = keyof typeof PRIORITY_LABELS;
type Action = keyof typeof ACTION_LABELS;

interface Entry {
  id: number;
  recordId: number;
  location: string;
  material: string;
  condition: Condition;
  riskScore: number | null;
  priority: Priority;
  action: Action;
  lastInspected: string | null;
  notes: string | null;
}

/** An earlier survey whose report was replaced or detached. */
interface PastSurvey {
  id: number;
  surveyType: SurveyType | null;
  surveyDate: string | null;
  surveyor: string | null;
  reportFileName: string | null;
  replacedAt: string;
}

interface AsbestosRecord {
  id: number;
  siteId: number | null;
  builtBefore2000: Built;
  noAsbestosExpected: boolean;
  surveyType: SurveyType | null;
  surveyDate: string | null;
  surveyor: string | null;
  reportObjectPath: string | null;
  reportFileName: string | null;
  planReviewDue: string | null;
  planReviewOverdue: boolean;
  notes: string | null;
  entries: Entry[];
  surveyHistory?: PastSurvey[];
}

interface RecordForm {
  siteId: string;
  builtBefore2000: Built;
  noAsbestosExpected: boolean;
  surveyType: SurveyType | "none";
  surveyDate: string;
  surveyor: string;
  document: DocumentValue;
  planReviewDue: string;
  planReviewTouched: boolean;
  notes: string;
}

interface EntryForm {
  location: string;
  material: string;
  condition: Condition;
  riskScore: string;
  priority: Priority;
  action: Action;
  lastInspected: string;
  notes: string;
}

const LIST_PATH = "/registers/asbestos";

const PRIORITY_STYLE: Record<Priority, string> = {
  low: "border-emerald-300 bg-emerald-50 text-emerald-700",
  medium: "border-amber-300 bg-amber-50 text-amber-800",
  high: "border-red-300 bg-red-50 text-red-700",
};

export default function AsbestosRegisterPage() {
  const canEdit = useCanEdit();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sites, siteName } = useRegisterSites();

  const [siteFilter, setSiteFilter] = useState("all");
  const [editing, setEditing] = useState<AsbestosRecord | null>(null);
  const [form, setForm] = useState<RecordForm | null>(null);
  const [entryParent, setEntryParent] = useState<AsbestosRecord | null>(null);
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);
  const [entryForm, setEntryForm] = useState<EntryForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteRecord, setDeleteRecord] = useState<AsbestosRecord | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);

  const { data: records = [], isLoading, error } = useRegisterList<AsbestosRecord>(LIST_PATH);
  const visible = useMemo(() => records.filter((record) => siteFilter === "all" || String(record.siteId) === siteFilter), [records, siteFilter]);
  const sitesWithoutRecord = sites.filter((site) => !records.some((record) => record.siteId === site.id)
    && (siteFilter === "all" || String(site.id) === siteFilter));

  const refresh = () => queryClient.invalidateQueries({ queryKey: [`/api${LIST_PATH}`] });

  function openNew(siteId?: number) {
    setEditing(null);
    setForm({
      siteId: siteId != null ? String(siteId) : siteFilter !== "all" ? siteFilter : "",
      builtBefore2000: "unknown", noAsbestosExpected: false, surveyType: "none", surveyDate: "", surveyor: "",
      document: { objectPath: null, fileName: null },
      planReviewDue: addMonthsIso(todayIso(), 12), planReviewTouched: false, notes: "",
    });
  }

  function openEdit(record: AsbestosRecord) {
    setEditing(record);
    setForm({
      siteId: record.siteId == null ? "" : String(record.siteId),
      builtBefore2000: record.builtBefore2000,
      noAsbestosExpected: record.noAsbestosExpected,
      surveyType: record.surveyType ?? "none",
      surveyDate: record.surveyDate ?? "",
      surveyor: record.surveyor ?? "",
      document: { objectPath: record.reportObjectPath, fileName: record.reportFileName },
      planReviewDue: record.planReviewDue ?? "",
      planReviewTouched: true,
      notes: record.notes ?? "",
    });
  }

  async function saveRecord() {
    if (!form) return;
    if (!form.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const noAsbestos = form.builtBefore2000 === "no" && form.noAsbestosExpected;
      await ensureOk(await api(editing ? `${LIST_PATH}/${editing.id}` : LIST_PATH, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          siteId: Number(form.siteId),
          builtBefore2000: form.builtBefore2000,
          noAsbestosExpected: noAsbestos,
          surveyType: form.surveyType === "none" ? null : form.surveyType,
          surveyDate: form.surveyDate || null,
          surveyor: form.surveyor || null,
          objectPath: form.document.objectPath,
          fileName: form.document.fileName,
          planReviewDue: noAsbestos ? null : form.planReviewDue || null,
          notes: form.notes || null,
        }),
      }), "Could not save");
      toast({ title: editing ? "Asbestos record updated" : "Asbestos record added" });
      setForm(null);
      setEditing(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function openNewEntry(record: AsbestosRecord) {
    setEntryParent(record);
    setEditingEntry(null);
    setEntryForm({ location: "", material: "", condition: "good", riskScore: "", priority: "low", action: "manage", lastInspected: record.surveyDate ?? "", notes: "" });
  }

  function openEditEntry(record: AsbestosRecord, entry: Entry) {
    setEntryParent(record);
    setEditingEntry(entry);
    setEntryForm({
      location: entry.location, material: entry.material, condition: entry.condition,
      riskScore: entry.riskScore == null ? "" : String(entry.riskScore), priority: entry.priority,
      action: entry.action, lastInspected: entry.lastInspected ?? "", notes: entry.notes ?? "",
    });
  }

  function closeEntry() {
    setEntryForm(null);
    setEditingEntry(null);
    setEntryParent(null);
  }

  async function saveEntry() {
    if (!entryForm || !entryParent) return;
    if (!entryForm.location.trim() || !entryForm.material.trim()) {
      toast({ title: "Enter the location and the material", variant: "destructive" });
      return;
    }
    const score = entryForm.riskScore.trim() === "" ? null : Number(entryForm.riskScore);
    if (score !== null && (!Number.isInteger(score) || score < 0 || score > 24)) {
      toast({ title: "Risk score must be a whole number from 0 to 24", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await ensureOk(await api(editingEntry ? `${LIST_PATH}/entries/${editingEntry.id}` : `${LIST_PATH}/${entryParent.id}/entries`, {
        method: editingEntry ? "PUT" : "POST",
        body: JSON.stringify({
          location: entryForm.location, material: entryForm.material, condition: entryForm.condition,
          riskScore: score, priority: entryForm.priority, action: entryForm.action,
          lastInspected: entryForm.lastInspected || null, notes: entryForm.notes || null,
        }),
      }), "Could not save");
      toast({ title: editingEntry ? "Register entry updated" : "Register entry added" });
      closeEntry();
      await refresh();
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function removeRecord() {
    const target = deleteRecord;
    setDeleteRecord(null);
    if (!target) return;
    try {
      await ensureOk(await api(`${LIST_PATH}/${target.id}`, { method: "DELETE" }), "Could not remove");
      toast({ title: "Asbestos record removed" });
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function removeEntry() {
    const target = deleteEntry;
    setDeleteEntry(null);
    if (!target) return;
    try {
      await ensureOk(await api(`${LIST_PATH}/entries/${target.id}`, { method: "DELETE" }), "Could not remove");
      toast({ title: "Register entry removed" });
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function downloadReport(record: AsbestosRecord) {
    try {
      await downloadRegisterDocument(api, `${LIST_PATH}/${record.id}/report-url`, "asbestos-survey");
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function downloadPastReport(record: AsbestosRecord, survey: PastSurvey) {
    try {
      await downloadRegisterDocument(api, `${LIST_PATH}/${record.id}/history/${survey.id}/report-url`, "asbestos-survey");
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  function exportCsv() {
    const rows: string[][] = [];
    for (const record of visible) {
      const base = [
        siteName(record.siteId), BUILT_LABELS[record.builtBefore2000], record.noAsbestosExpected ? "Yes" : "No",
        record.surveyType ? SURVEY_LABELS[record.surveyType] : "", fmtDate(record.surveyDate), record.surveyor ?? "",
        record.reportFileName ?? (record.reportObjectPath ? "Attached" : ""), fmtDate(record.planReviewDue),
        record.planReviewOverdue ? "Yes" : "No",
      ];
      if (record.entries.length === 0) rows.push([...base, "", "", "", "", "", "", "", ""]);
      for (const entry of record.entries) {
        rows.push([...base, entry.location, entry.material, CONDITION_LABELS[entry.condition],
          entry.riskScore == null ? "" : String(entry.riskScore), PRIORITY_LABELS[entry.priority],
          ACTION_LABELS[entry.action], fmtDate(entry.lastInspected), entry.notes ?? ""]);
      }
    }
    downloadCsv(`asbestos-register-${todayIso()}.csv`, [
      "Site", "Built before 2000", "No asbestos expected", "Survey type", "Survey date", "Surveyor", "Survey report",
      "Management plan review due", "Plan review overdue", "Location", "Material", "Condition", "Risk score",
      "Priority", "Action", "Last inspected", "Notes",
    ], rows);
  }

  return (
    <AppLayout title="Asbestos register">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-slate-100 border border-slate-300 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-4 h-4 text-slate-700" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Asbestos register</h1>
            <p className="text-xs text-muted-foreground">Surveys, known asbestos-containing materials and the management plan for each site</p>
          </div>
        </div>

        <div role="alert" className="flex gap-2 rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            <strong>Show contractors the asbestos register before they start any work</strong> that could disturb the
            building fabric (drilling, cutting, fixing, lifting floors or ceilings). Work on refurbishment or demolition
            needs a refurbishment and demolition survey of the area first.
          </p>
        </div>

        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            Under regulation 4 of the Control of Asbestos Regulations 2012, whoever is responsible for maintaining
            non-domestic premises must find out whether asbestos is present, record where it is and its condition,
            and manage the risk. Buildings built before 2000 may contain asbestos. The suggested 12-month plan review
            is a common default: follow your surveyor's advice on re-inspection.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <SiteFilter value={siteFilter} onChange={setSiteFilter} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={exportCsv} disabled={visible.length === 0}>
              <Download className="w-3.5 h-3.5" /> Export CSV
            </Button>
            {canEdit && (
              <Button size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={() => openNew()}>
                <Plus className="w-3.5 h-3.5" /> Add site record
              </Button>
            )}
          </div>
        </div>

        {sitesWithoutRecord.length > 0 && !isLoading && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
            <p className="font-medium">No asbestos record yet for: {sitesWithoutRecord.map((site) => site.name).join(", ")}</p>
            {canEdit && sitesWithoutRecord.length <= 5 && (
              <div className="flex flex-wrap gap-2">
                {sitesWithoutRecord.map((site) => (
                  <Button key={site.id} variant="outline" size="sm" className="h-7 text-xs bg-white" onClick={() => openNew(site.id)}>
                    <Plus className="w-3 h-3 mr-1" /> {site.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        {visible.map((record) => (
          <section key={record.id} className={cn("rounded-xl border p-4 space-y-3", record.planReviewOverdue ? "border-red-300" : "border-border")}>
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <h2 className="font-semibold break-words">{siteName(record.siteId)}</h2>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  <Badge variant="outline" className="text-[11px]">Built before 2000: {BUILT_LABELS[record.builtBefore2000]}</Badge>
                  {record.noAsbestosExpected && <Badge variant="outline" className="text-[11px] border-emerald-300 bg-emerald-50 text-emerald-700">No asbestos expected (post-2000 build)</Badge>}
                  {!record.noAsbestosExpected && record.planReviewDue && (
                    <Badge variant="outline" className={cn("text-[11px]", record.planReviewOverdue ? "border-red-300 bg-red-50 text-red-700" : "")}>
                      {record.planReviewOverdue ? "Plan review overdue" : "Plan review due"} {fmtDate(record.planReviewDue)}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {record.reportObjectPath && (
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => downloadReport(record)}>
                    <FileText className="w-3.5 h-3.5" /> Survey report
                  </Button>
                )}
                {canEdit && (
                  <>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit site record" onClick={() => openEdit(record)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label="Remove site record" onClick={() => setDeleteRecord(record)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {record.surveyType
                ? `${SURVEY_LABELS[record.surveyType]}${record.surveyDate ? ` on ${fmtDate(record.surveyDate)}` : ""}${record.surveyor ? ` by ${record.surveyor}` : ""}`
                : record.noAsbestosExpected ? "No survey recorded" : "No survey recorded yet"}
            </p>
            {record.notes && <p className="text-xs whitespace-pre-wrap">{record.notes}</p>}
            {(record.surveyHistory?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">Previous surveys</h3>
                <ul className="space-y-1">
                  {record.surveyHistory!.map((survey) => (
                    <li key={survey.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 break-words text-muted-foreground">
                        {survey.surveyType ? SURVEY_LABELS[survey.surveyType] : "Survey"}
                        {survey.surveyDate ? ` on ${fmtDate(survey.surveyDate)}` : ""}
                        {survey.surveyor ? ` by ${survey.surveyor}` : ""}
                        {` (replaced ${fmtDate(survey.replacedAt)})`}
                      </span>
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 shrink-0" onClick={() => downloadPastReport(record, survey)}>
                        <FileText className="w-3 h-3" /> {survey.reportFileName ?? "Report"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Asbestos-containing materials ({record.entries.length})</h3>
                {canEdit && (
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => openNewEntry(record)}>
                    <Plus className="w-3 h-3" /> Add entry
                  </Button>
                )}
              </div>
              {record.entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">No materials recorded.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {record.entries.map((entry) => (
                    <li key={entry.id} className="p-2.5 flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium break-words">{entry.location}: <span className="font-normal">{entry.material}</span></p>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-[10px]">{CONDITION_LABELS[entry.condition]}</Badge>
                          <Badge variant="outline" className={cn("text-[10px]", PRIORITY_STYLE[entry.priority])}>
                            {PRIORITY_LABELS[entry.priority]} priority{entry.riskScore != null ? ` (score ${entry.riskScore})` : ""}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">{ACTION_LABELS[entry.action]}</Badge>
                          {entry.lastInspected && <span className="text-[11px] text-muted-foreground">Inspected {fmtDate(entry.lastInspected)}</span>}
                        </div>
                        {entry.notes && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{entry.notes}</p>}
                      </div>
                      {canEdit && (
                        <div className="flex shrink-0">
                          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit ${entry.location}`} onClick={() => openEditEntry(record, entry)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Remove ${entry.location}`} onClick={() => setDeleteEntry(entry)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ))}
        {!isLoading && !error && visible.length === 0 && (
          <div className="rounded-xl border-2 border-dashed border-muted py-12 text-center text-sm text-muted-foreground">
            No asbestos records yet.
          </div>
        )}
      </div>

      <Dialog open={form !== null} onOpenChange={(open) => { if (!open) { setForm(null); setEditing(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit site asbestos record" : "Add site asbestos record"}</DialogTitle>
            <DialogDescription>Record the latest survey and when the management plan is next reviewed.</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SiteSelect value={form.siteId} onChange={(siteId) => setForm({ ...form, siteId })} />
                <div className="space-y-1.5">
                  <Label htmlFor="asbestos-built">Building built before 2000?</Label>
                  <Select value={form.builtBefore2000} onValueChange={(value) => setForm({ ...form, builtBefore2000: value as Built, noAsbestosExpected: value === "no" ? form.noAsbestosExpected : false })}>
                    <SelectTrigger id="asbestos-built"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(BUILT_LABELS) as Built[]).map((key) => <SelectItem key={key} value={key}>{BUILT_LABELS[key]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {form.builtBefore2000 === "no" && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                  <Label htmlFor="asbestos-none">No asbestos expected (post-2000 build)</Label>
                  <Switch id="asbestos-none" checked={form.noAsbestosExpected} onCheckedChange={(noAsbestosExpected) => setForm({ ...form, noAsbestosExpected })} />
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="asbestos-survey-type">Survey type</Label>
                  <Select value={form.surveyType} onValueChange={(value) => setForm({ ...form, surveyType: value as RecordForm["surveyType"] })}>
                    <SelectTrigger id="asbestos-survey-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No survey yet</SelectItem>
                      <SelectItem value="management">{SURVEY_LABELS.management}</SelectItem>
                      <SelectItem value="refurbishment_demolition">{SURVEY_LABELS.refurbishment_demolition}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="asbestos-survey-date">Survey date</Label>
                  <Input id="asbestos-survey-date" type="date" value={form.surveyDate} onChange={(e) => {
                    const surveyDate = e.target.value;
                    setForm({ ...form, surveyDate, planReviewDue: form.planReviewTouched || !surveyDate ? form.planReviewDue : addMonthsIso(surveyDate, 12) });
                  }} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="asbestos-surveyor">Surveyor</Label>
                  <Input id="asbestos-surveyor" value={form.surveyor} maxLength={200} onChange={(e) => setForm({ ...form, surveyor: e.target.value })} />
                </div>
                {!(form.builtBefore2000 === "no" && form.noAsbestosExpected) && (
                  <div className="space-y-1.5">
                    <Label htmlFor="asbestos-plan-review">Management plan review due</Label>
                    <Input id="asbestos-plan-review" type="date" value={form.planReviewDue} onChange={(e) => setForm({ ...form, planReviewDue: e.target.value, planReviewTouched: true })} />
                    <p className="text-[11px] text-muted-foreground">Suggested: 12 months. Change it to suit your plan.</p>
                  </div>
                )}
              </div>
              <DocumentField label="Survey report" value={form.document} onChange={(document) => setForm({ ...form, document })} />
              <div className="space-y-1.5">
                <Label htmlFor="asbestos-notes">Notes</Label>
                <Textarea id="asbestos-notes" rows={2} value={form.notes} maxLength={4000} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setForm(null); setEditing(null); }} disabled={saving}>Cancel</Button>
            <Button onClick={saveRecord} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={entryForm !== null} onOpenChange={(open) => { if (!open) closeEntry(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingEntry ? "Edit register entry" : "Add register entry"}</DialogTitle>
            <DialogDescription>{entryParent ? siteName(entryParent.siteId) : ""}: take the details from the survey report.</DialogDescription>
          </DialogHeader>
          {entryForm && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="entry-location">Location *</Label>
                <Input id="entry-location" value={entryForm.location} maxLength={300} placeholder="For example: boiler room ceiling" onChange={(e) => setEntryForm({ ...entryForm, location: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="entry-material">Material *</Label>
                <Input id="entry-material" value={entryForm.material} maxLength={300} placeholder="For example: asbestos insulating board" onChange={(e) => setEntryForm({ ...entryForm, material: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="entry-condition">Condition</Label>
                  <Select value={entryForm.condition} onValueChange={(value) => setEntryForm({ ...entryForm, condition: value as Condition })}>
                    <SelectTrigger id="entry-condition"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(CONDITION_LABELS) as Condition[]).map((key) => <SelectItem key={key} value={key}>{CONDITION_LABELS[key]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="entry-score">Risk score (optional, 0 to 24)</Label>
                  <Input id="entry-score" inputMode="numeric" value={entryForm.riskScore} onChange={(e) => setEntryForm({ ...entryForm, riskScore: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="entry-priority">Priority</Label>
                  <Select value={entryForm.priority} onValueChange={(value) => setEntryForm({ ...entryForm, priority: value as Priority })}>
                    <SelectTrigger id="entry-priority"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PRIORITY_LABELS) as Priority[]).map((key) => <SelectItem key={key} value={key}>{PRIORITY_LABELS[key]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="entry-action">Action</Label>
                  <Select value={entryForm.action} onValueChange={(value) => setEntryForm({ ...entryForm, action: value as Action })}>
                    <SelectTrigger id="entry-action"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ACTION_LABELS) as Action[]).map((key) => <SelectItem key={key} value={key}>{ACTION_LABELS[key]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="entry-inspected">Last inspected</Label>
                  <Input id="entry-inspected" type="date" value={entryForm.lastInspected} onChange={(e) => setEntryForm({ ...entryForm, lastInspected: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="entry-notes">Notes</Label>
                <Textarea id="entry-notes" rows={2} value={entryForm.notes} maxLength={2000} onChange={(e) => setEntryForm({ ...entryForm, notes: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={closeEntry} disabled={saving}>Cancel</Button>
            <Button onClick={saveEntry} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDelete
        open={deleteRecord !== null}
        title="Remove this site's asbestos record?"
        description="The record and its register entries will no longer show here. Only do this if the record was added in error or the site is no longer yours to manage."
        onCancel={() => setDeleteRecord(null)}
        onConfirm={removeRecord}
      />
      <ConfirmDelete
        open={deleteEntry !== null}
        title="Remove this register entry?"
        description={`"${deleteEntry?.location ?? ""}" will be removed from the register. If the material has been removed by a licensed contractor, note that in the site record.`}
        onCancel={() => setDeleteEntry(null)}
        onConfirm={removeEntry}
      />
    </AppLayout>
  );
}
