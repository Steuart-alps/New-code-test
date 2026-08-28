import { FormEvent, useCallback, useEffect, useState } from "react";
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
import { cn } from "@/lib/utils";

type Severity = "monitor" | "action_required" | "urgent";
type ActionStatus = "open" | "in_progress" | "resolved";

interface TrackAction {
  id: number | string;
  title: string;
  severity: Severity;
  status: ActionStatus;
  siteId?: number | null;
  ownerName?: string | null;
  dueDate?: string | null;
  remedialAction?: string | null;
  evidenceReference?: string | null;
  resolutionNotes?: string | null;
  createdAt?: string | null;
}

interface Site {
  id: number;
  name: string;
}

const emptyDraft = { title: "", severity: "monitor" as Severity, siteId: "", ownerName: "", dueDate: "" };
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
  const { toast } = useToast();
  const [actions, setActions] = useState<TrackAction[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [resolution, setResolution] = useState<Record<string, { remedialAction: string; evidenceReference: string; resolutionNotes: string }>>({});

  const canMutate = user?.role !== "client_viewer" && !!user;
  const loadActions = useCallback(async () => {
    setLoading(true);
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

  async function createAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.title.trim()) return;
    setSubmitting(true);
    try {
      const response = await apiFetch("/track-actions", {
        method: "POST",
        body: JSON.stringify({
          module: moduleKey,
          title: draft.title.trim(),
          severity: draft.severity,
          siteId: draft.siteId ? Number(draft.siteId) : null,
          ...(draft.ownerName.trim() ? { ownerName: draft.ownerName.trim() } : {}),
          ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
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
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="action-title">Action title</Label><Input id="action-title" required value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="Describe the corrective action" /></div>
              <div className="space-y-1.5"><Label htmlFor="action-severity">Severity</Label><Select value={draft.severity} onValueChange={value => setDraft({ ...draft, severity: value as Severity })}><SelectTrigger id="action-severity"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monitor">Monitor</SelectItem><SelectItem value="action_required">Action required</SelectItem><SelectItem value="urgent">Urgent</SelectItem></SelectContent></Select></div>
              <div className="space-y-1.5"><Label htmlFor="action-site">Site <span className="text-muted-foreground">(optional)</span></Label><Select value={draft.siteId || "none"} onValueChange={value => setDraft({ ...draft, siteId: value === "none" ? "" : value })}><SelectTrigger id="action-site"><SelectValue placeholder="No site" /></SelectTrigger><SelectContent><SelectItem value="none">No site</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label htmlFor="action-owner">Owner <span className="text-muted-foreground">(optional)</span></Label><Input id="action-owner" value={draft.ownerName} onChange={event => setDraft({ ...draft, ownerName: event.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="action-due-date">Due date <span className="text-muted-foreground">(optional)</span></Label><Input id="action-due-date" type="date" value={draft.dueDate} onChange={event => setDraft({ ...draft, dueDate: event.target.value })} /></div>
              <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={submitting}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create action</Button><Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button></div>
            </form>
          )}

          <div className="space-y-3" aria-live="polite">
            {loading ? <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading actions…</div> : unresolved.length === 0 ? <p className="rounded-sm border border-dashed py-4 text-center text-sm text-muted-foreground">No unresolved actions for this module.</p> : unresolved.map(action => (
              <ActionRow key={action.id} action={action} sites={sites} siteName={sites.find(site => site.id === action.siteId)?.name} canMutate={canMutate} submitting={submitting} resolution={resolution[String(action.id)]} onResolutionChange={value => setResolution({ ...resolution, [String(action.id)]: value })} onStart={() => updateAction(action, { status: "in_progress" })} onUpdate={patch => updateAction(action, patch)} onResolve={values => updateAction(action, { status: "resolved", ...values })} />
            ))}
          </div>

          {resolved.length > 0 && <Collapsible open={showResolved} onOpenChange={setShowResolved}><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="w-full justify-between text-muted-foreground">Resolved actions ({resolved.length})<ChevronDown className={cn("h-4 w-4 transition-transform", showResolved && "rotate-180")} /></Button></CollapsibleTrigger><CollapsibleContent className="mt-3 space-y-2">{resolved.map(action => <ActionRow key={action.id} action={action} sites={sites} siteName={sites.find(site => site.id === action.siteId)?.name} canMutate={false} submitting={false} />)}</CollapsibleContent></Collapsible>}
        </CardContent>
      </Card>
    </section>
  );
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
  return <article className="rounded-sm border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-[#162D42]">{action.title}</h3><Badge variant="outline" className={cn("capitalize", severityStyles[action.severity] ?? severityStyles.monitor)}>{action.severity.replace("_", " ")}</Badge><Badge variant="outline" className="capitalize">{action.status.replace("_", " ")}</Badge></div><p className="mt-1.5 text-xs text-muted-foreground">{[siteName, action.ownerName && `Owner: ${action.ownerName}`, due && `Due: ${due}`].filter(Boolean).join(" · ") || "No site, owner or due date recorded"}</p></div>{canMutate && <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" aria-expanded={editing} onClick={() => setEditing(value => !value)}>Edit details</Button>{action.status === "open" && <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={onStart}><CircleDot className="mr-1.5 h-4 w-4" />Start action</Button>}</div>}</div>{editing && canMutate && <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2"><div className="space-y-1.5 sm:col-span-2"><Label htmlFor={`${fieldId}-title`}>Action title</Label><Input id={`${fieldId}-title`} value={details.title} onChange={event => setDetails({ ...details, title: event.target.value })} /></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-severity`}>Severity</Label><Select value={details.severity} onValueChange={value => setDetails({ ...details, severity: value as Severity })}><SelectTrigger id={`${fieldId}-severity`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monitor">Monitor</SelectItem><SelectItem value="action_required">Action required</SelectItem><SelectItem value="urgent">Urgent</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-site`}>Site <span className="text-muted-foreground">(optional)</span></Label><Select value={details.siteId || "none"} onValueChange={value => setDetails({ ...details, siteId: value === "none" ? "" : value })}><SelectTrigger id={`${fieldId}-site`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No site</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-owner`}>Owner <span className="text-muted-foreground">(optional)</span></Label><Input id={`${fieldId}-owner`} value={details.ownerName} onChange={event => setDetails({ ...details, ownerName: event.target.value })} /></div><div className="space-y-1.5"><Label htmlFor={`${fieldId}-due`}>Due date <span className="text-muted-foreground">(optional)</span></Label><Input id={`${fieldId}-due`} type="date" value={details.dueDate} onChange={event => setDetails({ ...details, dueDate: event.target.value })} /></div><div className="flex gap-2 sm:col-span-2"><Button type="button" size="sm" disabled={submitting || !details.title.trim()} onClick={() => onUpdate?.({ title: details.title.trim(), severity: details.severity, siteId: details.siteId ? Number(details.siteId) : null, ownerName: details.ownerName.trim() || null, dueDate: details.dueDate || null })}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save details</Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div></div>}{action.status === "resolved" ? <div className="mt-3 border-t pt-3 text-sm text-muted-foreground space-y-1"><p><strong className="text-foreground">Remedial action:</strong> {action.remedialAction || "Not recorded"}</p><p><strong className="text-foreground">Evidence:</strong> {action.evidenceReference || "Not recorded"}</p><p><strong className="text-foreground">Resolution notes:</strong> {action.resolutionNotes || "Not recorded"}</p></div> : canMutate && <div className="mt-3 border-t pt-3"><Button type="button" size="sm" variant="outline" onClick={() => setResolving(value => !value)}><CheckCircle2 className="mr-1.5 h-4 w-4" />Resolve action</Button>{resolving && <div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Remedial action</Label><Textarea value={values.remedialAction} onChange={event => onResolutionChange?.({ ...values, remedialAction: event.target.value })} /></div><div className="space-y-1.5"><Label>Evidence reference</Label><Input value={values.evidenceReference} onChange={event => onResolutionChange?.({ ...values, evidenceReference: event.target.value })} placeholder="Photo, record or document reference" /></div><div className="space-y-1.5 sm:col-span-2"><Label>Resolution notes</Label><Textarea value={values.resolutionNotes} onChange={event => onResolutionChange?.({ ...values, resolutionNotes: event.target.value })} /></div><div><Button type="button" size="sm" disabled={submitting || !canResolve} onClick={() => onResolve?.(values)}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm resolution</Button></div></div>}</div>}</article>;
}