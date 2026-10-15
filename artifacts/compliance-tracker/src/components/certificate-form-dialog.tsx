import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutations } from "@/hooks/use-app-data";
import { format } from "date-fns";
import { useUpload } from "@/hooks/use-upload";
import { useToast } from "@/hooks/use-toast";
import {
  Certificate, CertificateDefectCode, createCertificateDefect, getListItemCertificatesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloud, FileText, Plus, Trash2, AlertTriangle } from "lucide-react";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  issueDate: z.string().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
  notes: z.string().optional(),
  outcome: z.enum(["", "satisfactory", "unsatisfactory", "not_stated"]).optional(),
});

type FormValues = z.infer<typeof formSchema>;

/** Codes in the order they appear on EICRs and gas safety records. */
export const DEFECT_CODE_OPTIONS: Array<{ value: CertificateDefectCode; label: string }> = [
  { value: "C1", label: "C1 — Danger present" },
  { value: "C2", label: "C2 — Potentially dangerous" },
  { value: "C3", label: "C3 — Improvement recommended" },
  { value: "FI", label: "FI — Further investigation" },
  { value: "ID", label: "ID — Immediately dangerous (gas)" },
  { value: "AR", label: "AR — At risk (gas)" },
  { value: "other", label: "Other observation" },
];
const BLOCKING_CODES = new Set<string>(["C1", "C2", "FI", "ID", "AR"]);

type DefectDraft = { code: CertificateDefectCode; description: string; location: string };

const selectClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function CertificateFormDialog({
  isOpen,
  onClose,
  contractorId,
  itemId,
  suggestedName,
  defaultIssueDate,
  certificate = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  contractorId?: number;
  itemId?: number;
  suggestedName?: string;
  /** YYYY-MM-DD, e.g. the date a check was just marked done. */
  defaultIssueDate?: string | null;
  certificate?: Certificate | null;
}) {
  const {
    createCertificate, updateCertificate,
    createItemCertificate, updateItemCertificate,
  } = useAppMutations();
  const { uploadFile, isUploading, progress } = useUpload();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [defects, setDefects] = useState<DefectDraft[]>([]);
  const [defectError, setDefectError] = useState<string | null>(null);
  const [savingDefects, setSavingDefects] = useState(false);
  const isItemCertificate = !!itemId;
  const suggestedCertificateName = suggestedName?.trim()
    ? /certificate|licen[cs]e|registration|check/i.test(suggestedName)
      ? suggestedName.trim()
      : `${suggestedName.trim()} certificate`
    : "";

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      issueDate: "",
      expiryDate: "",
      notes: "",
      outcome: "",
    }
  });

  // "Change" only swaps the existing file display for the picker; the saved
  // file stays linked unless a new one is chosen.
  const [changingFile, setChangingFile] = useState(false);
  useEffect(() => setChangingFile(false), [certificate, isOpen]);

  useEffect(() => {
    if (certificate) {
      form.reset({
        name: certificate.name,
        issueDate: certificate.issueDate ? format(new Date(certificate.issueDate), "yyyy-MM-dd'T'HH:mm") : "",
        expiryDate: certificate.expiryDate ? format(new Date(certificate.expiryDate), "yyyy-MM-dd'T'HH:mm") : "",
        notes: certificate.notes || "",
        outcome: certificate.outcome ?? "not_stated",
      });
    } else {
      form.reset({
        name: suggestedCertificateName,
        issueDate: defaultIssueDate ? `${defaultIssueDate}T09:00` : "",
        expiryDate: "",
        notes: "",
        outcome: "",
      });
    }
    setSelectedFile(null);
    setDefects([]);
    setDefectError(null);
  }, [certificate, isOpen, form, suggestedCertificateName, defaultIssueDate]);

  const outcome = form.watch("outcome");
  const existingDefects = certificate?.defects ?? [];

  const onSubmit = async (data: FormValues) => {
    if (isItemCertificate && !data.outcome) {
      form.setError("outcome", { message: "Choose the outcome stated on the certificate" });
      return;
    }
    const cleanDefects = defects.map((d) => ({ ...d, description: d.description.trim(), location: d.location.trim() }));
    if (cleanDefects.some((d) => !d.description)) {
      setDefectError("Describe each defect, or remove the empty row");
      return;
    }
    setDefectError(null);
    try {
      let objectPath = certificate?.fileUrl;

      if (selectedFile) {
        objectPath = await uploadFile(selectedFile);
      }

      const { outcome: chosenOutcome, ...rest } = data;
      const payload = {
        ...rest,
        fileUrl: objectPath,
        issueDate: data.issueDate ? new Date(data.issueDate).toISOString() : null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate).toISOString() : null,
      };
      const defectPayload = cleanDefects.map((d) => ({ code: d.code, description: d.description, location: d.location || null }));

      if (itemId) {
        const itemOutcome = (chosenOutcome || "not_stated") as "satisfactory" | "unsatisfactory" | "not_stated";
        if (certificate) {
          await updateItemCertificate.mutateAsync({ itemId, id: certificate.id, data: { ...payload, outcome: itemOutcome } });
          if (defectPayload.length) {
            setSavingDefects(true);
            try {
              for (const defect of defectPayload) await createCertificateDefect(itemId, certificate.id, defect);
            } finally {
              setSavingDefects(false);
              queryClient.invalidateQueries({ queryKey: getListItemCertificatesQueryKey(itemId) });
              queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/compliance-items") });
            }
          }
        } else {
          await createItemCertificate.mutateAsync({ itemId, data: { ...payload, outcome: itemOutcome, defects: defectPayload } });
        }
      } else if (contractorId) {
        if (certificate) {
          await updateCertificate.mutateAsync({ contractorId, id: certificate.id, data: payload });
        } else {
          await createCertificate.mutateAsync({ contractorId, data: payload });
        }
      }
      toast({
        title: certificate ? "Certificate updated" : "Certificate uploaded",
        description: defectPayload.length
          ? `${data.name} — ${defectPayload.length} defect${defectPayload.length === 1 ? "" : "s"} recorded`
          : data.name,
      });
      onClose();
    } catch (e: any) {
      console.error(e);
      toast({
        title: "Could not save certificate",
        description: e?.message || "Something went wrong while uploading. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleFileSelect = (file: File | null) => {
    setSelectedFile(file);
    if (file && !form.getValues("name")) {
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
      form.setValue("name", nameWithoutExt, { shouldValidate: true });
    }
  };

  const updateDefect = (index: number, patch: Partial<DefectDraft>) =>
    setDefects((all) => all.map((d, i) => (i === index ? { ...d, ...patch } : d)));

  const busy = createCertificate.isPending || updateCertificate.isPending || createItemCertificate.isPending
    || updateItemCertificate.isPending || isUploading || savingDefects;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-display">
            {certificate ? "Edit Certificate" : "Upload Certificate"}
          </DialogTitle>
        </DialogHeader>

        <form id="certificate-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">
              Certificate Name *
              {suggestedCertificateName && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  for {suggestedName}
                </span>
              )}
            </Label>
            <Input id="name" {...form.register("name")} placeholder="e.g. Liability Insurance 2025" />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="issueDate">Issue Date</Label>
              <Input type="datetime-local" id="issueDate" {...form.register("issueDate")} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="expiryDate">Expiry / next inspection</Label>
              <Input type="datetime-local" id="expiryDate" {...form.register("expiryDate")} />
            </div>
          </div>

          {isItemCertificate && (
            <div className="space-y-1.5">
              <Label htmlFor="outcome">Outcome *</Label>
              <select id="outcome" className={selectClass} {...form.register("outcome")}>
                <option value="" disabled>Choose the outcome on the certificate</option>
                <option value="satisfactory">Satisfactory</option>
                <option value="unsatisfactory">Unsatisfactory</option>
                <option value="not_stated">Not stated</option>
              </select>
              {form.formState.errors.outcome ? (
                <p className="text-xs text-destructive">{form.formState.errors.outcome.message}</p>
              ) : outcome === "unsatisfactory" ? (
                <p className="text-xs text-rose-700 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  An unsatisfactory certificate does not move the due date, and the check stays flagged until its
                  C1/C2/FI defects are fixed or a satisfactory certificate is added.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Only a satisfactory certificate's expiry sets the check's next due date.</p>
              )}
            </div>
          )}

          {isItemCertificate && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Defects and observations</Label>
                <Button type="button" variant="outline" size="sm"
                  onClick={() => setDefects((all) => [...all, { code: outcome === "unsatisfactory" ? "C2" : "C3", description: "", location: "" }])}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add defect
                </Button>
              </div>
              {existingDefects.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {existingDefects.map((d) => (
                    <li key={d.id} className="rounded-md border px-2.5 py-1.5 bg-muted/30">
                      <span className="font-semibold">{d.code}</span> {d.description}
                      {d.location ? <span className="text-muted-foreground"> · {d.location}</span> : null}
                      <span className="text-muted-foreground"> · {d.open ? "open" : "closed"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {defects.map((d, index) => (
                <div key={index} className="rounded-lg border p-3 space-y-2">
                  <div className="flex gap-2">
                    <select aria-label="Defect code" className={selectClass} value={d.code}
                      onChange={(e) => updateDefect(index, { code: e.target.value as CertificateDefectCode })}>
                      {DEFECT_CODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove defect"
                      onClick={() => setDefects((all) => all.filter((_, i) => i !== index))}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <Input aria-label="Defect description" placeholder="What the certificate says, e.g. No RCD protection to sockets"
                    value={d.description} maxLength={1000} onChange={(e) => updateDefect(index, { description: e.target.value })} />
                  <Input aria-label="Defect location" placeholder="Location (optional), e.g. Kitchen DB2"
                    value={d.location} maxLength={300} onChange={(e) => updateDefect(index, { location: e.target.value })} />
                  <p className="text-xs text-muted-foreground">
                    {BLOCKING_CODES.has(d.code)
                      ? "Opens a FixTrack job; the check needs action until the job is resolved."
                      : "Opens a low-priority FixTrack job; it does not hold the check up."}
                  </p>
                </div>
              ))}
              {defectError && <p className="text-xs text-destructive">{defectError}</p>}
              {defects.length === 0 && existingDefects.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Record each C1, C2, C3 or FI code (or gas ID / AR warning) so the remedial work is tracked in FixTrack.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Certificate File</Label>
            {(!certificate?.fileUrl || changingFile) && !selectedFile ? (
              <div className="border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center justify-center text-center bg-muted/20 hover:bg-muted/50 transition-colors relative">
                <input
                  type="file"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                  accept=".pdf,.jpg,.jpeg,.png"
                />
                <UploadCloud className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm font-medium">Click or drag file to upload</p>
                <p className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG up to 10MB</p>
              </div>
            ) : (
              <div className="flex items-center justify-between p-4 border border-border rounded-xl bg-card">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2 rounded-lg">
                    <FileText className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium truncate max-w-[200px]">
                      {selectedFile ? selectedFile.name : "Existing Certificate File"}
                    </span>
                    {selectedFile && <span className="text-xs text-muted-foreground">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</span>}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedFile(null);
                    setChangingFile(true); // visual clear only
                  }}
                >
                  Change
                </Button>
              </div>
            )}

            {isUploading && (
              <div className="space-y-2 mt-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Uploading...</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                  <div className="bg-primary h-full transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" {...form.register("notes")} className="resize-none h-16" />
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button" disabled={isUploading}>Cancel</Button>
          <Button type="submit" form="certificate-form" disabled={busy}>
            {busy ? "Saving..." : "Save Certificate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
