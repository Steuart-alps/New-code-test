import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, ClipboardCheck, LayoutGrid, Lock, MapPin, Network, Plus, Sparkles, UsersRound, X } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { SETUP_STATE_KEY, type SetupTeam } from "@/components/setup-team-gate";
import { SetupGettingStarted, type SetupAi, type SetupAssistRequest } from "@/components/setup-getting-started";
import { departmentLabel } from "@/lib/departments";
import { roleLabel } from "@/lib/roles";
import { UserDialog, type RosterEntry, type User as Person } from "@/pages/users";
import { SiteFireWalkQuestions, type FireWalkAnswers } from "@/components/site-fire-walk-questions";
import {
  BUSINESS_TYPE_OPTIONS, DEPARTMENT_SUGGESTIONS, FIRST_RECORD_PRIORITY, MODULE_INFO, NATION_OPTIONS, RECOMMENDED_MODULES,
  formatDay, localToday, onboardingRequest,
} from "@/lib/onboarding";

type StarterCheck = {
  title: string; category: string; description: string; frequencyMonths: number | null;
  core: boolean; state: "untouched" | "customised" | "missing";
};
type SetupState = {
  needsSetup: boolean; setupCompletedAt: string | null; canManage: boolean; businessType: string | null;
  deferredAt?: string | null; nation?: string | null;
  sites?: ({ id: number; name: string } & Partial<FireWalkAnswers>)[];
  modules?: { available: string[]; picked: string[] }; starterChecks?: StarterCheck[];
  complimentary?: boolean; team?: SetupTeam; ai?: SetupAi; assistRequest?: SetupAssistRequest | null;
};
/**
 * `partial` marks a date box with an unfinished date (the browser reports no
 * value, so it would save as blank); `resetKey` remounts the box to empty it.
 */
type Choice = { ticked: boolean; date: string; partial?: boolean; resetKey?: number };
/** A check the business adds itself under a starter heading ("Add check"). */
type CustomCheck = { key: number; category: string; title: string; every: string; unit: "months" | "years"; lastDone: string };
/** A department sits under one site; `siteId` null means it spans every site. */
type Department = { id: number; name: string; siteId: number | null; siteName?: string | null; clientId: number };

const STEPS = [
  { label: "Your business", icon: Building2 },
  { label: "Sites", icon: MapPin },
  { label: "Departments", icon: Network },
  { label: "Your team", icon: UsersRound },
  { label: "Modules", icon: LayoutGrid },
  { label: "Starter checks", icon: ClipboardCheck },
  { label: "First record", icon: Sparkles },
];
/**
 * People come before modules, checks and the first record: every record
 * should be in the name of the person who did it, so the steps after this
 * one stay locked until there is a Manager or Staff login, or the Owner says
 * only Owners record for now.
 */
const TEAM_STEP = 3;
/** The getting-started page opens setup once per business on this browser; "What you'll need" reopens it. */
const introSeenKey = (clientId: number | null) => `complytrack:setup-intro-seen:${clientId ?? "own"}`;
function introSeen(clientId: number | null): boolean {
  try {
    return window.localStorage.getItem(introSeenKey(clientId)) === "true";
  } catch {
    return false;
  }
}
function markIntroSeen(clientId: number | null) {
  try {
    window.localStorage.setItem(introSeenKey(clientId), "true");
  } catch {
    // Private windows may block storage; the page just shows again next time.
  }
}

/** "12 months (every year)", "60 months (every 5 years)". */
function intervalLabel(months: number): string {
  if (months % 12 !== 0) return `${months} month${months === 1 ? "" : "s"}`;
  const years = months / 12;
  return `${months} months (every ${years === 1 ? "year" : `${years} years`})`;
}

const selectClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export default function SetupPage() {
  const { user, activeClientId, refresh } = useAuth();
  const clientId = user?.role === "consultant" ? activeClientId : null;
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SetupState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // "Add your team" on a held-back form page opens the wizard at the team step.
  const [step, setStep] = useState(() => new URLSearchParams(search).get("step") === "team" ? TEAM_STEP : 0);
  const [intro, setIntro] = useState(() => !new URLSearchParams(search).get("step") && !introSeen(clientId));
  const [busy, setBusy] = useState(false);
  const [businessType, setBusinessType] = useState("");
  const [nation, setNation] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [siteId, setSiteId] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [removeUnticked, setRemoveUnticked] = useState(false);
  const [customChecks, setCustomChecks] = useState<CustomCheck[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [deptSiteId, setDeptSiteId] = useState<number | null>(null);
  const [deptInput, setDeptInput] = useState("");
  const [newDepartments, setNewDepartments] = useState<string[]>([]);
  const [copyDepartments, setCopyDepartments] = useState(true);
  const [departmentsLoaded, setDepartmentsLoaded] = useState(false);
  const [suggestionsOffered, setSuggestionsOffered] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [personOpen, setPersonOpen] = useState(false);
  const [aloneOpen, setAloneOpen] = useState(false);

  async function load() {
    try {
      const data = await onboardingRequest<SetupState>("/setup/state", clientId);
      setState(data);
      setBusinessType(data.businessType ?? "");
      setNation(data.nation ?? "");
      setSiteId((current) => current ?? data.sites?.[0]?.id ?? null);
      setPicked(data.modules?.picked.length ? data.modules.picked
        : (RECOMMENDED_MODULES[data.businessType ?? "other"] ?? []).filter((m) => data.modules?.available.includes(m)));
      setChoices(Object.fromEntries((data.starterChecks ?? []).map((c) => [c.title, { ticked: c.core && c.state !== "customised", date: "" }])));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load setup");
    }
    await Promise.all([loadDepartments(), loadPeople()]);
  }

  async function loadPeople() {
    try {
      const [users, rosterRows] = await Promise.all([
        onboardingRequest<Person[]>("/users", clientId),
        onboardingRequest<RosterEntry[]>("/staff-roster", clientId).catch(() => [] as RosterEntry[]),
      ]);
      // ALPS consultants look after the business but aren't part of its team.
      setPeople(users.filter((u) => u.role !== "consultant" || u.id === user?.id));
      setRoster(rosterRows);
    } catch {
      // The team step still lets admins add people.
    }
  }

  /** After someone is added or Owners-only is confirmed: refresh the step and unlock form pages. */
  async function teamChanged() {
    await load();
    void queryClient.invalidateQueries({ queryKey: [SETUP_STATE_KEY] });
  }

  async function loadDepartments() {
    try {
      const rows = await onboardingRequest<Department[]>("/departments", clientId);
      setDepartments(rows);
    } catch {
      // The departments step still lets admins add new ones.
    }
    setDepartmentsLoaded(true);
  }
  useEffect(() => { void load(); }, [clientId]);

  async function run(action: () => Promise<void>, next = true) {
    setBusy(true);
    try {
      await action();
      if (next) setStep((s) => Math.min(s + 1, STEPS.length - 1));
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const post = (path: string, body: unknown, method = "POST") =>
    onboardingRequest(path, clientId, { method, body: JSON.stringify(body) });

  const saveBusiness = () => run(async () => {
    await post("/setup/business", { ...(businessType ? { businessType } : {}), ...(nation ? { nation } : {}) }, "PUT");
    await load();
    void refresh();
  });

  async function addTypedSite() {
    if (!siteName.trim()) return;
    const site = await post("/sites", { name: siteName.trim(), address: siteAddress.trim() || null, seedStarterChecks: false }) as { id: number };
    setSiteId((current) => current ?? site.id);
    setDeptSiteId((current) => current ?? site.id);
    setSiteName("");
    setSiteAddress("");
    void queryClient.invalidateQueries();
    await load();
  }
  // "Add site" stays on the step so several sites can be added in a row;
  // "Save and continue" saves any site still typed in and moves on in one click.
  const saveSite = () => run(addTypedSite, false);
  const saveSitesAndContinue = () => run(addTypedSite);
  // Each answer saves straight away; the list shows it at once.
  async function saveFireWalkAnswers(id: number, answers: FireWalkAnswers) {
    setState((current) => current && { ...current, sites: current.sites?.map((s) => s.id === id ? { ...s, ...answers } : s) });
    try {
      await post(`/sites/${id}`, answers, "PATCH");
      void queryClient.invalidateQueries();
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
      await load();
    }
  }

  const sites = state?.sites ?? [];
  const activeDeptSiteId = deptSiteId ?? sites[0]?.id ?? null;
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // A department with no site (made before departments moved under sites) counts at every site.
  const departmentsAt = (site: number | null) =>
    departments.filter((d) => d.siteId == null || d.siteId === site);
  const shownDepartments = departmentsAt(activeDeptSiteId);
  const departmentSuggestions = DEPARTMENT_SUGGESTIONS[businessType || "other"] ?? DEPARTMENT_SUGGESTIONS.other;
  const businessTypeLabel = BUSINESS_TYPE_OPTIONS.find((o) => o.value === businessType)?.label;
  const showCopyDepartments = sites.length > 1;

  // Steps after the team stay closed until it is done (older servers send no team: open).
  const teamReady = state?.team?.ready !== false;
  useEffect(() => {
    if (!teamReady && step > TEAM_STEP) setStep(TEAM_STEP);
  }, [teamReady, step]);

  // First visit to the step with no departments yet: pre-tick the usual names.
  useEffect(() => {
    if (step !== 2 || !departmentsLoaded || suggestionsOffered) return;
    setSuggestionsOffered(true);
    if (departments.length === 0) setNewDepartments(departmentSuggestions);
  }, [step, departmentsLoaded, suggestionsOffered]);

  function addDepartmentName(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!newDepartments.some((n) => sameName(n, name)) && !shownDepartments.some((d) => sameName(d.name, name))) {
      setNewDepartments((names) => [...names, name]);
    }
    setDeptInput("");
  }

  // Creates the new names at the chosen site, and with "copy" ticked at every
  // other site too (names only; a site that already has a name is skipped).
  const saveDepartments = () => run(async () => {
    const names = deptInput.trim() ? [...newDepartments, deptInput.trim()] : newDepartments;
    const targets = copyDepartments && showCopyDepartments
      ? [activeDeptSiteId, ...sites.map((s) => s.id).filter((id) => id !== activeDeptSiteId)]
      : [activeDeptSiteId];
    let created = 0;
    for (const target of targets) {
      const existing = departmentsAt(target);
      for (const name of names) {
        if (existing.some((d) => sameName(d.name, name))) continue;
        await post("/departments", target ? { name, siteId: target } : { name });
        created += 1;
      }
    }
    setNewDepartments([]);
    setDeptInput("");
    toast({ title: "Departments saved", description: `${created} added.` });
    void queryClient.invalidateQueries();
    await loadDepartments();
  });

  const saveModules = () => run(async () => { await post("/setup/modules", { modules: picked }, "PUT"); });

  const addCustomCheck = (category: string) =>
    setCustomChecks((all) => [...all, { key: Math.max(0, ...all.map((c) => c.key)) + 1, category, title: "", every: "12", unit: "months", lastDone: "" }]);
  const updateCustomCheck = (key: number, change: Partial<CustomCheck>) =>
    setCustomChecks((all) => all.map((c) => c.key === key ? { ...c, ...change } : c));
  /** Months between checks, or null when the number is missing or out of range. */
  const customMonths = (c: CustomCheck) => {
    const n = Number(c.every);
    const months = c.unit === "years" ? n * 12 : n;
    return Number.isInteger(months) && months >= 1 && months <= 120 ? months : null;
  };
  const customIncomplete = customChecks.some((c) => !c.title.trim() || customMonths(c) == null);

  const saveChecks = () => run(async () => {
    const checks = (state?.starterChecks ?? []).filter((c) => choices[c.title]?.ticked && c.state !== "customised").map((c) => {
      const date = choices[c.title]?.date || null;
      return c.frequencyMonths ? { title: c.title, lastDone: date } : { title: c.title, nextDue: date };
    });
    const custom = customChecks.map((c) => ({ category: c.category, title: c.title.trim(), frequencyMonths: customMonths(c)!, lastDone: c.lastDone || null }));
    const result = await post("/setup/starter-checks", { siteId, checks, removeUnticked, custom }) as { updated: number; created: number; kept: number; removed: number };
    // Ticked checks already on the list with no date are "kept", but they are
    // still on the list, so count them rather than report "0 set up".
    const onList = result.updated + result.created + result.kept;
    const dated = checks.filter((c) => c.lastDone || c.nextDue).length + custom.filter((c) => c.lastDone).length;
    toast({
      title: "Starter checks saved",
      description: `${onList} check${onList === 1 ? "" : "s"} on your list${result.removed ? `, ${result.removed} removed` : ""}.`
        + (dated < checks.length + custom.length ? " Checks left without a date can be dated later from Compliance Checks." : ""),
    });
    setCustomChecks([]);
    void queryClient.invalidateQueries();
  });

  const finishLater = () => run(async () => {
    await post("/setup/defer", {});
    navigate("/dashboard");
  }, false);

  const startSetup = () => {
    markIntroSeen(clientId);
    setIntro(false);
  };

  async function requestAssist(details: { phone: string; notes: string }) {
    try {
      const result = await post("/setup/assist-request", {
        ...(details.phone ? { phone: details.phone } : {}),
        ...(details.notes ? { notes: details.notes } : {}),
      }) as SetupAssistRequest;
      setState((current) => current ? { ...current, assistRequest: { requestedAt: result.requestedAt, requestedBy: result.requestedBy } } : current);
      toast({ title: "Request sent to ALPS", description: "We'll be in touch to arrange how to send your lists." });
    } catch (err) {
      toast({ title: "Request not sent", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
      throw err;
    }
  }

  const confirmOwnersOnly = () => run(async () => {
    await post("/setup/team-alone", {});
    setAloneOpen(false);
    await teamChanged();
  });

  const finish = (href = "/dashboard") => run(async () => {
    await post("/setup/complete", {});
    navigate(href);
  }, false);

  const firstModule = useMemo(() => {
    const pool = picked.length ? picked : state?.modules?.available ?? [];
    return FIRST_RECORD_PRIORITY.find((m) => pool.includes(m)) ?? "compliance";
  }, [picked, state]);

  const grouped = useMemo(() => {
    const map = new Map<string, StarterCheck[]>();
    for (const check of state?.starterChecks ?? []) map.set(check.category, [...(map.get(check.category) ?? []), check]);
    return [...map.entries()];
  }, [state]);

  if (user && user.role !== "consultant" && user.role !== "client_admin") {
    return <AppLayout title="Set up"><p className="p-6 text-sm text-muted-foreground">Only account administrators can run setup.</p></AppLayout>;
  }

  return (
    <AppLayout title="Set up ComplyTrack">
      <div className="max-w-2xl mx-auto py-6 px-4 space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Getting started</p>
            <h1 className="text-2xl font-bold tracking-tight">Set up your account</h1>
            <p className="text-sm text-muted-foreground mt-1">A few quick questions so your dashboard shows what applies to you. You can skip most steps, but your team comes before any checklists or forms.</p>
          </div>
          <div className="flex items-center gap-2">
            {!intro && <Button variant="ghost" size="sm" onClick={() => setIntro(true)}>What you'll need</Button>}
            <Button variant="outline" size="sm" onClick={finishLater} disabled={busy}>Finish later</Button>
          </div>
        </div>

        <ol className="grid grid-cols-7 gap-1" aria-label="Setup steps">
          {STEPS.map(({ label, icon: Icon }, i) => {
            const locked = i > TEAM_STEP && !teamReady;
            return (
            <li key={label}>
              <button type="button" onClick={() => { setStep(locked ? TEAM_STEP : i); if (intro) startSetup(); }} aria-current={!intro && i === step ? "step" : undefined}
                title={locked ? "Add your team first" : undefined}
                className={`w-full flex flex-col items-center gap-1 rounded-md p-1.5 text-[11px] leading-tight ${!intro && i === step ? "bg-primary/10 text-primary font-semibold" : i < step ? "text-foreground" : "text-muted-foreground"}`}>
                {locked ? <Lock className="w-4 h-4" aria-label="Locked until your team is added" /> : <Icon className="w-4 h-4" />}
                <span className="hidden sm:block text-center">{label}</span>
              </button>
            </li>
            );
          })}
        </ol>
        {!intro && <p className="sm:hidden text-sm font-medium">Step {step + 1} of {STEPS.length}: {STEPS[step].label}</p>}

        {loadError && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{loadError}</div>}
        {!state && !loadError && <div className="h-40 rounded-xl bg-muted animate-pulse" />}

        {state && intro && (
          <SetupGettingStarted
            ai={state.ai}
            assistRequest={state.assistRequest ?? null}
            canRequestAssist={user?.role === "client_admin"}
            onRequestAssist={requestAssist}
            onStart={startSetup}
            started={(state.sites?.length ?? 0) > 0}
            infoContext={{
              modules: state.modules?.picked.length ? state.modules.picked : state.modules?.available,
              sites: state.sites?.map((s) => s.name),
            }}
          />
        )}

        {state && !intro && (
          <section className="rounded-xl border bg-card p-5 shadow-sm space-y-5">
            {step === 0 && (
              <>
                <div>
                  <h2 className="text-lg font-bold">What kind of business is this?</h2>
                  <p className="text-sm text-muted-foreground">We use this to suggest modules and the starter compliance checks that usually apply.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-business-type">Business type</Label>
                  <select id="setup-business-type" className={selectClass} value={businessType} onChange={(e) => setBusinessType(e.target.value)}>
                    <option value="">Select your business type…</option>
                    {BUSINESS_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-nation">Where are your premises?</Label>
                  <select id="setup-nation" className={selectClass} value={nation} onChange={(e) => setNation(e.target.value)}>
                    <option value="">Select a nation…</option>
                    {NATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <p className="text-xs text-muted-foreground">Saved to your Compliance Hub profile. Some rules differ between nations, for example food reheating temperatures in Scotland.</p>
                </div>
                <StepActions busy={busy} onSave={saveBusiness} onSkip={() => setStep(1)} disabled={!businessType && !nation} />
              </>
            )}

            {step === 1 && (
              <>
                <div>
                  <h2 className="text-lg font-bold">Your sites</h2>
                  <p className="text-sm text-muted-foreground">A site is a building or location where checks are recorded. Add each of your locations now; you will set up their departments next.</p>
                </div>
                {sites.length > 0 && (
                  <ul className="space-y-2" aria-label="Your sites">
                    {sites.map((s) => (
                      <li key={s.id} className="rounded-lg border bg-muted/30 px-3 py-2 text-sm space-y-2">
                        <span className="flex items-center gap-2 font-medium"><MapPin className="h-4 w-4 text-primary shrink-0" /> {s.name}</span>
                        <SiteFireWalkQuestions idPrefix={`setup-site-${s.id}`}
                          value={{ sleepingAccommodation: s.sleepingAccommodation ?? null, nightPorter: s.nightPorter ?? null }}
                          onChange={(answers) => void saveFireWalkAnswers(s.id, answers)} />
                      </li>
                    ))}
                  </ul>
                )}
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">{sites.length > 0 ? "Add another site" : "Add your first site"}</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-site-name">Site name</Label>
                    <Input id="setup-site-name" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="e.g. The Red Lion" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-site-address">Address (optional)</Label>
                    <Input id="setup-site-address" value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} placeholder="Street, town, postcode" />
                  </div>
                  <div className="flex justify-end">
                    <Button variant="outline" onClick={saveSite} disabled={busy || !siteName.trim()}>
                      <Plus className="w-4 h-4 mr-1" /> {busy ? "Adding…" : "Add site and add another"}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {state.complimentary
                    ? "Every site is included free for this business. You can add or remove sites later from Sites."
                    : "Your plan is priced per site, so each extra site adds to the monthly price once your free trial ends. You can add or remove sites later from Sites."}
                </p>
                <div className="flex items-center justify-end gap-2 pt-2">
                  {sites.length === 0 && <Button variant="ghost" onClick={() => setStep(2)} disabled={busy}>Skip this step</Button>}
                  <Button onClick={saveSitesAndContinue} disabled={busy || (sites.length === 0 && !siteName.trim())}>
                    {busy ? "Saving…" : "Save and continue"} <ArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <h2 className="text-lg font-bold">Departments</h2>
                  <p className="text-sm text-muted-foreground">Departments split a site into areas such as Kitchen or Housekeeping, so staff see the records for their own area. Skip this if you don't need them.</p>
                </div>
                {sites.length > 1 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-dept-site">Departments at</Label>
                    <select id="setup-dept-site" className={selectClass} value={activeDeptSiteId ?? ""}
                      onChange={(e) => setDeptSiteId(Number(e.target.value))}>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                )}
                {shownDepartments.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Already set up</p>
                    <div className="flex flex-wrap gap-1.5">
                      {shownDepartments.map((d) => (
                        <span key={d.id} className="rounded-full border bg-muted/40 px-3 py-1 text-sm">{d.name}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="setup-dept-name">Add a department</Label>
                  <div className="flex gap-2">
                    <Input id="setup-dept-name" value={deptInput} onChange={(e) => setDeptInput(e.target.value)} placeholder="e.g. Kitchen"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDepartmentName(deptInput); } }} />
                    <Button type="button" variant="outline" onClick={() => addDepartmentName(deptInput)} disabled={!deptInput.trim()}>
                      <Plus className="w-4 h-4 mr-1" /> Add
                    </Button>
                  </div>
                </div>
                {(() => {
                  const suggestions = departmentSuggestions
                    .filter((n) => !newDepartments.some((x) => sameName(x, n)) && !shownDepartments.some((d) => sameName(d.name, n)));
                  return suggestions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Common choices:</span>
                      {suggestions.map((n) => (
                        <button key={n} type="button" onClick={() => addDepartmentName(n)}
                          className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5 text-xs hover:border-primary hover:text-primary">
                          <Plus className="h-3 w-3" /> {n}
                        </button>
                      ))}
                    </div>
                  );
                })()}
                {newDepartments.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To add</p>
                    {departments.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        We've suggested the usual departments{businessTypeLabel && businessType !== "other" ? ` for ${businessTypeLabel}` : ""}. Remove any you don't need, or add your own.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {newDepartments.map((n) => (
                        <span key={n} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-3 py-1 text-sm">
                          {n}
                          <button type="button" aria-label={`Remove ${n}`} onClick={() => setNewDepartments((names) => names.filter((x) => x !== n))}
                            className="rounded-full p-0.5 hover:bg-primary/10"><X className="h-3 w-3" /></button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {showCopyDepartments && (
                  <label className="flex items-start gap-2 rounded-lg border p-3 text-sm cursor-pointer">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={copyDepartments} onChange={(e) => setCopyDepartments(e.target.checked)} />
                    <span>
                      <span className="block font-medium">Use these department names at {sites.length === 2 ? "both sites" : `all ${sites.length} sites`}</span>
                      <span className="block text-xs text-muted-foreground">Only the names are copied. Staff, checks and other settings are set up separately at each site.</span>
                    </span>
                  </label>
                )}
                <StepActions busy={busy} onSave={saveDepartments} onSkip={() => setStep(3)}
                  disabled={newDepartments.length === 0 && !deptInput.trim()} saveLabel="Save departments" />
              </>
            )}

            {step === TEAM_STEP && (
              <>
                <div>
                  <h2 className="text-lg font-bold">Who will record checks?</h2>
                  <p className="text-sm text-muted-foreground">
                    Add the people who will fill in checklists and forms before anything is recorded, so every record is in the name of the person who did it.
                    Each person gets an email to set their own password.
                  </p>
                </div>
                {people.length > 0 && (
                  <ul className="space-y-1.5" aria-label="Your team">
                    {people.map((p) => {
                      const ids = p.departmentIds ?? (p.departmentId != null ? [p.departmentId] : []);
                      const where = p.role === "client_admin" || p.role === "consultant" || p.allDepartments ? "All departments"
                        : ids.map((id) => departmentLabel(departments.find((d) => d.id === id))).filter(Boolean).join(", ") || "No department";
                      return (
                        <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                          <span className="min-w-0">
                            <span className="block font-medium truncate">{p.name}{p.id === user?.id ? " (you)" : ""}</span>
                            <span className="block text-xs text-muted-foreground truncate">{where}</span>
                          </span>
                          <span className="shrink-0 rounded-full border bg-background px-2.5 py-0.5 text-xs">{roleLabel(p.role, user?.role === "consultant")}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <Button variant="outline" onClick={() => setPersonOpen(true)} disabled={busy}>
                  <Plus className="w-4 h-4 mr-1" /> Add a person
                </Button>
                <p className="text-xs text-muted-foreground">
                  Staff record checks for their own department. Managers look after one, several or all departments.
                  Viewers only see and sign their own training. People who never sign in can go on
                  the <Link href="/staff-roster" className="text-primary hover:underline">Staff roster</Link> for training records.
                </p>
                {!teamReady && aloneOpen && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2 text-sm text-amber-950" role="alert">
                    <p className="flex items-start gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> Every record will be in an Owner's name
                    </p>
                    <p className="text-xs">
                      Only do this if nobody else will sign in yet. Checks done by other people would then look as if an Owner did them.
                      You can add people at any time from Users.
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setAloneOpen(false)} disabled={busy}>Back</Button>
                      <Button size="sm" onClick={confirmOwnersOnly} disabled={busy}>Yes, only Owners record for now</Button>
                    </div>
                  </div>
                )}
                {!teamReady && !aloneOpen && (
                  <p className="text-xs text-muted-foreground">Add at least one Manager or Staff member to carry on. Checklists and forms stay closed until you do.</p>
                )}
                <div className="flex items-center justify-end gap-2 pt-2">
                  {!teamReady && !aloneOpen && (
                    <Button variant="ghost" onClick={() => setAloneOpen(true)} disabled={busy}>Nobody else signs in yet</Button>
                  )}
                  <Button onClick={() => setStep(TEAM_STEP + 1)} disabled={busy || !teamReady}>
                    Continue <ArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </>
            )}

            {step === 4 && teamReady && (
              <>
                <div>
                  <h2 className="text-lg font-bold">Which modules do you want to start with?</h2>
                  <p className="text-sm text-muted-foreground">We have ticked the ones that usually suit your business type. This only sets your starting point; it does not change your plan or billing.</p>
                </div>
                {(state.modules?.available.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No modules are included in your plan yet. You can add them from Settings.</p>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-2">
                    {state.modules!.available.filter((m) => MODULE_INFO[m]).map((m) => (
                      <label key={m} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${picked.includes(m) ? "border-primary/40 bg-primary/5" : ""}`}>
                        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={picked.includes(m)}
                          onChange={(e) => setPicked((p) => e.target.checked ? [...p, m] : p.filter((x) => x !== m))} />
                        <span>
                          <span className="block text-sm font-medium">{MODULE_INFO[m].label}</span>
                          <span className="block text-xs text-muted-foreground">{MODULE_INFO[m].hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <StepActions busy={busy} onSave={saveModules} onSkip={() => setStep(5)} />
              </>
            )}

            {step === 5 && teamReady && (
              <>
                <div>
                  <h2 className="text-lg font-bold">Starter compliance checks</h2>
                  <p className="text-sm text-muted-foreground">
                    Tick the checks that apply to your premises and enter when each was last done, so due dates are real.
                    We have ticked the core legal checks; untick anything that does not apply.
                  </p>
                </div>
                <div className="space-y-4">
                  {grouped.map(([category, checks]) => (
                    <div key={category}>
                      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1.5">{category}</h3>
                      <ul className="space-y-2">
                        {checks.map((c) => {
                          const choice = choices[c.title] ?? { ticked: false, date: "" };
                          const id = `starter-${c.title.replace(/[^a-z0-9]+/gi, "-")}`;
                          return (
                            <li key={c.title} className={`rounded-lg border p-3 ${choice.ticked ? "border-primary/40 bg-primary/5" : ""}`}>
                              <label htmlFor={id} className="flex items-start gap-3 cursor-pointer">
                                <input id={id} type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={choice.ticked} disabled={c.state === "customised"}
                                  onChange={(e) => setChoices((all) => ({ ...all, [c.title]: { ...choice, ticked: e.target.checked } }))} />
                                <span className="min-w-0">
                                  <span className="block text-sm font-medium">{c.title}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {c.state === "customised" ? "Already on your list and edited, so it is left as it is."
                                      : c.frequencyMonths ? `Repeats every ${intervalLabel(c.frequencyMonths)}.` : "Interval set by your premises or competent person."}
                                  </span>
                                </span>
                              </label>
                              {choice.ticked && c.state !== "customised" && (
                                <div className="mt-2 pl-7 flex flex-wrap items-center gap-2">
                                  <Label htmlFor={`${id}-date`} className="text-xs font-normal text-muted-foreground">
                                    {c.frequencyMonths ? "Last done" : "Next due"}
                                  </Label>
                                  <Input key={choice.resetKey ?? 0} id={`${id}-date`} type="date" className="h-8 w-auto text-sm" value={choice.date}
                                    max={c.frequencyMonths ? localToday() : undefined}
                                    onChange={(e) => {
                                      const date = e.target.value;
                                      setChoices((all) => ({ ...all, [c.title]: { ...(all[c.title] ?? choice), date, partial: !date && e.target.validity.badInput } }));
                                    }}
                                    onBlur={(e) => {
                                      const partial = e.currentTarget.validity.badInput;
                                      setChoices((all) => ({ ...all, [c.title]: { ...(all[c.title] ?? choice), partial } }));
                                    }} />
                                  {choice.date && <span className="text-xs text-muted-foreground">{formatDay(choice.date)}</span>}
                                  {choice.date || choice.partial ? (
                                    <button type="button" className="text-xs text-primary hover:underline"
                                      onClick={() => setChoices((all) => ({ ...all, [c.title]: { ...(all[c.title] ?? choice), date: "", partial: false, resetKey: (all[c.title]?.resetKey ?? 0) + 1 } }))}>
                                      Clear date (not sure)
                                    </button>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Leave blank if you are not sure</span>
                                  )}
                                  {choice.partial && !choice.date && (
                                    <span className="basis-full text-xs text-amber-700">This date is not finished, so it will be saved blank. Finish it or clear it.</span>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                        {customChecks.filter((c) => c.category === category).map((c) => {
                          const id = `custom-${c.key}`;
                          return (
                            <li key={c.key} className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
                              <div className="flex items-center gap-2">
                                <Label htmlFor={`${id}-title`} className="sr-only">Check name</Label>
                                <Input id={`${id}-title`} className="h-8 text-sm" placeholder="Check name, e.g. Mini digger — Thorough Examination" value={c.title} autoFocus
                                  onChange={(e) => updateCustomCheck(c.key, { title: e.target.value })} />
                                <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" aria-label="Remove this check"
                                  onClick={() => setCustomChecks((all) => all.filter((x) => x.key !== c.key))}>
                                  <X className="w-4 h-4" />
                                </Button>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Label htmlFor={`${id}-every`} className="text-xs font-normal text-muted-foreground">Repeats every</Label>
                                <Input id={`${id}-every`} type="number" min={1} max={c.unit === "years" ? 10 : 120} step={1} className="h-8 w-20 text-sm" value={c.every}
                                  onChange={(e) => updateCustomCheck(c.key, { every: e.target.value })} />
                                <select aria-label="Months or years" className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={c.unit}
                                  onChange={(e) => updateCustomCheck(c.key, { unit: e.target.value as CustomCheck["unit"] })}>
                                  <option value="months">months</option>
                                  <option value="years">years</option>
                                </select>
                                <Label htmlFor={`${id}-date`} className="text-xs font-normal text-muted-foreground ml-2">Last done</Label>
                                <Input id={`${id}-date`} type="date" className="h-8 w-auto text-sm" value={c.lastDone} max={localToday()}
                                  onChange={(e) => updateCustomCheck(c.key, { lastDone: e.target.value })} />
                              </div>
                              {customMonths(c) == null
                                ? <p className="text-xs text-destructive">Enter a whole number between 1 month and 10 years.</p>
                                : !c.lastDone && <p className="text-xs text-muted-foreground">Leave the date blank if you are not sure.</p>}
                            </li>
                          );
                        })}
                      </ul>
                      <Button type="button" variant="ghost" size="sm" className="mt-1.5 h-8 px-2 text-primary" onClick={() => addCustomCheck(category)}>
                        <Plus className="w-4 h-4 mr-1" /> Add check
                      </Button>
                    </div>
                  ))}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={removeUnticked} onChange={(e) => setRemoveUnticked(e.target.checked)} />
                  <span>Remove the starter checks I have unticked from my checks list (only ones nobody has edited; you can add checks again at any time).</span>
                </label>
                {sites.length > 1 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-site">Add these checks to</Label>
                    <select id="setup-site" className={selectClass} value={siteId ?? ""} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <p className="text-xs text-muted-foreground">Save, then pick your next site to set up its checks too.</p>
                  </div>
                )}
                {siteId == null && <p className="text-xs text-muted-foreground">Add a site first to attach these checks to it; otherwise they apply to the whole business.</p>}
                {customIncomplete && <p className="text-xs text-destructive">Give each added check a name and how often it repeats, or remove it.</p>}
                <StepActions busy={busy} onSave={saveChecks} onSkip={() => setStep(6)} saveLabel="Save checks" disabled={customIncomplete} />
              </>
            )}

            {step === 6 && teamReady && (
              <>
                <div>
                  <h2 className="text-lg font-bold">Record your first check</h2>
                  <p className="text-sm text-muted-foreground">The quickest way to see how ComplyTrack works is to record something real today.</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-4 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-medium">{MODULE_INFO[firstModule]?.label}</p>
                    <p className="text-xs text-muted-foreground">{MODULE_INFO[firstModule]?.hint}</p>
                  </div>
                  <Button onClick={() => finish(MODULE_INFO[firstModule]?.href ?? "/dashboard")} disabled={busy}>
                    Record now <ArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
                  <Link href="/tasks" className="text-sm text-primary hover:underline">Set up staff tasks instead</Link>
                  <Button variant="outline" onClick={() => finish()} disabled={busy}>
                    <CheckCircle2 className="w-4 h-4 mr-1" /> Finish setup
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
      <UserDialog
        open={personOpen}
        onClose={() => setPersonOpen(false)}
        onSaved={(notice) => {
          if (notice) toast({ title: notice.kind === "error" ? "Invite email not sent" : "Person added", description: notice.text, variant: notice.kind === "error" ? "destructive" : undefined });
          void teamChanged();
        }}
        user={null}
        departments={departments.map((d) => ({ ...d, siteId: d.siteId ?? null }))}
        roster={roster}
        clientId={clientId}
        isConsultant={user?.role === "consultant"}
        currentUserId={user?.id ?? null}
        actor={user ? { role: user.role, departmentId: user.departmentId, departmentIds: user.departmentIds, allDepartments: user.allDepartments } : null}
        defaultRole="client_staff"
      />
    </AppLayout>
  );
}

function StepActions({ busy, onSave, onSkip, disabled, saveLabel = "Save and continue" }: {
  busy: boolean; onSave: () => void; onSkip: () => void; disabled?: boolean; saveLabel?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <Button variant="ghost" onClick={onSkip} disabled={busy}>Skip this step</Button>
      <Button onClick={onSave} disabled={busy || disabled}>{busy ? "Saving…" : saveLabel}</Button>
    </div>
  );
}
