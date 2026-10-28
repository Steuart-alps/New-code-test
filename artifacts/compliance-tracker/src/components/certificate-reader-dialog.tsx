import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText, Loader2, Plus, Sparkles, Trash2, UploadCloud } from "lucide-react";
import {
  assignFixTrackContractor, createComplianceItem, createItemCertificate, readCertificate,
  useGetCertificateReading, useListComplianceItems, useListContractors, useListSites,
  type CertificateDefectCode, type CertificateReading,
} from "@workspace/api-client-react";
import { AiAllowanceNote, aiAllowanceState } from "@/components/ai-allowance-note";
import { DEFECT_CODE_OPTIONS } from "@/components/certificate-form-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { localToday } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Largest file ComplyTrack's AI reads (the server's limit too). */
const MAX_READ_BYTES = 15 * 1024 * 1024;
/** Codes that are remedial work by default; C3s never are (Steuart, 2026-10-27). */
const WORK_CODES = new Set<string>(["C1", "C2", "FI", "ID", "AR"]);
const NEW_CHECK = "new";

const selectClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function fileMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "docx" ? DOCX_TYPE
    : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "";
}

/** Phone photos are shrunk to 2,000 pixels before they are read; Claude reads them just as well. */
async function shrinkPhoto(file: File, mimeType: string): Promise<{ blob: Blob; mimeType: string }> {
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType) || typeof createImageBitmap !== "function") return { blob: file, mimeType };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1_500_000) { bitmap.close(); return { blob: file, mimeType }; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? { blob, mimeType: "image/jpeg" } : { blob: file, mimeType };
  } catch {
    return { blob: file, mimeType };
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(blob);
  });
}

type DefectDraft = { code: CertificateDefectCode; description: string; location: string; reference: string | null; needsWork: boolean };

interface Draft {
  check: string;
  newTitle: string;
  newSiteId: string;
  newFrequency: string;
  name: string;
  issueDate: string;
  nextInspectionDate: string;
  outcome: "satisfactory" | "unsatisfactory" | "not_stated";
  defects: DefectDraft[];
  askQuote: boolean;
  quoteContractorId: string;
  checked: boolean;
}

function draftFrom(reading: CertificateReading): Draft {
  return {
    check: reading.itemId != null ? String(reading.itemId) : reading.newCheck ? NEW_CHECK : "",
    newTitle: reading.newCheck?.title ?? "",
    newSiteId: "",
    newFrequency: reading.newCheck?.frequencyMonths ? String(reading.newCheck.frequencyMonths) : "",
    name: reading.name,
    issueDate: reading.issueDate ?? "",
    nextInspectionDate: reading.nextInspectionDate ?? "",
    outcome: reading.outcome,
    defects: reading.defects.map((d) => ({
      code: d.code, description: d.description, location: d.location ?? "", reference: d.reference ?? null, needsWork: d.needsWork,
    })),
    askQuote: true,
    quoteContractorId: "",
    checked: false,
  };
}

/**
 * Upload a contractor certificate and let ComplyTrack's AI read it: which
 * check (and so which track) it belongs to, its dates, outcome and defects.
 * The person checks every detail before anything is saved. The C1, C2 and FI
 * items (and gas ID / AR, or other work the certificate requires) become one
 * FixTrack job, and a quote for it can be asked of a contractor in the same
 * step. C3s are recorded on the certificate without a job.
 */
export function CertificateReaderDialog({ open, onOpenChange, itemId = null }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The check the reader was opened from; the certificate is filed there. */
  itemId?: number | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading } = useUpload();
  // Mounted only while open (see CertificateReaderButton), so these load fresh each time.
  const status = useGetCertificateReading();
  const { data: items = [] } = useListComplianceItems({});
  const { data: contractors = [] } = useListContractors();
  const { data: sites = [] } = useListSites();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState<CertificateReading | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ai = status.data?.ai;
  const canRead = !!status.data?.available && !!ai && aiAllowanceState(ai).canUse;
  const { isDragging, dropZoneProps } = useFileDrop((files) => void read(files[0]!), canRead && busy === null);

  function reset() {
    setFile(null); setReading(null); setDraft(null); setBusy(null); setError(null);
    if (input.current) input.current.value = "";
  }
  function close() {
    if (busy === "saving") return;
    reset();
    onOpenChange(false);
  }
  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateDefect = (index: number, patch: Partial<DefectDraft>) =>
    setDraft((d) => (d ? { ...d, defects: d.defects.map((x, i) => (i === index ? { ...x, ...patch } : x)) } : d));

  const chosenItem = draft && draft.check !== NEW_CHECK ? items.find((i) => String(i.id) === draft.check) ?? null : null;
  const fixedItem = itemId != null ? items.find((i) => i.id === itemId) ?? null : null;
  const quotable = contractors.filter((c) => !!c.email);
  const workCount = draft?.defects.filter((d) => d.needsWork && d.description.trim()).length ?? 0;
  const canQuote = !!status.data?.fixTrack && workCount > 0;

  async function read(selected: File) {
    reset();
    setFile(selected);
    const mimeType = fileMimeType(selected);
    if (!/^(application\/pdf|image\/(jpeg|png|webp|gif)|text\/plain)$/.test(mimeType) && mimeType !== DOCX_TYPE) {
      setError("ComplyTrack can read a PDF, a photo or a Word (.docx) certificate.");
      return;
    }
    setBusy("reading");
    try {
      const shrunk = await shrinkPhoto(selected, mimeType);
      if (shrunk.blob.size > MAX_READ_BYTES) throw new Error("This file is too large to read (15 MB at most). Upload a smaller PDF, or fill the certificate in by hand.");
      const result = await readCertificate({ fileName: selected.name, mimeType: shrunk.mimeType, data: await toBase64(shrunk.blob), itemId });
      const next = draftFrom(result);
      const item = items.find((i) => String(i.id) === next.check);
      if (item?.contractorId && quotable.some((c) => c.id === item.contractorId)) next.quoteContractorId = String(item.contractorId);
      else if (result.contractorName) {
        const named = result.contractorName.toLowerCase();
        const match = quotable.find((c) => [c.company, c.name].some((n) => n && (n.toLowerCase().includes(named) || named.includes(n.toLowerCase()))));
        if (match) next.quoteContractorId = String(match.id);
      }
      setReading(result);
      setDraft(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ComplyTrack could not read this certificate");
    } finally {
      setBusy(null);
      void status.refetch();
    }
  }

  function chooseCheck(value: string) {
    const item = items.find((i) => String(i.id) === value);
    const contractor = item?.contractorId && quotable.some((c) => c.id === item.contractorId) ? String(item.contractorId) : draft?.quoteContractorId ?? "";
    update({ check: value, quoteContractorId: contractor });
  }

  async function save() {
    if (!draft || !file) return;
    if (!draft.check) return setError("Choose the check this certificate is for");
    if (draft.check === NEW_CHECK && !draft.newTitle.trim()) return setError("Give the new check a title");
    if (!draft.name.trim()) return setError("Give the certificate a name");
    if (draft.defects.some((d) => !d.description.trim())) return setError("Describe each defect, or remove the empty row");
    if (canQuote && draft.askQuote && !draft.quoteContractorId) return setError("Choose who to ask for a quote, or untick \"Ask for a quote\"");
    if (!draft.checked) return setError("Tick to confirm you have checked the details against the certificate");
    setError(null);
    setBusy("saving");
    try {
      let targetId = Number(draft.check);
      if (draft.check === NEW_CHECK) {
        const frequency = Number(draft.newFrequency);
        const created = await createComplianceItem({
          title: draft.newTitle.trim(),
          siteId: draft.newSiteId ? Number(draft.newSiteId) : null,
          frequencyMonths: Number.isInteger(frequency) && frequency >= 1 && frequency <= 120 ? frequency : null,
          contractorId: draft.quoteContractorId ? Number(draft.quoteContractorId) : null,
        });
        targetId = created.id;
      }
      const fileUrl = await uploadFile(file);
      const certificate = await createItemCertificate(targetId, {
        name: draft.name.trim(),
        fileUrl,
        issueDate: draft.issueDate ? new Date(`${draft.issueDate}T09:00:00`).toISOString() : null,
        expiryDate: draft.nextInspectionDate ? new Date(`${draft.nextInspectionDate}T09:00:00`).toISOString() : null,
        notes: reading?.summary ? `Read by ComplyTrack AI: ${reading.summary}` : null,
        outcome: draft.outcome,
        defects: draft.defects.map((d) => ({
          code: d.code,
          description: d.reference ? `${d.description.trim()} (item ${d.reference})`.slice(0, 1000) : d.description.trim(),
          location: d.location.trim() || null,
          needsWork: d.needsWork,
        })),
        remedialJob: true,
        readByAi: true,
      });
      const jobId = certificate.defects?.find((d) => d.fixTrackIssueId != null)?.fixTrackIssueId ?? null;
      let quoteNote = "";
      if (jobId && canQuote && draft.askQuote && draft.quoteContractorId) {
        try {
          const sent = await assignFixTrackContractor(jobId, { contractorId: Number(draft.quoteContractorId), mode: "quote" });
          quoteNote = ` ${sent.message}.`;
        } catch (err) {
          quoteNote = ` The quote request was not sent (${err instanceof Error ? err.message : "please try again"}); ask for it from the job in FixTrack.`;
        }
      }
      await queryClient.invalidateQueries();
      toast({
        title: "Certificate saved",
        description: `${draft.name.trim()}${jobId ? ": remedial work added to FixTrack." : "."}${quoteNote}`,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The certificate could not be saved");
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-display flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" aria-hidden="true" /> Upload a certificate for AI to read
          </DialogTitle>
          <DialogDescription>
            {fixedItem ? `For ${fixedItem.title}. ` : ""}
            ComplyTrack reads an EICR, gas safety record, fire alarm service or other certificate: the check it is for, the next
            inspection date and any remedial work. You check everything before it is saved.
          </DialogDescription>
        </DialogHeader>

        {!draft && (
          <div className="space-y-3">
            <div
              {...dropZoneProps}
              className={cn(
                "border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center bg-muted/20",
                isDragging ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              {busy === "reading" ? (
                <>
                  <Loader2 className="w-8 h-8 text-primary mb-2 animate-spin" aria-hidden="true" />
                  <p className="text-sm font-medium">Reading {file?.name}…</p>
                  <p className="text-xs text-muted-foreground mt-1">This usually takes under a minute.</p>
                </>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-muted-foreground mb-2" aria-hidden="true" />
                  <p className="text-sm font-medium">Drag the certificate here, or</p>
                  <Button type="button" className="mt-2" disabled={!canRead} onClick={() => input.current?.click()}>
                    Choose a PDF or photo
                  </Button>
                  <input ref={input} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
                </>
              )}
            </div>
            {status.data && !status.data.available && (
              <p className="text-xs text-muted-foreground">Reading certificates is not switched on yet. Use "Upload Certificate" on the check to fill one in by hand.</p>
            )}
            {status.data?.available && ai && <AiAllowanceNote ai={ai} />}
          </div>
        )}

        {draft && reading && (
          <div className="space-y-5 py-1">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
              <p className="flex items-center gap-2 font-medium"><FileText className="w-4 h-4" aria-hidden="true" /> {reading.certificateType || file?.name}</p>
              {reading.summary && <p className="text-muted-foreground">{reading.summary}</p>}
              {reading.contractorName && <p className="text-xs text-muted-foreground">Contractor on the certificate: {reading.contractorName}</p>}
              {reading.unclear.length > 0 && (
                <p className="text-xs text-amber-700 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                  Check these, they were hard to read: {reading.unclear.join("; ")}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reader-check">Compliance check *</Label>
              {itemId != null ? (
                <p className="text-sm">{fixedItem?.title ?? "This check"}</p>
              ) : (
                <>
                  <select id="reader-check" className={selectClass} value={draft.check} onChange={(e) => chooseCheck(e.target.value)}>
                    <option value="" disabled>Choose the check it is for</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}{item.siteName ? ` · ${item.siteName}` : ""}{item.categoryName ? ` (${item.categoryName})` : ""}
                      </option>
                    ))}
                    <option value={NEW_CHECK}>+ Create a new check</option>
                  </select>
                  {reading.checkReason && <p className="text-xs text-muted-foreground">{reading.checkReason}</p>}
                </>
              )}
              {draft.check === NEW_CHECK && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg border p-3">
                  <div className="sm:col-span-3 space-y-1">
                    <Label htmlFor="reader-new-title">New check title *</Label>
                    <Input id="reader-new-title" value={draft.newTitle} maxLength={200} onChange={(e) => update({ newTitle: e.target.value })} />
                  </div>
                  <div className="sm:col-span-2 space-y-1">
                    <Label htmlFor="reader-new-site">Site</Label>
                    <select id="reader-new-site" className={selectClass} value={draft.newSiteId} onChange={(e) => update({ newSiteId: e.target.value })}>
                      <option value="">All sites</option>
                      {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reader-new-frequency">Repeat (months)</Label>
                    <Input id="reader-new-frequency" type="number" min={1} max={120} value={draft.newFrequency}
                      onChange={(e) => update({ newFrequency: e.target.value })} />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reader-name">Certificate name *</Label>
              <Input id="reader-name" value={draft.name} maxLength={200} onChange={(e) => update({ name: e.target.value })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="reader-issue">Inspection date</Label>
                <Input id="reader-issue" type="date" value={draft.issueDate} onChange={(e) => update({ issueDate: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reader-next">Next inspection</Label>
                <Input id="reader-next" type="date" value={draft.nextInspectionDate} onChange={(e) => update({ nextInspectionDate: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reader-outcome">Outcome</Label>
                <select id="reader-outcome" className={selectClass} value={draft.outcome}
                  onChange={(e) => update({ outcome: e.target.value as Draft["outcome"] })}>
                  <option value="satisfactory">Satisfactory</option>
                  <option value="unsatisfactory">Unsatisfactory</option>
                  <option value="not_stated">Not stated</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-3">
              {reading.nextInspectionSource === "repeat" && draft.nextInspectionDate === reading.nextInspectionDate
                ? "The certificate gives no next date, so this is worked out from the check's repeat interval. "
                : ""}
              {draft.outcome === "unsatisfactory"
                ? "An unsatisfactory certificate does not move the check's due date; the check stays red until the remedial work is done."
                : "The next inspection date becomes the check's next due date."}
              {draft.outcome !== "unsatisfactory" && draft.nextInspectionDate && draft.nextInspectionDate < localToday()
                ? " That date has already passed, so the check will show as overdue until the next inspection is booked."
                : ""}
            </p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Defects and observations</Label>
                <Button type="button" variant="outline" size="sm"
                  onClick={() => update({ defects: [...draft.defects, { code: "C2", description: "", location: "", reference: null, needsWork: true }] })}>
                  <Plus className="w-3.5 h-3.5 mr-1" aria-hidden="true" /> Add
                </Button>
              </div>
              {draft.defects.length === 0 && <p className="text-xs text-muted-foreground">No defects were found on this certificate.</p>}
              {draft.defects.map((d, index) => (
                <div key={index} className={cn("rounded-lg border p-3 space-y-2", d.needsWork ? "border-rose-200 bg-rose-50/40 dark:bg-rose-950/20" : "")}>
                  <div className="flex gap-2">
                    <select aria-label="Code" className={selectClass} value={d.code}
                      onChange={(e) => {
                        const code = e.target.value as CertificateDefectCode;
                        updateDefect(index, { code, needsWork: code === "other" ? d.needsWork : WORK_CODES.has(code) });
                      }}>
                      {DEFECT_CODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove"
                      onClick={() => update({ defects: draft.defects.filter((_, i) => i !== index) })}>
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <Input aria-label="Description" value={d.description} maxLength={1000}
                    onChange={(e) => updateDefect(index, { description: e.target.value })} />
                  <Input aria-label="Location" placeholder="Location (optional)" value={d.location} maxLength={300}
                    onChange={(e) => updateDefect(index, { location: e.target.value })} />
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={d.needsWork} onCheckedChange={(value) => updateDefect(index, { needsWork: value === true })} />
                    {d.needsWork ? "Remedial work: goes on the FixTrack job and the quote" : "Recorded on the certificate only (no job)"}
                  </label>
                </div>
              ))}
            </div>

            {workCount > 0 && (
              <div className="rounded-lg border p-3 space-y-2">
                {!status.data?.fixTrack ? (
                  <p className="text-xs text-muted-foreground">
                    The {workCount} remedial item{workCount === 1 ? "" : "s"} will keep the check flagged until each is marked fixed. With FixTrack they
                    would become a job you can ask a contractor to quote for.
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-medium">
                      {workCount} remedial item{workCount === 1 ? "" : "s"} become one FixTrack job.
                    </p>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={draft.askQuote} onCheckedChange={(value) => update({ askQuote: value === true })} />
                      Ask for a quote
                    </label>
                    {draft.askQuote && (
                      quotable.length ? (
                        <select aria-label="Contractor to ask for a quote" className={selectClass} value={draft.quoteContractorId}
                          onChange={(e) => update({ quoteContractorId: e.target.value })}>
                          <option value="" disabled>Choose a contractor</option>
                          {quotable.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.company ? `${c.company} (${c.name})` : c.name}{c.id === chosenItem?.contractorId ? " · this check's contractor" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-xs text-muted-foreground">Add a contractor with an email address on the Contractors page, then ask for a quote from the job in FixTrack.</p>
                      )
                    )}
                    <p className="text-xs text-muted-foreground">The email lists every remedial item and has a link for the contractor to send their price. Nothing is assigned until you accept a quote.</p>
                  </>
                )}
              </div>
            )}

            <label className="flex items-start gap-2 text-sm font-medium">
              <Checkbox className="mt-0.5" checked={draft.checked} onCheckedChange={(value) => update({ checked: value === true })} />
              I have checked these details against the certificate
            </label>
          </div>
        )}

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        <DialogFooter>
          <Button variant="outline" type="button" onClick={close} disabled={busy === "saving"}>Cancel</Button>
          {draft && (
            <>
              <Button variant="ghost" type="button" onClick={reset} disabled={busy !== null}>Start again</Button>
              <Button type="button" onClick={() => void save()} disabled={busy !== null}>
                {busy === "saving" ? (isUploading ? "Uploading…" : "Saving…") : canQuote && draft.askQuote ? "Save and ask for a quote" : "Save certificate"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "Read a certificate with AI" button and its dialog, for owners and ALPS.
 * The dialog is only mounted while open.
 */
export function CertificateReaderButton({ itemId = null, size = "default", label = "Read a certificate with AI", className }: {
  itemId?: number | null;
  size?: "default" | "sm";
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={() => setOpen(true)} className={cn("gap-2", className)}>
        <Sparkles className="w-4 h-4" aria-hidden="true" /> {label}
      </Button>
      {open && <CertificateReaderDialog open={open} onOpenChange={setOpen} itemId={itemId} />}
    </>
  );
}
