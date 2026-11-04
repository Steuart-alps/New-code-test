import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContractorSignInSite, ContractorSignInSites, ContractorSignInVisit, ContractorSignInVisitDetail } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { getApiErrorMessage } from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { AlertTriangle, Copy, Download, Flame, Loader2, LogOut, Mail, Phone, Printer, RefreshCw, ShieldAlert, Users } from "lucide-react";
import { useWorkingSiteId } from "@/hooks/use-working-site";

const ASBESTOS_TEXT: Record<ContractorSignInSite["asbestosStatus"], string> = {
  register: "Contractors see this site's asbestos register.",
  none_expected: "This site is recorded as built in 2000 or later, so contractors are told no asbestos is expected.",
  missing: "This site has no asbestos register yet. Contractors are told to ask to see it before disturbing the building.",
};
const STATUS_BADGE: Record<ContractorSignInVisit["status"], { label: string; className: string }> = {
  on_site: { label: "On site", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  signed_out: { label: "Signed out", className: "bg-slate-100 text-slate-700 border-slate-200" },
  did_not_sign_out: { label: "Didn't sign out", className: "bg-amber-100 text-amber-900 border-amber-200" },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dateTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface ContractorOption { id: number; name: string; company: string | null; email: string | null }

/**
 * Contractor sign-in on arrival: who is on site now (the fire roll call), the
 * site's sign-in link and QR poster, the fire procedure contractors read, and
 * every visit with what was acknowledged.
 */
export default function ContractorSignInPage() {
  const { activeClientId } = useAuth();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const search = useSearch();
  const [siteId, setSiteId] = useState<number | null>(() => Number(new URLSearchParams(search).get("siteId")) || null);
  const [fireDraft, setFireDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [openVisit, setOpenVisit] = useState<number | null>(null);

  const sitesQuery = useQuery<ContractorSignInSites>({
    queryKey: ["contractor-sign-in-sites", activeClientId],
    queryFn: async () => {
      const res = await api("/contractor-sign-in/sites");
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load your sites"));
      return res.json();
    },
    enabled: !!activeClientId,
  });
  const sites = sitesQuery.data?.sites ?? [];
  const canManage = sitesQuery.data?.canManage ?? false;
  // A link's site, else the user's working site, else the first site.
  const workingSiteId = useWorkingSiteId();
  const site = sites.find((s) => s.siteId === (siteId ?? workingSiteId)) ?? sites[0] ?? null;

  useEffect(() => { setFireDraft(site?.fireProcedure ?? ""); }, [site?.siteId, site?.fireProcedure]);

  const visitsQuery = useQuery<ContractorSignInVisit[]>({
    queryKey: ["contractor-sign-in-visits", activeClientId, site?.siteId],
    queryFn: async () => {
      const res = await api(`/contractor-sign-in/visits?siteId=${site!.siteId}&days=30`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load visits"));
      return res.json();
    },
    enabled: !!activeClientId && !!site,
    refetchInterval: 60_000,
  });
  const visits = visitsQuery.data ?? [];
  const onSite = visits.filter((v) => v.status === "on_site");

  const contractorsQuery = useQuery<ContractorOption[]>({
    queryKey: ["contractors", activeClientId],
    queryFn: async () => {
      const res = await api("/contractors");
      if (!res.ok) throw new Error("Failed to load contractors");
      return res.json();
    },
    enabled: !!activeClientId && canManage,
  });
  const contractors = (contractorsQuery.data ?? []).filter((c) => c.email);

  const detailQuery = useQuery<ContractorSignInVisitDetail>({
    queryKey: ["contractor-sign-in-visit", activeClientId, openVisit],
    queryFn: async () => {
      const res = await api(`/contractor-sign-in/visits/${openVisit}`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not load the visit"));
      return res.json();
    },
    enabled: !!openVisit,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["contractor-sign-in-sites"] });
    queryClient.invalidateQueries({ queryKey: ["contractor-sign-in-visits"] });
  };

  async function save(body: { enabled?: boolean; fireProcedure?: string | null }, done: string) {
    if (!site) return;
    setSaving(true);
    try {
      const res = await api(`/contractor-sign-in/sites/${site.siteId}`, { method: "PUT", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not save"));
      toast({ title: done });
      refresh();
    } catch (err) {
      toast({ title: "Couldn't save", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function post(path: string, body: unknown, done: string, failed: string) {
    try {
      const res = await api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, failed));
      toast({ title: done });
      refresh();
      return true;
    } catch (err) {
      toast({ title: failed, description: (err as Error).message, variant: "destructive" });
      return false;
    }
  }

  async function downloadPoster() {
    if (!site) return;
    try {
      const res = await api(`/contractor-sign-in/sites/${site.siteId}/poster`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, "Could not make the poster"));
      downloadBlob(await res.blob(), `contractor-sign-in-${site.siteName.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.pdf`);
    } catch (err) {
      toast({ title: "Couldn't make the poster", description: (err as Error).message, variant: "destructive" });
    }
  }

  async function copyLink() {
    if (!site?.link) return;
    try {
      await navigator.clipboard.writeText(site.link);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy", description: site.link });
    }
  }

  const fireChanged = (fireDraft.trim() || null) !== (site?.fireProcedure?.trim() || null);
  const lastVisits = useMemo(() => visits.filter((v) => v.status !== "on_site"), [visits]);

  return (
    <AppLayout title="Contractor sign-in">
      <div className="space-y-6 max-w-5xl print:max-w-none">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 print:hidden">
          <p className="text-muted-foreground max-w-2xl">
            Contractors sign in on their phone when they arrive. They read this site's fire procedure and asbestos register,
            tick to confirm and sign. Signing out tells you who is still on site in a fire.
          </p>
          {sites.length > 1 && (
            <Select value={site ? String(site.siteId) : undefined} onValueChange={(value) => setSiteId(Number(value))}>
              <SelectTrigger className="w-full sm:w-64 bg-card" aria-label="Site"><SelectValue placeholder="Choose a site" /></SelectTrigger>
              <SelectContent>{sites.map((s) => <SelectItem key={s.siteId} value={String(s.siteId)}>{s.siteName}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>

        {sitesQuery.isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : sitesQuery.isError ? (
          <p role="alert" className="text-destructive">{(sitesQuery.error as Error).message}</p>
        ) : !site ? (
          <Card className="p-8 text-center text-muted-foreground">Add a site first, then turn on contractor sign-in for it.</Card>
        ) : (
          <>
            {/* On site now: also the printed roll call */}
            <Card className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="font-display font-bold text-lg flex items-center gap-2">
                  <Users className="w-5 h-5 text-primary" aria-hidden="true" /> On site now at {site.siteName}
                  <Badge variant="outline" className="ml-1 font-sans text-sm tabular-nums">{onSite.length}</Badge>
                </h2>
                <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
                  <Printer className="w-4 h-4 mr-2" /> Print roll call
                </Button>
              </div>
              <p className="hidden print:block text-sm mb-3">Printed {new Date().toLocaleString("en-GB")}</p>
              {visitsQuery.isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              ) : onSite.length === 0 ? (
                <p className="text-muted-foreground">Nobody is signed in at this site.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {onSite.map((v) => (
                    <li key={v.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold">{v.name} <span className="font-normal text-muted-foreground">· {v.company}</span></p>
                        <p className="text-sm text-muted-foreground">
                          Since {time(v.signedInAt)}{v.visitReason ? ` · ${v.visitReason}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 print:hidden">
                        {v.phone && (
                          <Button asChild variant="ghost" size="sm"><a href={`tel:${v.phone}`}><Phone className="w-4 h-4 mr-1" /> {v.phone}</a></Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => post(`/contractor-sign-in/visits/${v.id}/sign-out`, undefined, `${v.name} signed out`, "Couldn't sign out")}>
                          <LogOut className="w-4 h-4 mr-1" /> Sign out
                        </Button>
                      </div>
                      {v.phone && <p className="hidden print:block text-sm">{v.phone}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="grid gap-6 lg:grid-cols-2 print:hidden">
              <Card className="p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display font-bold text-lg">Sign-in link and poster</h2>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Label htmlFor="sign-in-enabled" className="text-sm">{site.enabled ? "On" : "Off"}</Label>
                      <Switch id="sign-in-enabled" checked={site.enabled} disabled={saving}
                        onCheckedChange={(on) => save({ enabled: on }, on ? "Contractor sign-in is on" : "Contractor sign-in is off")} />
                    </div>
                  )}
                </div>
                {!site.enabled ? (
                  <p className="text-muted-foreground text-sm">
                    {canManage ? "Turn it on to get this site's sign-in link and QR poster." : "An Owner or Manager can turn contractor sign-in on for this site."}
                  </p>
                ) : (
                  <>
                    <div className="rounded-lg border bg-muted/30 p-3 text-sm break-all">{site.link}</div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={downloadPoster}><Download className="w-4 h-4 mr-2" /> QR poster for reception</Button>
                      <Button size="sm" variant="outline" onClick={copyLink}><Copy className="w-4 h-4 mr-2" /> Copy link</Button>
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}><RefreshCw className="w-4 h-4 mr-2" /> New link</Button>
                      )}
                    </div>
                    {canManage && (
                      <div className="space-y-2 pt-2 border-t">
                        <Label>Email the link to a contractor before their visit</Label>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Select value={emailTo} onValueChange={setEmailTo}>
                            <SelectTrigger className="flex-1" aria-label="Contractor"><SelectValue placeholder={contractors.length ? "Choose a contractor" : "No contractors with an email address"} /></SelectTrigger>
                            <SelectContent>
                              {contractors.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}{c.company ? ` (${c.company})` : ""}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <Button size="sm" variant="outline" disabled={!emailTo} className="h-9"
                            onClick={async () => { if (await post(`/contractor-sign-in/sites/${site.siteId}/email-link`, { contractorId: Number(emailTo) }, "Sign-in link emailed", "Couldn't send the email")) setEmailTo(""); }}>
                            <Mail className="w-4 h-4 mr-2" /> Send
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Card>

              <Card className="p-5 sm:p-6 space-y-3">
                <h2 className="font-display font-bold text-lg flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-amber-600" aria-hidden="true" /> Asbestos register</h2>
                <p className={site.asbestosStatus === "missing" ? "text-amber-900 text-sm flex gap-2" : "text-sm"}>
                  {site.asbestosStatus === "missing" && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />}
                  {ASBESTOS_TEXT[site.asbestosStatus]}
                  {site.asbestosStatus === "register" ? ` ${site.asbestosEntryCount} ${site.asbestosEntryCount === 1 ? "entry" : "entries"}.` : ""}
                </p>
                <p className="text-sm text-muted-foreground">Contractors see the location, material, condition and action for each entry, not your notes.</p>
                <Button asChild size="sm" variant="outline"><Link href="/asbestos">Open the asbestos register</Link></Button>
              </Card>
            </div>

            <Card className="p-5 sm:p-6 space-y-3 print:hidden">
              <h2 className="font-display font-bold text-lg flex items-center gap-2"><Flame className="w-5 h-5 text-rose-600" aria-hidden="true" /> Fire procedure contractors read</h2>
              {!site.fireProcedure && (
                <p className="text-sm text-amber-900 flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  Not added yet. Contractors are told to ask the site contact where the exits and assembly point are.</p>
              )}
              <Textarea value={fireDraft} onChange={(e) => setFireDraft(e.target.value)} rows={6} maxLength={10000} disabled={!canManage}
                placeholder="What to do if the alarm sounds: nearest exits, the assembly point, who to report to, not to use the lifts, how to raise the alarm." />
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={!fireChanged || saving} onClick={() => save({ fireProcedure: fireDraft.trim() || null }, "Fire procedure saved")}>
                    {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save
                  </Button>
                  {site.fireTrackEvacuation && (
                    <Button size="sm" variant="outline" onClick={() => setFireDraft(site.fireTrackEvacuation ?? "")}>Copy from FireTrack</Button>
                  )}
                  {site.fireTrackEvacuation && (
                    <p className="text-xs text-muted-foreground w-full">FireTrack's evacuation arrangements may name staff with personal evacuation plans. Remove personal details before saving.</p>
                  )}
                </div>
              )}
            </Card>

            <Card className="p-5 sm:p-6 print:hidden">
              <h2 className="font-display font-bold text-lg mb-3">Visits in the last 30 days</h2>
              {lastVisits.length === 0 ? (
                <p className="text-muted-foreground text-sm">No visits yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-muted-foreground">
                      <tr><th className="py-2 pr-3 font-medium">Contractor</th><th className="py-2 pr-3 font-medium">Signed in</th><th className="py-2 pr-3 font-medium">Signed out</th><th className="py-2 font-medium" /></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {lastVisits.map((v) => (
                        <tr key={v.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenVisit(v.id)}>
                          <td className="py-2 pr-3"><span className="font-medium">{v.name}</span><br /><span className="text-muted-foreground">{v.company}</span></td>
                          <td className="py-2 pr-3 whitespace-nowrap">{dateTime(v.signedInAt)}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">{v.signedOutAt ? `${time(v.signedOutAt)}${v.signedOutByName ? ` by ${v.signedOutByName}` : ""}` : "—"}</td>
                          <td className="py-2"><Badge variant="outline" className={STATUS_BADGE[v.status].className}>{STATUS_BADGE[v.status].label}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make a new sign-in link?</AlertDialogTitle>
            <AlertDialogDescription>
              The old link and any posters with its QR code stop working. Print the new poster for reception afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => site && post(`/contractor-sign-in/sites/${site.siteId}/reset-link`, undefined, "New sign-in link made", "Couldn't make a new link")}>
              Make a new link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!openVisit} onOpenChange={(open) => { if (!open) setOpenVisit(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detailQuery.data?.name ?? "Visit"}</DialogTitle>
            <DialogDescription>{detailQuery.data ? `${detailQuery.data.company} · ${detailQuery.data.siteName}` : "Loading…"}</DialogDescription>
          </DialogHeader>
          {detailQuery.data && <VisitDetail visit={detailQuery.data} />}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function VisitDetail({ visit }: { visit: ContractorSignInVisitDetail }) {
  const asbestos = visit.asbestosSnapshot as { entries?: Array<{ location: string; material: string }> };
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Signed in</dt><dd>{dateTime(visit.signedInAt)}</dd>
        <dt className="text-muted-foreground">Signed out</dt><dd>{visit.signedOutAt ? `${dateTime(visit.signedOutAt)}${visit.signedOutByName ? ` by ${visit.signedOutByName}` : ""}` : STATUS_BADGE[visit.status].label}</dd>
        {visit.visitReason && <><dt className="text-muted-foreground">Here to</dt><dd>{visit.visitReason}</dd></>}
        {visit.phone && <><dt className="text-muted-foreground">Phone</dt><dd>{visit.phone}</dd></>}
        {visit.email && <><dt className="text-muted-foreground">Email</dt><dd>{visit.email}</dd></>}
      </dl>
      <div>
        <p className="font-semibold mb-1">Fire procedure</p>
        {visit.fireProcedureText
          ? <p className="rounded border bg-muted/30 p-2 whitespace-pre-wrap">{visit.fireProcedureText}</p>
          : <p className="text-amber-900">None on record; they agreed to ask the site contact.</p>}
      </div>
      <div>
        <p className="font-semibold mb-1">Asbestos</p>
        {visit.asbestosStatus === "register" ? (
          asbestos.entries?.length
            ? <ul className="list-disc pl-5">{asbestos.entries.map((e, i) => <li key={i}>{e.location}: {e.material}</li>)}</ul>
            : <p>Survey on record with no asbestos-containing materials listed.</p>
        ) : visit.asbestosStatus === "none_expected"
          ? <p>No asbestos expected (built in 2000 or later).</p>
          : <p className="text-amber-900">No register on record; they agreed to ask to see it before disturbing the building.</p>}
      </div>
      <div>
        <p className="font-semibold mb-1">Signature</p>
        <img src={visit.signature} alt={`Signature of ${visit.name}`} className="max-h-28 rounded border bg-white" />
      </div>
    </div>
  );
}
