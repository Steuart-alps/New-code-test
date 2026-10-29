import { useState, useEffect, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { downloadFile, getDownloadErrorMessage } from "@/lib/download";
import { useAuth } from "@/context/auth-context";
import { AuditLog } from "@/components/audit-log";
import { PublicLinkAccessHistory } from "@/components/public-link-access-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Upload, FolderOpen, FileText, FileSpreadsheet, FileImage, FileVideo, File,
  Download, Trash2, Search, Plus, Loader2, Presentation, CheckSquare, Users,
  CheckCircle2, Clock, Link2, Copy, Check, BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MyDocumentsView } from "@/components/my-documents-view";
import { AcknowledgementsDialog, type StaffMember } from "@/components/acknowledgements-dialog";
import { assertWithinUploadLimit } from "@/lib/upload-limits";
import { sortByLabel } from "@/lib/sort-options";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Doc {
  id: number;
  client_id: number;
  site_id: number | null;
  title: string;
  category: Category;
  description: string | null;
  file_name: string;
  file_size: number | null;
  mime_type: string;
  object_path: string;
  uploaded_by: string | null;
  requires_acknowledgement: boolean;
  annual_acknowledgement?: boolean;
  acknowledgement_status?: "not_required" | "pending" | "acknowledged" | "expired";
  acknowledgement_staff_total?: number;
  acknowledged_count?: number;
  pending_acknowledgement_count?: number;
  expired_acknowledgement_count?: number;
  department: string | null;
  site_name: string | null;
  created_at: string;
  updated_at: string;
}

interface Site {
  id: number;
  name: string;
}

type Category = "risk_assessment" | "sop" | "handbook" | "policy" | "procedure" | "other" | "haccp" | "recipe_spec";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_TABS = [
  { key: "all",             label: "All" },
  { key: "risk_assessment", label: "Risk Assessments" },
  { key: "sop",             label: "SOPs" },
  { key: "handbook",        label: "Handbooks" },
  { key: "policy",          label: "Policies" },
  { key: "procedure",       label: "Procedures" },
  { key: "other",           label: "Other" },
  { key: "haccp",           label: "HACCP" },
  { key: "recipe_spec",     label: "Recipe specs" },
] as const;

// KitchenTrack shows only its HACCP plans and recipe spec sheets.
const KITCHEN_CATEGORY_TABS = [
  { key: "all",         label: "All" },
  { key: "haccp",       label: "HACCP plans" },
  { key: "recipe_spec", label: "Recipe spec sheets" },
] as const;
const KITCHEN_CATEGORIES: Category[] = ["haccp", "recipe_spec"];

const UPLOAD_CATEGORY_LABELS: Record<Category, string> = {
  risk_assessment: "Risk Assessment (including COSHH)",
  sop: "SOP (Standard Operating Procedure)",
  handbook: "Staff Handbook",
  policy: "Policy",
  procedure: "Procedure",
  other: "Other",
  haccp: "HACCP plan",
  recipe_spec: "Recipe spec sheet",
};

const CATEGORY_META: Record<string, { label: string; color: string; bg: string }> = {
  risk_assessment: { label: "Risk Assessment", color: "text-red-700",    bg: "bg-red-50 border-red-200" },
  sop:             { label: "SOP",             color: "text-blue-700",   bg: "bg-blue-50 border-blue-200" },
  handbook:        { label: "Handbook",        color: "text-orange-700", bg: "bg-orange-50 border-orange-200" },
  policy:          { label: "Policy",          color: "text-purple-700", bg: "bg-purple-50 border-purple-200" },
  procedure:       { label: "Procedure",       color: "text-teal-700",   bg: "bg-teal-50 border-teal-200" },
  other:           { label: "Other",           color: "text-gray-600",   bg: "bg-gray-100 border-gray-200" },
  haccp:           { label: "HACCP plan",      color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
  recipe_spec:     { label: "Recipe spec sheet", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
};

const ACCEPTED_TYPES = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.avi,.mkv,.webm";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileIcon(mimeType: string) {
  if (mimeType === "application/pdf")
    return { Icon: FileText, color: "text-red-500", bg: "bg-red-50" };
  if (mimeType.includes("wordprocessingml") || mimeType.includes("msword"))
    return { Icon: FileText, color: "text-blue-500", bg: "bg-blue-50" };
  if (mimeType.includes("spreadsheetml") || mimeType.includes("ms-excel"))
    return { Icon: FileSpreadsheet, color: "text-green-500", bg: "bg-green-50" };
  if (mimeType.includes("presentationml") || mimeType.includes("ms-powerpoint"))
    return { Icon: Presentation, color: "text-orange-500", bg: "bg-orange-50" };
  if (mimeType.startsWith("image/"))
    return { Icon: FileImage, color: "text-purple-500", bg: "bg-purple-50" };
  if (mimeType.startsWith("video/"))
    return { Icon: FileVideo, color: "text-indigo-500", bg: "bg-indigo-50" };
  return { Icon: File, color: "text-gray-400", bg: "bg-gray-100" };
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Acknowledgements Dialog ──────────────────────────────────────────────────

// ─── Document card ────────────────────────────────────────────────────────────

function DocCard({
  doc,
  onDelete,
  onAcknowledge,
  canMutate,
  canManageAcknowledgements,
}: {
  doc: Doc;
  onDelete: (doc: Doc) => void;
  onAcknowledge: (doc: Doc) => void;
  canMutate: boolean;
  canManageAcknowledgements: boolean;
}) {
  const { toast } = useToast();
  const { Icon, color, bg } = fileIcon(doc.mime_type);
  const cat = CATEGORY_META[doc.category] ?? CATEGORY_META.other;
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await apiFetch(`/doc-track/documents/${doc.id}/download-url`);
      if (!res.ok) throw new Error(await getDownloadErrorMessage(res, "Please try again."));
      const { downloadUrl } = await res.json();
      await downloadFile(downloadUrl, doc.file_name);
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card className="group shadow-sm shadow-black/5 border-border/60 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
      <CardContent className="p-5">
        {/* File icon + title */}
        <div className="flex items-start gap-3 mb-3">
          <div className={cn("p-2.5 rounded-lg flex-shrink-0", bg)}>
            <Icon className={cn("w-5 h-5", color)} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm leading-snug break-words">{doc.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{doc.file_name}</p>
          </div>
        </div>

        {/* Category badge */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={cn(
            "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
            cat.bg, cat.color,
          )}>
            {cat.label}
          </span>
          {doc.requires_acknowledgement && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
              <CheckSquare className="w-2.5 h-2.5" /> Ack. required
            </span>
          )}
          {doc.annual_acknowledgement && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-700 border-blue-200">
              Annual
            </span>
          )}
          {doc.requires_acknowledgement && doc.acknowledgement_status && (
            <span className={cn(
              "inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium border",
              doc.acknowledgement_status === "acknowledged" && "bg-emerald-50 text-emerald-700 border-emerald-200",
              doc.acknowledgement_status === "pending" && "bg-amber-50 text-amber-700 border-amber-200",
              doc.acknowledgement_status === "expired" && "bg-red-50 text-red-700 border-red-200",
            )}>
              {doc.acknowledgement_status === "acknowledged" ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
              {doc.acknowledgement_status === "acknowledged" ? "Acknowledged" : doc.acknowledgement_status === "expired" ? "Expired" : "Pending"}
            </span>
          )}
          {doc.site_name && (
            <span className="text-[11px] text-muted-foreground truncate">{doc.site_name}</span>
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-4">
          <span>{formatDate(doc.created_at)}</span>
          {doc.file_size && <span>{formatSize(doc.file_size)}</span>}
        </div>
        {doc.requires_acknowledgement && doc.acknowledgement_staff_total != null && (
          <p className="text-[11px] text-muted-foreground -mt-2 mb-3">
            {doc.acknowledged_count ?? 0}/{doc.acknowledgement_staff_total} current
            {(doc.pending_acknowledgement_count ?? 0) > 0 && ` · ${doc.pending_acknowledgement_count} pending`}
            {(doc.expired_acknowledgement_count ?? 0) > 0 && ` · ${doc.expired_acknowledgement_count} expired`}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="default"
            className="flex-1 h-8 text-xs gap-1.5"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            Download
          </Button>
          {canManageAcknowledgements && doc.requires_acknowledgement && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs gap-1 text-amber-700 border-amber-200 hover:bg-amber-50"
              onClick={() => onAcknowledge(doc)}
            >
              <Users className="w-3 h-3" /> Acknowledge
            </Button>
          )}
          {canMutate && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onDelete(doc)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Upload Dialog ────────────────────────────────────────────────────────────

function UploadDialog({
  open,
  onClose,
  onUploaded,
  sites,
  existingDepts,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  sites: Site[];
  existingDepts: string[];
  categories: Category[];
}) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>(categories[0]);
  const [description, setDescription] = useState("");
  const [siteId, setSiteId] = useState<string>("none");
  const [department, setDepartment] = useState("");
  // Risk assessments (COSHH included), SOPs, policies and the like become a
  // read-and-sign task for staff unless the uploader unticks it.
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(true);
  const [ackChosen, setAckChosen] = useState(false);
  const [annualAcknowledgement, setAnnualAcknowledgement] = useState(false);
  const [roster, setRoster] = useState<StaffMember[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<"idle" | "requesting" | "uploading" | "saving">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setTitle("");
    setCategory(categories[0]);
    setDescription("");
    setSiteId("none");
    setDepartment("");
    setRequiresAcknowledgement(true);
    setAckChosen(false);
    setAnnualAcknowledgement(false);
    setRoster(null);
    setUploading(false);
    setProgress("idle");
  }

  // The staff list, to suggest departments and say who will be asked to sign.
  useEffect(() => {
    if (!open || roster) return;
    apiFetch("/staff-roster")
      .then(r => (r.ok ? r.json() : []))
      .then((rows: StaffMember[]) => setRoster(rows.filter(m => m.active)))
      .catch(() => setRoster([]));
  }, [open, roster]);

  function changeCategory(next: Category) {
    setCategory(next);
    if (!ackChosen) {
      setRequiresAcknowledgement(next !== "other");
      if (next === "other") setAnnualAcknowledgement(false);
    }
  }

  const departmentOptions = Array.from(new Set([
    ...existingDepts,
    ...(roster ?? []).map(m => m.department?.trim()).filter(Boolean) as string[],
  ])).sort((a, b) => a.localeCompare(b));
  // Same rule as the server: active staff in the department and at the site, when set.
  const signers = (roster ?? []).filter(m =>
    (!department.trim() || m.department === department.trim())
    && (siteId === "none" || m.site_id === Number(siteId)));

  function handleFileChange(f: File) {
    setFile(f);
    if (!title) setTitle(titleFromFileName(f.name));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileChange(f);
  }

  async function handleUpload() {
    if (!file || !title.trim()) return;
    setUploading(true);

    try {
      assertWithinUploadLimit(file);
      // 1. Request presigned PUT URL
      setProgress("requesting");
      const urlRes = await apiFetch("/doc-track/documents/request-upload", {
        method: "POST",
        body: JSON.stringify({ name: file.name, contentType: file.type || "application/octet-stream" }),
      });
      if (!urlRes.ok) {
        throw new Error(await getApiErrorMessage(urlRes, "Could not get upload URL"));
      }
      const { uploadUrl, objectPath } = await urlRes.json();

      // 2. PUT file directly to GCS
      setProgress("uploading");
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error("File upload failed");

      // 3. Save document record
      setProgress("saving");
      const saveRes = await apiFetch("/doc-track/documents", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          category,
          description: description.trim() || null,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
          objectPath,
          siteId: siteId !== "none" ? Number(siteId) : null,
          uploadedBy: user?.name ?? user?.email ?? null,
          requiresAcknowledgement,
          annualAcknowledgement: requiresAcknowledgement ? annualAcknowledgement : false,
          department: department.trim() || null,
        }),
      });
      if (!saveRes.ok) throw new Error("Could not save document");

      toast({ title: "Document uploaded", description: `"${title.trim()}" has been added to the library.` });
      reset();
      onUploaded();
      onClose();
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message ?? "Something went wrong.", variant: "destructive" });
      setUploading(false);
      setProgress("idle");
    }
  }

  const progressLabel = { idle: "", requesting: "Preparing…", uploading: "Uploading file…", saving: "Saving…" }[progress];

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !uploading) { reset(); onClose(); } }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-4 h-4" /> Upload Document
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30",
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFileChange(f); }}
            />
            {file ? (
              <div className="flex items-center justify-center gap-2 text-sm font-medium">
                <File className="w-4 h-4 text-primary" />
                <span className="truncate max-w-xs">{file.name}</span>
                <span className="text-muted-foreground text-xs">({formatSize(file.size)})</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 text-muted-foreground">
                <Upload className="w-8 h-8 mb-1 opacity-40" />
                <p className="text-sm font-medium">Drop a file here or click to browse</p>
                <p className="text-xs">PDF, Word, Excel, PowerPoint, images, videos</p>
              </div>
            )}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label>Title <span className="text-destructive">*</span></Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Manual Handling Risk Assessment" />
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={v => changeCategory(v as Category)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {sortByLabel(categories, c => UPLOAD_CATEGORY_LABELS[c]).map(c => <SelectItem key={c} value={c}>{UPLOAD_CATEGORY_LABELS[c]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Department */}
          <div className="space-y-1.5">
            <Label>Department <span className="text-muted-foreground text-xs">(optional, leave blank for all staff)</span></Label>
            <Input
              value={department}
              onChange={e => setDepartment(e.target.value)}
              placeholder="e.g. Kitchen, Front of House, All Staff"
              list="upload-dept-list"
            />
            <datalist id="upload-dept-list">
              {departmentOptions.map(d => <option key={d} value={d} />)}
            </datalist>
          </div>

          {/* Site */}
          {sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger><SelectValue placeholder="Not site-specific" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not site-specific</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Description */}
          <div className="space-y-1.5">
            <Label>Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description of this document…"
              rows={2}
            />
          </div>

          {/* Requires acknowledgement */}
          <div className="flex items-start gap-3 pt-1">
            <Checkbox
              id="requires-ack"
              checked={requiresAcknowledgement}
              onCheckedChange={v => { setAckChosen(true); setRequiresAcknowledgement(!!v); if (!v) setAnnualAcknowledgement(false); }}
              className="mt-0.5"
            />
            <div className="flex-1">
              <Label htmlFor="requires-ack" className="cursor-pointer">Staff must read and sign</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Asks every member of staff on the Staff Roster {department.trim() ? <>in <strong>{department.trim()}</strong></> : "in the business"}
                {siteId !== "none" ? " at this site" : ""} to read and sign it. Each signature is saved in their training record, and anyone still to sign is listed in the Monday email.
              </p>
              {requiresAcknowledgement && roster && (
                <p className={cn("text-xs mt-1", signers.length ? "text-foreground" : "text-amber-700")} data-testid="upload-signers">
                  {signers.length
                    ? `${signers.length} member${signers.length === 1 ? "" : "s"} of staff will be asked to sign.`
                    : "No active staff on the Staff Roster match yet. Staff added to this department later will be asked to sign."}
                </p>
              )}

              {requiresAcknowledgement && (
                <div className="flex items-start gap-2.5 mt-3 pl-0.5">
                  <Checkbox
                    id="annual-ack"
                    checked={annualAcknowledgement}
                    onCheckedChange={v => setAnnualAcknowledgement(!!v)}
                    className="mt-0.5"
                  />
                  <div>
                    <Label htmlFor="annual-ack" className="cursor-pointer text-sm">Annual re-acknowledgement</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">TrainTrack records will carry a 1-year expiry — staff will be reminded to re-read and re-sign each year.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {uploading && (
            <span className="text-xs text-muted-foreground mr-auto flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> {progressLabel}
            </span>
          )}
          <Button variant="outline" onClick={() => { if (!uploading) { reset(); onClose(); } }} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || !title.trim() || uploading} className="gap-1.5">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const DOC_TRACK_CATEGORIES: Category[] = ["risk_assessment", "sop", "handbook", "policy", "procedure", "other", "haccp", "recipe_spec"];

export default function DocTrackPage() {
  return (
    <AppLayout title="DocTrack">
      <DocTrackLibrary />
    </AppLayout>
  );
}

/**
 * The document library with staff read-and-sign. `kitchen` shows only
 * KitchenTrack's HACCP plans and recipe spec sheets, without the DocTrack
 * heading, audit log or link history.
 */
export function DocTrackLibrary({ kitchen = false }: { kitchen?: boolean }) {
  const { activeClientId, user } = useAuth();
  const { toast } = useToast();

  // Determine if the current user is a manager (admin / consultant) or staff
  const isManager = user?.role === "client_admin" || user?.role === "consultant";
  const canMutate = user?.role !== "client_viewer";

  const [docs, setDocs] = useState<Doc[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [pageView, setPageView] = useState<"library" | "my-docs" | "audit" | "link-access">(
    user?.role === "client_admin" || user?.role === "consultant" ? "library" : "my-docs",
  );
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Doc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [ackDoc, setAckDoc] = useState<Doc | null>(null);
  const [outstandingOpen, setOutstandingOpen] = useState(false);
  const [signOffToken, setSignOffToken] = useState<string | null>(null);
  const [signOffExpiresAt, setSignOffExpiresAt] = useState<string | null>(null);
  const [signOffLinkBusy, setSignOffLinkBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/doc-track/documents");
      if (res.ok) {
        const rows: Doc[] = await res.json();
        setDocs(kitchen ? rows.filter(d => KITCHEN_CATEGORIES.includes(d.category)) : rows);
      }
    } finally {
      setLoading(false);
    }
  }, [activeClientId, kitchen]);

  useEffect(() => {
    if (!activeClientId) return;
    load();
    apiFetch("/sites").then(r => r.ok ? r.json() : []).then(setSites);
    setSignOffToken(null);
    setSignOffExpiresAt(null);
    apiFetch("/doc-track/sign-off-info").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.token) {
        setSignOffToken(d.token);
        setSignOffExpiresAt(d.expiresAt ?? null);
      }
    });
  }, [activeClientId, load]);

  const signOffUrl = signOffToken
    ? `${window.location.origin}${import.meta.env.BASE_URL}sign-off/${signOffToken}`.replace(/\/+$/, "")
    : null;

  function copySignOffLink() {
    if (!signOffUrl) return;
    navigator.clipboard.writeText(signOffUrl).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    });
  }

  async function createSignOffLink() {
    setSignOffLinkBusy(true);
    try {
      const response = await apiFetch("/doc-track/sign-off-info", { method: "POST" });
      if (!response.ok) throw new Error("Could not create a sign-off link");
      const data = await response.json();
      setSignOffToken(data.token);
      setSignOffExpiresAt(data.expiresAt ?? null);
      toast({ title: "Staff sign-off link created" });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "Could not create a sign-off link",
        variant: "destructive",
      });
    } finally {
      setSignOffLinkBusy(false);
    }
  }

  async function revokeSignOffLink() {
    if (!window.confirm("Revoke this staff sign-off link? Anyone using it will lose access immediately.")) return;
    setSignOffLinkBusy(true);
    try {
      const response = await apiFetch("/doc-track/sign-off-info", { method: "DELETE" });
      if (!response.ok && response.status !== 204) throw new Error("Could not revoke the sign-off link");
      setSignOffToken(null);
      setSignOffExpiresAt(null);
      toast({ title: "Staff sign-off link revoked" });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : "Could not revoke the sign-off link",
        variant: "destructive",
      });
    } finally {
      setSignOffLinkBusy(false);
    }
  }

  // Unique departments from existing docs (for autocomplete in upload dialog)
  const existingDepts = Array.from(new Set(docs.map(d => d.department).filter(Boolean) as string[])).sort();

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/doc-track/documents/${deleteTarget.id}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        toast({ title: "Document deleted" });
        setDocs(prev => prev.filter(d => d.id !== deleteTarget.id));
      } else {
        toast({ title: "Delete failed", variant: "destructive" });
      }
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  // Filter
  const visible = docs.filter(d => {
    if (activeTab !== "all" && d.category !== activeTab) return false;
    if (search && !d.title.toLowerCase().includes(search.toLowerCase()) &&
        !d.file_name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Per-category counts
  const counts = docs.reduce<Record<string, number>>((acc, d) => {
    acc.all = (acc.all ?? 0) + 1;
    acc[d.category] = (acc[d.category] ?? 0) + 1;
    return acc;
  }, {});

  const categoryTabs = kitchen ? KITCHEN_CATEGORY_TABS : CATEGORY_TABS;

  return (
    <>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        {kitchen ? (
          <p className="text-sm text-muted-foreground max-w-xl">
            Upload your HACCP plan and recipe spec sheets. Staff on the Staff Roster are asked to read and sign each one, and every signature is saved in their training record.
          </p>
        ) : <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 bg-cyan-50 rounded-lg">
              <FolderOpen className="w-5 h-5 text-cyan-600" />
            </div>
            <h1 className="text-2xl font-display font-bold text-foreground">DocTrack</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Document library — risk assessments, SOPs, policies &amp; more
          </p>
        </div>}
        <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
          {isManager && (
            <Button variant="outline" onClick={() => setOutstandingOpen(true)} className="gap-1.5">
              <Users className="w-4 h-4" /> Outstanding
            </Button>
          )}
          {canMutate && (
            <Button onClick={() => setUploadOpen(true)} className="gap-1.5">
              <Plus className="w-4 h-4" /> Upload Document
            </Button>
          )}
        </div>
      </div>

      {/* Personal sign-offs are available to every account with a roster match. */}
      <div className="flex gap-1 mb-6 border-b border-border">
          <button
            onClick={() => { setPageView("library"); load(); }}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
              pageView === "library"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <FolderOpen className="w-4 h-4" /> Document Library
          </button>
          <button
            onClick={() => setPageView("my-docs")}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
              pageView === "my-docs"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <BookOpen className="w-4 h-4" /> My Documents
          </button>
          {isManager && !kitchen && <button type="button" data-testid="tab-doc-audit" onClick={() => setPageView("audit")} className={cn("flex items-center px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px", pageView === "audit" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>Audit log</button>}
          {isManager && !kitchen && <button type="button" data-testid="tab-doc-link-access" onClick={() => setPageView("link-access")} className={cn("flex items-center px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px", pageView === "link-access" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>Sign-off link access</button>}
      </div>
      {isManager && pageView === "audit" && <AuditLog module="doc" />}
      {isManager && pageView === "link-access" && <PublicLinkAccessHistory linkType="sign_off" />}

      {/* My Documents personal view */}
      {pageView === "my-docs" && (
        <MyDocumentsView key={activeClientId ?? "none"} canAcknowledge={canMutate} />
      )}

      {/* Library view */}
      {pageView === "library" && (
        <>
          {/* Staff self-sign link */}
          {isManager && (
            <div className="flex items-center gap-3 mb-6 p-3.5 rounded-xl border bg-amber-50 border-amber-200">
              <Link2 className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-900">Staff self-sign link</p>
                {signOffUrl ? (
                  <>
                    <p data-testid="text-sign-off-link" className="text-xs text-amber-700 truncate mt-0.5">{signOffUrl}</p>
                    <p data-testid="text-sign-off-expiry" className="text-xs text-amber-800 mt-1">
                      Expires {signOffExpiresAt ? new Date(signOffExpiresAt).toLocaleDateString("en-GB") : "in 90 days"}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-amber-800 mt-0.5">No active link. Create one to let staff sign required documents.</p>
                )}
              </div>
              {signOffUrl ? (
                <>
                  <Button
                    data-testid="button-copy-sign-off-link"
                    size="sm"
                    variant="outline"
                    className="flex-shrink-0 gap-1.5 border-amber-300 text-amber-800 hover:bg-amber-100 h-8"
                    onClick={copySignOffLink}
                    disabled={signOffLinkBusy}
                  >
                    {linkCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {linkCopied ? "Copied!" : "Copy link"}
                  </Button>
                  <Button
                    data-testid="button-renew-sign-off-link"
                    size="sm"
                    variant="outline"
                    className="flex-shrink-0 h-8"
                    onClick={createSignOffLink}
                    disabled={signOffLinkBusy}
                  >
                    Renew
                  </Button>
                  <Button
                    data-testid="button-revoke-sign-off-link"
                    size="sm"
                    variant="outline"
                    className="flex-shrink-0 h-8 text-destructive"
                    onClick={revokeSignOffLink}
                    disabled={signOffLinkBusy}
                  >
                    Revoke
                  </Button>
                </>
              ) : (
                <Button
                  data-testid="button-create-sign-off-link"
                  size="sm"
                  variant="outline"
                  className="flex-shrink-0 h-8 border-amber-300 text-amber-800 hover:bg-amber-100"
                  onClick={createSignOffLink}
                  disabled={signOffLinkBusy}
                >
                  {signOffLinkBusy ? "Creating…" : "Create link"}
                </Button>
              )}
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            {/* Category tabs */}
            <div className="flex overflow-x-auto gap-1 pb-1 flex-shrink-0">
              {categoryTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                    activeTab === tab.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70",
                  )}
                >
                  {tab.label}
                  {counts[tab.key] != null && (
                    <span className={cn(
                      "ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full",
                      activeTab === tab.key ? "bg-white/20" : "bg-background",
                    )}>
                      {counts[tab.key]}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search documents…"
                className="pl-8 h-9"
              />
            </div>
          </div>

          {/* Content */}
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center gap-3">
              <div className="p-4 bg-cyan-50 rounded-2xl">
                <FolderOpen className="w-10 h-10 text-cyan-400" />
              </div>
              <div>
                <p className="font-medium text-base">
                  {docs.length === 0 ? "No documents yet" : "No documents match your filter"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {docs.length === 0
                    ? kitchen ? "Upload your HACCP plan or a recipe spec sheet to get started." : "Upload your first risk assessment, SOP, or policy to get started."
                    : "Try a different category or clear the search."}
                </p>
              </div>
              {docs.length === 0 && (
                <Button onClick={() => setUploadOpen(true)} variant="outline" size="sm" className="gap-1.5 mt-1">
                  <Upload className="w-3.5 h-3.5" /> Upload Document
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {visible.map(doc => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  onDelete={setDeleteTarget}
                  onAcknowledge={setAckDoc}
                  canMutate={canMutate}
                  canManageAcknowledgements={isManager}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Upload dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={load}
        sites={sites}
        existingDepts={existingDepts}
        categories={kitchen ? KITCHEN_CATEGORIES : DOC_TRACK_CATEGORIES}
      />

      {/* Acknowledgements dialog */}
      {ackDoc && (
        <AcknowledgementsDialog doc={ackDoc} open={!!ackDoc} onClose={() => setAckDoc(null)} canExport={isManager} />
      )}

      {/* Outstanding acknowledgements overview */}
      <OutstandingDialog open={outstandingOpen} onClose={() => setOutstandingOpen(false)} canExport={isManager}
        categories={kitchen ? KITCHEN_CATEGORIES : null} />

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteTarget?.title}&rdquo; will be permanently removed from the library. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Outstanding acknowledgements dialog ─────────────────────────────────────

interface OutstandingDoc {
  id: number;
  title: string;
  category: string;
  department: string | null;
  staffTotal: number;
  acknowledgedCount: number;
  outstanding: { id: number; name: string; department: string | null }[];
  acknowledged: { name: string; acknowledgedAt: string | null; signed: boolean }[];
}

function OutstandingDialog({ open, onClose, canExport, categories = null }: {
  open: boolean; onClose: () => void; canExport: boolean;
  /** Only documents in these categories (KitchenTrack); null for all. */
  categories?: Category[] | null;
}) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<OutstandingDoc[]>([]);
  const [view, setView] = useState<"outstanding" | "summary">("outstanding");
  const [exporting, setExporting] = useState(false);
  const clientScope = activeClientId == null ? "" : `?clientId=${encodeURIComponent(activeClientId)}`;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setView("outstanding");
    apiFetch(`/doc-track/acknowledgements/outstanding${clientScope}`)
      .then(r => (r.ok ? r.json() : { documents: [] }))
      .then(d => setDocs(((d.documents ?? []) as OutstandingDoc[]).filter(doc => !categories || categories.includes(doc.category as Category))))
      .finally(() => setLoading(false));
  }, [open, clientScope, categories]);

  async function handleExportCombinedRegister() {
    setExporting(true);
    try {
      const response = await apiFetch(`/doc-track/acknowledgements/export${clientScope}`);
      if (!response.ok) throw new Error("Export failed");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "document-acknowledgement-register.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast({ title: "PDF export failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  const withOutstanding = docs.filter(d => d.outstanding.length > 0);
  const fullyAcknowledged = docs.filter(d => d.outstanding.length === 0);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-4 h-4" /> Acknowledgements Overview
          </DialogTitle>
        </DialogHeader>

        {/* View toggle + export */}
        {!loading && docs.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-border overflow-hidden text-xs">
              <button
                onClick={() => setView("outstanding")}
                className={cn(
                  "px-3 py-1.5 font-medium transition-colors",
                  view === "outstanding" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                )}
              >
                Outstanding ({withOutstanding.length})
              </button>
              <button
                onClick={() => setView("summary")}
                className={cn(
                  "px-3 py-1.5 font-medium transition-colors border-l border-border",
                  view === "summary" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                )}
              >
                All docs ({docs.length})
              </button>
            </div>
            {canExport && (
              <Button variant="outline" size="sm" className="ml-auto gap-1.5"
                onClick={handleExportCombinedRegister} disabled={exporting} aria-busy={exporting}>
                {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                {exporting ? "Preparing…" : "Export PDF"}
              </Button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : docs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No documents require acknowledgement yet. Tick &ldquo;Staff must read and sign&rdquo; when uploading to track staff sign-off here.
            </p>
          ) : view === "outstanding" ? (
            withOutstanding.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-emerald-700">
                <CheckCircle2 className="w-4 h-4" /> All staff have acknowledged every required document.
              </div>
            ) : (
              <div className="space-y-4 py-1">
                {withOutstanding.map(d => (
                  <div key={d.id} className="border rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <p className="text-sm font-medium truncate">{d.title}</p>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {d.acknowledgedCount}/{d.staffTotal} acknowledged
                      </span>
                    </div>
                    {d.department && (
                      <p className="text-xs text-muted-foreground mb-1.5">Department: {d.department}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {d.outstanding.map(s => (
                        <span key={s.id} className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                          {s.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            /* Summary view — all required docs with completion status */
            <div className="space-y-2 py-1">
              {docs.map(d => {
                const pct = d.staffTotal > 0 ? Math.round((d.acknowledgedCount / d.staffTotal) * 100) : 100;
                const allDone = d.outstanding.length === 0;
                return (
                  <div key={d.id} className={cn(
                    "border rounded-lg p-3",
                    allDone ? "border-green-200 bg-green-50/50" : "border-border"
                  )}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{d.title}</p>
                        {d.department && (
                          <p className="text-xs text-muted-foreground">Department: {d.department}</p>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <span className={cn(
                          "text-xs font-semibold",
                          allDone ? "text-emerald-700" : d.outstanding.length > 0 ? "text-amber-700" : "text-muted-foreground"
                        )}>
                          {d.acknowledgedCount}/{d.staffTotal}
                        </span>
                        <p className="text-[10px] text-muted-foreground">staff</p>
                      </div>
                    </div>
                    {/* Progress bar */}
                    <div className="w-full bg-muted rounded-full h-1.5">
                      <div
                        className={cn("h-1.5 rounded-full transition-all", allDone ? "bg-emerald-500" : "bg-amber-400")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {allDone && (
                      <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> All staff acknowledged
                      </p>
                    )}
                  </div>
                );
              })}
              {fullyAcknowledged.length > 0 && withOutstanding.length > 0 && (
                <p className="text-xs text-muted-foreground text-center pt-1">
                  {fullyAcknowledged.length} doc{fullyAcknowledged.length !== 1 ? "s" : ""} fully acknowledged · {withOutstanding.length} with outstanding
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
