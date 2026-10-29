import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  InspectionReportDetail, InspectionReportDraftAction, InspectionReportOptions, InspectionReportSummary, InspectionReportType,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useWorkingSiteId } from "@/hooks/use-working-site";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { downloadBlob, getDownloadErrorMessage } from "@/lib/download";
import { takeLinkParams } from "@/lib/deep-link";
import { assertWithinUploadLimit } from "@/lib/upload-limits";
import { useFileDrop } from "@/hooks/use-file-drop";
import { cn } from "@/lib/utils";
import { AiAllowanceNote, aiAllowanceState } from "@/components/ai-allowance-note";
import { Download, FileSearch, Loader2, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { sortByLabel } from "@/lib/sort-options";

type Draft = InspectionReportDraftAction & { key: string };
type Severity = InspectionReportDraftAction["severity"];

const WHOLE_BUSINESS = "none";
const NOBODY = "none";
const SEVERITY_LABELS: Record<Severity, string> = { urgent: "Urgent", action_required: "Action required", monitor: "Recommendation" };
const SEVERITY_STYLES: Record<Severity, string> = {
  urgent: "bg-red-50 text-red-800 border-red-200",
  action_required: "bg-amber-50 text-amber-800 border-amber-200",
  monitor: "bg-slate-100 text-slate-700 border-slate-200",
};
const TRACK_PAGES: Record<string, string> = {
  daily_am: "/daily-track-am", daily_pm: "/daily-track-pm", kitchen: "/kitchen", fire: "/fire-safety", legionella: "/legionella",
  pool: "/aqua-track", pat: "/pat-track", pest: "/pest-track", fix: "/fix-track", premises: "/premises-track", doc: "/doc-track",
  safe: "/doc-track", train: "/train-track", hot_tub: "/hot-tub", tree: "/tree-track", bike: "/bike-track", green: "/green-track",
  swim: "/aqua-track", incident: "/incidents", room: "/room-track", coshh: "/coshh-track",
};

// A report can be a document, photos of its pages, or a video walk-round.
// ComplyTrack reads PDF, Word and photos; for anything else the actions are typed in.
const REPORT_FILE_ACCEPT = ".pdf,.docx,.doc,.jpg,.jpeg,.png,.webp,.txt,.mp4,.mov,.webm,application/pdf,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm";
const REPORT_FILE_EXTENSIONS = /\.(pdf|docx?|jpe?g|png|webp|txt|mp4|mov|webm)$/i;

const actionsText = (count: number) => `${count} ${count === 1 ? "action" : "actions"}`;

let draftKey = 0;
const withKey = (action: InspectionReportDraftAction): Draft => ({ ...action, key: `d${++draftKey}` });
const blankAction = (siteId: number | null): Draft => withKey({
  title: "", instruction: "", module: "audit", severity: "action_required", siteId, dueDate: null,
  assignedUserId: null, reportReference: null, draftSource: "manual",
});
const stripKey = ({ key: _key, ...action }: Draft): InspectionReportDraftAction => ({
  ...action, title: action.title.trim(), instruction: action.instruction?.trim() || null, reportReference: action.reportReference?.trim() || null,
});

function formatDate(value: string | null | undefined) {
  if (!value) return null;
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

async function readJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, fallback));
  return await res.json() as T;
}

function personLabel(person: InspectionReportOptions["assignees"][number]) {
  const role = person.role === "client_admin" ? "Owner" : person.isMaintenanceManager ? "Maintenance manager" : "Manager";
  return `${person.name} (${role})`;
}

function UploadDialog({ open, onClose, options, onUploaded }: {
  open: boolean; onClose: () => void; options: InspectionReportOptions; onUploaded: (id: number) => void;
}) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [reportType, setReportType] = useState<InspectionReportType>("alps_audit");
  const [reportDate, setReportDate] = useState("");
  const [siteId, setSiteId] = useState(WHOLE_BUSINESS);
  const [busy, setBusy] = useState(false);
  // A new report starts on the user's working site.
  const workingSiteId = useWorkingSiteId();
  useEffect(() => { if (open) setSiteId(workingSiteId ? String(workingSiteId) : WHOLE_BUSINESS); }, [open]);

  function choose(picked: File | null) {
    if (picked && !REPORT_FILE_EXTENSIONS.test(picked.name)) {
      toast({ title: "That type of file can't be uploaded", description: "Use a PDF, Word file, photo (JPEG, PNG or WebP) or video (MP4, MOV or WebM).", variant: "destructive" });
      return;
    }
    setFile(picked);
    if (picked && !title) setTitle(picked.name.replace(/\.[^.]+$/, ""));
  }
  const drop = useFileDrop((files) => choose(files[0] ?? null), open && !busy);

  function reset() {
    setFile(null); setTitle(""); setReportType("alps_audit"); setReportDate(""); setSiteId(WHOLE_BUSINESS); setBusy(false);
  }

  async function submit() {
    if (!file || !title.trim()) return;
    setBusy(true);
    try {
      assertWithinUploadLimit(file);
      const presign = await apiFetch("/storage/uploads/request-url", {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
      });
      if (!presign.ok) throw new Error(await getApiErrorMessage(presign, "Couldn't prepare the upload"));
      const { uploadURL, objectPath } = await presign.json();
      const put = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!put.ok) throw new Error("The file didn't upload. Please try again.");
      const created = await apiFetch("/inspection-reports", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(), reportType, reportDate: reportDate || null,
          siteId: siteId === WHOLE_BUSINESS ? null : Number(siteId), objectPath, fileName: file.name,
        }),
      });
      if (!created.ok) throw new Error(await getApiErrorMessage(created, "Couldn't save the report"));
      const report = await created.json();
      toast({ title: "Report uploaded" });
      reset();
      onUploaded(report.id);
    } catch (error) {
      toast({ title: "Upload failed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload a report</DialogTitle>
          <DialogDescription>An audit, inspection or survey report. PDF works best; Word files, photos of each page and videos work too. ComplyTrack can suggest actions from a PDF, Word file or photo; for a video, type the actions in.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="report-file">File</Label>
            <div
              {...drop.dropZoneProps}
              className={cn("space-y-2 rounded-sm border border-dashed p-3 transition-colors", drop.isDragging ? "border-primary bg-primary/5" : "border-border")}
              data-testid="dropzone-report-file"
            >
              <Input id="report-file" type="file" accept={REPORT_FILE_ACCEPT}
                onChange={(event) => { choose(event.target.files?.[0] ?? null); event.target.value = ""; }} />
              <p className="text-xs text-muted-foreground">
                {file ? `Chosen: ${file.name}` : <><span className="hidden sm:inline">Drag the file here, or </span>choose it above.</>}
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-title">Name</Label>
            <Input id="report-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="For example: Care Inspectorate inspection, October 2026" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="report-type">Type of report</Label>
              <Select value={reportType} onValueChange={(value) => setReportType(value as InspectionReportType)}>
                <SelectTrigger id="report-type"><SelectValue /></SelectTrigger>
                <SelectContent>{sortByLabel(options.reportTypes, (type) => type.label).map((type) => <SelectItem key={type.key} value={type.key}>{type.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-date">Date of the report <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="report-date" type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-site">Site</Label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger id="report-site"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={WHOLE_BUSINESS}>Whole business</SelectItem>
                {options.sites.map((site) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button disabled={busy || !file || !title.trim()} onClick={submit}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftRow({ action, index, options, onChange, onRemove }: {
  action: Draft; index: number; options: InspectionReportOptions; onChange: (next: Draft) => void; onRemove: () => void;
}) {
  const id = `draft-${action.key}`;
  const set = (patch: Partial<Draft>) => onChange({ ...action, ...patch });
  return (
    <div className="rounded-sm border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-[#162D42]">
          Action {index + 1}
          {action.draftSource === "ai" && <Badge variant="outline" className="gap-1 border-violet-200 bg-violet-50 text-violet-800"><Sparkles className="h-3 w-3" />Suggested by ComplyTrack</Badge>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove action ${index + 1}`}><Trash2 className="h-4 w-4" /></Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-title`}>What needs doing</Label>
        <Input id={`${id}-title`} dictation value={action.title} onChange={(event) => set({ title: event.target.value })} placeholder="For example: Repair the self-closer on the first-floor fire door" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-details`}>Details <span className="text-muted-foreground">(optional)</span></Label>
        <Textarea id={`${id}-details`} rows={2} value={action.instruction ?? ""} onChange={(event) => set({ instruction: event.target.value })} placeholder="Where, and what the report asks for" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-assignee`}>Assigned to</Label>
          <Select value={action.assignedUserId ? String(action.assignedUserId) : NOBODY} onValueChange={(value) => set({ assignedUserId: value === NOBODY ? null : Number(value) })}>
            <SelectTrigger id={`${id}-assignee`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NOBODY}>Not assigned yet</SelectItem>
              {options.assignees.map((person) => <SelectItem key={person.id} value={String(person.id)}>{personLabel(person)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-severity`}>Priority</Label>
          <Select value={action.severity} onValueChange={(value) => set({ severity: value as Severity })}>
            <SelectTrigger id={`${id}-severity`}><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(SEVERITY_LABELS) as Severity[]).map((key) => <SelectItem key={key} value={key}>{SEVERITY_LABELS[key]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-due`}>Due date <span className="text-muted-foreground">(optional)</span></Label>
          <Input id={`${id}-due`} type="date" value={action.dueDate ?? ""} onChange={(event) => set({ dueDate: event.target.value || null })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-track`}>Track</Label>
          <Select value={action.module} onValueChange={(value) => set({ module: value })}>
            <SelectTrigger id={`${id}-track`}><SelectValue /></SelectTrigger>
            <SelectContent>{sortByLabel(options.modules, (module) => module.label).map((module) => <SelectItem key={module.key} value={module.key}>{module.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-site`}>Site</Label>
          <Select value={action.siteId ? String(action.siteId) : WHOLE_BUSINESS} onValueChange={(value) => set({ siteId: value === WHOLE_BUSINESS ? null : Number(value) })}>
            <SelectTrigger id={`${id}-site`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={WHOLE_BUSINESS}>Whole business</SelectItem>
              {options.sites.map((site) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reference`}>Where in the report <span className="text-muted-foreground">(optional)</span></Label>
          <Input id={`${id}-reference`} value={action.reportReference ?? ""} onChange={(event) => set({ reportReference: event.target.value })} placeholder="For example: Requirement 2, page 4" />
        </div>
      </div>
    </div>
  );
}

type CreatedAction = InspectionReportDetail["actions"][number];

/** An action made from the report, with its "Assigned to" picker (the action plan email's buttons open here). */
function CreatedActionRow({ action, options, focused, moduleLabel, siteName, onAssigned }: {
  action: CreatedAction; options: InspectionReportOptions; focused: boolean;
  moduleLabel: (key: string) => string; siteName: (siteId: number | null | undefined) => string; onAssigned: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  const page = TRACK_PAGES[action.module];
  // The person (their reminders reach them), or a name typed elsewhere for someone without an account.
  const value = action.assigneeUserId != null ? String(action.assigneeUserId) : action.ownerName ? "typed" : NOBODY;
  const listed = action.assigneeUserId != null && options.assignees.some((person) => person.id === action.assigneeUserId);

  const [dueDate, setDueDate] = useState(action.dueDate?.slice(0, 10) ?? "");
  useEffect(() => { setDueDate(action.dueDate?.slice(0, 10) ?? ""); }, [action.dueDate]);
  const resolved = action.status === "resolved";

  async function save(patch: { assigneeUserId?: number | null; dueDate?: string | null }, done: string) {
    setSaving(true);
    try {
      const res = await apiFetch(`/track-actions/${action.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Couldn't save the change"));
      toast({ title: done });
      onAssigned();
    } catch (err) {
      toast({ title: "Not saved", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
      setDueDate(action.dueDate?.slice(0, 10) ?? "");
    } finally { setSaving(false); }
  }
  const assign = (next: string) => {
    const person = options.assignees.find((candidate) => String(candidate.id) === next);
    return save({ assigneeUserId: person?.id ?? null }, person ? `Assigned to ${person.name}` : "No longer assigned");
  };
  const saveDueDate = () => {
    const next = dueDate || null;
    if (next === (action.dueDate?.slice(0, 10) ?? null)) return;
    void save({ dueDate: next }, next ? `Due date changed to ${formatDate(next)}` : "Due date removed");
  };
  const lastMove = action.dueDateChanges?.at(-1);

  return (
    <li ref={rowRef} className={`flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between ${focused ? "bg-amber-50 ring-2 ring-inset ring-amber-300" : ""}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{action.title}</span>
          <Badge variant="outline" className={SEVERITY_STYLES[action.severity]}>{SEVERITY_LABELS[action.severity]}</Badge>
          <Badge variant="outline" className="capitalize">{action.status.replace("_", " ")}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {[moduleLabel(action.module), siteName(action.siteId),
            action.confirmedByName && `${action.draftSource === "ai" ? "AI-drafted, confirmed by" : "Confirmed by"} ${action.confirmedByName}`].filter(Boolean).join(" · ")}
        </p>
        {lastMove && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Due date changed from {formatDate(lastMove.from) ?? "none"} to {formatDate(lastMove.to) ?? "none"}
            {lastMove.changedByName && ` by ${lastMove.changedByName}`} on {formatDate(lastMove.changedAt)}
            {action.dueDateChanges!.length > 1 && ` (changed ${action.dueDateChanges!.length} times)`}
          </p>
        )}
        {page && <a href={page} className="mt-1 inline-block text-xs font-medium underline underline-offset-2">Open {moduleLabel(action.module)}</a>}
      </div>
      <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-[26rem] sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`due-${action.id}`} className="text-xs">Due date</Label>
          <Input id={`due-${action.id}`} type="date" className="h-9" value={dueDate} disabled={saving || resolved}
            onChange={(event) => setDueDate(event.target.value)} onBlur={saveDueDate}
            onKeyDown={(event) => { if (event.key === "Enter") saveDueDate(); }} />
        </div>
        <div className="space-y-1">
        <Label htmlFor={`assign-${action.id}`} className="text-xs">Assigned to</Label>
        <Select value={value} defaultOpen={focused && !action.ownerName} disabled={saving || resolved} onValueChange={(next) => { if (next !== value && next !== "typed") void assign(next); }}>
          <SelectTrigger id={`assign-${action.id}`} className="h-9">{saving ? <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving…</span> : <SelectValue />}</SelectTrigger>
          <SelectContent>
            <SelectItem value={NOBODY}>Not assigned yet</SelectItem>
            {options.assignees.map((person) => <SelectItem key={person.id} value={String(person.id)}>{personLabel(person)}</SelectItem>)}
            {value === "typed" && <SelectItem value="typed">{action.ownerName}</SelectItem>}
            {action.assigneeUserId != null && !listed && <SelectItem value={value}>{action.ownerName || "Former member"}</SelectItem>}
          </SelectContent>
        </Select>
        </div>
      </div>
    </li>
  );
}

function ReportDetail({ reportId, options, focusActionId, onRemoved }: {
  reportId: number; options: InspectionReportOptions; focusActionId: number | null; onRemoved: () => void;
}) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: report, isLoading, error } = useQuery({
    queryKey: ["inspection-report", activeClientId, reportId],
    queryFn: () => readJson<InspectionReportDetail>(`/inspection-reports/${reportId}`, "Couldn't load the report"),
  });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const newRow = useFocusNewRow<HTMLElement>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "read" | "save" | "confirm" | "remove" | "download">(null);
  const [checked, setChecked] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (report && !dirty) setDrafts(report.draftActions.map(withKey));
  }, [report, dirty]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inspection-report", activeClientId, reportId] });
    void queryClient.invalidateQueries({ queryKey: ["inspection-reports"] });
    void queryClient.invalidateQueries({ queryKey: ["inspection-report-options"] });
  };
  const update = (next: Draft[]) => { setDrafts(next); setDirty(true); setChecked(false); };
  const siteName = (siteId: number | null | undefined) => siteId ? options.sites.find((site) => site.id === siteId)?.name ?? "Another site" : "Whole business";
  const moduleLabel = (key: string) => options.modules.find((module) => module.key === key)?.label ?? key;
  const anyAi = drafts.some((action) => action.draftSource === "ai");
  const incomplete = drafts.some((action) => !action.title.trim());

  async function send(path: string, method: string, body?: unknown) {
    const res = await apiFetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new Error(await getApiErrorMessage(res, "Something went wrong. Please try again."));
    return res.status === 204 ? null : await res.json();
  }

  async function run(kind: NonNullable<typeof busy>, work: () => Promise<void>, failure: string) {
    setBusy(kind);
    try { await work(); } catch (err) {
      toast({ title: failure, description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally { setBusy(null); }
  }

  const readReport = () => run("read", async () => {
    if (drafts.length && !window.confirm("Replace the list below with ComplyTrack's suggestions?")) return;
    const reading = await send(`/inspection-reports/${reportId}/read`, "POST");
    setDrafts((reading.draftActions as InspectionReportDraftAction[]).map(withKey));
    setDirty(false);
    setChecked(false);
    toast({ title: reading.draftActions.length ? `${actionsText(reading.draftActions.length)} suggested` : "No actions found", description: "Check each one against the report before creating them." });
    refresh();
  }, "Couldn't read the report");

  const saveDraft = () => run("save", async () => {
    await send(`/inspection-reports/${reportId}/draft`, "PUT", { actions: drafts.map(stripKey) });
    setDirty(false);
    toast({ title: "List saved", description: "Nothing has been created yet." });
    refresh();
  }, "Couldn't save the list");

  const confirm = () => run("confirm", async () => {
    const result = await send(`/inspection-reports/${reportId}/confirm`, "POST", { actions: drafts.map(stripKey) });
    setDrafts([]);
    setDirty(false);
    setChecked(false);
    const emailed: string[] = result.emailedTo ?? [];
    toast({
      title: `${actionsText(result.actions.length)} created`,
      description: emailed.length
        ? `The action plan was emailed to ${emailed.join(", ")}, with a button to assign each action.`
        : "Each one is in its track's action list.",
    });
    refresh();
    void queryClient.invalidateQueries();
  }, "Couldn't create the actions");

  const download = () => run("download", async () => {
    const res = await apiFetch(`/inspection-reports/${reportId}/file`);
    if (!res.ok) throw new Error(await getDownloadErrorMessage(res, "Couldn't download the report"));
    downloadBlob(await res.blob(), report?.fileName ?? `report-${reportId}`);
  }, "Download failed");

  const remove = () => run("remove", async () => {
    await send(`/inspection-reports/${reportId}`, "DELETE");
    toast({ title: "Report removed" });
    void queryClient.invalidateQueries({ queryKey: ["inspection-reports"] });
    onRemoved();
  }, "Couldn't remove the report");

  if (isLoading) return <Card className="p-6 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading the report…</Card>;
  if (error || !report) return <Card className="p-6 text-sm text-destructive">{error instanceof Error ? error.message : "Report not found"}</Card>;

  const reading = options.reading;
  const typeLabel = options.reportTypes.find((type) => type.key === report.reportType)?.label ?? "Report";
  return (
    <Card className="rounded-sm p-5 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-[#162D42]">{report.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {[typeLabel, formatDate(report.reportDate), siteName(report.siteId), `Uploaded by ${report.uploadedByName}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={download}>
            {busy === "download" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}Download report
          </Button>
          {report.actions.length === 0 && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(true)}><Trash2 className="mr-1.5 h-4 w-4" />Remove</Button>}
        </div>
      </div>

      <section ref={newRow.ref} className="space-y-3">
        <h3 className="font-bold text-[#162D42]">Actions to create</h3>
        {reading.available && report.readable ? (
          <div className="rounded-sm border border-violet-200 bg-violet-50/60 p-4 text-sm space-y-2">
            <p>ComplyTrack can read this report and suggest the actions it asks for. The report is sent to Anthropic, our AI provider, to read; it isn't used to train their AI. It takes up to two minutes. You check every action before anything is created.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={busy !== null || !aiAllowanceState(reading.ai).canUse || (reading.monthlyLimit > 0 && reading.usedThisMonth >= reading.monthlyLimit)} onClick={readReport}>
                {busy === "read" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                {busy === "read" ? "Reading the report…" : report.aiReadCount > 0 ? "Suggest actions again" : "Suggest actions from the report"}
              </Button>
              {reading.ai.active && reading.monthlyLimit > 0 && <span className="text-xs text-muted-foreground">{reading.usedThisMonth} of {reading.monthlyLimit} reports read this month</span>}
            </div>
            <AiAllowanceNote ai={reading.ai} />
            {report.aiStatus === "failed" && report.aiError && <p className="text-destructive">{report.aiError}</p>}
          </div>
        ) : reading.available ? (
          <p className="text-sm text-muted-foreground">ComplyTrack can't read this type of file. Type the actions in below, or upload the report as a PDF.</p>
        ) : (
          <p className="text-sm text-muted-foreground">Type the actions in from the report below.</p>
        )}
        {report.aiSummary && <p className="rounded-sm bg-muted/50 px-3 py-2 text-sm"><strong>Summary of the report:</strong> {report.aiSummary}</p>}

        {drafts.map((action, index) => (
          <DraftRow key={action.key} action={action} index={index} options={options}
            onChange={(next) => update(drafts.map((item) => item.key === action.key ? next : item))}
            onRemove={() => update(drafts.filter((item) => item.key !== action.key))} />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => { newRow.expect(); update([...drafts, blankAction(report.siteId)]); }}>
          <Plus className="mr-1.5 h-4 w-4" />Add an action
        </Button>

        {drafts.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            {anyAi && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={checked} onCheckedChange={(value) => setChecked(value === true)} className="mt-0.5" />
                <span>I have checked these actions against the report.</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy !== null || incomplete || (anyAi && !checked)} onClick={confirm}>
                {busy === "confirm" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create {actionsText(drafts.length)}
              </Button>
              <Button variant="outline" disabled={busy !== null || incomplete || !dirty} onClick={saveDraft}>
                {busy === "save" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save for later
              </Button>
            </div>
            {incomplete && <p className="text-xs text-muted-foreground">Every action needs a "What needs doing".</p>}
          </div>
        )}
      </section>

      {report.actions.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-bold text-[#162D42]">Actions created from this report</h3>
          <ul className="divide-y rounded-sm border">
            {report.actions.map((action) => (
              <CreatedActionRow key={action.id} action={action} options={options} focused={action.id === focusActionId}
                moduleLabel={moduleLabel} siteName={siteName} onAssigned={refresh} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Actions in "Report actions" are listed at the bottom of this page, where they are started and signed off.</p>
        </section>
      )}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this report?</AlertDialogTitle>
            <AlertDialogDescription>The file and any unsaved list are deleted. Do this only if it was uploaded by mistake.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function ReportActionsPage() {
  const { activeClientId } = useAuth();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  // The action plan email links to /report-actions?report=ID&action=ID.
  const [link] = useState(() => {
    const params = takeLinkParams(["report", "action"] as const);
    const id = (value: string | undefined) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; };
    return { report: id(params?.report), action: id(params?.action) };
  });
  const [selected, setSelected] = useState<number | null>(link.report);
  const { data: options, error: optionsError } = useQuery({
    queryKey: ["inspection-report-options", activeClientId],
    queryFn: () => readJson<InspectionReportOptions>("/inspection-reports/options", "Couldn't load the report settings"),
  });
  const { data: reports = [], isLoading } = useQuery({
    queryKey: ["inspection-reports", activeClientId],
    queryFn: () => readJson<InspectionReportSummary[]>("/inspection-reports", "Couldn't load reports"),
  });
  const typeLabels = useMemo(() => new Map(options?.reportTypes.map((type) => [type.key, type.label]) ?? []), [options]);
  const siteNames = useMemo(() => new Map(options?.sites.map((site) => [site.id, site.name]) ?? []), [options]);

  return (
    <AppLayout title="Report actions">
      <div className="space-y-5">
        <Card className="rounded-sm p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <FileSearch className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-[#162D42]">Turn an audit or inspection report into actions</p>
                <p className="text-muted-foreground">
                  Upload an ALPS audit, Care Inspectorate, Environmental Health, fire officer or insurer report.
                  {options?.reading.available && options.reading.ai.active ? " ComplyTrack suggests the actions it asks for." : " Type in the actions it asks for."}
                  {" "}You check them, choose who does each one, and confirm. The report stays with its actions as evidence.
                </p>
              </div>
            </div>
            <Button className="shrink-0" disabled={!options} onClick={() => setUploading(true)}><Upload className="mr-2 h-4 w-4" />Upload a report</Button>
          </div>
        </Card>
        {optionsError && <p className="text-sm text-destructive">{optionsError instanceof Error ? optionsError.message : "Couldn't load the page"}</p>}

        <Card className="rounded-sm">
          {isLoading ? (
            <p className="p-5 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading reports…</p>
          ) : reports.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No reports uploaded yet.</p>
          ) : (
            <ul className="divide-y">
              {reports.map((report) => {
                const status = report.actionCount > 0
                  ? `${actionsText(report.actionCount)}, ${report.openCount} still open`
                  : report.draftCount > 0 ? `${actionsText(report.draftCount)} waiting to be checked` : "No actions yet";
                return (
                  <li key={report.id}>
                    <button type="button" onClick={() => setSelected(report.id)}
                      className={`flex w-full flex-col gap-1 px-5 py-3 text-left hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between ${selected === report.id ? "bg-muted/60" : ""}`}>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-[#162D42]">{report.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {[typeLabels.get(report.reportType), formatDate(report.reportDate), report.siteId ? siteNames.get(report.siteId) : "Whole business"].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <span className={`shrink-0 text-xs ${report.actionCount === 0 && report.draftCount > 0 ? "font-medium text-amber-700" : "text-muted-foreground"}`}>{status}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {selected && options && <ReportDetail key={selected} reportId={selected} options={options}
          focusActionId={selected === link.report ? link.action : null} onRemoved={() => setSelected(null)} />}
        {options && <UploadDialog open={uploading} onClose={() => setUploading(false)} options={options}
          onUploaded={(id) => { setUploading(false); setSelected(id); void queryClient.invalidateQueries({ queryKey: ["inspection-reports"] }); }} />}
      </div>
    </AppLayout>
  );
}
