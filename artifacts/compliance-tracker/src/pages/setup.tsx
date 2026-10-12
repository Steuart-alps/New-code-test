import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, CheckCircle2, ClipboardCheck, LayoutGrid, MapPin, Sparkles } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import {
  BUSINESS_TYPE_OPTIONS, FIRST_RECORD_PRIORITY, MODULE_INFO, NATION_OPTIONS, RECOMMENDED_MODULES,
  formatDay, localToday, onboardingRequest,
} from "@/lib/onboarding";

type StarterCheck = {
  title: string; category: string; description: string; frequencyMonths: number | null;
  core: boolean; state: "untouched" | "customised" | "missing";
};
type SetupState = {
  needsSetup: boolean; setupCompletedAt: string | null; canManage: boolean; businessType: string | null;
  deferredAt?: string | null; nation?: string | null; sites?: { id: number; name: string }[];
  modules?: { available: string[]; picked: string[] }; starterChecks?: StarterCheck[];
};
type Choice = { ticked: boolean; date: string };

const STEPS = [
  { label: "Your business", icon: Building2 },
  { label: "First site", icon: MapPin },
  { label: "Modules", icon: LayoutGrid },
  { label: "Starter checks", icon: ClipboardCheck },
  { label: "First record", icon: Sparkles },
];
const selectClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export default function SetupPage() {
  const { user, activeClientId, refresh } = useAuth();
  const clientId = user?.role === "consultant" ? activeClientId : null;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SetupState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [businessType, setBusinessType] = useState("");
  const [nation, setNation] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [siteId, setSiteId] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [removeUnticked, setRemoveUnticked] = useState(false);

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

  const saveSite = () => run(async () => {
    if (!siteName.trim()) return;
    const site = await post("/sites", { name: siteName.trim(), address: siteAddress.trim() || null, seedStarterChecks: false }) as { id: number };
    setSiteId(site.id);
    void queryClient.invalidateQueries();
    await load();
  });

  const saveModules = () => run(async () => { await post("/setup/modules", { modules: picked }, "PUT"); });

  const saveChecks = () => run(async () => {
    const checks = (state?.starterChecks ?? []).filter((c) => choices[c.title]?.ticked && c.state !== "customised").map((c) => {
      const date = choices[c.title]?.date || null;
      return c.frequencyMonths ? { title: c.title, lastDone: date } : { title: c.title, nextDue: date };
    });
    const result = await post("/setup/starter-checks", { siteId, checks, removeUnticked }) as { updated: number; created: number; removed: number };
    toast({ title: "Starter checks saved", description: `${result.updated + result.created} set up${result.removed ? `, ${result.removed} removed` : ""}.` });
    void queryClient.invalidateQueries();
  });

  const finishLater = () => run(async () => {
    await post("/setup/defer", {});
    navigate("/dashboard");
  }, false);

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
            <p className="text-sm text-muted-foreground mt-1">A few quick questions so your dashboard shows what applies to you. You can skip any step.</p>
          </div>
          <Button variant="outline" size="sm" onClick={finishLater} disabled={busy}>Finish later</Button>
        </div>

        <ol className="grid grid-cols-5 gap-1" aria-label="Setup steps">
          {STEPS.map(({ label, icon: Icon }, i) => (
            <li key={label}>
              <button type="button" onClick={() => setStep(i)} aria-current={i === step ? "step" : undefined}
                className={`w-full flex flex-col items-center gap-1 rounded-md p-1.5 text-[11px] leading-tight ${i === step ? "bg-primary/10 text-primary font-semibold" : i < step ? "text-foreground" : "text-muted-foreground"}`}>
                <Icon className="w-4 h-4" />
                <span className="hidden sm:block text-center">{label}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="sm:hidden text-sm font-medium">Step {step + 1} of {STEPS.length}: {STEPS[step].label}</p>

        {loadError && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{loadError}</div>}
        {!state && !loadError && <div className="h-40 rounded-xl bg-muted animate-pulse" />}

        {state && (
          <section className="rounded-xl border bg-card p-5 shadow-sm space-y-5">
            {step === 0 && (
              <>
                <div>
                  <h2 className="text-lg font-semibold">What kind of business is this?</h2>
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
                  <h2 className="text-lg font-semibold">Your first site</h2>
                  <p className="text-sm text-muted-foreground">A site is a building or location where checks are recorded.</p>
                </div>
                {(state.sites?.length ?? 0) > 0 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-site">Use this site for your starter checks</Label>
                    <select id="setup-site" className={selectClass} value={siteId ?? ""} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}>
                      {state.sites!.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <p className="text-xs text-muted-foreground">You can add more sites later from Sites.</p>
                    <div className="flex justify-end pt-2"><Button onClick={() => setStep(2)}>Continue <ArrowRight className="w-4 h-4 ml-1" /></Button></div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="setup-site-name">Site name</Label>
                      <Input id="setup-site-name" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="e.g. The Red Lion" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="setup-site-address">Address (optional)</Label>
                      <Input id="setup-site-address" value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} placeholder="Street, town, postcode" />
                    </div>
                    <StepActions busy={busy} onSave={saveSite} onSkip={() => setStep(2)} disabled={!siteName.trim()} saveLabel="Add site" />
                  </>
                )}
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <h2 className="text-lg font-semibold">Which modules do you want to start with?</h2>
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
                <StepActions busy={busy} onSave={saveModules} onSkip={() => setStep(3)} />
              </>
            )}

            {step === 3 && (
              <>
                <div>
                  <h2 className="text-lg font-semibold">Starter compliance checks</h2>
                  <p className="text-sm text-muted-foreground">
                    Tick the checks that apply to your premises and enter when each was last done, so due dates are real.
                    We have ticked the core legal checks; untick anything that does not apply.
                  </p>
                </div>
                <div className="space-y-4">
                  {grouped.map(([category, checks]) => (
                    <div key={category}>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">{category}</h3>
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
                                      : c.frequencyMonths ? `Repeats every ${c.frequencyMonths} months.` : "Interval set by your premises or competent person."}
                                  </span>
                                </span>
                              </label>
                              {choice.ticked && c.state !== "customised" && (
                                <div className="mt-2 pl-7 flex flex-wrap items-center gap-2">
                                  <Label htmlFor={`${id}-date`} className="text-xs font-normal text-muted-foreground">
                                    {c.frequencyMonths ? "Last done" : "Next due"}
                                  </Label>
                                  <Input id={`${id}-date`} type="date" className="h-8 w-auto text-sm" value={choice.date}
                                    max={c.frequencyMonths ? localToday() : undefined}
                                    onChange={(e) => setChoices((all) => ({ ...all, [c.title]: { ...choice, date: e.target.value } }))} />
                                  {choice.date && <span className="text-xs text-muted-foreground">{formatDay(choice.date)}</span>}
                                  {!choice.date && <span className="text-xs text-muted-foreground">Leave blank if you are not sure</span>}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={removeUnticked} onChange={(e) => setRemoveUnticked(e.target.checked)} />
                  <span>Remove the starter checks I have unticked from my checks list (only ones nobody has edited; you can add checks again at any time).</span>
                </label>
                {siteId == null && <p className="text-xs text-muted-foreground">Add a site first to attach these checks to it; otherwise they apply to the whole business.</p>}
                <StepActions busy={busy} onSave={saveChecks} onSkip={() => setStep(4)} saveLabel="Save checks" />
              </>
            )}

            {step === 4 && (
              <>
                <div>
                  <h2 className="text-lg font-semibold">Record your first check</h2>
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
