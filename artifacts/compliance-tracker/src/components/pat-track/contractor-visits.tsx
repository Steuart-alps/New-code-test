import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PATContractorVisit, PATContractorVisitDetail, PATContractorVisitLink, PATContractorVisits } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { getApiErrorMessage } from "@/lib/api";
import { CheckCircle2, ChevronDown, ChevronUp, Copy, FileText, HardHat, Link2, Loader2, Plus, XCircle } from "lucide-react";
import { RecordSiteField } from "@/components/record-site-field";

type Site = { id: number; name: string };
interface ContractorOption { id: number; name: string; company: string | null; email: string | null }

const STATUS: Record<PATContractorVisit["status"], { label: string; className: string }> = {
  open: { label: "Link open", className: "bg-blue-100 text-blue-800 border-blue-200" },
  expired: { label: "Link expired", className: "bg-amber-100 text-amber-900 border-amber-200" },
  signed_off: { label: "Signed off", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  ended: { label: "Ended", className: "bg-slate-100 text-slate-700 border-slate-200" },
};
const OTHER = "other";

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const today = () => new Date().toLocaleDateString("en-CA");
const days = (visit: PATContractorVisit) => visit.startsOn === visit.endsOn ? day(visit.startsOn) : `${day(visit.startsOn)} to ${day(visit.endsOn)}`;

function VisitDetail({ id }: { id: number }) {
  const { activeClientId } = useAuth();
  const api = useActiveClientApi();
  const query = useQuery<PATContractorVisitDetail>({
    queryKey: ["pat-contractor-visit", activeClientId, id],
    queryFn: async () => {
      const res = await api(`/pat-track/contractor-visits/${id}`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load the results"));
      return res.json();
    },
    refetchInterval: 60_000,
  });
  if (query.isLoading) return <p className="py-3 text-sm text-muted-foreground flex items-center"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading results…</p>;
  if (query.error || !query.data) return <p className="py-3 text-sm text-destructive">{(query.error as Error)?.message ?? "Could not load the results"}</p>;
  const visit = query.data;
  return (
    <div className="mt-3 space-y-4 border-t pt-3">
      {visit.signIns.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Signed in at the site</h4>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {visit.signIns.map((s) => (
              <li key={s.id}>{s.name} ({s.company}) · in {dateTime(s.signedInAt)}{s.signedOutAt ? `, out ${dateTime(s.signedOutAt)}` : ", not signed out"}
                {!s.fireProcedureShown || s.asbestosStatus === "missing" ? <span className="text-amber-700"> · the site had no {[!s.fireProcedureShown && "fire procedure", s.asbestosStatus === "missing" && "asbestos register"].filter(Boolean).join(" or ")} to show</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="text-sm font-semibold">Results ({visit.results.length})</h4>
        {visit.results.length === 0 ? <p className="text-sm text-muted-foreground mt-1">Nothing logged yet.</p> : (
          <ul className="mt-1 divide-y rounded-sm border">
            {visit.results.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm" data-testid={`contractor-result-${r.id}`}>
                <div className="min-w-0">
                  <p className="font-medium">{r.applianceName}{r.assetTag ? <span className="text-muted-foreground"> · {r.assetTag}</span> : null}</p>
                  <p className="text-xs text-muted-foreground">
                    {[r.location, r.earthContinuityOhms && `Earth ${r.earthContinuityOhms} Ω`, r.insulationMohms && `Insulation ${r.insulationMohms} MΩ`,
                      r.operatingCurrent && `${r.operatingCurrent} mA`, day(r.testDate)].filter(Boolean).join(" · ")}
                  </p>
                  {r.notes && <p className="text-xs mt-0.5">{r.notes}</p>}
                </div>
                {r.result === "fail"
                  ? <Badge className="rounded-sm bg-rose-100 text-rose-800 border-rose-200 shrink-0"><XCircle className="mr-1 h-3 w-3" />Fail</Badge>
                  : <Badge className="rounded-sm bg-emerald-100 text-emerald-800 border-emerald-200 shrink-0"><CheckCircle2 className="mr-1 h-3 w-3" />Pass</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {visit.signOffSignature && (
        <div>
          <h4 className="text-sm font-semibold">Sign-off</h4>
          <p className="text-sm text-muted-foreground">{visit.signedOffName} ({visit.signedOffCompany}), {visit.signedOffAt ? dateTime(visit.signedOffAt) : ""}. They confirmed the results match their certificate.</p>
          {visit.signOffNotes && <p className="text-sm mt-1">“{visit.signOffNotes}”</p>}
          <img src={visit.signOffSignature} alt={`Signature of ${visit.signedOffName}`} className="mt-2 h-16 rounded-sm border bg-white" />
        </div>
      )}
    </div>
  );
}

/**
 * PATrack's "Contractor visits" tab: set up a link for a contractor to log
 * their own PAT tests at one site (they sign in at the site first), follow the
 * results as they come in, and see the certificate and sign-off.
 */
export function PATContractorVisits({ sites, siteFilter, openVisitId }: { sites: Site[]; siteFilter: string; openVisitId?: number }) {
  const { activeClientId } = useAuth();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ siteId: "", contractor: "", contractorName: "", contractorEmail: "", startsOn: today(), endsOn: today(), sendEmail: true });
  const [saving, setSaving] = useState(false);
  const [issued, setIssued] = useState<PATContractorVisitLink | null>(null);
  const [open, setOpen] = useState<number | null>(openVisitId ?? null);
  const [ending, setEnding] = useState<PATContractorVisit | null>(null);

  useEffect(() => { if (openVisitId) setOpen(openVisitId); }, [openVisitId]);

  const visitsQuery = useQuery<PATContractorVisits>({
    queryKey: ["pat-contractor-visits", activeClientId, siteFilter],
    queryFn: async () => {
      const res = await api(`/pat-track/contractor-visits${siteFilter ? `?siteId=${siteFilter}` : ""}`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load contractor visits"));
      return res.json();
    },
    refetchInterval: 60_000,
  });
  const canManage = visitsQuery.data?.canManage ?? false;
  const visits = visitsQuery.data?.visits ?? [];

  const contractorsQuery = useQuery<ContractorOption[]>({
    queryKey: ["contractors", activeClientId],
    queryFn: async () => {
      const res = await api("/contractors");
      if (!res.ok) throw new Error("Failed to load contractors");
      return res.json();
    },
    enabled: canManage && creating,
  });
  const contractors = [...(contractorsQuery.data ?? [])].sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["pat-contractor-visits"] });
    queryClient.invalidateQueries({ queryKey: ["pat-contractor-visit"] });
  };

  function startCreating() {
    setForm({ siteId: siteFilter || (sites.length === 1 ? String(sites[0].id) : ""), contractor: "", contractorName: "", contractorEmail: "",
      startsOn: today(), endsOn: today(), sendEmail: true });
    setCreating(true);
  }

  const chosen = contractors.find((c) => String(c.id) === form.contractor);
  const needsEmail = form.sendEmail && (form.contractor === OTHER ? !form.contractorEmail.trim() : !!chosen && !chosen.email);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form.siteId || !form.contractor) {
      toast({ title: form.siteId ? "Choose the contractor" : "Choose the site", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const other = form.contractor === OTHER;
      const res = await api("/pat-track/contractor-visits", {
        method: "POST",
        body: JSON.stringify({
          siteId: Number(form.siteId),
          contractorId: other ? null : Number(form.contractor),
          contractorName: other ? form.contractorName.trim() || null : null,
          contractorEmail: (other ? form.contractorEmail : chosen?.email ?? "").trim() || null,
          startsOn: form.startsOn, endsOn: form.endsOn, sendEmail: form.sendEmail,
        }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not set up the visit"));
      setIssued(await res.json());
      setCreating(false);
      refresh();
    } catch (err) {
      toast({ title: "Couldn't set up the visit", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function newLink(visit: PATContractorVisit) {
    const res = await api(`/pat-track/contractor-visits/${visit.id}/new-link`, { method: "POST", body: JSON.stringify({ sendEmail: !!visit.contractorEmail }) });
    if (!res.ok) {
      toast({ title: "Couldn't make a new link", description: await getApiErrorMessage(res, "Please try again"), variant: "destructive" });
      return;
    }
    setIssued(await res.json());
    refresh();
  }

  async function endVisit() {
    if (!ending) return;
    const res = await api(`/pat-track/contractor-visits/${ending.id}/end`, { method: "POST" });
    setEnding(null);
    if (!res.ok) {
      toast({ title: "Couldn't end the visit", description: await getApiErrorMessage(res, "Please try again"), variant: "destructive" });
      return;
    }
    toast({ title: "Visit ended", description: "The link no longer works. Results already logged stay on PATrack." });
    refresh();
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select the link and copy it instead.", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <Card className="rounded-sm">
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold flex items-center gap-2"><HardHat className="h-5 w-5 text-amber-600" /> Let your contractor log their tests</h2>
            <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
              Email your PAT contractor a link for one site. On the day they sign in at the site (fire procedure and asbestos register),
              tap Pass or Fail for each appliance, then upload their own certificate and sign off. Fails become actions straight away.
            </p>
          </div>
          {canManage && <Button data-testid="button-new-contractor-visit" onClick={startCreating}><Plus className="mr-1.5 h-4 w-4" />Set up a visit</Button>}
        </CardContent>
      </Card>

      {visitsQuery.isLoading ? <p className="flex justify-center p-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></p>
        : visitsQuery.error ? <p className="text-sm text-destructive">{(visitsQuery.error as Error).message}</p>
          : visits.length === 0 ? <p className="rounded-sm border border-dashed p-8 text-center text-sm text-muted-foreground">No contractor visits set up yet.</p>
            : (
              <div className="space-y-2">
                {visits.map((visit) => (
                  <Card key={visit.id} className="rounded-sm" data-testid={`contractor-visit-${visit.id}`}>
                    <CardContent className="p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-bold">{visit.contractorName}</h3>
                            <Badge className={`rounded-sm ${STATUS[visit.status].className}`}>{STATUS[visit.status].label}</Badge>
                            {visit.onSiteNow > 0 && <Badge className="rounded-sm bg-emerald-600 text-white">On site now</Badge>}
                          </div>
                          <p className="text-sm text-muted-foreground">{visit.siteName} · {days(visit)}</p>
                          <p className="mt-1 text-sm">
                            <strong>{visit.tested}</strong> tested
                            {visit.failed > 0 ? <span className="text-rose-700"> · <strong>{visit.failed}</strong> failed</span> : visit.tested > 0 ? " · all passed" : ""}
                          </p>
                          {visit.status === "signed_off" && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Certificate {visit.certificateRef} · signed off by {visit.signedOffName} {visit.signedOffAt ? dateTime(visit.signedOffAt) : ""}
                              {visit.nextTestDue ? ` · next test due ${day(visit.nextTestDue)}` : ""}
                            </p>
                          )}
                          {visit.certificateUrl
                            ? <a className="mt-1 inline-flex items-center text-xs text-primary underline" href={visit.certificateUrl} target="_blank" rel="noreferrer"><FileText className="mr-1 h-3 w-3" />{visit.certificateFileName ?? "Contractor's certificate"}</a>
                            : visit.status === "signed_off" ? <p className="mt-1 text-xs text-amber-700">Certificate file still to come: the contractor can upload it from their link for 30 days.</p> : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button variant="outline" size="sm" onClick={() => setOpen(open === visit.id ? null : visit.id)} data-testid={`button-visit-results-${visit.id}`}>
                            Results {open === visit.id ? <ChevronUp className="ml-1 h-4 w-4" /> : <ChevronDown className="ml-1 h-4 w-4" />}
                          </Button>
                          {canManage && (visit.status === "open" || visit.status === "expired") && <>
                            <Button variant="outline" size="sm" onClick={() => newLink(visit)}><Link2 className="mr-1 h-4 w-4" />New link</Button>
                            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setEnding(visit)}>End visit</Button>
                          </>}
                        </div>
                      </div>
                      {open === visit.id && <VisitDetail id={visit.id} />}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

      <Dialog open={creating} onOpenChange={(value) => !value && setCreating(false)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle>Set up a contractor visit</DialogTitle>
            <DialogDescription>The contractor gets a link that works for this site only, until two days after the last day.</DialogDescription>
          </DialogHeader>
          <form id="contractor-visit-form" onSubmit={create} className="space-y-3">
            <RecordSiteField testId="cv-site" value={form.siteId} onChange={(id) => setForm({ ...form, siteId: id ? String(id) : "" })}
              pageSiteId={siteFilter ? Number(siteFilter) : null} />
            <div className="space-y-1.5"><Label htmlFor="cv-contractor">Contractor</Label>
              <select id="cv-contractor" className="h-10 w-full rounded-sm border border-input bg-background px-3 text-sm" value={form.contractor} onChange={(e) => setForm({ ...form, contractor: e.target.value })}>
                <option value="">{contractorsQuery.isLoading ? "Loading…" : "Choose a contractor"}</option>
                {contractors.map((c) => <option key={c.id} value={c.id}>{c.company ? `${c.company} (${c.name})` : c.name}</option>)}
                <option value={OTHER}>Someone not on your Contractors list</option>
              </select></div>
            {form.contractor === OTHER && <>
              <div className="space-y-1.5"><Label htmlFor="cv-name">Company name</Label>
                <Input id="cv-name" maxLength={160} value={form.contractorName} onChange={(e) => setForm({ ...form, contractorName: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="cv-email">Email</Label>
                <Input id="cv-email" type="email" maxLength={320} value={form.contractorEmail} onChange={(e) => setForm({ ...form, contractorEmail: e.target.value })} /></div>
            </>}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label htmlFor="cv-start">First day</Label>
                <Input id="cv-start" type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value, endsOn: form.endsOn < e.target.value ? e.target.value : form.endsOn })} /></div>
              <div className="space-y-1.5"><Label htmlFor="cv-end">Last day</Label>
                <Input id="cv-end" type="date" min={form.startsOn} value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} /></div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.sendEmail} onChange={(e) => setForm({ ...form, sendEmail: e.target.checked })} />
              Email the link to the contractor
            </label>
            {needsEmail && <p className="text-xs text-amber-700">This contractor has no email address. Add one, or untick the box and copy the link to send yourself.</p>}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" form="contractor-visit-form" disabled={saving || needsEmail}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Set up visit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!issued} onOpenChange={(value) => !value && setIssued(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle>The contractor's link</DialogTitle>
            <DialogDescription>
              {issued?.emailedTo ? `Emailed to ${issued.emailedTo}. ` : ""}
              This is the only time the link is shown. If it gets lost, use New link and the old one stops working.
            </DialogDescription>
          </DialogHeader>
          {issued?.emailError && <p className="text-sm text-amber-700">{issued.emailError}</p>}
          <div className="flex gap-2">
            <Input readOnly value={issued?.link ?? ""} onFocus={(e) => e.target.select()} data-testid="input-contractor-link" />
            <Button variant="outline" onClick={() => issued && copyLink(issued.link)}><Copy className="h-4 w-4" /></Button>
          </div>
          <DialogFooter><Button onClick={() => setIssued(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!ending} onOpenChange={(value) => !value && setEnding(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this visit?</AlertDialogTitle>
            <AlertDialogDescription>
              {ending?.contractorName}'s link stops working. The {ending?.tested ?? 0} result{ending?.tested === 1 ? "" : "s"} already logged stay on PATrack, but no certificate is recorded without their sign-off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void endVisit(); }}>End visit</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
