import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Link } from "wouter";
import { CheckCircle2, ChevronDown, ChevronUp, FileText, Loader2, PenLine, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { SignaturePad } from "@/components/signature-pad";
import { AcknowledgementsDialog, type AcknowledgementDoc } from "@/components/acknowledgements-dialog";
import { ensureOk } from "@/components/register-shared";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { getDownloadErrorMessage } from "@/lib/download";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

// DocTrack documents marked "staff must read and sign" (API:
// /api/doc-track/acknowledgements/outstanding for TrainTrack's Documents
// section, /api/train-track/my-documents for a Viewer's own). Each signature
// becomes a TrainTrack document sign-off.

interface DocumentSignOffStatus {
  id: number;
  title: string;
  category: string;
  department: string | null;
  siteId: number | null;
  siteName: string | null;
  staffTotal: number;
  acknowledgedCount: number;
  outstanding: { id: number; name: string; department: string | null }[];
  acknowledged: { name: string; acknowledgedAt: string | null; signed: boolean }[];
}

const CATEGORY_LABEL: Record<string, string> = {
  risk_assessment: "Risk assessment", sop: "SOP", handbook: "Handbook", policy: "Policy", procedure: "Procedure", other: "Document",
  haccp: "HACCP plan", recipe_spec: "Recipe spec sheet",
};
const ukDate = (value: string | null) => (value ? format(new Date(value), "d MMM yyyy") : "");

/** Open a document's short-lived link in a new tab (opened in the click so popup blockers allow it). */
async function openDocument(path: string): Promise<void> {
  const popup = window.open("", "_blank");
  try {
    const response = await apiFetch(path);
    if (!response.ok) throw new Error(await getDownloadErrorMessage(response, "Could not open the document"));
    const { downloadUrl } = await response.json() as { downloadUrl: string };
    if (popup) {
      popup.opener = null;
      popup.location.href = downloadUrl;
    } else {
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.click();
    }
  } catch (error) {
    popup?.close();
    throw error;
  }
}

/** TrainTrack's Documents section: who has read and signed each DocTrack document. */
export function DocumentSignOffSection({ siteFilter, canManage }: { siteFilter: string; canManage: boolean }) {
  const api = useActiveClientApi();
  const { activeClientId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [signing, setSigning] = useState<AcknowledgementDoc | null>(null);

  const { data, isLoading, error } = useQuery<{ documents: DocumentSignOffStatus[] }>({
    queryKey: ["/api/doc-track/acknowledgements/outstanding", activeClientId],
    queryFn: async () => (await ensureOk(await api("/doc-track/acknowledgements/outstanding"), "Could not load document sign-offs")).json(),
  });
  const documents = (data?.documents ?? []).filter((d) => siteFilter === "all" || d.siteId == null || String(d.siteId) === siteFilter);
  const complete = documents.filter((d) => d.staffTotal > 0 && d.outstanding.length === 0).length;
  const outstanding = documents.reduce((sum, d) => sum + d.outstanding.length, 0);

  async function open(id: number) {
    try {
      await openDocument(`/doc-track/documents/${id}/download-url`);
    } catch (err) {
      toast({ title: "Could not open document", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Risk assessments, COSHH assessments, SOPs and policies uploaded in <Link href="/doc-track" className="font-medium underline">DocTrack</Link> with
        &ldquo;Staff must read and sign&rdquo; ticked. Everyone in the document&rsquo;s department (or everyone, if it has none) must read it and
        sign; each signature is saved in their training record. Staff sign their own under <Link href="/doc-track" className="font-medium underline">DocTrack → My documents</Link>.
      </p>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-sm border border-border p-3">
          <p className="text-xs text-muted-foreground">Documents to sign</p>
          <p className="text-xl font-bold">{isLoading ? "–" : documents.length}</p>
        </div>
        <div className="rounded-sm border border-border p-3">
          <p className="text-xs text-muted-foreground">Signed by everyone</p>
          <p className="text-xl font-bold">{isLoading ? "–" : complete}</p>
        </div>
        <div className={cn("rounded-sm border p-3", outstanding ? "border-amber-300 bg-amber-50" : "border-border")}>
          <p className={cn("text-xs", outstanding ? "text-amber-800" : "text-muted-foreground")}>Signatures still needed</p>
          <p className={cn("text-xl font-bold", outstanding ? "text-amber-800" : "")}>{isLoading ? "–" : outstanding}</p>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {!isLoading && !error && documents.length === 0 && (
        <div className="rounded-sm border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
          No documents for staff to sign yet. Upload one in DocTrack with &ldquo;Staff must read and sign&rdquo; ticked and it appears here.
        </div>
      )}

      {documents.map((d) => {
        const done = d.staffTotal > 0 && d.outstanding.length === 0;
        const isOpen = expanded === d.id;
        const target: AcknowledgementDoc = { id: d.id, title: d.title, department: d.department, site_id: d.siteId };
        return (
          <div key={d.id} className="space-y-3 rounded-sm border border-border p-4" data-testid={`document-signoff-${d.id}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="break-words font-medium">{d.title}</p>
                <p className="text-xs text-muted-foreground">
                  {[CATEGORY_LABEL[d.category] ?? "Document", d.department ?? "All staff", d.siteName].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn("text-[11px]", done ? "border-emerald-300 bg-emerald-50 text-emerald-700" : d.staffTotal === 0 ? "" : "border-amber-300 bg-amber-50 text-amber-800")}>
                  {d.staffTotal === 0 ? "No staff on the list for this department" : `${d.acknowledgedCount} of ${d.staffTotal} signed`}
                </Badge>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open the document" onClick={() => open(d.id)}>
                  <FileText className="h-4 w-4" />
                </Button>
                {canManage && d.outstanding.length > 0 && (
                  <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setSigning(target)}>
                    <PenLine className="h-3.5 w-3.5" /> Sign off staff
                  </Button>
                )}
              </div>
            </div>
            {d.outstanding.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <span className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Still to sign:</span>
                {d.outstanding.map((member) => (
                  <span key={member.id} className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
                    {member.name}
                  </span>
                ))}
              </div>
            )}
            {d.acknowledged.length > 0 && (
              <div>
                <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded(isOpen ? null : d.id)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {d.acknowledged.length} signed
                </button>
                {isOpen && (
                  <ul className="mt-2 divide-y divide-border rounded-sm border border-border text-sm">
                    {d.acknowledged.map((member, index) => (
                      <li key={`${member.name}-${index}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="flex min-w-0 items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />{member.name}</span>
                        <span className="text-xs text-muted-foreground">{ukDate(member.acknowledgedAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}

      {signing && (
        <AcknowledgementsDialog
          doc={signing}
          open
          canExport={canManage}
          onClose={() => {
            setSigning(null);
            void queryClient.invalidateQueries({ queryKey: ["/api/doc-track/acknowledgements/outstanding"] });
            void queryClient.invalidateQueries({ queryKey: ["train-track-records"] });
          }}
        />
      )}
    </div>
  );
}

interface MyDocument {
  id: number;
  title: string;
  category: string;
  description: string | null;
  site_name: string | null;
  department: string | null;
}

interface MyDocuments {
  rosterLinked: boolean;
  pending: MyDocument[];
  completed: MyDocument[];
}

const DECLARATION = "I have read and understood this document and I will follow it.";

function MyDocumentCard({ doc }: { doc: MyDocument }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [signingOpen, setSigningOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function open() {
    try {
      await openDocument(`/train-track/my-documents/${doc.id}/download-url`);
      setOpened(true);
    } catch (error) {
      toast({ title: "Could not open document", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  }

  async function sign() {
    if (!signature || !agreed) return;
    setSaving(true);
    try {
      const response = await apiFetch(`/train-track/my-documents/${doc.id}/sign`, { method: "POST", body: JSON.stringify({ signature }) });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Your signature wasn't saved"));
      toast({ title: "Signed", description: doc.title });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-documents"] }),
        queryClient.invalidateQueries({ queryKey: ["my-training"] }),
      ]);
    } catch (error) {
      toast({ title: "Not signed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3 rounded-sm p-4" data-testid={`my-document-${doc.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Document to read and sign</p>
          <p className="break-words font-semibold">{doc.title}</p>
          <p className="text-sm text-muted-foreground">{[CATEGORY_LABEL[doc.category] ?? "Document", doc.site_name, doc.department].filter(Boolean).join(" · ")}</p>
          {doc.description && <p className="mt-1 whitespace-pre-wrap text-sm">{doc.description}</p>}
        </div>
        {!signingOpen && <Button size="sm" onClick={() => setSigningOpen(true)}><PenLine className="mr-1.5 h-3.5 w-3.5" />Read and sign</Button>}
      </div>
      {signingOpen && (
        <div className="space-y-3 border-t pt-3">
          <Button variant="outline" size="sm" onClick={open}><FileText className="mr-1.5 h-3.5 w-3.5" />Open the document</Button>
          {!opened && <p className="text-xs text-muted-foreground">Open and read the document before you sign.</p>}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={agreed} disabled={!opened} onCheckedChange={(checked) => setAgreed(checked === true)} />
            {DECLARATION}
          </label>
          <SignaturePad value={signature} onChange={setSignature} label="Your signature" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setSigningOpen(false); setSignature(null); setAgreed(false); }}>Cancel</Button>
            <Button size="sm" onClick={sign} disabled={!opened || !signature || !agreed || saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Confirm sign-off
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** A Viewer's DocTrack documents waiting for their signature (My training). */
export function MyDocumentSignOffs() {
  const { data } = useQuery<MyDocuments>({
    queryKey: ["my-documents"],
    queryFn: async () => {
      const response = await apiFetch("/train-track/my-documents");
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load your documents"));
      return response.json();
    },
  });
  if (!data?.rosterLinked || data.pending.length === 0) return null;
  return (
    <section className="space-y-3">
      <p className="text-sm font-medium">
        {data.pending.length === 1 ? "1 document is" : `${data.pending.length} documents are`} waiting for you to read and sign.
      </p>
      {data.pending.map((doc) => <MyDocumentCard key={doc.id} doc={doc} />)}
    </section>
  );
}
