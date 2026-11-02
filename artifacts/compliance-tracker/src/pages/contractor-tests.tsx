import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { CheckCircle2, ChevronDown, ChevronUp, FileUp, Loader2, LogOut, Plus, Search, UploadCloud, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignaturePad } from "@/components/signature-pad";
import { SiteSignInForm, Tick, type SignInSubmission, type SiteBriefing } from "@/components/site-sign-in-form";
import { useFileDrop } from "@/hooks/use-file-drop";
import { cn } from "@/lib/utils";

interface VisitInfo extends SiteBriefing {
  module: "pat";
  businessName: string;
  siteName: string;
  contractorName: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "signed_off";
  hasCertificate: boolean;
  certificateFileName: string | null;
  signedOff: { at: string; name: string; company: string; certificateRef: string; nextTestDue: string | null } | null;
  maxCertificateBytes: number;
  applianceTypes: string[];
  retestMonths: number;
  showEarthBond: boolean;
  showInsulation: boolean;
}
interface Session { name: string; company: string; signedInAt: string; signedOutAt: string | null; onSite: boolean }
interface Item {
  id: number;
  name: string;
  applianceType: string;
  location: string | null;
  assetTag: string | null;
  lastTestDate: string | null;
  lastResult: string | null;
  result: "pass" | "fail" | null;
  visualInspection: string | null;
  earthContinuityOhms: string | null;
  insulationMohms: string | null;
  operatingCurrent: string | null;
  notes: string | null;
}
type Readings = Pick<Item, "visualInspection" | "earthContinuityOhms" | "insulationMohms" | "operatingCurrent" | "notes">;

const apiBase = import.meta.env.VITE_API_URL ?? "";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const NO_LOCATION = "Other appliances";

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// The phone keeps the sign-in key so the contractor can come back to the link
// (and sign out) on the same phone. Storage can be unavailable (private
// browsing), so every use is guarded; they can sign in again if it is lost.
const storageKey = (token: string) => `contractor-tests:${token}`;
function readSaved(token: string): string | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(token)) ?? "null");
    return typeof parsed?.signOutToken === "string" ? parsed.signOutToken : null;
  } catch { return null; }
}
function writeSaved(token: string, signOutToken: string | null) {
  try {
    if (signOutToken) window.localStorage.setItem(storageKey(token), JSON.stringify({ signOutToken }));
    else window.localStorage.removeItem(storageKey(token));
  } catch { /* they can sign in again */ }
}

class LinkError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function call<T>(token: string, path: string, init: RequestInit & { key?: string | null } = {}): Promise<T> {
  const { key, ...rest } = init;
  const response = await fetch(`${apiBase}/api/contractor-tests/${token}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(key ? { "X-Contractor-Sign-In": key } : {}), ...(rest.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new LinkError(body.error ?? "Something went wrong. Please try again.", response.status, body.code);
  return body as T;
}

function fileType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "docx" ? DOCX_TYPE : ext === "png" ? "image/png"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "heic" ? "image/heic" : "";
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });
}

/** Choose or drop the contractor's own certificate; it replaces any earlier file. */
function CertificateUpload({ token, info, onUploaded }: { token: string; info: VisitInfo; onUploaded: (fileName: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError(null);
    if (file.size > info.maxCertificateBytes) {
      setError(`${file.name} is over ${Math.round(info.maxCertificateBytes / 1024 / 1024)} MB. Save it as a smaller PDF and try again.`);
      return;
    }
    setUploading(file.name);
    try {
      const result = await call<{ certificateFileName: string }>(token, "/certificate", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, mimeType: fileType(file), data: await toBase64(file) }),
      });
      onUploaded(result.certificateFileName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(null);
      if (input.current) input.current.value = "";
    }
  }

  const { isDragging, dropZoneProps } = useFileDrop((files) => void upload(files), !uploading);
  return (
    <div>
      <div
        {...dropZoneProps}
        className={cn("border-2 border-dashed rounded-xl p-5 flex flex-col items-center justify-center text-center bg-muted/20",
          isDragging ? "border-emerald-500 bg-emerald-50" : "border-border")}
      >
        {uploading ? (
          <p className="text-sm font-medium flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" /> Sending {uploading}…</p>
        ) : info.hasCertificate ? (
          <>
            <p className="text-sm font-medium flex items-center text-emerald-700"><CheckCircle2 className="w-4 h-4 mr-2" aria-hidden="true" /> {info.certificateFileName ?? "Certificate"} received</p>
            <Button type="button" variant="link" size="sm" onClick={() => input.current?.click()}>Replace it</Button>
          </>
        ) : (
          <>
            <UploadCloud className="w-7 h-7 text-muted-foreground mb-2" aria-hidden="true" />
            <Button type="button" onClick={() => input.current?.click()}><FileUp className="w-4 h-4 mr-2" aria-hidden="true" /> Upload your certificate</Button>
            <p className="text-xs text-muted-foreground mt-2">A PDF or a photo, {Math.round(info.maxCertificateBytes / 1024 / 1024)} MB at most.</p>
          </>
        )}
        <input ref={input} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.heic,.docx,application/pdf,image/*"
          data-testid="input-contractor-certificate"
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void upload(files); }} />
      </div>
      {error && <p className="text-sm text-destructive mt-2" role="alert">{error}</p>}
    </div>
  );
}

function ItemRow({ item, info, busy, onLog }: {
  item: Item; info: VisitInfo; busy: boolean; onLog: (item: Item, result: "pass" | "fail", readings: Readings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [readings, setReadings] = useState<Readings>({
    visualInspection: item.visualInspection, earthContinuityOhms: item.earthContinuityOhms, insulationMohms: item.insulationMohms,
    operatingCurrent: item.operatingCurrent, notes: item.notes,
  });
  const set = (key: keyof Readings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setReadings((current) => ({ ...current, [key]: e.target.value || null }));
  const log = (result: "pass" | "fail") => {
    onLog(item, result, readings);
    // A fail is worth a note: open the details for it.
    if (result === "fail" && !readings.notes) setOpen(true);
  };
  const facts = [item.applianceType, item.assetTag ? `Tag ${item.assetTag}` : null,
    item.lastTestDate ? `Last tested ${day(item.lastTestDate)}${item.lastResult === "fail" ? " (failed)" : ""}` : "Not tested before"].filter(Boolean).join(" · ");
  return (
    <li className={cn("rounded-lg border bg-white p-3", item.result === "fail" ? "border-rose-300 bg-rose-50/50" : item.result === "pass" ? "border-emerald-300" : "border-slate-200")}
      data-testid={`pat-item-${item.id}`}>
      <div className="flex items-center gap-3">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <p className="font-semibold leading-tight flex items-center gap-1">{item.name}{open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{facts}</p>
        </button>
        <div className="flex shrink-0 gap-1.5">
          <Button type="button" size="sm" disabled={busy} data-testid={`button-pass-${item.id}`}
            className={cn("h-11 w-16", item.result === "pass" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-50")}
            onClick={() => log("pass")}>Pass</Button>
          <Button type="button" size="sm" disabled={busy} data-testid={`button-fail-${item.id}`}
            className={cn("h-11 w-16", item.result === "fail" ? "bg-rose-600 hover:bg-rose-700 text-white" : "bg-white text-rose-700 border border-rose-300 hover:bg-rose-50")}
            onClick={() => log("fail")}>Fail</Button>
        </div>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3">
          <div className="space-y-1">
            <Label htmlFor={`visual-${item.id}`} className="text-xs">Visual inspection</Label>
            <select id={`visual-${item.id}`} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={readings.visualInspection ?? ""} onChange={set("visualInspection")}>
              <option value="">Not recorded</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="na">N/A</option>
            </select>
          </div>
          {info.showEarthBond && (
            <div className="space-y-1"><Label htmlFor={`earth-${item.id}`} className="text-xs">Earth continuity (Ω)</Label>
              <Input id={`earth-${item.id}`} inputMode="decimal" value={readings.earthContinuityOhms ?? ""} onChange={set("earthContinuityOhms")} /></div>
          )}
          {info.showInsulation && (
            <div className="space-y-1"><Label htmlFor={`insulation-${item.id}`} className="text-xs">Insulation (MΩ)</Label>
              <Input id={`insulation-${item.id}`} inputMode="decimal" value={readings.insulationMohms ?? ""} onChange={set("insulationMohms")} /></div>
          )}
          <div className="space-y-1"><Label htmlFor={`current-${item.id}`} className="text-xs">Load / leakage (mA)</Label>
            <Input id={`current-${item.id}`} inputMode="decimal" value={readings.operatingCurrent ?? ""} onChange={set("operatingCurrent")} /></div>
          <div className="col-span-2 space-y-1"><Label htmlFor={`notes-${item.id}`} className="text-xs">{item.result === "fail" ? "What's wrong with it?" : "Notes"}</Label>
            <Textarea id={`notes-${item.id}`} rows={2} maxLength={1000} value={readings.notes ?? ""} onChange={set("notes")} /></div>
          <p className="col-span-2 text-xs text-muted-foreground">Readings are saved when you tap Pass or Fail.</p>
        </div>
      )}
    </li>
  );
}

/**
 * A contractor's link to log PATrack tests for one visit (emailed by the
 * business). No account: the link is the key. They sign in at the site first
 * (fire procedure, asbestos register, signature), tap Pass or Fail for each
 * appliance, then upload their own certificate and sign off.
 */
export default function ContractorTestsPage() {
  const [, params] = useRoute("/contractor-tests/:token");
  const token = params?.token ?? "";
  const [info, setInfo] = useState<VisitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signInKey, setSignInKey] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [locations, setLocations] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<{ name: string; applianceType: string; location: string; assetTag: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [signOff, setSignOff] = useState({ certificateRef: "", nextTestDue: "", name: "", company: "", notes: "" });
  const [declared, setDeclared] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);

  const loadInfo = useCallback(async () => {
    const data = await call<VisitInfo>(token, "");
    setInfo(data);
    return data;
  }, [token]);

  const forgetSignIn = useCallback(() => {
    writeSaved(token, null);
    setSignInKey(null);
    setSession(null);
    setItems(null);
  }, [token]);

  const loadItems = useCallback(async (key: string) => {
    const data = await call<{ items: Item[]; locations: string[] }>(token, "/items", { key });
    setItems(data.items);
    setLocations(data.locations);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const data = await loadInfo();
        const saved = readSaved(token);
        if (saved) {
          try {
            const current = await call<Session>(token, "/session", { method: "POST", body: JSON.stringify({ signOutToken: saved }) });
            setSession(current);
            if (current.onSite) {
              setSignInKey(saved);
              if (data.status === "open") await loadItems(saved);
            } else writeSaved(token, null);
          } catch { writeSaved(token, null); }
        }
      } catch (err) {
        setLoadError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [token, loadInfo, loadItems]);

  useEffect(() => {
    if (session) setSignOff((current) => ({ ...current, name: current.name || session.name, company: current.company || session.company }));
  }, [session]);

  /** A logging call failed: a lost sign-in goes back to the sign-in form. */
  function failed(err: unknown) {
    const status = (err as LinkError).status;
    if (status === 401) {
      forgetSignIn();
      setError("You've been signed out. Please sign in again to carry on.");
    } else if (status === 404) {
      setLoadError((err as Error).message);
      setInfo(null);
    } else setError((err as Error).message);
  }

  async function signIn(body: SignInSubmission) {
    setError(null);
    setBusy(true);
    try {
      const result = await call<{ signOutToken: string; signedInAt: string; name: string }>(token, "/sign-in", { method: "POST", body: JSON.stringify(body) });
      writeSaved(token, result.signOutToken);
      setSignInKey(result.signOutToken);
      setSession({ name: body.name, company: body.company, signedInAt: result.signedInAt, signedOutAt: null, onSite: true });
      await loadItems(result.signOutToken);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if ((err as LinkError).status === 409) {
        setChanged(true);
        await loadInfo().catch(() => undefined);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    const saved = readSaved(token) ?? signInKey;
    if (!saved) return;
    setBusy(true);
    try {
      const result = await call<{ signedOutAt: string }>(token, "/sign-out", { method: "POST", body: JSON.stringify({ signOutToken: saved }) });
      writeSaved(token, null);
      setSignInKey(null);
      setItems(null);
      setSession((current) => current && { ...current, signedOutAt: result.signedOutAt, onSite: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logResult(item: Item, result: "pass" | "fail", readings: Readings) {
    if (!signInKey) return;
    setError(null);
    setSavingId(item.id);
    try {
      const saved = await call<Item>(token, `/items/${item.id}/result`, {
        method: "PUT", key: signInKey, body: JSON.stringify({ result, ...readings }),
      });
      setItems((list) => list?.map((row) => row.id === saved.id ? saved : row) ?? list);
    } catch (err) {
      failed(err);
    } finally {
      setSavingId(null);
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!signInKey || !adding) return;
    if (!adding.name.trim()) return setError("Enter what the appliance is.");
    setError(null);
    setBusy(true);
    try {
      const created = await call<Item>(token, "/items", {
        method: "POST", key: signInKey,
        body: JSON.stringify({ name: adding.name, applianceType: adding.applianceType, location: adding.location || null, assetTag: adding.assetTag || null }),
      });
      setItems((list) => [...(list ?? []), created]);
      if (adding.location.trim() && !locations.includes(adding.location.trim())) setLocations((list) => [...list, adding.location.trim()]);
      setAdding(null);
      setSearch(created.name);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitSignOff(e: React.FormEvent) {
    e.preventDefault();
    if (!signInKey) return;
    setError(null);
    if (!signOff.certificateRef.trim()) return setError("Enter your certificate number.");
    if (!signOff.name.trim() || !signOff.company.trim()) return setError("Enter your name and company.");
    if (!declared) return setError("Tick to confirm the results are accurate.");
    if (!signature) return setError("Sign in the box with your finger.");
    setBusy(true);
    try {
      await call(token, "/sign-off", {
        method: "POST", key: signInKey,
        body: JSON.stringify({ ...signOff, nextTestDue: signOff.nextTestDue || null, declaration: true, signature }),
      });
      await loadInfo();
      setFinishing(false);
      window.scrollTo({ top: 0 });
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  }

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const shown = (items ?? []).filter((item) => !term
      || [item.name, item.location, item.assetTag, item.applianceType].some((text) => text?.toLowerCase().includes(term)));
    const byPlace = new Map<string, Item[]>();
    for (const item of shown) {
      const place = item.location?.trim() || NO_LOCATION;
      byPlace.set(place, [...(byPlace.get(place) ?? []), item]);
    }
    return [...byPlace.entries()];
  }, [items, search]);
  const tested = items?.filter((item) => item.result).length ?? 0;
  const failedCount = items?.filter((item) => item.result === "fail").length ?? 0;

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-amber-50 px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-xl space-y-4">{children}</div>
    </div>
  );

  if (loading) {
    return shell(<Card className="p-8 flex items-center justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</Card>);
  }
  if (!info) {
    return shell(
      <Card className="p-8 text-center">
        <h1 className="text-xl font-bold mb-2">Link unavailable</h1>
        <p className="text-muted-foreground">{loadError}</p>
      </Card>,
    );
  }

  const header = (
    <div className="px-1">
      <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{info.businessName} · {info.siteName}</p>
      <h1 className="text-2xl font-bold mt-1 flex items-center gap-2"><Zap className="w-6 h-6 text-amber-500" aria-hidden="true" /> PAT testing</h1>
      <p className="text-sm text-muted-foreground mt-1">{info.contractorName} · {info.startsOn === info.endsOn ? day(info.startsOn) : `${day(info.startsOn)} to ${day(info.endsOn)}`}</p>
    </div>
  );
  const signOutCard = session?.onSite && (
    <Card className="p-4 flex items-center justify-between gap-3">
      <p className="text-sm">Signed in as <strong>{session.name}</strong> at {time(session.signedInAt)}. Please sign out when you leave.</p>
      <Button variant="outline" onClick={signOut} disabled={busy} data-testid="button-contractor-sign-out"><LogOut className="w-4 h-4 mr-2" /> Sign out</Button>
    </Card>
  );

  if (info.status === "signed_off" && info.signedOff) {
    return shell(
      <>
        {header}
        <Card className="p-6 text-center space-y-3">
          <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" aria-hidden="true" />
          <h2 className="text-xl font-bold">Signed off. Thank you, {info.signedOff.name}.</h2>
          <p className="text-muted-foreground">Certificate {info.signedOff.certificateRef}{info.signedOff.nextTestDue ? `. Next test due ${day(info.signedOff.nextTestDue)}` : ""}.</p>
          <p className="text-sm">{info.businessName} has your results, and any failed appliances are on their action list.</p>
        </Card>
        <Card className="p-5 space-y-3">
          <h2 className="font-bold">Your certificate</h2>
          {!info.hasCertificate && <p className="text-sm text-muted-foreground">If your certificate isn't ready yet, come back to this link from the office to upload it within 30 days.</p>}
          <CertificateUpload token={token} info={info} onUploaded={(fileName) => setInfo({ ...info, hasCertificate: true, certificateFileName: fileName })} />
        </Card>
        {signOutCard}
        {session?.signedOutAt && <p className="text-center text-sm text-muted-foreground">Signed out at {time(session.signedOutAt)}. Have a safe journey.</p>}
      </>,
    );
  }

  if (!signInKey || !items) {
    return shell(
      <>
        {session?.signedOutAt && (
          <Card className="p-4 text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600" /> Signed out at {time(session.signedOutAt)}. Sign in again to log more tests.</Card>
        )}
        <SiteSignInForm
          briefing={info}
          defaultReason="PAT testing"
          intro={<>{header}<p className="px-1 text-sm">Before you start, please sign in at the site. Once you're signed in you can log each appliance as you test it.</p></>}
          changed={changed}
          busy={busy}
          error={error}
          onSubmit={signIn}
        />
      </>,
    );
  }

  if (finishing) {
    return shell(
      <form onSubmit={submitSignOff} className="space-y-4">
        {header}
        <Card className="p-5 space-y-2">
          <h2 className="font-bold text-lg">Finish and sign off</h2>
          <p className="text-sm">{tested} appliance{tested === 1 ? "" : "s"} tested, {failedCount} failed.{items.length > tested ? ` ${items.length - tested} on the list weren't tested.` : ""}</p>
          <Button type="button" variant="link" className="px-0 h-auto" onClick={() => setFinishing(false)}>Back to the list</Button>
        </Card>
        <Card className="p-5 space-y-3">
          <h2 className="font-bold">Your certificate</h2>
          <p className="text-sm text-muted-foreground">Upload it now if you have it. If not, you can come back to this link to upload it within 30 days of signing off.</p>
          <CertificateUpload token={token} info={info} onUploaded={(fileName) => setInfo({ ...info, hasCertificate: true, certificateFileName: fileName })} />
          <div className="space-y-1.5"><Label htmlFor="ct-ref">Certificate number</Label>
            <Input id="ct-ref" maxLength={120} value={signOff.certificateRef} onChange={(e) => setSignOff({ ...signOff, certificateRef: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="ct-next">Next test due (optional)</Label>
            <Input id="ct-next" type="date" value={signOff.nextTestDue} onChange={(e) => setSignOff({ ...signOff, nextTestDue: e.target.value })} />
            <p className="text-xs text-muted-foreground">Left blank, it's {info.retestMonths} months from the test, the business's usual interval.</p></div>
          <div className="space-y-1.5"><Label htmlFor="ct-notes">Notes for the site (optional)</Label>
            <Textarea id="ct-notes" rows={3} maxLength={2000} value={signOff.notes} onChange={(e) => setSignOff({ ...signOff, notes: e.target.value })} /></div>
        </Card>
        <Card className="p-5 space-y-3">
          <h2 className="font-bold">Sign off</h2>
          <div className="space-y-1.5"><Label htmlFor="ct-name">Your name</Label>
            <Input id="ct-name" maxLength={120} value={signOff.name} onChange={(e) => setSignOff({ ...signOff, name: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="ct-company">Company</Label>
            <Input id="ct-company" maxLength={160} value={signOff.company} onChange={(e) => setSignOff({ ...signOff, company: e.target.value })} /></div>
          <Tick id="ct-declare" checked={declared} onChange={setDeclared}>
            The results I've logged are accurate and match the certificate I'm issuing.
          </Tick>
          <SignaturePad value={signature} onChange={setSignature} label="Your signature" />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Sign off
          </Button>
        </Card>
      </form>,
    );
  }

  return shell(
    <>
      {header}
      {signOutCard}
      <Card className="p-4 space-y-3 sticky top-2 z-10 shadow-md">
        <div className="flex items-center justify-between text-sm">
          <span data-testid="text-pat-progress"><strong>{tested}</strong> of {items.length} tested</span>
          {failedCount > 0 && <span className="flex items-center gap-1 text-rose-700 font-medium"><XCircle className="w-4 h-4" /> {failedCount} failed</span>}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input className="pl-9" placeholder="Find an appliance, room or tag" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find an appliance" />
        </div>
      </Card>
      {error && <p className="text-sm text-destructive px-1" role="alert">{error}</p>}

      {groups.length === 0 && (
        <Card className="p-5 text-sm text-muted-foreground">{items.length ? "Nothing matches that search." : "The site has no appliances listed yet. Add each one as you test it."}</Card>
      )}
      {groups.map(([place, list]) => (
        <section key={place} className="space-y-2">
          <h2 className="px-1 text-sm font-semibold text-slate-600">{place} <span className="font-normal text-muted-foreground">· {list.filter((item) => item.result).length}/{list.length}</span></h2>
          <ul className="space-y-2">
            {list.map((item) => <ItemRow key={item.id} item={item} info={info} busy={savingId === item.id} onLog={logResult} />)}
          </ul>
        </section>
      ))}

      {adding ? (
        <Card className="p-4">
          <form onSubmit={addItem} className="space-y-3">
            <h2 className="font-bold">Add an appliance</h2>
            <div className="space-y-1.5"><Label htmlFor="ct-new-name">What is it?</Label>
              <Input id="ct-new-name" autoFocus maxLength={200} placeholder="e.g. Kettle" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="ct-new-type">Type</Label>
                <select id="ct-new-type" className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={adding.applianceType}
                  onChange={(e) => setAdding({ ...adding, applianceType: e.target.value })}>
                  {info.applianceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select></div>
              <div className="space-y-1.5"><Label htmlFor="ct-new-tag">Asset tag</Label>
                <Input id="ct-new-tag" maxLength={100} value={adding.assetTag} onChange={(e) => setAdding({ ...adding, assetTag: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label htmlFor="ct-new-place">Room or area</Label>
              <Input id="ct-new-place" list="ct-places" maxLength={200} value={adding.location} onChange={(e) => setAdding({ ...adding, location: e.target.value })} />
              <datalist id="ct-places">{locations.map((place) => <option key={place} value={place} />)}</datalist></div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Add</Button>
              <Button type="button" variant="outline" onClick={() => setAdding(null)}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : (
        <Button variant="outline" className="w-full h-12" data-testid="button-add-appliance"
          onClick={() => setAdding({ name: "", applianceType: "Other", location: search && locations.includes(search) ? search : "", assetTag: "" })}>
          <Plus className="w-4 h-4 mr-2" /> Add an appliance that isn't listed
        </Button>
      )}

      <Card className="p-5 space-y-2">
        <h2 className="font-bold">Finished?</h2>
        <p className="text-sm text-muted-foreground">Upload your certificate and sign off. You can only sign off once, so finish testing first.</p>
        <Button size="lg" className="w-full" disabled={tested === 0} onClick={() => { setError(null); setFinishing(true); window.scrollTo({ top: 0 }); }}
          data-testid="button-finish-sign-off">Finish and sign off</Button>
      </Card>
    </>,
  );
}
