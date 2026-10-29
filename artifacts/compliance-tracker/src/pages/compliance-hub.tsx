import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, BookOpen, ClipboardList, ExternalLink, Plus, ShieldCheck, UserRoundCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { fetchWithOverrideReason, withCsrfToken } from "@/lib/api";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { sortByLabel } from "@/lib/sort-options";
import { BUSINESS_TYPE_OPTIONS } from "@/lib/onboarding";
import { PickOrTypeSelect, usePeopleAndContractors, type PickGroup } from "@/components/pick-or-type-select";
import { CorrectiveActionUpdate } from "@/components/corrective-action-update";

type Appointment = { area: string; person: string; evidence?: string | null };
type Profile = {
  nation: "england" | "wales" | "scotland" | "northern_ireland" | "multi_nation";
  operationType: string; responsiblePersonName: string; responsiblePersonRole: string;
  responsiblePersonEmail?: string | null; competentAppointments: Appointment[];
  reviewCadence: string; nextReviewDate: string;
  // No longer shown here (the HACCP review is a yearly KitchenTrack check and
  // the written scheme is recorded in LegionellaTrack), but saved back as
  // loaded so nothing recorded is lost.
  haccpSystemReviewed: boolean;
  waterWrittenSchemeReference?: string | null;
};
type Guidance = { track: string; title: string; classification: string; jurisdiction: string; applicability: string; owner: string; url: string; reviewedAt: string; reviewNote: string };
type ComplianceGap = { id: string; priority: "high" | "medium" | "low"; tracks: string[]; title: string; rationale: string; recommendedControl: string };
type Action = {
  id: number; sourceTrack: string; sourceRecordId?: string | null; title: string;
  severity: "low" | "medium" | "high" | "critical"; status: "open" | "in_progress" | "awaiting_verification" | "verified";
  ownerName: string; dueDate?: string | null; interimControl?: string | null; correctiveAction: string;
  evidenceReference?: string | null; verificationNotes?: string | null; fixTrackIssueId?: number | null;
};

const emptyProfile: Profile = {
  nation: "england", operationType: "", responsiblePersonName: "", responsiblePersonRole: "",
  responsiblePersonEmail: "", competentAppointments: [], reviewCadence: "Annual review and after material change",
  nextReviewDate: "", haccpSystemReviewed: false,
  waterWrittenSchemeReference: "",
};
// Stand-in text the server stores when Business setup creates the profile
// (the columns can't be blank). Show it as an empty box with a grey hint so
// people can type straight in, and send it back if the box is left empty.
const setupStandIns = {
  operationType: "Not yet described",
  responsiblePersonRole: "Business owner or manager",
} as const;
type StandInField = keyof typeof setupStandIns;
const standInFields = Object.keys(setupStandIns) as StandInField[];

function withoutStandIns(profile: Profile): { profile: Profile; standIns: Set<StandInField> } {
  const standIns = new Set(standInFields.filter(field => profile[field].trim() === setupStandIns[field]));
  const cleared = { ...profile };
  for (const field of standIns) cleared[field] = "";
  return { profile: cleared, standIns };
}

// Dropdown choices. Each list ends with "Other (type it in)", and a value
// typed before (or not in a list) shows in the box under it.
const operationTypeOptions = BUSINESS_TYPE_OPTIONS.filter(option => option.value !== "other").map(option => option.label);
const roleOptions = sortByLabel([
  "Business owner", "Director", "General manager", "Club manager / secretary", "Premises / facilities manager",
  "Health and safety manager", "Head of department", "Operations manager",
], role => role);
// Most frequent first: this list reads in time order, not A to Z.
const reviewCadenceOptions = [
  "Every 3 months and after material change", "Every 6 months and after material change",
  "Annual review and after material change", "Every 2 years and after material change",
];
const appointmentAreaOptions = sortByLabel([
  "Asbestos", "Electrical safety", "Fire safety", "Food safety", "Gas safety", "Health and safety advice",
  "Legionella / water hygiene", "Lifting equipment (LOLER)", "Pool and spa water", "Pressure systems",
  "First aid", "Trees", "Work equipment (PUWER)", "COSHH / LEV",
], area => area);
const severityLabels: Record<Action["severity"], string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
const statusLabels: Record<Action["status"], string> = {
  open: "Open", in_progress: "In progress", awaiting_verification: "Awaiting verification", verified: "Verified closed",
};

export default function ComplianceHubPage() {
  const { activeClientId, user } = useAuth();
  const canAdmin = useCanAdmin();
  const canEdit = user?.role !== "client_viewer";
  const peopleAndContractors = usePeopleAndContractors(canEdit);
  const [emails, setEmails] = useState<Map<string, string>>(new Map());
  const { toast } = useToast();
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const newRow = useFocusNewRow();
  const [guidance, setGuidance] = useState<Guidance[]>([]);
  const [guidanceReviewedAt, setGuidanceReviewedAt] = useState("");
  const [gaps, setGaps] = useState<ComplianceGap[]>([]);
  const [disclaimer, setDisclaimer] = useState("");
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [editingAction, setEditingAction] = useState<number | null>(null);
  const [tab, setTab] = useState("profile");
  const loadGeneration = useRef(0);
  const standIns = useRef(new Set<StandInField>());
  const clientQuery = user?.role === "consultant" && activeClientId ? `?clientId=${activeClientId}` : "";
  const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchWithOverrideReason(`${apiBase}${path}${clientQuery}`, await withCsrfToken({
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    }));
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      // Validation failures carry zod's flattened errors rather than a string.
      const error = data?.error;
      const [field, messages] = Object.entries<string[]>(error?.fieldErrors ?? {})[0] ?? [];
      throw new Error(typeof error === "string" ? error : field ? `${field}: ${messages?.[0] ?? "invalid"}` : "Request failed");
    }
    return data as T;
  }

  async function refresh() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const [loadedProfile, loadedGuidance, loadedActions] = await Promise.all([
        request<Profile | null>("/compliance-hub/profile"),
        request<{ guidance: Guidance[]; disclaimer: string; reviewedAt: string; gaps: ComplianceGap[] }>("/compliance-hub/guidance"),
        request<Action[]>("/compliance-hub/actions"),
      ]);
      if (generation !== loadGeneration.current) return;
      showProfile(loadedProfile ? { ...emptyProfile, ...loadedProfile, competentAppointments: loadedProfile.competentAppointments ?? [] } : emptyProfile);
      setGuidance(loadedGuidance.guidance);
      setGuidanceReviewedAt(loadedGuidance.reviewedAt);
      setGaps(loadedGuidance.gaps ?? []);
      setDisclaimer(loadedGuidance.disclaimer);
      setActions(loadedActions);
      // Picking a person with a login fills in their email.
      const users = canAdmin ? await request<{ name: string; email: string; active?: boolean }[]>("/users").catch(() => []) : [];
      if (generation !== loadGeneration.current) return;
      setEmails(new Map(users.filter(u => u.active !== false && u.email).map(u => [u.name, u.email])));
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
    showProfile(emptyProfile);
    setActions([]);
    void refresh();
  }, [activeClientId]);

  const guidanceGroups = useMemo(() => guidance.reduce<Record<string, Guidance[]>>((all, item) => {
    (all[item.track] ??= []).push(item); return all;
  }, {}), [guidance]);

  function showProfile(next: Profile) {
    const shown = withoutStandIns(next);
    standIns.current = shown.standIns;
    setProfile(shown.profile);
  }

  async function saveProfile() {
    const generation = loadGeneration.current;
    setSavingProfile(true);
    try {
      const body = { ...profile };
      for (const field of standIns.current) if (!body[field].trim()) body[field] = setupStandIns[field];
      const saved = await request<Profile>("/compliance-hub/profile", { method: "PUT", body: JSON.stringify(body) });
      if (generation !== loadGeneration.current) return;
      showProfile(saved);
      toast({ title: "Accountability profile saved", description: "Review it whenever your operation, risk assessment or appointments change." });
    } catch (error: any) {
      toast({ title: "Couldn't save profile", description: error.message, variant: "destructive" });
    } finally { setSavingProfile(false); }
  }

  async function sendToFixTrack(id: number) {
    const generation = loadGeneration.current;
    try {
      const sent = await request<{ fixTrackIssueId: number }>(`/compliance-hub/actions/${id}/fix-track`, { method: "POST", body: "{}" });
      if (generation !== loadGeneration.current) return;
      await refresh();
      toast({ title: "Sent to FixTrack", description: `FixTrack issue #${sent.fixTrackIssueId} raised.` });
    } catch (error: any) {
      toast({ title: "Couldn't send to FixTrack", description: error.message, variant: "destructive" });
    }
  }

  // Actions are logged on their track now. Ones logged here before (other than
  // IncidentTrack's, which show on the incident) stay until they are closed.
  const earlierActions = actions.filter(action => action.status !== "verified" && action.sourceTrack !== "IncidentTrack");

  return (
    <AppLayout title="Compliance Hub">
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex gap-3 p-5 text-sm text-foreground">
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary mt-0.5" />
          <div><strong>Evidence, not a compliance certificate.</strong> {disclaimer || "This workspace helps organise who is accountable and the sources that apply."}</div>
        </CardContent>
      </Card>

      <Tabs value={tab === "actions" && earlierActions.length === 0 ? "profile" : tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="profile">Accountability profile</TabsTrigger>
          {earlierActions.length > 0 && <TabsTrigger value="actions">Earlier actions ({earlierActions.length})</TabsTrigger>}
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
              <PickField id="hub-operation-type" label="Premises / operation type" value={profile.operationType} disabled={!canAdmin}
                groups={[{ options: operationTypeOptions }]} typedPlaceholder="e.g. hospitality venue with commercial kitchen"
                onChange={operationType => setProfile({ ...profile, operationType })} />
              <PickField id="hub-responsible-person" label="Responsible person" value={profile.responsiblePersonName} disabled={!canAdmin}
                groups={peopleAndContractors.slice(0, 1)} otherLabel="Someone else (type their name)" typedPlaceholder="Named duty holder"
                onChange={responsiblePersonName => setProfile({ ...profile, responsiblePersonName, responsiblePersonEmail: emails.get(responsiblePersonName) ?? profile.responsiblePersonEmail })} />
              <PickField id="hub-responsible-role" label="Responsible person's role" value={profile.responsiblePersonRole} disabled={!canAdmin}
                groups={[{ options: roleOptions }]} typedPlaceholder="e.g. Business owner, director or premises manager"
                onChange={responsiblePersonRole => setProfile({ ...profile, responsiblePersonRole })} />
              <Field label="Responsible person's email (optional)" type="email" value={profile.responsiblePersonEmail ?? ""} disabled={!canAdmin} onChange={responsiblePersonEmail => setProfile({ ...profile, responsiblePersonEmail })} />
              <PickField id="hub-review-cadence" label="Review cadence" value={profile.reviewCadence} disabled={!canAdmin}
                groups={[{ options: reviewCadenceOptions }]} typedPlaceholder="e.g. Annual and after significant change"
                onChange={reviewCadence => setProfile({ ...profile, reviewCadence })} />
              <div className="space-y-2"><Label htmlFor="hub-next-review">Next review date</Label><Input id="hub-next-review" type="date" disabled={!canAdmin} value={profile.nextReviewDate} onChange={e => setProfile({ ...profile, nextReviewDate: e.target.value })} /></div>
              <div ref={newRow.ref} className="md:col-span-2 space-y-3 pt-2">
                <div><Label>Competent-person appointments</Label><p className="text-xs text-muted-foreground mt-1">Record the person and evidence of appointment/competence for specialist risk areas. This is not a substitute for checking qualifications.</p></div>
                {profile.competentAppointments.map((appointment, index) => <div key={index} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto] md:items-start">
                  <PickOrTypeSelect disabled={!canAdmin} value={appointment.area} groups={[{ options: appointmentAreaOptions }]} placeholder="Choose the area…"
                    typedPlaceholder="Area" onChange={area => setProfile({ ...profile, competentAppointments: profile.competentAppointments.map((a, i) => i === index ? { ...a, area } : a) })} />
                  <PickOrTypeSelect disabled={!canAdmin} value={appointment.person} groups={peopleAndContractors} placeholder="Choose the person or contractor…"
                    otherLabel="Someone else (type the name)" typedPlaceholder="Person / organisation"
                    onChange={person => setProfile({ ...profile, competentAppointments: profile.competentAppointments.map((a, i) => i === index ? { ...a, person } : a) })} />
                  <Input disabled={!canAdmin} value={appointment.evidence ?? ""} placeholder="Evidence reference" onChange={e => setProfile({ ...profile, competentAppointments: profile.competentAppointments.map((a, i) => i === index ? { ...a, evidence: e.target.value } : a) })} />
                  {canAdmin && <Button variant="ghost" onClick={() => setProfile({ ...profile, competentAppointments: profile.competentAppointments.filter((_, i) => i !== index) })}>Remove</Button>}
                </div>)}
                {canAdmin && <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setProfile({ ...profile, competentAppointments: [...profile.competentAppointments, { area: "", person: "", evidence: "" }] }); }}><Plus className="mr-1 h-4 w-4" />Add appointment</Button>}
              </div>
              {canAdmin && <div className="md:col-span-2"><Button disabled={savingProfile} onClick={saveProfile}>{savingProfile ? "Saving…" : "Save accountability profile"}</Button></div>}
            </CardContent>
          </Card>
        </TabsContent>

        {earlierActions.length > 0 && <TabsContent value="actions" className="space-y-4">
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5 text-primary" />Earlier corrective actions</CardTitle>
            <CardDescription>Corrective actions are now logged on each track. These were logged here before; finish them off here or send them to FixTrack. Once verified closed they leave this list.</CardDescription></CardHeader></Card>
          {earlierActions.map(action => <Card key={action.id}><CardContent className="p-5 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-start sm:justify-between"><div><div className="flex items-center gap-2 flex-wrap"><h3 className="font-bold">{action.title}</h3><Badge variant="outline">{statusLabels[action.status]}</Badge><Badge variant={action.severity === "critical" || action.severity === "high" ? "destructive" : "outline"}>{severityLabels[action.severity]}</Badge></div><p className="text-sm text-muted-foreground mt-1">{action.sourceTrack}{action.sourceRecordId ? ` · ${action.sourceRecordId}` : ""} · Owner: {action.ownerName}{action.dueDate ? ` · Due ${action.dueDate}` : ""}</p></div><div className="flex flex-wrap gap-2">{action.fixTrackIssueId ? <a className="text-sm font-medium text-primary underline self-center" href={`/fix-track/${action.fixTrackIssueId}`}>FixTrack issue #{action.fixTrackIssueId}</a> : canEdit && !/green/i.test(action.sourceTrack) && <Button variant="outline" size="sm" onClick={() => sendToFixTrack(action.id)}>Send to FixTrack</Button>}{canEdit && <Button variant="outline" size="sm" onClick={() => setEditingAction(action.id)}>Update / verify</Button>}</div></div>
            <div className="grid gap-3 md:grid-cols-2 text-sm"><div><span className="font-medium">Corrective action: </span>{action.correctiveAction}</div>{action.interimControl && <div><span className="font-medium">Interim control: </span>{action.interimControl}</div>}{action.evidenceReference && <div><span className="font-medium">Evidence: </span>{action.evidenceReference}</div>}{action.verificationNotes && <div><span className="font-medium">Verification: </span>{action.verificationNotes}</div>}</div>
            {editingAction === action.id && <CorrectiveActionUpdate action={action} onCancel={() => setEditingAction(null)} onSaved={async () => { setEditingAction(null); await refresh(); }} />}
          </CardContent></Card>)}
        </TabsContent>}

        <TabsContent value="guidance" className="space-y-5">
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5 text-primary" />Source register</CardTitle><CardDescription>Public authoritative signposts and scope notes. Reviewed {guidanceReviewedAt || "recently"}; review applicability after a change in activity, premises, incident or law.</CardDescription></CardHeader></Card>
          {Object.entries(guidanceGroups).map(([track, sources]) => <Card key={track}><CardHeader className="pb-3"><CardTitle className="text-lg">{track}</CardTitle></CardHeader><CardContent className="space-y-4">{sources.map(source => <div key={`${source.track}-${source.title}`} className="border-l-2 border-primary/40 pl-4"><div className="flex gap-2 flex-wrap items-center"><a className="font-medium hover:underline inline-flex items-center gap-1" href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink className="h-3.5 w-3.5" /></a><Badge variant="outline">{source.classification}</Badge><Badge variant="secondary">{source.jurisdiction}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{source.applicability}</p><p className="mt-1 text-xs text-muted-foreground">Owner: {source.owner} · Reviewed: {source.reviewedAt}</p><p className="mt-2 text-sm">{source.reviewNote}</p></div>)}</CardContent></Card>)}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-600" />Open comparison points</CardTitle><CardDescription>These are prioritised product and governance gaps identified by the review. They are not a legal-compliance verdict.</CardDescription></CardHeader><CardContent className="space-y-4">{gaps.map(gap => <div key={gap.id} className="rounded-md border p-4"><div className="flex flex-wrap items-center gap-2"><Badge variant={gap.priority === "high" ? "destructive" : "outline"}>{gap.priority} priority</Badge><h3 className="font-bold">{gap.title}</h3></div><p className="mt-2 text-sm text-muted-foreground">{gap.rationale}</p><p className="mt-2 text-sm"><span className="font-medium">Recommended control:</span> {gap.recommendedControl}</p><p className="mt-2 text-xs text-muted-foreground">Tracks: {gap.tracks.join(" · ")}</p></div>)}</CardContent></Card>
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function PickField({ id, label, ...props }: { id: string; label: string; value: string; onChange: (value: string) => void; groups: PickGroup[]; otherLabel?: string; typedPlaceholder?: string; disabled?: boolean }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><PickOrTypeSelect id={id} typedLabel={label} {...props} /></div>;
}

function Field({ label, value, onChange, type = "text", placeholder, disabled }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; disabled?: boolean }) {
  return <div className="space-y-2"><Label>{label}</Label><Input type={type} value={value} disabled={disabled} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></div>;
}