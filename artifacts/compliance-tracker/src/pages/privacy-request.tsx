import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

// Public page: plain fetch with no session, client id or CSRF bootstrap.
const BASE = import.meta.env.BASE_URL ?? "/";

const REQUEST_TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: "access", label: "See the personal data you hold about me", hint: "Right of access (a subject access request)" },
  { value: "rectification", label: "Correct personal data about me", hint: "Right to rectification" },
  { value: "erasure", label: "Delete personal data about me", hint: "Right to erasure" },
  { value: "restriction", label: "Limit how my data is used", hint: "Right to restrict processing" },
  { value: "portability", label: "Get a copy of my data to move elsewhere", hint: "Right to data portability" },
  { value: "objection", label: "Object to how my data is used", hint: "Right to object" },
  { value: "other", label: "Something else", hint: "Any other data protection request" },
];

type FormInfo = { organisationName: string; privacyNoticeUrl: string | null };
type Receipt = { reference: string; receivedAt: string };

function tokenFromPath(): string {
  return window.location.pathname.split("/").filter(Boolean)[1] ?? "";
}

export default function PrivacyRequestPage() {
  const token = tokenFromPath();
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestType, setRequestType] = useState("access");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [details, setDetails] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  useEffect(() => {
    document.title = "Privacy request";
    let cancelled = false;
    fetch(`${BASE}api/privacy-intake/${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) setInfo(await response.json());
        else if (response.status === 429) setLoadError("Too many attempts from this connection. Please try again later.");
        else setLoadError("This privacy request link is not active. Please contact the organisation directly.");
      })
      .catch(() => !cancelled && setLoadError("The form could not be loaded. Check your connection and try again."));
    return () => { cancelled = true; };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch(`${BASE}api/privacy-intake/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType, name, email, details, website }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        setReceipt(body as Receipt);
      } else if (response.status === 429) {
        setSubmitError("Too many requests have been sent from this connection or for this organisation. Please try again later, or contact the organisation directly.");
      } else if (response.status === 404) {
        setSubmitError("This privacy request link is no longer active. Please contact the organisation directly.");
      } else {
        setSubmitError(body?.details?.[0]?.message ?? body?.error ?? "Your request could not be sent. Please try again.");
      }
    } catch {
      setSubmitError("Your request could not be sent. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const organisation = info?.organisationName ?? "the organisation";

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Shield className="h-4 w-4" /> Privacy request
        </div>

        {!info && !loadError && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        )}

        {loadError && (
          <Card><CardContent className="py-8 text-sm">{loadError}</CardContent></Card>
        )}

        {info && receipt && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-green-600" />Request sent</CardTitle>
              <CardDescription>{organisation} has received your request.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>Your reference is <strong>{receipt.reference}</strong>. Keep it in case you need to contact {organisation} about this request.</p>
              <p>Received {new Date(receipt.receivedAt).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" })}.</p>
              <p>{organisation} may contact you to confirm your identity before acting on the request. Organisations normally respond within one month of receiving a request; they can extend this in some cases and must tell you if they do.</p>
            </CardContent>
          </Card>
        )}

        {info && !receipt && (
          <Card>
            <CardHeader>
              <CardTitle>Make a privacy request to {organisation}</CardTitle>
              <CardDescription>
                Use this form to exercise your data protection rights under UK and EU data protection law, for example to see, correct or delete personal data {organisation} holds about you.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="privacy-request-type">What would you like {organisation} to do?</Label>
                  <Select value={requestType} onValueChange={setRequestType}>
                    <SelectTrigger id="privacy-request-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {REQUEST_TYPES.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{REQUEST_TYPES.find((type) => type.value === requestType)?.hint}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="privacy-request-name">Your full name</Label>
                  <Input id="privacy-request-name" autoComplete="name" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="privacy-request-email">Email address for the reply</Label>
                  <Input id="privacy-request-email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="privacy-request-details">Your request</Label>
                  <Textarea id="privacy-request-details" rows={5} required maxLength={5000} value={details} onChange={(event) => setDetails(event.target.value)} />
                  <p className="text-xs text-muted-foreground">Say what the request is about, for example your relationship with {organisation} and any dates or records it concerns. Do not include identity documents, passwords or bank details.</p>
                </div>
                {/* Spam trap: hidden from people and screen readers. */}
                <div aria-hidden="true" className="absolute left-[-10000px] h-px w-px overflow-hidden">
                  <label htmlFor="privacy-request-website">Website</label>
                  <input id="privacy-request-website" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {organisation} may contact you to confirm your identity before acting on your request, and normally responds within one month.
                  {info.privacyNoticeUrl && <> Read how {organisation} uses personal data in its <a className="underline" href={info.privacyNoticeUrl} target="_blank" rel="noopener noreferrer">privacy notice</a>.</>}
                </p>
                {submitError && <p className="text-sm text-red-700" role="alert">{submitError}</p>}
                <Button type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send request"}</Button>
              </form>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          This form is provided by ComplyTrack, a service of ALPS Consulting Ltd t/as ALPS Consultancy, on behalf of {organisation}, which is responsible for handling your request and the information you send.
        </p>
      </div>
    </div>
  );
}
