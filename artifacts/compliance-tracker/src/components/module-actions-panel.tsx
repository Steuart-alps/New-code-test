import { FormEvent, useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KitchenActionAudit } from "./kitchen-action-audit";
import { CheckCircle2, ChevronDown, CircleDot, Loader2, Plus, Wrench } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DrawnSignatureDialog } from "@/components/drawn-signature-dialog";
import { TrackEvidencePanel } from "@/components/track-evidence-panel";
import { cn } from "@/lib/utils";

type Severity = "monitor" | "action_required" | "urgent";
type ActionStatus = "open" | "in_progress" | "resolved";

export interface TrackAction {
  id: number | string;
  title: string;
  severity: Severity;
  status: ActionStatus;
  siteId?: number | null;
  ownerName?: string | null;
  ownerDefault?: string | null;
  dueDate?: string | null;
  remedialAction?: string | null;
  evidenceReference?: string | null;
  resolutionNotes?: string | null;
  resolvedByName?: string | null;
  resolverSignature?: string | null;
  instruction?: string | null;
  instructionSnapshot?: string | null;
  sourceKind?: string | null;
  sourceRecordId?: number | null;
  fixTrackIssueId?: number | null;
  fixTrackDisposition?: "linked" | "not_needed" | null;
  provenance?: "product_default" | "template" | "one_off" | null;
  templateId?: number | null;
  createdAt?: string | null;
}

interface Site {
  id: number;
  name: string;
}

interface RequiredActionTemplate {
  id: number | string;
  module?: string | null;
  moduleKey?: string | null;
  title: string;
  instruction?: string | null;
  severity?: Severity | null;
  ownerName?: string | null;
  ownerDefault?: string | null;
  defaultOwner?: string | null;
  leadTimeDays?: number | null;
  defaultLeadTimeDays?: number | null;
  siteId?: number | null;
  departmentId?: number | null;
  enabled?: boolean;
  active?: boolean;
}

const emptyDraft = { title: "", instruction: "", severity: "monitor" as Severity, siteId: "", ownerName: "", dueDate: "", templateId: "" };
type ResolutionValues = { remedialAction: string; evidenceReference: string; resolutionNotes: string };
const severityStyles: Record<Severity, string> = {
  monitor: "bg-slate-100 text-slate-700 border-slate-200",
  action_required: "bg-amber-50 text-amber-800 border-amber-200",
  urgent: "bg-red-50 text-red-800 border-red-200",
};

function errorMessage(data: unknown, fallback: string) {
  return typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : fallback;
}

export function ModuleActionsPanel({ moduleKey }: { moduleKey: string }) {
  const { user, activeClientId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [actions, setActions] = useState<TrackAction[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [templates, setTemplates] = useState<RequiredActionTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [resolution, setResolution] = useState<Record<string, ResolutionValues>>({});
  const [pendingSignature, setPendingSignature] = useState<{ action: TrackAction; values: ResolutionValues } | null>(null);

  const kitchenManager = user?.role === "client_admin" || user?.role === "consultant";
  const canMutate = user?.role !== "client_viewer" && !!user && (moduleKey !== "kitchen" || kitchenManager);
  const loadActions = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    void queryClient.invalidateQueries({ queryKey: ["kitchen-action-audit"] });
    try {
      const [actionsResponse, sitesResponse] = await Promise.all([
        apiFetch(`/track-actions?module=${encodeURIComponent(moduleKey)}`),
        apiFetch("/sites"),
      ]);
      const [actionsData, sitesData] = await Promise.all([
        actionsResponse.json().catch(() => null),
        sitesResponse.json().catch(() => null),
      ]);
      if (!actionsResponse.ok) throw new Error(errorMessage(actionsData, "Unable to load actions"));
      if (!sitesResponse.ok) throw new Error(errorMessage(sitesData, "Unable to load sites"));
      setActions(Array.isArray(actionsData) ? actionsData : Array.isArray(actionsData?.actions) ? actionsData.actions : []);
      setSites(Array.isArray(sitesData) ? sitesData : Array.isArray(sitesData?.sites) ? sitesData.sites : []);
    } catch (error) {
      toast({ title: "Couldn't load module actions", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [activeClientId, moduleKey, toast]);

  useEffect(() => { void loadActions(); }, [loadActions]);
  useEffect(() => {
    if (moduleKey !== "kitchen") return;
    const refresh = () => { void loadActions(true); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("kitchen-actions-changed", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("kitchen-actions-changed", refresh); };
  }, [moduleKey, loadActions]);
  useEffect(() => {
    let cancelled = false;
    const site = draft.siteId ? `&siteId=${encodeURIComponent(draft.siteId)}` : "";
    void apiFetch(`/track-actions/templates/matching?module=${encodeURIComponent(moduleKey)}${site}`)
      .then(async response => ({ response, data: await response.json().catch(() => null) }))
      .then(({ response, data }) => {
        if (cancelled) return;
        const list = response.ok ? (Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : []) : [];
        setTemplates(list.filter((template: RequiredActionTemplate) => template.active ?? true));
      })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [activeClientId, draft.siteId, moduleKey]);

  function selectTemplate(templateId: string) {
    if (templateId === "one-off") {
      setDraft(emptyDraft);
      return;
    }
    const template = templates.find(item => String(item.id) === templateId);
    if (!template) return;
    const leadTimeDays = template.leadTimeDays ?? template.defaultLeadTimeDays ?? 0;
    const dueDate = leadTimeDays > 0
      ? new Date(Date.now() + leadTimeDays * 86_400_000).toISOString().slice(0, 10)
      : "";
    setDraft({
      title: template.title,
      instruction: template.instruction ?? "",
      severity: template.severity ?? "action_required",
      siteId: template.siteId ? String(template.siteId) : "",
      ownerName: template.ownerDefault ?? template.ownerName ?? template.defaultOwner ?? "",
      dueDate,
      templateId,
    });
  }

  async function createAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.title.trim()) return;
    setSubmitting(true);
    try {
      const response = await apiFetch("/track-actions", {
        method: "POST",
        body: JSON.stringify(draft.templateId ? {
          module: moduleKey,
          templateId: Number(draft.templateId),
          siteId: draft.siteId ? Number(draft.siteId) : null,
        } : {
          module: moduleKey,
          title: draft.title.trim(),
          severity: draft.severity,
          siteId: draft.siteId ? Number(draft.siteId) : null,
          ...(draft.ownerName.trim() ? { ownerName: draft.ownerName.trim() } : {}),
          ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
          instruction: draft.instruction.trim() || null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to create action"));
      setDraft(emptyDraft);
      setShowCreate(false);
      toast({ title: "Action created" });
      await loadActions();
    } catch (error) {
      toast({ title: "Couldn't create action", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function updateAction(action: TrackAction, patch: Record<string, unknown>) {
    setSubmitting(true);
    try {
      const response = await apiFetch(`/track-actions/${action.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to update action"));
      toast({ title: patch.status === "resolved" ? "Action resolved" : "Action updated" });
      await loadActions();
    } catch (error) {
      toast({ title: "Couldn't update action", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function decideFixTrack(action: TrackAction, create: boolean) {
    setSubmitting(true);
    try {
      const response = await apiFetch(`/track-actions/${action.id}/fix-track`, {
        method: "POST",
        body: JSON.stringify({ create }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to update the FixTrack link"));
      toast({ title: create ? "Added to FixTrack" : "Action kept in this track" });
      await loadActions();
    } catch (error) {
      toast({ title: "Couldn't update FixTrack", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  const unresolved = actions.filter(action => action.status !== "resolved");
  const resolved = actions.filter(action => action.status === "resolved");

  return (
    <section aria-labelledby="module-actions-heading" className="pt-2">
      <Card className="rounded-sm border-[#162D42]/15 shadow-sm">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle id="module-actions-heading" className="flex items-center gap-2 text-[#162D42]">
              <Wrench className="h-5 w-5 text-primary" /> Module actions
            </CardTitle>
            <CardDescription className="mt-1">Corrective actions raised from this module stay with its operational records.</CardDescription>
          </div>
          {canMutate && <Button type="button" size="sm" className="rounded-sm self-start" onClick={() => setShowCreate(value => !value)}><Plus className="mr-1.5 h-4 w-4" />Add action</Button>}
        </CardHeader>
        <CardContent className="space-y-4">
          {showCreate && canMutate && (
            <form onSubmit={createAction} className="grid gap-3 rounded-sm border bg-muted/30 p-4 sm:grid-cols-2">
               <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="action-template">Start from a required-action template <span className="text-muted-foreground">(optional)</span></Label><Select value={draft.templateId || "one-off"} onValueChange={selectTemplate}><SelectTrigger id="action-template"><SelectValue placeholder="Create a one-off action" /></SelectTrigger><SelectContent><SelectItem value="one-off">One-off action</SelectItem>{templates.map(template => <SelectItem key={template.id} value={String(template.id)}>{template.title}</SelectItem>)}</SelectContent></Select>{draft.templateId && <p className="text-xs text-muted-foreground">The current approved template is copied into the action as an immutable snapshot. Choose one-off to customise it first.</p>}</div>
               <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="action-title">Action title</Label><Input id="action-title" required disabled={!!draft.templateId} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="Describe the corrective action" /></div>
               <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="action-instruction">Instruction snapshot <span className="text-muted-foreground">(optional)</span></Label><Textarea id="action-instruction" disabled={!!draft.templateId} value={draft.instruction} onChange={event => setDraft({ ...draft, instruction: event.target.value })} placeholder="What needs to be done and how" /></div>
               <div className="space-y-1.5"><Label htmlFor="action-severity">Severity</Label><Select disabled={!!draft.templateId} value={draft.severity} onValueChange={value => setDraft({ ...draft, severity: value as Severity })}><SelectTrigger id="action-severity"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monitor">Monitor</SelectItem><SelectItem value="action_required">Action required</SelectItem><SelectItem value="urgent">Urgent</SelectItem></SelectContent></Select></div>
               <div className="space-y-1.5"><Label htmlFor="action-site">Site <span className="text-muted-foreground">(optional)</span></Label><Select value={draft.siteId || "none"} onValueChange={value => setDraft({ ...draft, siteId: value === "none" ? "" : value, templateId: "" })}><SelectTrigger id="action-site"><SelectValue placeholder="No site" /></SelectTrigger><SelectContent><SelectItem value="none">No site</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div>
               <div className="space-y-1.5"><Label htmlFor="action-owner">Owner <span className="text-muted-foreground">(optional)</span></Label><Input id="action-owner" disabled={!!draft.templateId} value={draft.ownerName} onChange={event => setDraft({ ...draft, ownerName: event.target.value })} /></div>
               <div className="space-y-1.5"><Label htmlFor="action-due-date">Due date <span className="text-muted-foreground">(optional)</span></Label><Input id="action-due-date" disabled={!!draft.templateId} type="date" value={draft.dueDate} onChange={event => setDraft({ ...draft, dueDate: event.target.value })} /></div>
              <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={submitting}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create action</Button><Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button></div>
            </form>
          )}

          <div className="space-y-3" aria-live="polite">
            {loading ? <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading actions…</div> : unresolved.length === 0 ? <p className="rounded-sm border border-dashed py-4 text-center text-sm text-muted-foreground">No unresolved actions for this module.</p> : unresolved.map(action => (
              <div key={action.id}>
                <ActionRow action={action} sites={sites} siteName={sites.find(site => site.id === action.siteId)?.name} canMutate={canMutate} submitting={submitting} resolution={resolution[String(action.id)]} onResolutionChange={value => setResolution({ ...resolution, [String(action.id)]: value })} onStart={() => updateAction(action, { status: "in_progress" })} onUpdate={patch => updateAction(action, patch)} onResolve={values => action.fixTrackIssueId ? toast({ title: "Complete this action in FixTrack", description: `Resolve FixTrack issue #${action.fixTrackIssueId} to update this module automatically.` }) : setPendingSignature({ action, values })} />
                {moduleKey !== "green" && <FixTrackChoice action={action} canMutate={canMutate} submitting={submitting} onDecision={create => decideFixTrack(action, create)} />}
              </div>
            ))}
          </div>

          {resolved.length > 0 && <Collapsible open={showResolved} onOpenChange={setShowResolved}><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="w-full justify-between text-muted-foreground">Resolved actions ({resolved.length})<ChevronDown className={cn("h-4 w-4 transition-transform", showResolved && "rotate-180")} /></Button></CollapsibleTrigger><CollapsibleContent className="mt-3 space-y-2">{resolved.map(action => <div key={action.id}><ActionRow action={action} sites={sites} siteName={sites.find(site => site.id === action.siteId)?.name} canMutate={false} submitting={false} />{action.resolvedByName && <div className="-mt-3 border-x border-b bg-slate-50 px-4 pb-3 text-xs text-muted-foreground"><p>Signed off as complete by <strong className="text-foreground">{action.resolvedByName}</strong></p>{action.resolverSignature && <img src={action.resolverSignature} alt={`Signature of ${action.resolvedByName}`} className="mt-2 h-14 max-w-52 rounded-sm border bg-white object-contain" />}</div>}</div>)}</CollapsibleContent></Collapsible>}
        </CardContent>
      </Card>
       <TrackEvidencePanel
         moduleKey={moduleKey}
         actions={actions.map(action => ({ id: action.id, title: action.title, status: action.status }))}
         sites={sites}
         canMutate={canMutate}
       />
      <DrawnSignatureDialog open={!!pendingSignature} busy={submitting} onCancel={() => setPendingSignature(null)} onConfirm={async resolverSignature => {
        if (!pendingSignature) return;
        await updateAction(pendingSignature.action, { status: "resolved", ...pendingSignature.values, resolverSignature });
        setPendingSignature(null);
      }} />
      {moduleKey === "kitchen" && kitchenManager && actions.filter(action => action.sourceKind?.startsWith("kitchen_temperature_")).map(action =>
        <div key={`audit-${action.id}`} className="px-4"><p className="text-sm font-medium">{action.title}</p><KitchenActionAudit actionId={action.id} /></div>
      )}
    </section>
  );
}

function FixTrackChoice({ action, canMutate, submitting, onDecision }: { action: TrackAction; canMutate: boolean; submitting: boolean; onDecision: (create: boolean) => void }) {
  if (action.sourceKind?.startsWith("kitchen_temperature_")) return null;
  if (action.fixTrackIssueId) return <div className="-mt-3 rounded-b-sm border-x border-b bg-blue-50 px-4 pb-3 pt-2 text-xs text-blue-900">Linked to <a className="font-semibold underline" href={`/fix-track/${action.fixTrackIssueId}`}>FixTrack issue #{action.fixTrackIssueId}</a>. Resolving it will complete this action.</div>;
  if (!canMutate) return null;
  return <div className="-mt-3 flex flex-wrap items-center gap-2 rounded-b-sm border-x border-b bg-slate-50 px-4 pb-3 pt-2 text-xs"><span>{action.fixTrackDisposition === "not_needed" ? "Kept in this track. Add it to FixTrack now?" : "Does this action require FixTrack repair or contractor work?"}</span><Button type="button" size="sm" variant="outline" className="h-7" disabled={submitting} onClick={() => onDecision(true)}>Yes, add to FixTrack</Button>{action.fixTrackDisposition !== "not_needed" && <Button type="button" size="sm" variant="ghost" className="h-7" disabled={submitting} onClick={() => onDecision(false)}>No</Button>}</div>;
}

function ActionRow({ action, sites, siteName, canMutate, submitting, resolution, onResolutionChange, onStart, onUpdate, onResolve }: { action: TrackAction; sites: Site[]; siteName?: string; canMutate: boolean; submitting: boolean; resolution?: { remedialAction: string; evidenceReference: string; resolutionNotes: string }; onResolutionChange?: (value: { remedialAction: string; evidenceReference: string; resolutionNotes: string }) => void; onStart?: () => void; onUpdate?: (patch: Record<string, unknown>) => void; onResolve?: (value: { remedialAction: string; evidenceReference: string; resolutionNotes: string }) => void }) {
  const [resolving, setResolving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState({
    title: action.title,
    severity: action.severity,
    siteId: action.siteId ? String(action.siteId) : "",
    ownerName: action.ownerName ?? "",
    dueDate: action.dueDate?.slice(0, 10) ?? "",
  });
  const values = resolution ?? { remedialAction: "", evidenceReference: "", resolutionNotes: "" };
  const canResolve = values.remedialAction.trim() && values.evidenceReference.trim() && values.resolutionNotes.trim();
  const due = action.dueDate ? new Date(`${action.dueDate}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  const fieldId = `action-${action.id}`;
  const provenance = action.provenance === "product_default" || action.sourceKind ? "Product default" : action.provenance === "template" || action.templateId ? "Client template" : "One-off";
  const instruction = action.instructionSnapshot ?? action.instruction;
  return <article className="rounded-sm border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-[#162D42]">{action.title}</h3><Badge variant="outline" className={cn("capitalize", severityStyles[action.severity] ?? severityStyles.monitor)}>{action.severity.replace("_", " ")}</Badge><Badge variant="outline" className="capitalize">{action.status.replace("_", " ")}</Badge><Badge variant="secondary">{provenance}</Badge></div><p className="mt-1.5 text-xs text-muted-foreground">{[siteName, action.ownerName && `Owner: ${action.ownerName}`, due && `Due: ${due}`].filter(Boolean).join(" · ") || "No site, owner or due date recorded"}</p>{instruction && <p className="mt-2 rounded-sm bg-muted/50 px-2.5 py-2 text-sm text-muted-foreground"><strong className="text-foreground">Instruction snapshot:</strong> {instruction}</p>}</div>{canMutate && <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" aria-expanded={editing} onClick={() => setEditing(value => !value)}>Edit details</Button>{action.status === "open" && <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={onStart}><CircleDot className="mr-1.5 h-4 w-4" />Start action</Button>}</div>}</div>{editing && canMutate && <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2"><div className="space-y-1.5 sm:col-span-2"><Label htmlFor={`${fieldId}-title`}>Action title</Label><Input id={`${fieldId}-title`} value={details.title} onChange={event => setDetails({ ...details, title: event.target.value })} /></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-severity`}>Severity</Label><Select value={details.severity} onValueChange={value => setDetails({ ...details, severity: value as Severity })}><SelectTrigger id={`${fieldId}-severity`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monitor">Monitor</SelectItem><SelectItem value="action_required">Action required</SelectItem><SelectItem value="urgent">Urgent</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-site`}>Site <span className="text-muted-foreground">(optional)</span></Label><Select value={details.siteId || "none"} onValueChange={value => setDetails({ ...details, siteId: value === "none" ? "" : value })}><SelectTrigger id={`${fieldId}-site`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No site</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-owner`}>Owner <span className="text-muted-foreground">(optional)</span></Label><Input id={`${fieldId}-owner`} value={details.ownerName} onChange={event => setDetails({ ...details, ownerName: event.target.value })} /></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-due`}>Due date <span className="text-muted-foreground">(optional)</span></Label><Input id={`${fieldId}-due`} type="date" value={details.dueDate} onChange={event => setDetails({ ...details, dueDate: event.target.value })} /></div><div className="flex gap-2 sm:col-span-2"><Button type="button" size="sm" disabled={submitting || !details.title.trim()} onClick={() => onUpdate?.({ title: details.title.trim(), severity: details.severity, siteId: details.siteId ? Number(details.siteId) : null, ownerName: details.ownerName.trim() || null, dueDate: details.dueDate || null })}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save details</Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div></div>}{action.status === "resolved" ? <div className="mt-3 border-t pt-3 text-sm text-muted-foreground space-y-1"><p><strong className="text-foreground">Remedial action:</strong> {action.remedialAction || "Not recorded"}</p><p><strong className="text-foreground">Evidence:</strong> {action.evidenceReference || "Not recorded"}</p><p><strong className="text-foreground">Resolution notes:</strong> {action.resolutionNotes || "Not recorded"}</p></div> : canMutate && <div className="mt-3 border-t pt-3"><Button type="button" size="sm" variant="outline" onClick={() => setResolving(value => !value)}><CheckCircle2 className="mr-1.5 h-4 w-4" />Resolve action</Button>{resolving && <div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Remedial action</Label><Textarea value={values.remedialAction} onChange={event => onResolutionChange?.({ ...values, remedialAction: event.target.value })} /></div><div className="space-y-1.5"><Label>Evidence reference</Label><Input value={values.evidenceReference} onChange={event => onResolutionChange?.({ ...values, evidenceReference: event.target.value })} placeholder="Photo, record or document reference" /></div><div className="space-y-1.5 sm:col-span-2"><Label>Resolution notes</Label><Textarea value={values.resolutionNotes} onChange={event => onResolutionChange?.({ ...values, resolutionNotes: event.target.value })} /></div><div><Button type="button" size="sm" disabled={submitting || !canResolve} onClick={() => onResolve?.(values)}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm resolution</Button></div></div>}</div>}</article>;
}