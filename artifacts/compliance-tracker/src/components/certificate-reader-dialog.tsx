import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, FileText, Loader2, Plus, Sparkles, Trash2, UploadCloud } from "lucide-react";
import {
  assignFixTrackContractor, createComplianceItem, createItemCertificate, fileCertificateInboxItem, readCertificateFiles,
  readCertificateInboxItem, useGetCertificateReading, useListComplianceItems, useListContractors, useListSites,
  type CertificateDefectCode, type CertificateInboxItem, type CertificateReading,
} from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { privateObjectUrl } from "@/lib/media-upload";
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
import {
  CERTIFICATE_INPUT_ACCEPT, MAX_READ_FILES, certificateFileFor, prepareCertificateFiles, toBase64, type CertificateFile,
} from "@/lib/certificate-files";
import { cn } from "@/lib/utils";
import { sortByLabel } from "@/lib/sort-options";

/** Codes that are remedial work by default; C3s never are (Steuart, 2026-10-27). */
const WORK_CODES = new Set<string>(["C1", "C2", "FI", "ID", "AR"]);
const NEW_CHECK = "new";
const NEW_CONTRACTOR = "new";

const selectClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

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
  newContractor: { company: string; name: string; email: string };
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
    newContractor: { company: reading.contractorName ?? "", name: "", email: "" },
    checked: false,
  };
}

/** A starting point to fill in by hand: an emailed certificate the AI did not read, or a file uploaded without AI. */
function blankReading(name: string, itemId: number | null, contractorName: string | null = null): CertificateReading {
  return {
    certificateType: "", name: name.replace(/\.[a-z0-9]+$/i, "") || "Certificate", itemId,
    checkReason: "", newCheck: null, contractorName, issueDate: null, nextInspectionDate: null,
    nextInspectionSource: null, outcome: "not_stated", summary: "", defects: [], unclear: [],
  };
}

/** One certificate to check and save, and the chosen files it is on. */
interface BatchEntry {
  reading: CertificateReading;
  fileIndexes: number[];
  byAi: boolean;
}

function sentBy(inbox: CertificateInboxItem): string {
  const who = inbox.contractorName ?? inbox.senderName ?? inbox.senderEmail ?? "a contractor";
  const how = inbox.source === "upload" ? "Uploaded by" : "Emailed by";
  return `${how} ${who} on ${new Date(inbox.receivedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
}

/**
 * Upload a contractor certificate and let ComplyTrack's AI read it: which
 * check (and so which track) it belongs to, its dates, outcome and defects.
 * The person checks every detail before anything is saved. The C1, C2 and FI
 * items (and gas ID / AR, or other work the certificate requires) become one
 * FixTrack job, and a quote for it can be asked of a contractor in the same
 * step. C3s are recorded on the certificate without a job.
 *
 * Up to 10 files can be chosen at once (Steuart, 2026-10-29): the pages of
 * one certificate (joined into one PDF when saved), or a batch of
 * certificates the AI sorts to their checks, checked and saved one by one.
 * Without the AI the same files are filled in by hand.
 */
export function CertificateReaderDialog({ open, onOpenChange, itemId = null, inbox = null, onFiled }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The check the reader was opened from; the certificate is filed there. */
  itemId?: number | null;
  /** A certificate emailed or uploaded by a contractor (Certificates to confirm): its file is already held. */
  inbox?: CertificateInboxItem | null;
  onFiled?: () => void;
}) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading } = useUpload();
  // Mounted only while open (see CertificateReaderButton), so these load fresh each time.
  const status = useGetCertificateReading();
  const { data: items = [] } = useListComplianceItems({});
  const { data: contractors = [] } = useListContractors();
  const { data: sites = [] } = useListSites();
  const input = useRef<HTMLInputElement>(null);
  // The chosen files, the certificates found in them, and which one is being checked.
  const [files, setFiles] = useState<CertificateFile[]>([]);
  const [batch, setBatch] = useState<BatchEntry[]>([]);
  const [position, setPosition] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  /** Files left out (cannot be read, or hold no certificate), each with why. */
  const [leftOut, setLeftOut] = useState<string[]>([]);
  /** Stored files by the chosen files they were made from, so a PDF holding two certificates is stored once. */
  const stored = useRef(new Map<string, string>());
  const initialReading = inbox ? inbox.reading ?? blankReading(inbox.fileName ?? "", inbox.itemId, inbox.contractorName) : null;
  const [reading, setReading] = useState<CertificateReading | null>(initialReading);
  const [draft, setDraft] = useState<Draft | null>(initialReading ? draftFrom(initialReading) : null);
  const [inboxNote, setInboxNote] = useState<string | null>(inbox?.note ?? null);
  const entry = inbox ? null : batch[position] ?? null;
  const readByAi = inbox ? !!inbox.reading || reading !== initialReading : !!entry?.byAi;
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ai = status.data?.ai;
  const canRead = !!status.data?.available && !!ai && aiAllowanceState(ai).canUse;
  // Without the AI (no add-on, or its allowance used) certificates can still be uploaded and filled in by hand.
  const canUpload = !!status.data;
  const { isDragging, dropZoneProps } = useFileDrop((chosen) => void read(chosen), !inbox && canUpload && busy === null && !draft);

  function reset() {
    setFiles([]); setBatch([]); setPosition(0); setSavedCount(0); setLeftOut([]); stored.current.clear();
    setReading(null); setDraft(null); setBusy(null); setError(null);
    if (input.current) input.current.value = "";
  }
  function close() {
    if (busy === "saving" || busy === "reading") return;
    reset();
    onOpenChange(false);
  }

  /** Ask the AI to read an emailed certificate it has not read (no allowance then, or a failed read). */
  async function readInbox() {
    if (!inbox) return;
    setError(null);
    setBusy("reading");
    try {
      const result = await readCertificateInboxItem(inbox.id);
      setInboxNote(result.note);
      if (result.reading) {
        const next = draftFrom(result.reading);
        const item = items.find((i) => String(i.id) === next.check);
        if (item?.contractorId && quotable.some((c) => c.id === item.contractorId)) next.quoteContractorId = String(item.contractorId);
        setReading(result.reading);
        setDraft(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ComplyTrack could not read this certificate");
    } finally {
      setBusy(null);
      void status.refetch();
    }
  }
  const entryFileNames = entry ? entry.fileIndexes.map((i) => files[i]?.name).filter(Boolean).join(", ") : "";
  // Links to open the chosen files while checking or filling in a certificate.
  const fileLinks = useMemo(() => files.map((f) => URL.createObjectURL(f.stored)), [files]);
  useEffect(() => () => fileLinks.forEach((link) => URL.revokeObjectURL(link)), [fileLinks]);
  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateDefect = (index: number, patch: Partial<DefectDraft>) =>
    setDraft((d) => (d ? { ...d, defects: d.defects.map((x, i) => (i === index ? { ...x, ...patch } : x)) } : d));

  const chosenItem = draft && draft.check !== NEW_CHECK ? items.find((i) => String(i.id) === draft.check) ?? null : null;
  const fixedItem = itemId != null ? items.find((i) => i.id === itemId) ?? null : null;
  const quotable = contractors.filter((c) => !!c.email);
  const workCount = draft?.defects.filter((d) => d.needsWork && d.description.trim()).length ?? 0;
  const canQuote = !!status.data?.fixTrack && workCount > 0;
  const addingContractor = draft?.quoteContractorId === NEW_CONTRACTOR;
  const updateContractor = (patch: Partial<Draft["newContractor"]>) =>
    setDraft((d) => (d ? { ...d, newContractor: { ...d.newContractor, ...patch } } : d));

  /** A draft for a reading, with the contractor to ask for a quote chosen where it can be. */
  function draftWithContractor(next: CertificateReading): Draft {
    const result = draftFrom(next);
    const item = items.find((i) => String(i.id) === result.check);
    if (item?.contractorId && quotable.some((c) => c.id === item.contractorId)) result.quoteContractorId = String(item.contractorId);
    else if (next.contractorName) {
      const named = next.contractorName.toLowerCase();
      const match = quotable.find((c) => [c.company, c.name].some((n) => n && (n.toLowerCase().includes(named) || named.includes(n.toLowerCase()))));
      if (match) result.quoteContractorId = String(match.id);
    }
    // No one to pick yet: start on adding the contractor named on the certificate.
    if (!result.quoteContractorId && !quotable.length) result.quoteContractorId = NEW_CONTRACTOR;
    return result;
  }

  function show(entries: BatchEntry[], index: number) {
    const next = entries[index]!;
    setPosition(index);
    setReading(next.reading);
    setDraft(next.byAi ? draftWithContractor(next.reading) : draftFrom(next.reading));
  }

  /** Each file becomes a certificate to fill in by hand (or one, for the check the reader was opened from). */
  function fillInByHand(ready: CertificateFile[] = files) {
    if (!ready.length) return;
    setError(null);
    const entries: BatchEntry[] = itemId != null
      ? [{ reading: blankReading(ready[0]!.name, itemId), fileIndexes: ready.map((_, i) => i), byAi: false }]
      : ready.map((f, i) => ({ reading: blankReading(f.name, null), fileIndexes: [i], byAi: false }));
    setBatch(entries);
    show(entries, 0);
  }

  async function read(chosen: File[]) {
    reset();
    if (!chosen.length) return;
    setBusy("reading");
    try {
      const { ready, problems } = await prepareCertificateFiles(chosen);
      setFiles(ready);
      setLeftOut(problems);
      if (!ready.length) {
        setError(chosen.length === 1 ? "This file can't be read. See why below." : "None of these files can be read. See why below.");
        return;
      }
      if (!canRead) return fillInByHand(ready);
      const result = await readCertificateFiles({
        files: await Promise.all(ready.map(async (f) => ({ fileName: f.name, mimeType: f.mimeType, data: await toBase64(f.blob) }))),
        itemId,
      });
      setLeftOut([...problems, ...result.skipped.map((s) => `${ready[s.fileIndex]?.name ?? "A file"}: ${s.reason}`)]);
      const entries = result.certificates.map((c): BatchEntry => ({ reading: c, fileIndexes: c.fileIndexes, byAi: true }));
      setBatch(entries);
      show(entries, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ComplyTrack could not read this certificate");
    } finally {
      setBusy(null);
      void status.refetch();
    }
  }

  /** On to the next certificate found, or close once they are all done. */
  function next(saved: boolean) {
    const done = savedCount + (saved ? 1 : 0);
    if (position + 1 < batch.length) {
      setSavedCount(done);
      setBusy(null);
      setError(null);
      show(batch, position + 1);
      return;
    }
    reset();
    if (done) onFiled?.();
    onOpenChange(false);
  }

  /** The stored file for the current certificate: uploaded once, joined into one PDF when it is on several files. */
  async function storedFileUrl(current: BatchEntry, name: string): Promise<string> {
    const key = current.fileIndexes.join(",");
    const known = stored.current.get(key);
    if (known) return known;
    const parts = current.fileIndexes.map((i) => files[i]).filter((f): f is CertificateFile => !!f);
    if (!parts.length) throw new Error("The certificate file is missing. Start again and choose it.");
    const url = await uploadFile(await certificateFileFor(parts, name));
    stored.current.set(key, url);
    return url;
  }

  function chooseCheck(value: string) {
    const item = items.find((i) => String(i.id) === value);
    const contractor = item?.contractorId && quotable.some((c) => c.id === item.contractorId) ? String(item.contractorId) : draft?.quoteContractorId ?? "";
    update({ check: value, quoteContractorId: contractor });
  }

  async function save() {
    if (!draft || (!entry && !inbox)) return;
    if (!draft.check) return setError("Choose the check this certificate is for");
    if (draft.check === NEW_CHECK && !draft.newTitle.trim()) return setError("Give the new check a title");
    if (!draft.name.trim()) return setError("Give the certificate a name");
    if (draft.defects.some((d) => !d.description.trim())) return setError("Describe each defect, or remove the empty row");
    if (canQuote && draft.askQuote && !draft.quoteContractorId) return setError("Choose who to ask for a quote, or untick \"Ask for a quote\"");
    if (canQuote && draft.askQuote && addingContractor) {
      if (!draft.newContractor.company.trim() && !draft.newContractor.name.trim()) return setError("Give the contractor's company or contact name, or untick \"Ask for a quote\"");
      if (!/^\S+@\S+\.\S+$/.test(draft.newContractor.email.trim())) return setError("Give the contractor's email address so the quote request can be sent");
    }
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
          contractorId: draft.quoteContractorId && !addingContractor ? Number(draft.quoteContractorId) : null,
        });
        targetId = created.id;
      }
      const notes = [
        inbox ? `${sentBy(inbox)}.` : null,
        readByAi && reading?.summary ? `Read by ComplyTrack AI: ${reading.summary}` : null,
      ].filter(Boolean).join(" ");
      const details = {
        name: draft.name.trim(),
        issueDate: draft.issueDate ? new Date(`${draft.issueDate}T09:00:00`).toISOString() : null,
        expiryDate: draft.nextInspectionDate ? new Date(`${draft.nextInspectionDate}T09:00:00`).toISOString() : null,
        notes: notes || null,
        outcome: draft.outcome,
        defects: draft.defects.map((d) => ({
          code: d.code,
          description: d.reference ? `${d.description.trim()} (item ${d.reference})`.slice(0, 1000) : d.description.trim(),
          location: d.location.trim() || null,
          needsWork: d.needsWork,
        })),
        remedialJob: true,
        readByAi,
      };
      const certificate = inbox
        ? await fileCertificateInboxItem(inbox.id, { itemId: targetId, certificate: details })
        : await createItemCertificate(targetId, { ...details, fileUrl: await storedFileUrl(entry!, draft.name.trim()) });
      const jobId = certificate.defects?.find((d) => d.fixTrackIssueId != null)?.fixTrackIssueId ?? null;
      let quoteNote = "";
      if (jobId && canQuote && draft.askQuote && draft.quoteContractorId) {
        try {
          const { company, name, email } = draft.newContractor;
          const sent = await assignFixTrackContractor(jobId, addingContractor
            ? { newContractor: { name: name.trim() || company.trim(), company: name.trim() ? company.trim() || null : null, email: email.trim() }, mode: "quote" }
            : { contractorId: Number(draft.quoteContractorId), mode: "quote" });
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
      if (inbox) {
        reset();
        onFiled?.();
        onOpenChange(false);
      } else next(true);
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
            <Sparkles className="w-5 h-5 text-primary" aria-hidden="true" />{" "}
            {inbox ? "Check and save this certificate"
              : batch.length > 1 ? `Certificate ${position + 1} of ${batch.length}`
              : status.data && !canRead ? "Upload certificates" : "Upload certificates for AI to read"}
          </DialogTitle>
          <DialogDescription>
            {inbox ? (
              <>{sentBy(inbox)}. Check every detail against the certificate before you save it.</>
            ) : draft ? (
              <>
                {fixedItem ? `For ${fixedItem.title}. ` : ""}
                {batch.length > 1 && savedCount > 0 ? `${savedCount} saved so far. ` : ""}
                Check every detail against the certificate before you save it.
              </>
            ) : (
              <>
                {fixedItem ? `For ${fixedItem.title}. ` : ""}
                {status.data && !canRead
                  ? "Choose the certificate files, then fill in each one: the check it is for, the next inspection date and any remedial work."
                  : <>ComplyTrack reads EICRs, gas and oil service records, fire alarm and other certificates: the check each is for, the next
                    inspection date and any remedial work. Add the pages of one certificate together, or a batch of certificates and the AI sorts
                    each to its check. You check everything before it is saved.</>}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!draft && !inbox && (
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
                  <p className="text-sm font-medium">
                    {files.length > 1 ? `Reading ${files.length} files…` : files.length === 1 ? `Reading ${files[0]!.name}…` : "Getting the files ready…"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">This usually takes under a minute.</p>
                </>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-muted-foreground mb-2" aria-hidden="true" />
                  <p className="text-sm font-medium">Drag certificates here (up to {MAX_READ_FILES} files at once), or</p>
                  <Button type="button" className="mt-2" disabled={!canUpload} onClick={() => input.current?.click()}>
                    Choose files
                  </Button>
                  <p className="text-xs text-muted-foreground mt-2">PDFs, photos (including iPhone photos) and Word files. Several photos of one certificate are joined into one PDF.</p>
                  <input ref={input} type="file" multiple className="hidden" accept={CERTIFICATE_INPUT_ACCEPT}
                    onChange={(e) => { const chosen = Array.from(e.target.files ?? []); if (chosen.length) void read(chosen); }} />
                </>
              )}
            </div>
            {status.data && !status.data.available && (
              <p className="text-xs text-muted-foreground">Reading certificates with AI is not switched on yet, so you fill each one in by hand.</p>
            )}
            {status.data?.available && ai && <AiAllowanceNote ai={ai} />}
            {status.data?.available && ai && !canRead && (
              <p className="text-xs text-muted-foreground">You can still upload certificates and fill them in by hand.</p>
            )}
            {error && files.length > 0 && busy === null && (
              <Button type="button" variant="outline" size="sm" onClick={() => fillInByHand()}>
                Fill in by hand instead
              </Button>
            )}
          </div>
        )}

        {leftOut.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-200 space-y-1">
            <p className="font-medium flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> Not read:</p>
            <ul className="list-disc pl-5 space-y-0.5">{leftOut.map((note, i) => <li key={i}>{note}</li>)}</ul>
          </div>
        )}

        {inbox && (
          <div className="rounded-lg border p-3 text-sm space-y-2">
            {inbox.fileUrl && (
              <a className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline" target="_blank" rel="noreferrer"
                href={privateObjectUrl(inbox.fileUrl, activeClientId)}>
                <ExternalLink className="w-4 h-4" aria-hidden="true" /> Open {inbox.fileName ?? "the certificate"}
              </a>
            )}
            {inboxNote && <p className="text-xs text-amber-700">{inboxNote}</p>}
            {!readByAi && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted-foreground flex-1 min-w-[12rem]">
                  {busy === "reading" ? "Reading the certificate… this usually takes under a minute." : "Fill the details in by hand, or let ComplyTrack's AI read it."}
                </p>
                <Button type="button" size="sm" variant="outline" disabled={!canRead || busy !== null} onClick={() => void readInbox()}>
                  {busy === "reading" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden="true" /> : <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />}
                  Read with AI
                </Button>
              </div>
            )}
            {!readByAi && status.data?.available && ai && <AiAllowanceNote ai={ai} />}
          </div>
        )}

        {draft && reading && (
          <div className="space-y-5 py-1">
            {entry && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {entry.fileIndexes.filter((i) => files[i]).map((i) => (
                  <a key={i} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline" target="_blank" rel="noreferrer" href={fileLinks[i]}>
                    <ExternalLink className="w-4 h-4" aria-hidden="true" /> Open {files[i]!.name}
                  </a>
                ))}
              </p>
            )}
            {readByAi && <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
              <p className="flex items-center gap-2 font-medium"><FileText className="w-4 h-4" aria-hidden="true" /> {reading.certificateType || entryFileNames}</p>
              {reading.summary && <p className="text-muted-foreground">{reading.summary}</p>}
              {reading.contractorName && <p className="text-xs text-muted-foreground">Contractor on the certificate: {reading.contractorName}</p>}
              {reading.unclear.length > 0 && (
                <p className="text-xs text-amber-700 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                  Check these, they were hard to read: {reading.unclear.join("; ")}
                </p>
              )}
            </div>}

            <div className="space-y-1.5">
              <Label htmlFor="reader-check">Compliance check *</Label>
              {itemId != null ? (
                <p className="text-sm">{fixedItem?.title ?? "This check"}</p>
              ) : (
                <>
                  <select id="reader-check" className={selectClass} value={draft.check} onChange={(e) => chooseCheck(e.target.value)}>
                    <option value="" disabled>Choose the check it is for</option>
                    {sortByLabel(items, (item) => item.title).map((item) => (
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
              {draft.defects.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {readByAi ? "No defects were found on this certificate." : "No defects added. Use Add for each defect or observation on the certificate."}
                </p>
              )}
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
                      <>
                        <select aria-label="Contractor to ask for a quote" className={selectClass} value={draft.quoteContractorId}
                          onChange={(e) => update({ quoteContractorId: e.target.value })}>
                          <option value="" disabled>Choose a contractor</option>
                          {quotable.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.company ? `${c.company} (${c.name})` : c.name}{c.id === chosenItem?.contractorId ? " · this check's contractor" : ""}
                            </option>
                          ))}
                          <option value={NEW_CONTRACTOR}>+ Add a new contractor</option>
                        </select>
                        {addingContractor && (
                          <div className="grid gap-2 sm:grid-cols-3">
                            <div className="space-y-1">
                              <Label htmlFor="reader-contractor-company" className="text-xs">Company</Label>
                              <Input id="reader-contractor-company" value={draft.newContractor.company} maxLength={200}
                                onChange={(e) => updateContractor({ company: e.target.value })} />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="reader-contractor-name" className="text-xs">Contact name (optional)</Label>
                              <Input id="reader-contractor-name" value={draft.newContractor.name} maxLength={200}
                                onChange={(e) => updateContractor({ name: e.target.value })} />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="reader-contractor-email" className="text-xs">Email</Label>
                              <Input id="reader-contractor-email" type="email" value={draft.newContractor.email} maxLength={320}
                                onChange={(e) => updateContractor({ email: e.target.value })} />
                            </div>
                            <p className="text-xs text-muted-foreground sm:col-span-3">They are added to your Contractors list when the quote request is sent.</p>
                          </div>
                        )}
                      </>
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
              {!inbox && batch.length > 1 && (
                <Button variant="ghost" type="button" onClick={() => next(false)} disabled={busy !== null}>
                  {position + 1 < batch.length ? "Skip this one" : "Skip and finish"}
                </Button>
              )}
              {!inbox && batch.length <= 1 && <Button variant="ghost" type="button" onClick={reset} disabled={busy !== null}>Start again</Button>}
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
