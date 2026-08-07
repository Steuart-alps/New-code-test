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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Upload, FolderOpen, FileText, FileSpreadsheet, FileImage, FileVideo, File,
  Download, Trash2, Search, Plus, Loader2, Presentation, CheckSquare, Users,
  CheckCircle2, Clock, Link2, Copy, Check,
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
  requires_acknowledgement: boolean;
  department: string | null;
  site_name: string | null;
  created_at: string;
  updated_at: string;
}

interface StaffMember {
  id: number;
  name: string;
  job_title: string | null;
  department: string | null;
  active: boolean;
}

interface Acknowledgement {
  id: number;
  staff_roster_id: number;
  staff_name: string;
  signature: string | null;
  acknowledged_at: string;
}

interface Site {
  id: number;
  name: string;
}

type Category = "risk_assessment" | "sop" | "handbook" | "policy" | "procedure" | "other";

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_TABS = [
  { key: "all",             label: "All" },
  { key: "risk_assessment", label: "Risk Assessments" },
  { key: "sop",             label: "SOPs" },
  { key: "handbook",        label: "Handbooks" },
  { key: "policy",          label: "Policies" },
  { key: "procedure",       label: "Procedures" },
  { key: "other",           label: "Other" },
] as const;

const CATEGORY_META: Record<string, { label: string; color: string; bg: string }> = {
  risk_assessment: { label: "Risk Assessment", color: "text-red-700",    bg: "bg-red-50 border-red-200" },
  sop:             { label: "SOP",             color: "text-blue-700",   bg: "bg-blue-50 border-blue-200" },
  handbook:        { label: "Handbook",        color: "text-orange-700", bg: "bg-orange-50 border-orange-200" },
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

// ─── Acknowledgements Dialog ──────────────────────────────────────────────────

function AcknowledgementsDialog({ doc, open, onClose }: { doc: Doc; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [acks, setAcks] = useState<Acknowledgement[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [sigs, setSigs] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [deptFilter, setDeptFilter] = useState("all");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setDeptFilter("all");
    Promise.all([
      apiFetch("/staff-roster").then(r => r.ok ? r.json() : []),
      apiFetch(`/doc-track/documents/${doc.id}/acknowledgements`).then(r => r.ok ? r.json() : []),
    ]).then(([s, a]) => {
      setStaff(s);
      setAcks(a);
      setChecked({});
      setSigs({});
    }).finally(() => setLoading(false));
  }, [open, doc.id]);

  const ackedIds = new Set(acks.map((a: Acknowledgement) => a.staff_roster_id));
  const ackedMap = Object.fromEntries(acks.map(a => [a.staff_roster_id, a]));

  // Department filter
  const departments = ["all", ...Array.from(new Set(staff.map(s => s.department).filter(Boolean) as string[])).sort()];
  const visibleStaff = deptFilter === "all" ? staff : staff.filter(s => s.department === deptFilter);
  const unacked = visibleStaff.filter(s => !ackedIds.has(s.id));
  const acked   = visibleStaff.filter(s => ackedIds.has(s.id));

  // Counts across ALL staff (for the footer summary)
  const totalAcked = staff.filter(s => ackedIds.has(s.id)).length;

  const anyChecked = Object.values(checked).some(Boolean);

  async function handleSave() {
    const toSave = staff.filter(s => checked[s.id] && !ackedIds.has(s.id));
    if (!toSave.length) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/doc-track/documents/${doc.id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({
          acknowledgements: toSave.map(s => ({
            staffRosterId: s.id,
            staffName: s.name,
            signature: sigs[s.id]?.trim() || null,
          })),
        }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast({ title: `${data.created} acknowledgement${data.created === 1 ? "" : "s"} recorded`, description: "TrainTrack sign-off records created automatically." });
      const fresh = await apiFetch(`/doc-track/documents/${doc.id}/acknowledgements`);
      if (fresh.ok) setAcks(await fresh.json());
      setChecked({});
      setSigs({});
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function toggleAll() {
    if (unacked.every(s => checked[s.id])) {
      const cleared = { ...checked };
      unacked.forEach(s => { delete cleared[s.id]; });
      setChecked(cleared);
    } else {
      setChecked(prev => ({ ...prev, ...Object.fromEntries(unacked.map(s => [s.id, true])) }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4" /> Acknowledgements — {doc.title}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : staff.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No staff in roster</p>
            <p className="text-sm mt-1">Add staff members in <strong>Staff Roster</strong> before recording acknowledgements.</p>
          </div>
        ) : (
          <>
            {/* Department filter */}
            {departments.length > 2 && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {departments.map(d => (
                  <button
                    key={d}
                    onClick={() => { setDeptFilter(d); setChecked({}); }}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium transition-colors border",
                      deptFilter === d
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/40 text-muted-foreground border-border hover:bg-muted",
                    )}
                  >
                    {d === "all" ? "All departments" : d}
                    {d !== "all" && (
                      <span className="ml-1.5 opacity-60">
                        {staff.filter(s => s.department === d && ackedIds.has(s.id)).length}/
                        {staff.filter(s => s.department === d).length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Pending */}
              {unacked.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-muted-foreground">Pending ({unacked.length})</p>
                    <button onClick={toggleAll} className="text-xs text-primary hover:underline">
                      {unacked.every(s => checked[s.id]) ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {unacked.map(s => (
                      <div key={s.id} className={cn("border rounded-lg p-3 transition-colors", checked[s.id] ? "bg-primary/5 border-primary/30" : "")}>
                        <div className="flex items-center gap-3">
                          <Checkbox
                            checked={!!checked[s.id]}
                            onCheckedChange={v => setChecked(prev => ({ ...prev, [s.id]: !!v }))}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.name}</p>
                            {(s.job_title || s.department) && (
                              <p className="text-xs text-muted-foreground">{[s.job_title, s.department].filter(Boolean).join(" · ")}</p>
                            )}
                          </div>
                        </div>
                        {checked[s.id] && (
                          <div className="mt-2 ml-7">
                            <Input
                              placeholder="Signature (typed name) — optional"
                              value={sigs[s.id] ?? ""}
                              onChange={e => setSigs(prev => ({ ...prev, [s.id]: e.target.value }))}
                              className="h-8 text-sm"
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Acknowledged */}
              {acked.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">Acknowledged ({acked.length})</p>
                  <div className="space-y-1.5">
                    {acked.map(s => {
                      const a = ackedMap[s.id];
                      return (
                        <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-green-50 border border-green-100">
                          <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.name}</p>
                            {(s.job_title || s.department) && (
                              <p className="text-xs text-muted-foreground">{[s.job_title, s.department].filter(Boolean).join(" · ")}</p>
                            )}
                            {a?.signature && <p className="text-xs text-muted-foreground">Signed: {a.signature}</p>}
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(a.acknowledged_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {unacked.length === 0 && acked.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No staff in this department.</p>
              )}
            </div>
          </>
        )}

        <DialogFooter className="pt-3 border-t mt-2 gap-2 sm:gap-0">
          <span className="text-xs text-muted-foreground mr-auto">
            {totalAcked}/{staff.length} acknowledged overall · TrainTrack records created automatically
          </span>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          {unacked.length > 0 && (
            <Button onClick={handleSave} disabled={!anyChecked || saving}>
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Record Acknowledgements
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Document card ────────────────────────────────────────────────────────────

function DocCard({
  doc,
  onDelete,
  onAcknowledge,
}: {
  doc: Doc;
  onDelete: (doc: Doc) => void;
  onAcknowledge: (doc: Doc) => void;
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
          {doc.requires_acknowledgement && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
              <CheckSquare className="w-2.5 h-2.5" /> Ack. required
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
          {doc.requires_acknowledgement && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs gap-1 text-amber-700 border-amber-200 hover:bg-amber-50"
              onClick={() => onAcknowledge(doc)}
            >
              <Users className="w-3 h-3" /> Acknowledge
            </Button>
          )}
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
  existingDepts,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  sites: Site[];
  existingDepts: string[];
}) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("risk_assessment");
  const [description, setDescription] = useState("");
  const [siteId, setSiteId] = useState<string>("none");
  const [department, setDepartment] = useState("");
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<"idle" | "requesting" | "uploading" | "saving">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setTitle("");
    setCategory("risk_assessment");
    setDescription("");
    setSiteId("none");
    setDepartment("");
    setRequiresAcknowledgement(false);
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
          requiresAcknowledgement,
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
            <Select value={category} onValueChange={v => setCategory(v as Category)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="risk_assessment">Risk Assessment</SelectItem>
                <SelectItem value="sop">SOP (Standard Operating Procedure)</SelectItem>
                <SelectItem value="handbook">Staff Handbook</SelectItem>
                <SelectItem value="policy">Policy</SelectItem>
                <SelectItem value="procedure">Procedure</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Department */}
          <div className="space-y-1.5">
            <Label>Department <span className="text-muted-foreground text-xs">(optional — leave blank for all staff)</span></Label>
            <Input
              value={department}
              onChange={e => setDepartment(e.target.value)}
              placeholder="e.g. Kitchen, Front of House, All Staff"
              list="upload-dept-list"
            />
            <datalist id="upload-dept-list">
              {existingDepts.map(d => <option key={d} value={d} />)}
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
          <div className="flex items-center gap-3 pt-1">
            <Checkbox
              id="requires-ack"
              checked={requiresAcknowledgement}
              onCheckedChange={v => setRequiresAcknowledgement(!!v)}
            />
            <div>
              <Label htmlFor="requires-ack" className="cursor-pointer">Requires staff acknowledgement</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Staff must sign off that they have read this document. Creates TrainTrack records automatically.</p>
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
  const [ackDoc, setAckDoc] = useState<Doc | null>(null);
  const [outstandingOpen, setOutstandingOpen] = useState(false);
  const [signOffToken, setSignOffToken] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

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
    apiFetch("/doc-track/sign-off-info").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.token) setSignOffToken(d.token);
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
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Button variant="outline" onClick={() => setOutstandingOpen(true)} className="gap-1.5">
            <Users className="w-4 h-4" /> Outstanding
          </Button>
          <Button onClick={() => setUploadOpen(true)} className="gap-1.5">
            <Plus className="w-4 h-4" /> Upload Document
          </Button>
        </div>
      </div>

      {/* Staff self-sign link */}
      {signOffUrl && (
        <div className="flex items-center gap-3 mb-6 p-3.5 rounded-xl border bg-amber-50 border-amber-200">
          <Link2 className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900">Staff self-sign link</p>
            <p className="text-xs text-amber-700 truncate mt-0.5">{signOffUrl}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="flex-shrink-0 gap-1.5 border-amber-300 text-amber-800 hover:bg-amber-100 h-8"
            onClick={copySignOffLink}
          >
            {linkCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {linkCopied ? "Copied!" : "Copy link"}
          </Button>
        </div>
      )}

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
            <DocCard key={doc.id} doc={doc} onDelete={setDeleteTarget} onAcknowledge={setAckDoc} />
          ))}
        </div>
      )}

      {/* Upload dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={load}
        sites={sites}
        existingDepts={existingDepts}
      />

      {/* Acknowledgements dialog */}
      {ackDoc && (
        <AcknowledgementsDialog doc={ackDoc} open={!!ackDoc} onClose={() => setAckDoc(null)} />
      )}

      {/* Outstanding acknowledgements overview */}
      <OutstandingDialog open={outstandingOpen} onClose={() => setOutstandingOpen(false)} />

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

function escapeHtml(s: string | null | undefined) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function exportAckRegister(docs: OutstandingDoc[]) {
  const generated = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Document Acknowledgement Register</title>
<style>
  body { font-family: Georgia, serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 22px 0 6px; }
  .meta { font-size: 11px; color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-top: 4px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0ede2; font-weight: bold; }
  .out { color: #a15c00; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<h1>Document Acknowledgement Register</h1>
<div class="meta">Generated ${generated} — for audit purposes</div>
${docs.map(d => `
<h2>${escapeHtml(d.title)}${d.department ? ` <span class="meta">(${escapeHtml(d.department)})</span>` : ""}</h2>
<div class="meta">${d.acknowledgedCount}/${d.staffTotal} staff acknowledged</div>
<table>
<tr><th>Staff member</th><th>Status</th><th>Date</th><th>Signed</th></tr>
${d.acknowledged.map(a => `<tr><td>${escapeHtml(a.name)}</td><td>Acknowledged</td><td>${fmtDate(a.acknowledgedAt)}</td><td>${a.signed ? "Yes" : "—"}</td></tr>`).join("")}
${d.outstanding.map(s => `<tr class="out"><td>${escapeHtml(s.name)}</td><td>Outstanding</td><td></td><td></td></tr>`).join("")}
</table>`).join("")}
${docs.length === 0 ? `<p class="meta">No documents require acknowledgement.</p>` : ""}
</body></html>`;
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
  return true;
}

function OutstandingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<OutstandingDoc[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiFetch("/doc-track/acknowledgements/outstanding")
      .then(r => (r.ok ? r.json() : { documents: [] }))
      .then(d => setDocs(d.documents ?? []))
      .finally(() => setLoading(false));
  }, [open]);

  const withOutstanding = docs.filter(d => d.outstanding.length > 0);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-4 h-4" /> Outstanding acknowledgements
          </DialogTitle>
        </DialogHeader>
        {!loading && docs.length > 0 && (
          <Button variant="outline" size="sm" className="self-start gap-1.5"
            onClick={() => exportAckRegister(docs)}>
            <Download className="w-3.5 h-3.5" /> Export register (PDF / print)
          </Button>
        )}
        {loading ? (
          <div className="flex items-center justify-center h-24">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : docs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No documents require acknowledgement yet. Mark a document as &ldquo;Acknowledgement required&rdquo; when uploading to track staff sign-off here.
          </p>
        ) : withOutstanding.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-emerald-700">
            <Check className="w-4 h-4" /> All staff have acknowledged every required document.
          </div>
        ) : (
          <div className="space-y-4">
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
        )}
      </DialogContent>
    </Dialog>
  );
}
