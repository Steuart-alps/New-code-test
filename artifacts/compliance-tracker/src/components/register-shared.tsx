import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListSites } from "@workspace/api-client-react";
import { format, isValid, parseISO } from "date-fns";
import { FileText, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { getApiErrorMessage } from "@/lib/api";
import { csvCell } from "@/lib/csv";
import { downloadBlob, downloadFile, getDownloadErrorMessage } from "@/lib/download";

// Shared pieces for the allergen, COSHH and asbestos register pages
// (API: /api/registers/*).

export type RegisterApi = ReturnType<typeof useActiveClientApi>;

/** UK display date (d MMM yyyy) for a YYYY-MM-DD value. */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, "d MMM yyyy") : value;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus whole calendar months, clamped to the end of the month. */
export function addMonthsIso(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return "";
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, lastDay));
  return first.toISOString().slice(0, 10);
}

/** Throws the API's error message for a failed response. */
export async function ensureOk(response: Response, fallback: string): Promise<Response> {
  if (!response.ok) throw new Error(await getApiErrorMessage(response, fallback));
  return response;
}

/** GET a register list for the active client. */
export function useRegisterList<T>(path: string, enabled = true) {
  const api = useActiveClientApi();
  const { activeClientId } = useAuth();
  return useQuery<T[]>({
    queryKey: [`/api${path}`, activeClientId],
    enabled,
    queryFn: async () => {
      const response = await ensureOk(await api(path), "Could not load the register");
      return response.json();
    },
  });
}

export function useRegisterSites() {
  const { data: sites = [] } = useListSites();
  const siteName = (id: number | null | undefined) =>
    id == null ? "Site removed" : sites.find((site) => site.id === id)?.name ?? "Unknown site";
  return { sites, siteName };
}

export function SiteFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { sites } = useRegisterSites();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs rounded-sm w-full sm:w-48" aria-label="Filter by site">
        <SelectValue placeholder="All sites" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All sites</SelectItem>
        {sites.map((site) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function SiteSelect({ value, onChange, id = "register-site" }: { value: string; onChange: (value: string) => void; id?: string }) {
  const { sites } = useRegisterSites();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Site *</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}><SelectValue placeholder={sites.length ? "Choose a site" : "Add a site first"} /></SelectTrigger>
        <SelectContent>
          {sites.map((site) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface DocumentValue { objectPath: string | null; fileName: string | null }

const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png"];

/**
 * Uploads a PDF/JPEG/PNG straight to storage, then hands the staging path to
 * the form. The API verifies the contents and secures the file on save.
 */
export function DocumentField({ label, value, onChange, disabled }: {
  label: string;
  value: DocumentValue;
  onChange: (value: DocumentValue) => void;
  disabled?: boolean;
}) {
  const api = useActiveClientApi();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast({ title: "Choose a PDF, JPEG or PNG file", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const signed = await ensureOk(await api("/registers/uploads/request-url", {
        method: "POST",
        body: JSON.stringify({ contentType: file.type }),
      }), "Could not start the upload");
      const { uploadUrl, objectPath } = await signed.json();
      const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error("Upload failed");
      onChange({ objectPath, fileName: file.name });
    } catch (err) {
      toast({ title: "Upload failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={(event) => event.target.files?.[0] && handleFile(event.target.files[0])}
      />
      {value.objectPath ? (
        <div className="flex items-center gap-2 p-2 rounded-md border border-border bg-muted/30 text-sm">
          <FileText className="w-4 h-4 text-primary shrink-0" />
          <span className="flex-1 truncate text-xs">{value.fileName ?? "Attached file"}</span>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label="Remove file"
            disabled={disabled} onClick={() => onChange({ objectPath: null, fileName: null })}>
            <X className="w-3 h-3" />
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-6 text-xs" disabled={uploading || disabled}
            onClick={() => inputRef.current?.click()}>Replace</Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-2"
          disabled={uploading || disabled} onClick={() => inputRef.current?.click()}>
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {uploading ? "Uploading…" : "Attach file (PDF, JPEG or PNG)"}
        </Button>
      )}
    </div>
  );
}

/** Fetches a short-lived download link from the API and saves the file. */
export async function downloadRegisterDocument(api: RegisterApi, path: string, fallbackName: string) {
  const response = await api(path);
  if (!response.ok) throw new Error(await getDownloadErrorMessage(response, "Could not get the download link"));
  const { downloadUrl, fileName } = await response.json();
  await downloadFile(downloadUrl, fileName ?? fallbackName);
}

/** Builds a formula-safe CSV in the browser and saves it. */
export function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const lines = [headers, ...rows].map((row) => row.map((cell) => csvCell(cell ?? "")).join(","));
  downloadBlob(new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" }), filename);
}

export function ConfirmDelete({ open, title, description, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
