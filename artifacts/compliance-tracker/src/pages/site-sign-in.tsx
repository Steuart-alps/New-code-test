import { useCallback, useEffect, useState } from "react";
import { useRoute } from "wouter";
import { CheckCircle2, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SiteSignInForm, type SignInSubmission, type SiteBriefing } from "@/components/site-sign-in-form";

interface Briefing extends SiteBriefing {
  businessName: string;
  siteName: string;
}
interface Visit { name: string; signedInAt: string; signedOutAt: string | null }

const apiBase = import.meta.env.VITE_API_URL ?? "";

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
  const [changed, setChanged] = useState(false);
  // A new form (cleared) for each person signing in on this phone.
  const [formKey, setFormKey] = useState(0);

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

  async function signIn(body: SignInSubmission) {
    setError(null);
    setBusy(true);
    try {
      const result = await call<{ signOutToken: string; signedInAt: string; name: string }>(`${token}/sign-in`, {
        method: "POST",
        body: JSON.stringify(body),
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
    setFormKey((key) => key + 1);
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

  return shell(
    <SiteSignInForm
      key={formKey}
      briefing={briefing}
      intro={<>{header}<p className="px-1 text-sm text-muted-foreground">Please sign in before you start work. It takes about two minutes.</p></>}
      changed={changed}
      busy={busy}
      error={error}
      onSubmit={signIn}
    />,
  );
}
