import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Link } from "wouter";
import { Beaker, CheckCircle2, ChevronDown, ChevronUp, Download, FileText, Loader2, PenLine, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SignaturePad } from "@/components/signature-pad";
import { downloadCsv, downloadRegisterDocument, ensureOk } from "@/components/register-shared";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

// COSHH assessments for staff to read and sign (API: /api/coshh-track/sign-offs
// for TrainTrack's COSHH section, /api/train-track/my-coshh for a Viewer's
// own). Each signature also becomes a TrainTrack document sign-off.

export interface CoshhSignOffSummary {
  id: number;
  siteId: number;
  siteName: string | null;
  task: string;
  productName: string | null;
  substanceId: number | null;
  hasSafetyDataSheet: boolean;
  hasDocument: boolean;
  revision: number;
  signOffDepartments: string[];
  assessmentDate: string | null;
  assessor: string | null;
  riskLevel: string;
  hazardStatements: string | null;
  signalWord: string | null;
  healthEffects: string | null;
  exposureRoutes: string[];
  controls: string | null;
  ppe: string[];
  ppeDetails: string | null;
  storage: string | null;
  spillProcedure: string | null;
  firstAid: string | null;
  disposal: string | null;
}

interface SignOffStatus extends CoshhSignOffSummary {
  staffTotal: number;
  signedCount: number;
  signed: { staffRosterId: number; name: string; department: string | null; signedAt: string; hasSignature: boolean }[];
  outstanding: { staffRosterId: number; name: string; department: string | null; resign: boolean }[];
}

const ROUTE_LABEL: Record<string, string> = {
  inhalation: "Breathing in", skin: "Skin contact", eyes: "Eyes", ingestion: "Swallowing", injection: "Cuts or needles",
};
const PPE_LABEL: Record<string, string> = {
  gloves: "Gloves", eye_protection: "Goggles or safety glasses", face_shield: "Face shield",
  respirator: "Mask or respirator", apron_overalls: "Apron or overalls", footwear: "Safety footwear",
};
const RISK_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
const ukDate = (value: string | null) => (value ? format(new Date(value), "d MMM yyyy") : "");

export const assessmentTitle = (a: Pick<CoshhSignOffSummary, "task" | "productName">) =>
  a.productName ? `${a.task} (${a.productName})` : a.task;

/** What a person reads before signing: the parts of the assessment that affect them. */
export function CoshhAssessmentReading({ assessment }: { assessment: CoshhSignOffSummary }) {
  const rows: [string, string | null][] = [
    ["Hazards", [assessment.signalWord && assessment.signalWord !== "none" ? assessment.signalWord.toUpperCase() : null, assessment.hazardStatements].filter(Boolean).join(" · ") || null],
    ["How it can harm you", [assessment.exposureRoutes.map((key) => ROUTE_LABEL[key] ?? key).join(", "), assessment.healthEffects].filter(Boolean).join(". ") || null],
    ["Controls", assessment.controls],
    ["PPE to wear", [...assessment.ppe.map((key) => PPE_LABEL[key] ?? key), assessment.ppeDetails].filter(Boolean).join(", ") || null],
    ["Storage", assessment.storage],
    ["Spills", assessment.spillProcedure],
    ["First aid", assessment.firstAid],
    ["Disposal", assessment.disposal],
  ];
  return (
    <dl className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
      {rows.filter(([, value]) => value).map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
          <dd className="whitespace-pre-wrap break-words">{value}</dd>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Risk after controls: {RISK_LABEL[assessment.riskLevel] ?? assessment.riskLevel}
        {assessment.assessor ? ` · Assessed by ${assessment.assessor}` : ""}
        {assessment.assessmentDate ? ` on ${ukDate(assessment.assessmentDate)}` : ""}
        {assessment.revision > 1 ? ` · Revision ${assessment.revision}` : ""}
      </p>
    </dl>
  );
}

const DECLARATION = "I have read and understood this COSHH assessment and I will follow the controls and wear the PPE it lists.";

/** TrainTrack's COSHH section: who has read and signed each current assessment. */
export function CoshhSignOffSection({ siteFilter, canSign }: { siteFilter: string; canSign: boolean }) {
  const api = useActiveClientApi();
  const { activeClientId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [signing, setSigning] = useState<SignOffStatus | null>(null);
  const [staffId, setStaffId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const query = siteFilter === "all" ? "" : `?siteId=${siteFilter}`;
  const { data, isLoading, error } = useQuery<{ assessments: SignOffStatus[] }>({
    queryKey: ["/api/coshh-track/sign-offs", activeClientId, siteFilter],
    queryFn: async () => (await ensureOk(await api(`/coshh-track/sign-offs${query}`), "Could not load COSHH sign-offs")).json(),
  });
  const assessments = data?.assessments ?? [];
  const totals = useMemo(() => ({
    complete: assessments.filter((a) => a.staffTotal > 0 && a.signedCount === a.staffTotal).length,
    outstanding: assessments.reduce((sum, a) => sum + a.outstanding.length, 0),
  }), [assessments]);

  function openSigning(assessment: SignOffStatus, rosterId?: number) {
    setSigning(assessment);
    setStaffId(String(rosterId ?? assessment.outstanding[0]?.staffRosterId ?? ""));
    setAgreed(false);
    setSignature(null);
  }

  async function sign() {
    if (!signing || !staffId || !signature || !agreed) return;
    setSaving(true);
    try {
      const response = await ensureOk(await api(`/coshh-track/assessments/${signing.id}/sign-offs`, {
        method: "POST",
        body: JSON.stringify({ signOffs: [{ staffRosterId: Number(staffId), signature }] }),
      }), "The sign-off wasn't saved");
      const result = await response.json() as { signed: number; assessment: SignOffStatus | null };
      const person = signing.outstanding.find((member) => String(member.staffRosterId) === staffId)?.name ?? "Signed";
      toast({ title: result.signed ? `${person} signed` : "Already signed", description: assessmentTitle(signing) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/coshh-track/sign-offs"] }),
        queryClient.invalidateQueries({ queryKey: ["train-track-records"] }),
      ]);
      // Hand the device to the next person still to sign, if any.
      if (result.assessment && result.assessment.outstanding.length > 0) openSigning(result.assessment);
      else setSigning(null);
    } catch (err) {
      toast({ title: "Not signed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function download(path: string, fallback: string) {
    try {
      await downloadRegisterDocument(api, path, fallback);
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  // Staff down the side, assessments across the top.
  function exportMatrix() {
    const people = new Map<number, { name: string; department: string | null; site: string }>();
    for (const a of assessments) {
      for (const p of [...a.signed, ...a.outstanding]) {
        if (!people.has(p.staffRosterId)) people.set(p.staffRosterId, { name: p.name, department: p.department, site: a.siteName ?? "" });
      }
    }
    const rows = [...people.entries()].sort((x, y) => x[1].name.localeCompare(y[1].name)).map(([id, person]) => [
      person.name, person.department ?? "", person.site,
      ...assessments.map((a) => {
        const signed = a.signed.find((p) => p.staffRosterId === id);
        if (signed) return `Signed ${ukDate(signed.signedAt)}`;
        return a.outstanding.some((p) => p.staffRosterId === id) ? "Needs to sign" : "";
      }),
    ]);
    downloadCsv(`coshh-sign-off-matrix-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Staff member", "Department", "Site", ...assessments.map((a) => `${assessmentTitle(a)}${a.revision > 1 ? ` (rev ${a.revision})` : ""}`)],
      rows);
  }

  const chosen = signing?.outstanding.find((member) => String(member.staffRosterId) === staffId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Staff read each current COSHH assessment for their site and sign that they understand it. Each signature is
          saved as a document sign-off in their training record. When an assessment is changed, they are asked to sign
          again. Assessments are written in <Link href="/coshh-track" className="font-medium underline">COSHHTrack</Link>.
        </p>
        <Button variant="outline" size="sm" className="gap-2 rounded-sm" onClick={exportMatrix} disabled={assessments.length === 0}>
          <Download className="h-4 w-4" /> Download sign-off matrix
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-sm border border-border p-3">
          <p className="text-xs text-muted-foreground">Current assessments</p>
          <p className="text-xl font-bold">{isLoading ? "–" : assessments.length}</p>
        </div>
        <div className="rounded-sm border border-border p-3">
          <p className="text-xs text-muted-foreground">Signed by everyone</p>
          <p className="text-xl font-bold">{isLoading ? "–" : totals.complete}</p>
        </div>
        <div className={cn("rounded-sm border p-3", totals.outstanding ? "border-amber-300 bg-amber-50" : "border-border")}>
          <p className={cn("text-xs", totals.outstanding ? "text-amber-800" : "text-muted-foreground")}>Signatures still needed</p>
          <p className={cn("text-xl font-bold", totals.outstanding ? "text-amber-800" : "")}>{isLoading ? "–" : totals.outstanding}</p>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {!isLoading && !error && assessments.length === 0 && (
        <div className="rounded-sm border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          <Beaker className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
          No current COSHH assessments yet. Once one is saved in COSHHTrack, it appears here for staff to sign.
        </div>
      )}

      {assessments.map((a) => {
        const done = a.staffTotal > 0 && a.signedCount === a.staffTotal;
        const open = expanded === a.id;
        return (
          <div key={a.id} className="space-y-3 rounded-sm border border-border p-4" data-testid={`coshh-signoff-${a.id}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="break-words font-medium">{assessmentTitle(a)}</p>
                <p className="text-xs text-muted-foreground">
                  {[a.siteName, a.signOffDepartments.length ? a.signOffDepartments.join(", ") : "Everyone at the site", a.revision > 1 ? `Revision ${a.revision}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn("text-[11px]", done ? "border-emerald-300 bg-emerald-50 text-emerald-700" : a.staffTotal === 0 ? "" : "border-amber-300 bg-amber-50 text-amber-800")}>
                  {a.staffTotal === 0 ? "No staff on the list for this site" : `${a.signedCount} of ${a.staffTotal} signed`}
                </Badge>
                {a.hasDocument && (
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Download the assessment document"
                    onClick={() => download(`/coshh-track/assessments/${a.id}/document-url`, "coshh-assessment")}>
                    <FileText className="h-4 w-4" />
                  </Button>
                )}
                {a.hasSafetyDataSheet && a.substanceId != null && (
                  <Button variant="outline" size="sm" className="h-8 text-xs"
                    onClick={() => download(`/registers/coshh/${a.substanceId}/sds-url`, "safety-data-sheet")}>
                    Safety data sheet
                  </Button>
                )}
                {canSign && a.outstanding.length > 0 && (
                  <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => openSigning(a)}>
                    <PenLine className="h-3.5 w-3.5" /> Sign off staff
                  </Button>
                )}
              </div>
            </div>
            {a.outstanding.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <span className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Still to sign:</span>
                {a.outstanding.map((member) => (
                  <button
                    key={member.staffRosterId}
                    type="button"
                    disabled={!canSign}
                    onClick={() => openSigning(a, member.staffRosterId)}
                    className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 enabled:hover:bg-amber-100"
                  >
                    {member.name}{member.resign ? " (changed, sign again)" : ""}
                  </button>
                ))}
              </div>
            )}
            {a.signed.length > 0 && (
              <div>
                <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded(open ? null : a.id)} aria-expanded={open}>
                  {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {a.signed.length} signed
                </button>
                {open && (
                  <ul className="mt-2 divide-y divide-border rounded-sm border border-border text-sm">
                    {a.signed.map((member) => (
                      <li key={member.staffRosterId} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="flex min-w-0 items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />{member.name}</span>
                        <span className="text-xs text-muted-foreground">{ukDate(member.signedAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}

      <Dialog open={signing !== null} onOpenChange={(open) => { if (!open) setSigning(null); }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Read and sign: {signing ? assessmentTitle(signing) : ""}</DialogTitle>
            <DialogDescription>Hand the device to the member of staff. They read the assessment, tick the box and sign.</DialogDescription>
          </DialogHeader>
          {signing && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="coshh-signoff-staff">Member of staff</Label>
                <Select value={staffId} onValueChange={(value) => { setStaffId(value); setSignature(null); setAgreed(false); }}>
                  <SelectTrigger id="coshh-signoff-staff"><SelectValue placeholder="Choose who is signing" /></SelectTrigger>
                  <SelectContent>
                    {signing.outstanding.map((member) => (
                      <SelectItem key={member.staffRosterId} value={String(member.staffRosterId)}>
                        {member.name}{member.department ? ` (${member.department})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {chosen?.resign && <p className="text-xs text-amber-800">This assessment has changed since {chosen.name} last signed it.</p>}
              </div>
              <CoshhAssessmentReading assessment={signing} />
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={agreed} onCheckedChange={(checked) => setAgreed(checked === true)} />
                {DECLARATION}
              </label>
              <SignaturePad value={signature} onChange={setSignature} label={chosen ? `${chosen.name}'s signature` : "Signature"} />
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSigning(null)} disabled={saving}>Close</Button>
            <Button onClick={sign} disabled={saving || !staffId || !agreed || !signature}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface MyCoshh {
  linked: boolean;
  pending: CoshhSignOffSummary[];
  signed: (CoshhSignOffSummary & { signedAt: string })[];
}

function MyCoshhCard({ assessment }: { assessment: CoshhSignOffSummary }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function sign() {
    if (!signature || !agreed) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/train-track/my-coshh/${assessment.id}/sign`, { method: "POST", body: JSON.stringify({ signature }) });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Your signature wasn't saved"));
      toast({ title: "Signed", description: assessmentTitle(assessment) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-coshh"] }),
        queryClient.invalidateQueries({ queryKey: ["my-training"] }),
      ]);
    } catch (error) {
      toast({ title: "Not signed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3 rounded-sm p-4" data-testid={`my-coshh-${assessment.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">COSHH assessment to read and sign</p>
          <p className="break-words font-semibold">{assessmentTitle(assessment)}</p>
          <p className="text-sm text-muted-foreground">{assessment.siteName}{assessment.revision > 1 ? " · Changed, please sign again" : ""}</p>
        </div>
        {!open && <Button size="sm" onClick={() => setOpen(true)}><PenLine className="mr-1.5 h-3.5 w-3.5" />Read and sign</Button>}
      </div>
      {open && (
        <div className="space-y-3 border-t pt-3">
          <CoshhAssessmentReading assessment={assessment} />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={agreed} onCheckedChange={(checked) => setAgreed(checked === true)} />
            {DECLARATION}
          </label>
          <SignaturePad value={signature} onChange={setSignature} label="Your signature" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setOpen(false); setSignature(null); setAgreed(false); }}>Cancel</Button>
            <Button size="sm" onClick={sign} disabled={!signature || !agreed || saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Confirm sign-off
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** A Viewer's COSHH assessments waiting for their signature (My training). */
export function MyCoshhSignOffs() {
  const { data } = useQuery<MyCoshh>({
    queryKey: ["my-coshh"],
    queryFn: async () => {
      const response = await apiFetch("/train-track/my-coshh");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load your COSHH assessments"));
      return response.json();
    },
  });
  if (!data?.linked || data.pending.length === 0) return null;
  return (
    <section className="space-y-3">
      <p className="text-sm font-medium">
        {data.pending.length === 1 ? "1 COSHH assessment is" : `${data.pending.length} COSHH assessments are`} waiting for you to read and sign.
      </p>
      {data.pending.map((assessment) => <MyCoshhCard key={assessment.id} assessment={assessment} />)}
    </section>
  );
}
