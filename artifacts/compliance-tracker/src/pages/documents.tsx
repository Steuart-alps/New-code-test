import { useState, useEffect, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileText,
  Upload,
  Download,
  Trash2,
  MoreVertical,
  Search,
  Loader2,
} from "lucide-react";
import { API_BASE } from "@/lib/api";
import { downloadFile } from "@/lib/download";

interface Doc {
  id: number;
  clientId: number;
  name: string;
  description: string | null;
  objectPath: string;
  fileSize: number | null;
  mimeType: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fileIcon(mimeType: string | null) {
  if (!mimeType) return "📄";
  if (mimeType.includes("pdf")) return "📕";
  if (mimeType.includes("word") || mimeType.includes("document")) return "📘";
  if (mimeType.includes("sheet") || mimeType.includes("excel")) return "📗";
  if (mimeType.includes("image")) return "🖼️";
  return "📄";
}

// ── Upload dialog ─────────────────────────────────────────────────────────────

function UploadDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<"idle" | "presign" | "upload" | "register" | "done">("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setName("");
    setDescription("");
    setUploading(false);
    setProgress("idle");
    setError("");
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && !name) setName(f.name.replace(/\.[^.]+$/, ""));
  }

  async function handleSubmit() {
    if (!file || !name.trim()) return;
    setUploading(true);
    setError("");

    try {
      // 1. Get presigned upload URL
      setProgress("presign");
      const presignRes = await apiFetch("/storage/uploads/request-url", {
        method: "POST",
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        }),
      });
      if (!presignRes.ok) throw new Error("Failed to get upload URL");
      const { uploadURL, objectPath } = await presignRes.json();

      // 2. PUT directly to object storage
      setProgress("upload");
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error("File upload failed");

      // 3. Register in the DB
      setProgress("register");
      const regRes = await apiFetch("/documents", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          objectPath,
          fileSize: file.size,
          mimeType: file.type || null,
        }),
      });
      if (!regRes.ok) {
        const d = await regRes.json();
        throw new Error(d.error ?? "Failed to save document");
      }

      setProgress("done");
      onUploaded();
      reset();
      onClose();
    } catch (err: any) {
      setError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const progressLabel = {
    idle: "",
    presign: "Preparing upload…",
    upload: "Uploading file…",
    register: "Saving…",
    done: "Done",
  }[progress];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !uploading) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* File drop zone */}
          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
              ${file ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/30"}`}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg"
              onChange={handleFileChange}
            />
            {file ? (
              <div className="space-y-1">
                <p className="text-2xl">{fileIcon(file.type)}</p>
                <p className="font-medium text-sm">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="w-8 h-8 mx-auto text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">Click to choose a file</p>
                <p className="text-xs text-muted-foreground/60">PDF, Word, Excel, images supported</p>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Document name <span className="text-destructive">*</span></label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Health & Safety Policy 2025"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Description <span className="text-muted-foreground text-xs">(optional)</span></label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this document…"
              className="resize-none min-h-[72px]"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {uploading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {progressLabel}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!file || !name.trim() || uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canManage = user?.role === "consultant" || user?.role === "client_admin";

  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/documents");
      if (res.ok) setDocs(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = docs.filter(
    (d) =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      (d.description?.toLowerCase().includes(search.toLowerCase()) ?? false),
  );

  async function handleDelete(id: number) {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    setDeleting(id);
    try {
      const res = await apiFetch(`/documents/${id}`, { method: "DELETE" });
      if (res.ok) setDocs((prev) => prev.filter((d) => d.id !== id));
    } finally {
      setDeleting(null);
    }
  }

  async function handleDownload(doc: Doc) {
    try {
      await downloadFile(`${API_BASE}/documents/${doc.id}/download`, doc.name);
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  }

  return (
    <AppLayout title="Documents">
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={load}
      />

      <div className="space-y-6">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search documents…"
              className="pl-9"
            />
          </div>
          {canManage && (
            <Button onClick={() => setUploadOpen(true)} className="gap-2 w-full sm:w-auto">
              <Upload className="w-4 h-4" />
              Upload document
            </Button>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-24 border border-dashed border-border rounded-xl">
            <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground/40" />
            <h3 className="font-semibold text-lg mb-1">
              {docs.length === 0 ? "No documents yet" : "No results"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {docs.length === 0
                ? canManage
                  ? "Upload your policies and procedures to replace the shared folder."
                  : "No documents have been shared yet."
                : "Try a different search term."}
            </p>
            {docs.length === 0 && canManage && (
              <Button className="mt-5 gap-2" onClick={() => setUploadOpen(true)}>
                <Upload className="w-4 h-4" /> Upload first document
              </Button>
            )}
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground">Document</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden md:table-cell">Uploaded by</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden sm:table-cell">Date</th>
                  <th className="text-left px-5 py-3 text-sm font-medium text-muted-foreground hidden sm:table-cell">Size</th>
                  <th className="px-3 py-3 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((doc) => (
                  <tr key={doc.id} className="hover:bg-muted/20 transition-colors group">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <span className="text-xl flex-shrink-0">{fileIcon(doc.mimeType)}</span>
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{doc.name}</p>
                          {doc.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-[300px]">{doc.description}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-muted-foreground hidden md:table-cell">
                      {doc.uploadedByName ?? "—"}
                    </td>
                    <td className="px-5 py-4 text-sm text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                      {formatDate(doc.createdAt)}
                    </td>
                    <td className="px-5 py-4 text-sm text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                      {formatBytes(doc.fileSize)}
                    </td>
                    <td className="px-3 py-4">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleDownload(doc)}>
                            <Download className="w-4 h-4 mr-2" />
                            Download
                          </DropdownMenuItem>
                          {canManage && (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => handleDelete(doc.id)}
                              disabled={deleting === doc.id}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              {deleting === doc.id ? "Deleting…" : "Delete"}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
