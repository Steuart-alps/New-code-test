import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ClipboardCheck, Loader2, Plus, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type EvidenceStatus = "recorded" | "verified" | "rejected";
type EvidenceType = "observation" | "photo" | "document" | "certificate" | "test_result" | "verification" | "other";
interface Evidence {
  id: number;
  siteId?: number | null;
  actionId?: number | null;
  evidenceType: EvidenceType;
  title: string;
  details: string;
  reference?: string | null;
  recordedByName: string;
  recordedAt: string;
  reviewStatus: EvidenceStatus;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
}
interface EvidenceRequirement {
  requirementKey: string;
  title: string;
  description: string;
  evidenceType: EvidenceType;
  minimumCount: number;
  reviewRequired: boolean;
  recordedCount: number;
  verifiedCount: number;
  rejectedCount: number;
  missingCount: number;
  satisfied: boolean;
}
interface ActionOption { id: number | string; title: string; status: string; }
interface SiteOption { id: number; name: string; }

const initialDraft = {
  evidenceType: "observation" as EvidenceType,
  title: "",
  details: "",
  reference: "",
  siteId: "",
  actionId: "",
  requirementKey: "",
};

function errorMessage(data: unknown, fallback: string) {
  return typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : fallback;
}

function requirementStatusLabel(requirement: EvidenceRequirement) {
  const acceptableCount = requirement.recordedCount + requirement.verifiedCount;
  let status: string;
  if (requirement.reviewRequired) {
    status = requirement.satisfied
      ? `Verified ${requirement.verifiedCount}/${requirement.minimumCount}`
      : acceptableCount === 0
        ? `Missing ${requirement.missingCount}`
        : `Verified ${requirement.verifiedCount}/${requirement.minimumCount} · ${requirement.recordedCount} recorded`;
  } else {
    status = requirement.satisfied
      ? `Recorded ${acceptableCount}/${requirement.minimumCount}`
      : `Missing ${requirement.missingCount} · Recorded ${acceptableCount}/${requirement.minimumCount}`;
  }
  return requirement.rejectedCount > 0 ? `${status} · ${requirement.rejectedCount} rejected` : status;
}

export function TrackEvidencePanel({ moduleKey, actions, sites, canMutate }: {
  moduleKey: string;
  actions: ActionOption[];
  sites: SiteOption[];
  canMutate: boolean;
}) {
  const { toast } = useToast();
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [requirements, setRequirements] = useState<EvidenceRequirement[]>([]);
  const [profileActionId, setProfileActionId] = useState("");
  const [draft, setDraft] = useState(initialDraft);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");

  const loadEvidence = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch(`/track-evidence?module=${encodeURIComponent(moduleKey)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to load evidence"));
      setEvidence(Array.isArray(data) ? data : []);
    } catch (error) {
      toast({ title: "Couldn't load inspection evidence", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [moduleKey, toast]);

  useEffect(() => { void loadEvidence(); }, [loadEvidence]);

  const loadRequirements = useCallback(async () => {
    try {
      const action = profileActionId ? `&actionId=${encodeURIComponent(profileActionId)}` : "";
      const response = await apiFetch(`/track-evidence/requirements?module=${encodeURIComponent(moduleKey)}${action}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to load evidence requirements"));
      setRequirements(Array.isArray(data) ? data : []);
    } catch (error) {
      setRequirements([]);
      toast({ title: "Couldn't load evidence requirements", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    }
  }, [moduleKey, profileActionId, toast]);

  useEffect(() => { void loadRequirements(); }, [loadRequirements]);

  async function createEvidence() {
    if (!draft.title.trim() || !draft.details.trim()) return;
    setSaving(true);
    try {
      const response = await apiFetch("/track-evidence", {
        method: "POST",
        body: JSON.stringify({
          module: moduleKey,
          evidenceType: draft.evidenceType,
          requirementKey: draft.requirementKey || null,
          title: draft.title.trim(),
          details: draft.details.trim(),
          reference: draft.reference.trim() || null,
          siteId: draft.siteId ? Number(draft.siteId) : null,
          actionId: draft.actionId ? Number(draft.actionId) : null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to record evidence"));
      setDraft(initialDraft);
      setShowCreate(false);
      toast({ title: "Inspection evidence recorded" });
      await loadEvidence();
      await loadRequirements();
    } catch (error) {
      toast({ title: "Couldn't record evidence", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function reviewEvidence(id: number, status: "verified" | "rejected") {
    if (!reviewNotes.trim()) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/track-evidence/${id}/review`, {
        method: "POST",
        body: JSON.stringify({ status, reviewNotes: reviewNotes.trim() }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "Unable to review evidence"));
      setReviewingId(null);
      setReviewNotes("");
      toast({ title: status === "verified" ? "Evidence independently verified" : "Evidence marked for follow-up" });
      await loadEvidence();
    } catch (error) {
      toast({ title: "Couldn't review evidence", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="rounded-sm border-[#162D42]/15 shadow-sm">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-[#162D42]"><ClipboardCheck className="h-5 w-5 text-primary" /> Inspection evidence</CardTitle>
          <CardDescription className="mt-1">Record the observation, supporting reference and authenticated recorder for this track. Evidence cannot be edited or deleted.</CardDescription>
        </div>
        {canMutate && <Button type="button" size="sm" className="rounded-sm self-start" onClick={() => setShowCreate(value => !value)}><Plus className="mr-1.5 h-4 w-4" />Record evidence</Button>}
      </CardHeader>
      <CardContent className="space-y-4">
        {requirements.length > 0 && <div className="rounded-sm border bg-slate-50 p-4">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-medium text-[#162D42]">Required evidence profile</p>
              <p className="text-xs text-muted-foreground">Structured requirements apply to source-linked FireTrack, LegionellaTrack and failed-temperature KitchenTrack actions. KitchenTrack’s manager verifies corrective-action evidence with their final signature. Evidence marked for independent review must be verified before sign-off.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {profileActionId
                  ? `Showing closure-specific evidence for action #${profileActionId}.`
                  : "Showing aggregate counts across this track; select an action to see its closure-specific status."}
              </p>
            </div>
            <div className="w-full space-y-1 sm:max-w-xs">
              <Label htmlFor="track-evidence-action-scope">Action status</Label>
              <Select value={profileActionId || "all-actions"} onValueChange={value => setProfileActionId(value === "all-actions" ? "" : value)}>
                <SelectTrigger id="track-evidence-action-scope" data-testid="select-evidence-action-scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all-actions">Across all actions</SelectItem>
                  {actions.map(action => <SelectItem key={action.id} value={String(action.id)}>#{action.id} · {action.status.replace("_", " ")} · {action.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">{requirements.map(requirement => <div key={requirement.requirementKey} data-testid={`status-evidence-requirement-${requirement.requirementKey}`} className="rounded-sm border bg-white p-3"><div className="flex items-start justify-between gap-2"><p className="text-sm font-medium">{requirement.title}</p><Badge data-testid={`status-evidence-progress-${requirement.requirementKey}`} variant={requirement.satisfied ? "default" : "outline"}>{requirementStatusLabel(requirement)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{requirement.description}</p><p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{requirement.evidenceType.replace("_", " ")}{requirement.reviewRequired ? " · independent review required" : ""}</p></div>)}</div>
        </div>}
        {showCreate && canMutate && (
          <div className="grid gap-3 rounded-sm border bg-muted/30 p-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Requirement <span className="text-muted-foreground">(optional for general evidence)</span></Label><Select value={draft.requirementKey || "general"} onValueChange={value => { const requirement = requirements.find(item => item.requirementKey === value); setDraft({ ...draft, requirementKey: value === "general" ? "" : value, evidenceType: requirement?.evidenceType ?? draft.evidenceType }); }}><SelectTrigger><SelectValue placeholder="General evidence" /></SelectTrigger><SelectContent><SelectItem value="general">General evidence</SelectItem>{requirements.map(requirement => <SelectItem key={requirement.requirementKey} value={requirement.requirementKey}>{requirement.title}</SelectItem>)}</SelectContent></Select>{draft.requirementKey && !draft.actionId && <p className="text-xs text-amber-700">Select a related action before saving required evidence.</p>}</div>
            <div className="space-y-1.5"><Label>Evidence type</Label><Select disabled={!!draft.requirementKey} value={draft.evidenceType} onValueChange={value => setDraft({ ...draft, evidenceType: value as EvidenceType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(["observation", "photo", "document", "certificate", "test_result", "verification", "other"] as EvidenceType[]).map(type => <SelectItem key={type} value={type}>{type.replace("_", " ")}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label>Site <span className="text-muted-foreground">(optional)</span></Label><Select value={draft.siteId || "none"} onValueChange={value => { setDraft({ ...draft, siteId: value === "none" ? "" : value, actionId: "" }); setProfileActionId(""); }}><SelectTrigger><SelectValue placeholder="No site" /></SelectTrigger><SelectContent><SelectItem value="none">No site</SelectItem>{sites.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Evidence title</Label><Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="What was observed or verified?" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Details</Label><Textarea value={draft.details} onChange={event => setDraft({ ...draft, details: event.target.value })} placeholder="Record the condition, measurement, location, decision or action taken." /></div>
            <div className="space-y-1.5"><Label>Reference <span className="text-muted-foreground">(optional)</span></Label><Input value={draft.reference} onChange={event => setDraft({ ...draft, reference: event.target.value })} placeholder="Photo, certificate or document reference" /></div>
            <div className="space-y-1.5"><Label>Related action <span className="text-muted-foreground">(optional unless a requirement is selected)</span></Label><Select value={draft.actionId || "none"} onValueChange={value => { const actionId = value === "none" ? "" : value; setDraft({ ...draft, actionId, requirementKey: value === "none" ? "" : draft.requirementKey }); setProfileActionId(actionId); }}><SelectTrigger><SelectValue placeholder="No corrective action" /></SelectTrigger><SelectContent><SelectItem value="none">No corrective action</SelectItem>{actions.map(action => <SelectItem key={action.id} value={String(action.id)}>#{action.id} — {action.title}</SelectItem>)}</SelectContent></Select></div>
            <div className="flex gap-2 sm:col-span-2"><Button type="button" disabled={saving || !draft.title.trim() || !draft.details.trim() || (!!draft.requirementKey && !draft.actionId)} onClick={() => void createEvidence()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save evidence</Button><Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button></div>
          </div>
        )}
        {loading ? <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading evidence…</div> : evidence.length === 0 ? <p className="rounded-sm border border-dashed py-4 text-center text-sm text-muted-foreground">No inspection evidence recorded for this track.</p> : <div className="space-y-3">{evidence.map(item => (
          <article key={item.id} className="rounded-sm border bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-[#162D42]">{item.title}</h3><Badge variant="outline" className="capitalize">{item.evidenceType.replace("_", " ")}</Badge><Badge variant={item.reviewStatus === "verified" ? "default" : item.reviewStatus === "rejected" ? "destructive" : "secondary"}>{item.reviewStatus}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Recorded by {item.recordedByName} · {new Date(item.recordedAt).toLocaleString()}</p></div>{item.actionId && <Badge variant="outline">Action #{item.actionId}</Badge>}</div>
            <p className="mt-3 whitespace-pre-wrap text-sm">{item.details}</p>
            {item.reference && <p className="mt-2 text-xs text-muted-foreground"><strong className="text-foreground">Reference:</strong> {item.reference}</p>}
            {item.reviewedByName && <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">Reviewed by <strong className="text-foreground">{item.reviewedByName}</strong>{item.reviewNotes ? ` — ${item.reviewNotes}` : ""}</p>}
            {canMutate && item.reviewStatus === "recorded" && (reviewingId === item.id ? <div className="mt-3 space-y-2 border-t pt-3"><Label htmlFor={`review-${item.id}`}>Independent review note</Label><Textarea id={`review-${item.id}`} value={reviewNotes} onChange={event => setReviewNotes(event.target.value)} placeholder="Explain why this evidence is accepted or needs follow-up." /><div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={saving || !reviewNotes.trim()} onClick={() => void reviewEvidence(item.id, "verified")}><CheckCircle2 className="mr-1.5 h-4 w-4" />Verify evidence</Button><Button type="button" size="sm" variant="outline" disabled={saving || !reviewNotes.trim()} onClick={() => void reviewEvidence(item.id, "rejected")}><XCircle className="mr-1.5 h-4 w-4" />Needs follow-up</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setReviewingId(null); setReviewNotes(""); }}>Cancel</Button></div></div> : <div className="mt-3 border-t pt-3"><Button type="button" size="sm" variant="outline" onClick={() => setReviewingId(item.id)}>Review evidence</Button></div>)}
          </article>
        ))}</div>}
      </CardContent>
    </Card>
  );
}