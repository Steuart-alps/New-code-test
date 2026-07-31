import { useState, useEffect, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
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
import {
  Upload, FolderOpen, FileText, FileSpreadsheet, FileImage, FileVideo, File,
  Download, Trash2, Search, Plus, Loader2, Presentation,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  site_name: string | null;
  created_at: string;
  updated_at: string;
}

interface Site {
  id: number;
  name: string;
}

type Category = "risk_assessment" | "sop" | "policy" | "procedure" | "other";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_TABS = [
  { key: "all",             label: "All" },
  { key: "risk_assessment", label: "Risk Assessments" },
  { key: "sop",             label: "SOPs" },
  { key: "policy",          label: "Policies" },
  { key: "procedure",       label: "Procedures" },
  { key: "other",           label: "Other" },
] as const;

const CATEGORY_META: Record<string, { label: string; color: string; bg: string }> = {
  risk_assessment: { label: "Risk Assessment", color: "text-red-700",    bg: "bg-red-50 border-red-200" },
  sop:             { label: "SOP",             color: "text-blue-700",   bg: "bg-blue-50 border-blue-200" },
  policy:          { label: "Policy",          color: "text-purple-700", bg: "bg-purple-50 border-purple-200" },
  procedure:       { label: "Procedure",       color: "text-teal-700",   bg: "bg-teal-50 border-teal-200" },
  other:           { label: "Other",           color: "text-gray-600",   bg: "bg-gray-100 border-gray-200" },
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

// ─── Document card ────────────────────────────────────────────────────────────

function DocCard({
  doc,
  onDelete,
}: {
  doc: Doc;
  onDelete: (doc: Doc) => void;
}) {
  const { Icon, color, bg } = fileIcon(doc.mime_type);
  const cat = CATEGORY_META[doc.category] ?? CATEGORY_META.other;
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await apiFetch(`/doc-track/documents/${doc.id}/download-url`);
      if (!res.ok) throw new Error("Failed to get download URL");
      const { downloadUrl } = await res.json();
      window.open(downloadUrl, "_blank", "noopener");
    } catch {
      /* silent */
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
          {doc.site_name && (
            <span className="text-[11px] text-muted-foreground truncate">{doc.site_name}</span>
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-4">
          <span>{formatDate(doc.created_at)}</span>
          {doc.file_size && <span>{formatSize(doc.file_size)}</span>}
        </div>

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
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(doc)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
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
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  sites: Site[];
}) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("risk_assessment");
  const [description, setDescription] = useState("");
  const [siteId, setSiteId] = useState<string>("none");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<"idle" | "requesting" | "uploading" | "saving">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setTitle("");
    setCategory("risk_assessment");
    setDescription("");
    setSiteId("none");
    setUploading(false);
    setProgress("idle");
  }

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
      // 1. Request presigned PUT URL
      setProgress("requesting");
      const urlRes = await apiFetch("/doc-track/documents/request-upload", {
        method: "POST",
        body: JSON.stringify({ name: file.name, contentType: file.type || "application/octet-stream" }),
      });
      if (!urlRes.ok) throw new Error("Could not get upload URL");
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
      <DialogContent className="max-w-lg">
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
            <Select value={category} onValueChange={v => setCategory(v as Category)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="risk_assessment">Risk Assessment</SelectItem>
                <SelectItem value="sop">SOP (Standard Operating Procedure)</SelectItem>
                <SelectItem value="policy">Policy</SelectItem>
                <SelectItem value="procedure">Procedure</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
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

export default function DocTrackPage() {
  const { activeClientId } = useAuth();
  const { toast } = useToast();

  const [docs, setDocs] = useState<Doc[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Doc | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/doc-track/documents");
      if (res.ok) setDocs(await res.json());
    } finally {
      setLoading(false);
    }
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId) return;
    load();
    apiFetch("/sites").then(r => r.ok ? r.json() : []).then(setSites);
  }, [activeClientId, load]);

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

  return (
    <AppLayout title="DocTrack">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 bg-cyan-50 rounded-lg">
              <FolderOpen className="w-5 h-5 text-cyan-600" />
            </div>
            <h1 className="text-2xl font-display font-bold text-foreground">DocTrack</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Document library — risk assessments, SOPs, policies &amp; more
          </p>
        </div>
        <Button onClick={() => setUploadOpen(true)} className="gap-1.5 self-start sm:self-auto">
          <Plus className="w-4 h-4" /> Upload Document
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        {/* Category tabs */}
        <div className="flex overflow-x-auto gap-1 pb-1 flex-shrink-0">
          {CATEGORY_TABS.map(tab => (
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
                ? "Upload your first risk assessment, SOP, or policy to get started."
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
            <DocCard key={doc.id} doc={doc} onDelete={setDeleteTarget} />
          ))}
        </div>
      )}

      {/* Upload dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={load}
        sites={sites}
      />

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
    </AppLayout>
  );
}
