import { useEffect, useState } from "react";
import { AlertTriangle, Flame, HardHat, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignaturePad } from "@/components/signature-pad";

export interface AsbestosEntry { location: string; material: string; condition: string; priority: string; action: string; lastInspected: string | null }
/** What a contractor reads before signing in at a site (api-server routes/contractor-sign-in.ts). */
export interface SiteBriefing {
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
/** The sign-in the server checks (SignInBody). */
export interface SignInSubmission {
  name: string; company: string; phone: string; email: string; visitReason: string;
  briefingVersion: string; fireAcknowledged: true; asbestosAcknowledged: true; declaration: true; signature: string;
}

const SURVEY_LABELS: Record<string, string> = { management: "Management survey", refurbishment_demolition: "Refurbishment and demolition survey" };
const CONDITION_LABELS: Record<string, string> = { good: "Good", low_damage: "Low damage", medium_damage: "Medium damage", high_damage: "High damage" };
const ACTION_LABELS: Record<string, string> = { manage: "Manage in place", encapsulate: "Encapsulate / repair", remove: "To be removed" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function Tick({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (value: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} className="mt-0.5 h-5 w-5" />
      <Label htmlFor={id} className="text-sm font-medium leading-snug cursor-pointer">{children}</Label>
    </div>
  );
}

export function Missing({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

/**
 * Signing in at a site: the contractor's details, the fire procedure and
 * asbestos register to read and tick, a declaration and their signature.
 * Used by the site's own sign-in link and by a testing visit's link. When the
 * site's information changes (a new briefing version), the ticks are cleared.
 */
export function SiteSignInForm({ briefing, intro, defaultReason = "", changed, busy, error, onSubmit }: {
  briefing: SiteBriefing;
  intro: React.ReactNode;
  defaultReason?: string;
  /** The site updated what contractors read since the form was opened. */
  changed: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (body: SignInSubmission) => void;
}) {
  const [form, setForm] = useState({ name: "", company: "", phone: "", email: "", visitReason: defaultReason });
  const [fireOk, setFireOk] = useState(false);
  const [asbestosOk, setAsbestosOk] = useState(false);
  const [declared, setDeclared] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => { setFireOk(false); setAsbestosOk(false); }, [briefing.version]);

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: e.target.value })),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (!form.name.trim() || !form.company.trim()) return setProblem("Enter your name and company.");
    if (!fireOk || !asbestosOk || !declared) return setProblem("Tick all three boxes to confirm.");
    if (!signature) return setProblem("Sign in the box with your finger.");
    onSubmit({ ...form, briefingVersion: briefing.version, fireAcknowledged: true, asbestosAcknowledged: true, declaration: true, signature });
  }

  const { asbestos } = briefing;
  const shown = problem ?? error;
  return (
    <form onSubmit={submit} className="space-y-4">
      {intro}
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
        {shown && <p className="text-sm text-destructive" role="alert">{shown}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Sign in
        </Button>
      </Card>
    </form>
  );
}
