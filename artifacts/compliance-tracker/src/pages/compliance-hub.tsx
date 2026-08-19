import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, BookOpen, CheckCircle2, ExternalLink, Plus, ShieldCheck, UserRoundCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Appointment = { area: string; person: string; evidence?: string | null };
type Profile = {
  nation: "england" | "wales" | "scotland" | "northern_ireland" | "multi_nation";
  operationType: string; responsiblePersonName: string; responsiblePersonRole: string;
  responsiblePersonEmail?: string | null; competentAppointments: Appointment[];
  reviewCadence: string; nextReviewDate: string; haccpSystemReviewed: boolean;
  waterWrittenSchemeReference?: string | null;
};
type Guidance = { track: string; title: string; classification: string; applicability: string; url: string; reviewNote: string };
type Action = {
  id: number; sourceTrack: string; sourceRecordId?: string | null; title: string;
  severity: "low" | "medium" | "high" | "critical"; status: "open" | "in_progress" | "awaiting_verification" | "verified";
  ownerName: string; dueDate?: string | null; interimControl?: string | null; correctiveAction: string;
  evidenceReference?: string | null; verificationNotes?: string | null;
};

const emptyProfile: Profile = {
  nation: "england", operationType: "", responsiblePersonName: "", responsiblePersonRole: "",
  responsiblePersonEmail: "", competentAppointments: [], reviewCadence: "Annual review and after material change",
  nextReviewDate: "", haccpSystemReviewed: false,
  waterWrittenSchemeReference: "",
};
const emptyAction = {
  sourceTrack: "FireTrack", sourceRecordId: "", title: "", severity: "medium" as const,
  ownerName: "", dueDate: "", interimControl: "", correctiveAction: "", evidenceReference: "",
};
const trackOptions = ["FireTrack", "KitchenTrack", "LegionellaTrack", "AquaTrack", "TubTrack", "PATtrack", "IncidentTrack", "PremisesTrack", "TreeTrack", "PestTrack", "BikeTrack", "GreenTrack", "FixTrack", "DocTrack", "TrainTrack", "DailyTrack"];

export default function ComplianceHubPage() {
  const { activeClientId, user } = useAuth();
  const canAdmin = useCanAdmin();
  const canEdit = user?.role !== "client_viewer";
  const { toast } = useToast();
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [guidance, setGuidance] = useState<Guidance[]>([]);
  const [disclaimer, setDisclaimer] = useState("");
  const [actions, setActions] = useState<Action[]>([]);
  const [actionDraft, setActionDraft] = useState(emptyAction);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const [editingAction, setEditingAction] = useState<number | null>(null);
  const [actionUpdate, setActionUpdate] = useState({ status: "open", evidenceReference: "", verificationNotes: "" });
  const loadGeneration = useRef(0);
  const clientQuery = user?.role === "consultant" && activeClientId ? `?clientId=${activeClientId}` : "";
  const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}${clientQuery}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "Request failed");
    return data as T;
  }

  async function refresh() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const [loadedProfile, loadedGuidance, loadedActions] = await Promise.all([
        request<Profile | null>("/compliance-hub/profile"),
        request<{ guidance: Guidance[]; disclaimer: string }>("/compliance-hub/guidance"),
        request<Action[]>("/compliance-hub/actions"),
      ]);
      if (generation !== loadGeneration.current) return;
      setProfile(loadedProfile ? { ...emptyProfile, ...loadedProfile, competentAppointments: loadedProfile.competentAppointments ?? [] } : emptyProfile);
      setGuidance(loadedGuidance.guidance);
      setDisclaimer(loadedGuidance.disclaimer);
      setActions(loadedActions);
    } catch (error: any) {
      if (generation !== loadGeneration.current) return;
      toast({ title: "Couldn't load Compliance Hub", description: error.message, variant: "destructive" });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    // Prevent a prior consultant-client response from ever being rendered and
    // subsequently saved against the newly selected client.
    loadGeneration.current++;
    setProfile(emptyProfile);
    setActions([]);
    void refresh();
  }, [activeClientId]);

  const guidanceGroups = useMemo(() => guidance.reduce<Record<string, Guidance[]>>((all, item) => {
    (all[item.track] ??= []).push(item); return all;
  }, {}), [guidance]);

  async function saveProfile() {
    const generation = loadGeneration.current;
    setSavingProfile(true);
    try {
      const saved = await request<Profile>("/compliance-hub/profile", { method: "PUT", body: JSON.stringify(profile) });
      if (generation !== loadGeneration.current) return;
      setProfile(saved);
      toast({ title: "Accountability profile saved", description: "Review it whenever your operation, risk assessment or appointments change." });
    } catch (error: any) {
      toast({ title: "Couldn't save profile", description: error.message, variant: "destructive" });
    } finally { setSavingProfile(false); }
  }

  async function createAction() {
    const generation = loadGeneration.current;
    setSavingAction(true);
    try {
      await request<Action>("/compliance-hub/actions", { method: "POST", body: JSON.stringify(actionDraft) });
      if (generation !== loadGeneration.current) return;
      setActionDraft(emptyAction);
      await refresh();
      toast({ title: "Corrective action logged", description: "Assign evidence and verification before closing it." });
    } catch (error: any) {
      toast({ title: "Couldn't log action", description: error.message, variant: "destructive" });
    } finally { setSavingAction(false); }
  }

  async function updateAction(id: number) {
    const generation = loadGeneration.current;
    try {
      await request<Action>(`/compliance-hub/actions/${id}`, { method: "PATCH", body: JSON.stringify(actionUpdate) });
      if (generation !== loadGeneration.current) return;
      setEditingAction(null);
      await refresh();
      toast({ title: actionUpdate.status === "verified" ? "Action verified closed" : "Corrective action updated" });
    } catch (error: any) {
      toast({ title: "Couldn't update action", description: error.message, variant: "destructive" });
    }
  }

  function beginEditingAction(action: Action) {
    setEditingAction(action.id);
    setActionUpdate({ status: action.status, evidenceReference: action.evidenceReference ?? "", verificationNotes: action.verificationNotes ?? "" });
  }

  return (
    <AppLayout title="Compliance Hub">
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex gap-3 p-5 text-sm text-foreground">
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary mt-0.5" />
          <div><strong>Evidence, not a compliance certificate.</strong> {disclaimer || "This workspace helps organise records, source material and corrective actions."}</div>
        </CardContent>
      </Card>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="profile">Accountability profile</TabsTrigger>
          <TabsTrigger value="actions">Corrective actions {actions.filter(a => a.status !== "verified").length ? `(${actions.filter(a => a.status !== "verified").length})` : ""}</TabsTrigger>
          <TabsTrigger value="guidance">Sources & scope</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="flex gap-2 items-center"><UserRoundCheck className="h-5 w-5 text-primary" />Who is accountable?</CardTitle>
              <CardDescription>Set the jurisdiction, responsible person and competent appointments that make checklist use meaningful for this client.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2"><Label>Primary jurisdiction</Label><Select value={profile.nation} disabled={!canAdmin} onValueChange={nation => setProfile({ ...profile, nation: nation as Profile["nation"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="england">England</SelectItem><SelectItem value="wales">Wales</SelectItem><SelectItem value="scotland">Scotland</SelectItem><SelectItem value="northern_ireland">Northern Ireland</SelectItem><SelectItem value="multi_nation">Multiple UK nations</SelectItem>
              </SelectContent></Select></div>
              <Field label="Premises / operation type" value={profile.operationType} disabled={!canAdmin} onChange={operationType => setProfile({ ...profile, operationType })} placeholder="e.g. hospitality venue with commercial kitchen" />
              <Field label="Responsible person" value={profile.responsiblePersonName} disabled={!canAdmin} onChange={responsiblePersonName => setProfile({ ...profile, responsiblePersonName })} placeholder="Named duty holder" />
              <Field label="Responsible person's role" value={profile.responsiblePersonRole} disabled={!canAdmin} onChange={responsiblePersonRole => setProfile({ ...profile, responsiblePersonRole })} placeholder="e.g. Director / premises manager" />
              <Field label="Responsible person's email (optional)" type="email" value={profile.responsiblePersonEmail ?? ""} disabled={!canAdmin} onChange={responsiblePersonEmail => setProfile({ ...profile, responsiblePersonEmail })} />
              <Field label="Review cadence" value={profile.reviewCadence} disabled={!canAdmin} onChange={reviewCadence => setProfile({ ...profile, reviewCadence })} />
              <div className="space-y-2"><Label>Next review date</Label><Input type="date" disabled={!canAdmin} value={profile.nextReviewDate} onChange={e => setProfile({ ...profile, nextReviewDate: e.target.value })} /></div>
              <div className="space-y-2"><Label>HACCP system review</Label><Select disabled={!canAdmin} value={profile.haccpSystemReviewed ? "reviewed" : "not-reviewed"} onValueChange={v => setProfile({ ...profile, haccpSystemReviewed: v === "reviewed" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="not-reviewed">Not yet confirmed</SelectItem><SelectItem value="reviewed">Reviewed for this operation</SelectItem></SelectContent></Select></div>
              <div className="space-y-2 md:col-span-2"><Label>Water written-scheme reference (where water systems, pools or spas apply)</Label><Input disabled={!canAdmin} value={profile.waterWrittenSchemeReference ?? ""} onChange={e => setProfile({ ...profile, waterWrittenSchemeReference: e.target.value })} placeholder="Document title, revision and storage reference" /><p className="text-xs text-muted-foreground">Record the current risk-assessed written scheme; its controls and monitoring frequencies must not be assumed from generic defaults.</p></div>
              <div className="md:col-span-2 space-y-3 pt-2">
                <div><Label>Competent-person appointments</Label><p className="text-xs text-muted-foreground mt-1">Record the person and evidence of appointment/competence for specialist risk areas. This is not a substitute for checking qualifications.</p></div>
                {profile.competentAppointments.map((appointment, index) => <div key={index} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                  <Input disabled={!canAdmin} value={appointment.area} placeholder="Area (e.g. Legionella)" onChange={e => setProfile({ ...profile, competentAppointments: profile.competentAppointments.map((a, i) => i === index ? { ...a, area: e.target.value } : a) })} />
                  <Input disabled={!canAdmin} value={appointment.person} placeholder="Person / organisation" onChange={e => setProfile({ ...profile, competentAppointments: profile.competentAppointments.map((a, i) => i === index ? { ...a, person: e.target.value } : a) })} />
                  <Input disabled={!canAdmin} value={appointment.evidence ?? ""} placeholder="Evidence reference" onChange={e => setProfile({ ...profile, competentAppointments: profile.competentAppointments.map((a, i) => i === index ? { ...a, evidence: e.target.value } : a) })} />
                  {canAdmin && <Button variant="ghost" onClick={() => setProfile({ ...profile, competentAppointments: profile.competentAppointments.filter((_, i) => i !== index) })}>Remove</Button>}
                </div>)}
                {canAdmin && <Button variant="outline" size="sm" onClick={() => setProfile({ ...profile, competentAppointments: [...profile.competentAppointments, { area: "", person: "", evidence: "" }] })}><Plus className="mr-1 h-4 w-4" />Add appointment</Button>}
              </div>
              {canAdmin && <div className="md:col-span-2"><Button disabled={savingProfile} onClick={saveProfile}>{savingProfile ? "Saving…" : "Save accountability profile"}</Button></div>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="actions" className="space-y-6">
          {canEdit && <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-primary" />Log a corrective action</CardTitle><CardDescription>Link any finding to its track and record. A different client admin or consultant must verify closure after evidence is recorded.</CardDescription></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2"><Label>Source track</Label><Select value={actionDraft.sourceTrack} onValueChange={sourceTrack => setActionDraft({ ...actionDraft, sourceTrack })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{trackOptions.map(track => <SelectItem key={track} value={track}>{track}</SelectItem>)}</SelectContent></Select></div>
              <Field label="Record reference (optional)" value={actionDraft.sourceRecordId} onChange={sourceRecordId => setActionDraft({ ...actionDraft, sourceRecordId })} placeholder="e.g. Fire check #42" />
              <Field label="Finding / action title" value={actionDraft.title} onChange={title => setActionDraft({ ...actionDraft, title })} placeholder="Describe the issue that needs controlling" />
              <Field label="Action owner" value={actionDraft.ownerName} onChange={ownerName => setActionDraft({ ...actionDraft, ownerName })} placeholder="Named person or contractor" />
              <div className="space-y-2"><Label>Severity</Label><Select value={actionDraft.severity} onValueChange={severity => setActionDraft({ ...actionDraft, severity: severity as typeof actionDraft.severity })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["low", "medium", "high", "critical"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
              <Field type="date" label="Due date (optional)" value={actionDraft.dueDate} onChange={dueDate => setActionDraft({ ...actionDraft, dueDate })} />
              <div className="space-y-2 md:col-span-2"><Label>Interim control (optional)</Label><Textarea value={actionDraft.interimControl} onChange={e => setActionDraft({ ...actionDraft, interimControl: e.target.value })} placeholder="What has been done now to reduce risk while the permanent action is open?" /></div>
              <div className="space-y-2 md:col-span-2"><Label>Corrective action</Label><Textarea value={actionDraft.correctiveAction} onChange={e => setActionDraft({ ...actionDraft, correctiveAction: e.target.value })} placeholder="Permanent action needed" /></div>
              <div className="space-y-2 md:col-span-2"><Label>Evidence reference (optional until verification)</Label><Input value={actionDraft.evidenceReference} onChange={e => setActionDraft({ ...actionDraft, evidenceReference: e.target.value })} placeholder="Document title, certificate, photo record or storage link" /></div>
              <div className="md:col-span-2"><Button disabled={savingAction} onClick={createAction}>{savingAction ? "Logging…" : "Log corrective action"}</Button></div>
            </CardContent>
          </Card>}
          <div className="space-y-3">{loading ? <p className="text-muted-foreground">Loading corrective actions…</p> : actions.length === 0 ? <Card><CardContent className="p-6 text-muted-foreground">No corrective actions are logged for this client.</CardContent></Card> : actions.map(action => <Card key={action.id} className={action.status === "verified" ? "opacity-75" : ""}><CardContent className="p-5 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-start sm:justify-between"><div><div className="flex items-center gap-2 flex-wrap"><h3 className="font-semibold">{action.title}</h3><Badge variant={action.status === "verified" ? "secondary" : "outline"}>{action.status.replaceAll("_", " ")}</Badge><Badge variant={action.severity === "critical" || action.severity === "high" ? "destructive" : "outline"}>{action.severity}</Badge></div><p className="text-sm text-muted-foreground mt-1">{action.sourceTrack}{action.sourceRecordId ? ` · ${action.sourceRecordId}` : ""} · Owner: {action.ownerName}{action.dueDate ? ` · Due ${action.dueDate}` : ""}</p></div>{canEdit && action.status !== "verified" && <Button variant="outline" size="sm" onClick={() => beginEditingAction(action)}>Update / verify</Button>}</div>
            <div className="grid gap-3 md:grid-cols-2 text-sm"><div><span className="font-medium">Corrective action: </span>{action.correctiveAction}</div>{action.interimControl && <div><span className="font-medium">Interim control: </span>{action.interimControl}</div>}{action.evidenceReference && <div><span className="font-medium">Evidence: </span>{action.evidenceReference}</div>}{action.verificationNotes && <div><span className="font-medium">Verification: </span>{action.verificationNotes}</div>}</div>
            {editingAction === action.id && <div className="grid gap-3 border-t pt-4 md:grid-cols-2"><div className="space-y-2"><Label>Action status</Label><Select value={actionUpdate.status} onValueChange={status => setActionUpdate({ ...actionUpdate, status })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="in_progress">In progress</SelectItem><SelectItem value="awaiting_verification">Awaiting verification</SelectItem><SelectItem value="verified">Verified closed</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label>Evidence reference</Label><Input value={actionUpdate.evidenceReference} onChange={e => setActionUpdate({ ...actionUpdate, evidenceReference: e.target.value })} /></div><div className="space-y-2 md:col-span-2"><Label>Verification notes {actionUpdate.status === "verified" ? "(required)" : ""}</Label><Textarea value={actionUpdate.verificationNotes} onChange={e => setActionUpdate({ ...actionUpdate, verificationNotes: e.target.value })} placeholder="Who verified the action, what they checked and when" /><p className="text-xs text-muted-foreground">Verified closure is available only from “Awaiting verification”, by a different client admin or consultant. It cannot be edited afterwards.</p></div><div className="flex gap-2 md:col-span-2"><Button onClick={() => updateAction(action.id)}>Save action update</Button><Button variant="ghost" onClick={() => setEditingAction(null)}>Cancel</Button></div></div>}
          </CardContent></Card>)}</div>
        </TabsContent>

        <TabsContent value="guidance" className="space-y-5">
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5 text-primary" />Source register</CardTitle><CardDescription>Public authoritative signposts and scope notes. Review their applicability following a change in activity, premises, incident or law.</CardDescription></CardHeader></Card>
          {Object.entries(guidanceGroups).map(([track, sources]) => <Card key={track}><CardHeader className="pb-3"><CardTitle className="text-lg">{track}</CardTitle></CardHeader><CardContent className="space-y-4">{sources.map(source => <div key={source.title} className="border-l-2 border-primary/40 pl-4"><div className="flex gap-2 flex-wrap items-center"><a className="font-medium hover:underline inline-flex items-center gap-1" href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink className="h-3.5 w-3.5" /></a><Badge variant="outline">{source.classification}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{source.applicability}</p><p className="mt-2 text-sm">{source.reviewNote}</p></div>)}</CardContent></Card>)}
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, disabled }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; disabled?: boolean }) {
  return <div className="space-y-2"><Label>{label}</Label><Input type={type} value={value} disabled={disabled} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></div>;
}