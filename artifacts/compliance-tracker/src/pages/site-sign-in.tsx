import { useCallback, useEffect, useState } from "react";
import { useRoute } from "wouter";
import { AlertTriangle, CheckCircle2, Flame, HardHat, Loader2, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignaturePad } from "@/components/signature-pad";

interface AsbestosEntry { location: string; material: string; condition: string; priority: string; action: string; lastInspected: string | null }
interface Briefing {
  businessName: string;
  siteName: string;
  fireProcedure: string | null;
  asbestos: {
    status: "register" | "none_expected" | "missing";
    surveyType: string | null;
    surveyDate: string | null;
    surveyor: string | null;
    entries: AsbestosEntry[];
  };
  version: string;
}
interface Visit { name: string; signedInAt: string; signedOutAt: string | null }

const apiBase = import.meta.env.VITE_API_URL ?? "";
const SURVEY_LABELS: Record<string, string> = { management: "Management survey", refurbishment_demolition: "Refurbishment and demolition survey" };
const CONDITION_LABELS: Record<string, string> = { good: "Good", low_damage: "Low damage", medium_damage: "Medium damage", high_damage: "High damage" };
const ACTION_LABELS: Record<string, string> = { manage: "Manage in place", encapsulate: "Encapsulate / repair", remove: "To be removed" };

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

// The phone keeps its sign-out key so the contractor can sign out later on
// the same link. Storage can be unavailable (private browsing), so every use
// is guarded and the page still works without it.
const storageKey = (token: string) => `site-sign-in:${token}`;
function readSaved(token: string): { signOutToken: string } | null {
  try {
    const raw = window.localStorage.getItem(storageKey(token));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.signOutToken === "string" ? parsed : null;
  } catch { return null; }
}
function writeSaved(token: string, value: { signOutToken: string } | null) {
  try {
    if (value) window.localStorage.setItem(storageKey(token), JSON.stringify(value));
    else window.localStorage.removeItem(storageKey(token));
  } catch { /* the visit is still recorded; staff can sign them out */ }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}/api/site-sign-in/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? "Something went wrong. Please try again."), { status: response.status });
  return body as T;
}

function Tick({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (value: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} className="mt-0.5 h-5 w-5" />
      <Label htmlFor={id} className="text-sm font-medium leading-snug cursor-pointer">{children}</Label>
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

/**
 * The contractor sign-in link for one site (QR poster at reception, or the
 * link in an email). No account: the link is the key. They read the fire
 * procedure and asbestos register, tick, sign, and sign out on the same phone.
 */
export default function SiteSignInPage() {
  const [, params] = useRoute("/site-sign-in/:token");
  const token = params?.token ?? "";
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", company: "", phone: "", email: "", visitReason: "" });
  const [fireOk, setFireOk] = useState(false);
  const [asbestosOk, setAsbestosOk] = useState(false);
  const [declared, setDeclared] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const loadBriefing = useCallback(async () => {
    const data = await call<Briefing>(token);
    setBriefing(data);
    return data;
  }, [token]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        await loadBriefing();
        const saved = readSaved(token);
        if (saved) {
          try {
            const current = await call<Visit>(`${token}/visit`, { method: "POST", body: JSON.stringify(saved) });
            if (current.signedOutAt) writeSaved(token, null);
            else setVisit(current);
          } catch { writeSaved(token, null); }
        }
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [token, loadBriefing]);

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: e.target.value })),
  });

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (!briefing) return;
    setError(null);
    if (!form.name.trim() || !form.company.trim()) return setError("Enter your name and company.");
    if (!fireOk || !asbestosOk || !declared) return setError("Tick all three boxes to confirm.");
    if (!signature) return setError("Sign in the box with your finger.");
    setBusy(true);
    try {
      const result = await call<{ signOutToken: string; signedInAt: string; name: string }>(`${token}/sign-in`, {
        method: "POST",
        body: JSON.stringify({
          ...form, briefingVersion: briefing.version, fireAcknowledged: true, asbestosAcknowledged: true, declaration: true, signature,
        }),
      });
      writeSaved(token, { signOutToken: result.signOutToken });
      setVisit({ name: result.name, signedInAt: result.signedInAt, signedOutAt: null });
      window.scrollTo({ top: 0 });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409) setError((err as Error).message);
      else {
        setChanged(true);
        // The site changed what contractors read: show the new version and ask again.
        setFireOk(false);
        setAsbestosOk(false);
        await loadBriefing().catch(() => undefined);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    const saved = readSaved(token);
    if (!saved || !visit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ signedOutAt: string }>(`${token}/sign-out`, { method: "POST", body: JSON.stringify(saved) });
      writeSaved(token, null);
      setVisit({ ...visit, signedOutAt: result.signedOutAt });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startAgain() {
    setVisit(null);
    setForm({ name: "", company: "", phone: "", email: "", visitReason: "" });
    setFireOk(false);
    setAsbestosOk(false);
    setDeclared(false);
    setSignature(null);
    setError(null);
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-emerald-50 px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-xl space-y-4">{children}</div>
    </div>
  );

  if (loading) {
    return shell(<Card className="p-8 flex items-center justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</Card>);
  }
  if (!briefing) {
    return shell(
      <Card className="p-8 text-center">
        <h1 className="text-xl font-bold mb-2">Sign-in unavailable</h1>
        <p className="text-muted-foreground">{loadError}</p>
      </Card>,
    );
  }

  const header = (
    <div className="px-1">
      <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{briefing.businessName} · {briefing.siteName}</p>
      <h1 className="text-2xl font-bold mt-1">Contractor sign-in</h1>
    </div>
  );

  if (visit) {
    return shell(
      <>
        {header}
        <Card className="p-6 sm:p-8 text-center space-y-4">
          <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" aria-hidden="true" />
          {visit.signedOutAt ? (
            <>
              <h2 className="text-xl font-bold">Signed out at {time(visit.signedOutAt)}</h2>
              <p className="text-muted-foreground">Thank you, {visit.name}. Have a safe journey.</p>
              <Button variant="outline" onClick={startAgain}>Sign in someone else</Button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold">You're signed in, {visit.name}</h2>
              <p className="text-muted-foreground">Signed in at {time(visit.signedInAt)} on {day(visit.signedInAt)}.</p>
              <p className="text-sm">Please sign out on this phone when you leave, so the site knows you're safe if there's a fire.</p>
              <Button size="lg" className="w-full" onClick={signOut} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogOut className="w-4 h-4 mr-2" />} Sign out
              </Button>
              <button type="button" className="text-sm text-muted-foreground underline" onClick={startAgain}>Sign in someone else on this phone</button>
            </>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </Card>
      </>,
    );
  }

  const { asbestos } = briefing;
  return shell(
    <form onSubmit={signIn} className="space-y-4">
      {header}
      <p className="px-1 text-sm text-muted-foreground">Please sign in before you start work. It takes about two minutes.</p>
      {changed && <Missing>The site has just updated its safety information. Please read it again and tick the boxes.</Missing>}

      <Card className="p-5 space-y-3">
        <h2 className="font-bold text-lg flex items-center gap-2"><HardHat className="w-5 h-5 text-primary" aria-hidden="true" /> Your details</h2>
        <div className="space-y-1.5"><Label htmlFor="ssi-name">Your name</Label><Input id="ssi-name" autoComplete="name" maxLength={120} {...field("name")} /></div>
        <div className="space-y-1.5"><Label htmlFor="ssi-company">Company</Label><Input id="ssi-company" autoComplete="organization" maxLength={160} {...field("company")} /></div>
        <div className="space-y-1.5"><Label htmlFor="ssi-phone">Mobile number</Label><Input id="ssi-phone" type="tel" autoComplete="tel" maxLength={40} {...field("phone")} /></div>
        <div className="space-y-1.5"><Label htmlFor="ssi-email">Email (optional)</Label><Input id="ssi-email" type="email" autoComplete="email" maxLength={320} {...field("email")} /></div>
        <div className="space-y-1.5"><Label htmlFor="ssi-reason">What are you here to do?</Label><Input id="ssi-reason" maxLength={300} placeholder="e.g. PAT testing, boiler service" {...field("visitReason")} /></div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold text-lg flex items-center gap-2"><Flame className="w-5 h-5 text-rose-600" aria-hidden="true" /> Fire procedure</h2>
        {briefing.fireProcedure ? (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm whitespace-pre-wrap leading-relaxed">{briefing.fireProcedure}</div>
        ) : (
          <Missing>This site hasn't added its fire procedure yet. Ask the site contact where the exits and assembly point are before you start work.</Missing>
        )}
        <Tick id="ssi-fire" checked={fireOk} onChange={setFireOk}>
          {briefing.fireProcedure ? "I have read the fire procedure and will follow it." : "I will ask the site contact for the fire procedure before I start work."}
        </Tick>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold text-lg flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-amber-600" aria-hidden="true" /> Asbestos</h2>
        {asbestos.status === "register" && (
          <>
            <p className="text-sm text-muted-foreground">
              {[asbestos.surveyType ? SURVEY_LABELS[asbestos.surveyType] ?? asbestos.surveyType : "Asbestos survey",
                asbestos.surveyDate ? `on ${day(asbestos.surveyDate)}` : null,
                asbestos.surveyor ? `by ${asbestos.surveyor}` : null].filter(Boolean).join(" ")}.
            </p>
            {asbestos.entries.length ? (
              <ul className="space-y-2">
                {asbestos.entries.map((entry, index) => (
                  <li key={index} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
                    <p className="font-semibold">{entry.location}</p>
                    <p>{entry.material}</p>
                    <p className="text-muted-foreground mt-1">
                      Condition: {CONDITION_LABELS[entry.condition] ?? entry.condition} · {ACTION_LABELS[entry.action] ?? entry.action}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">The survey found no asbestos-containing materials on the register.</p>
            )}
            <p className="text-sm font-medium">Do not drill, cut, sand or disturb any of these materials. If you find anything you think could be asbestos, stop work and tell the site contact.</p>
          </>
        )}
        {asbestos.status === "none_expected" && (
          <p className="text-sm">This building was built in 2000 or later, so no asbestos is expected. If you find anything you think could be asbestos, stop work and tell the site contact.</p>
        )}
        {asbestos.status === "missing" && (
          <Missing>This site hasn't added its asbestos register yet. Ask to see it before any work that could disturb walls, ceilings, floors or pipework.</Missing>
        )}
        <Tick id="ssi-asbestos" checked={asbestosOk} onChange={setAsbestosOk}>
          {asbestos.status === "missing" ? "I will ask to see the asbestos register before any work that could disturb the building." : "I have read the asbestos information above."}
        </Tick>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold text-lg">Sign off</h2>
        <Tick id="ssi-declare" checked={declared} onChange={setDeclared}>
          My details are correct, and I will work safely and follow the site's rules while I'm here.
        </Tick>
        <SignaturePad value={signature} onChange={setSignature} label="Your signature" />
        <p className="text-xs text-muted-foreground">Signed {day(new Date().toISOString())}. The time is recorded when you sign in.</p>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Sign in
        </Button>
      </Card>
    </form>,
  );
}
