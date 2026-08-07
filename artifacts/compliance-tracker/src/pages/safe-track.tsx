import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListSites } from "@workspace/api-client-react";
import {
  Plus, Pencil, Trash2, Search, FileText, ClipboardList, BookMarked,
  Upload, Download, X, Users, CheckCircle2, Clock, Loader2, CheckSquare,
} from "lucide-react";
import { SignaturePad } from "@/components/signature-pad";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileAttachment {
  objectPath?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
}

interface RiskAssessment extends FileAttachment {
  id: number; title: string; description?: string | null; assessedBy?: string | null;
  reviewDate?: string | null; status: string; version: string; siteId?: number | null;
  requiresAcknowledgement: boolean; createdAt: string;
}
interface Sop extends FileAttachment {
  id: number; title: string; scope?: string | null; content?: string | null;
  version: string; publishedAt?: string | null; siteId?: number | null;
  requiresAcknowledgement: boolean; createdAt: string;
}
interface Handbook extends FileAttachment {
  id: number; title: string; section?: string | null; content?: string | null;
  version: string; publishedAt?: string | null; siteId?: number | null;
  requiresAcknowledgement: boolean; createdAt: string;
}

interface StaffMember {
  id: number; name: string; job_title?: string | null; department?: string | null;
  site_id?: number | null; active: boolean;
}

interface Ack {
  id: number; staff_roster_id: number; staff_name: string;
  signature: string | null; acknowledged_at: string;
}

const RA_STATUS_COLORS: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  under_review: "bg-blue-100 text-blue-800",
};

// ── Acknowledgements dialog ───────────────────────────────────────────────────

function AcknowledgementsDialog({
  docId, docTitle, sub, open, onClose,
}: { docId: number; docTitle: string; sub: string; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [acks, setAcks] = useState<Ack[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [sigs, setSigs] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [deptFilter, setDeptFilter] = useState("all");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setDeptFilter("all");
    setChecked({});
    setSigs({});
    Promise.all([
      apiFetch("/staff-roster").then(r => r.ok ? r.json() : []),
      apiFetch(`/safe-track/${sub}/${docId}/acknowledgements`).then(r => r.ok ? r.json() : []),
    ]).then(([s, a]) => {
      setStaff((s as StaffMember[]).filter((m: StaffMember) => m.active !== false));
      setAcks(a);
    }).finally(() => setLoading(false));
  }, [open, docId, sub]);

  const ackedIds = new Set(acks.map(a => a.staff_roster_id));
  const ackedMap = Object.fromEntries(acks.map(a => [a.staff_roster_id, a]));

  const departments = ["all", ...Array.from(new Set(staff.map(s => s.department).filter(Boolean) as string[])).sort()];
  const visibleStaff = deptFilter === "all" ? staff : staff.filter(s => s.department === deptFilter);
  const unacked = visibleStaff.filter(s => !ackedIds.has(s.id));
  const acked   = visibleStaff.filter(s =>  ackedIds.has(s.id));
  const totalAcked = staff.filter(s => ackedIds.has(s.id)).length;
  const anyChecked = Object.values(checked).some(Boolean);

  function toggleAll() {
    if (unacked.every(s => checked[s.id])) {
      const cleared = { ...checked };
      unacked.forEach(s => { delete cleared[s.id]; });
      setChecked(cleared);
    } else {
      setChecked(prev => ({ ...prev, ...Object.fromEntries(unacked.map(s => [s.id, true])) }));
    }
  }

  async function handleSave() {
    const toSave = staff.filter(s => checked[s.id] && !ackedIds.has(s.id));
    if (!toSave.length) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/safe-track/${sub}/${docId}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({
          acknowledgements: toSave.map(s => ({
            staffRosterId: s.id,
            staffName: s.name,
            signature: sigs[s.id]?.trim() || null,
          })),
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      const data = await res.json();
      toast({ title: `${data.created} acknowledgement${data.created === 1 ? "" : "s"} recorded` });
      const fresh = await apiFetch(`/safe-track/${sub}/${docId}/acknowledgements`);
      if (fresh.ok) setAcks(await fresh.json());
      setChecked({});
      setSigs({});
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4" /> Acknowledgements — {docTitle}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : staff.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No staff in roster</p>
            <p className="text-sm mt-1">Add staff in <strong>Staff Roster</strong> before recording acknowledgements.</p>
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
                          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.name}</p>
                            {(s.job_title || s.department) && (
                              <p className="text-xs text-muted-foreground">{[s.job_title, s.department].filter(Boolean).join(" · ")}</p>
                            )}
                            {a?.signature && <p className="text-xs text-muted-foreground italic">Signed: {a.signature}</p>}
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

              {unacked.length === 0 && acked.length > 0 && deptFilter === "all" && (
                <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
                  <CheckCircle2 className="w-4 h-4" /> All staff have acknowledged this document
                </div>
              )}
            </div>
          </>
        )}

        <DialogFooter className="pt-3 border-t mt-2 gap-2 sm:gap-0">
          <span className="text-xs text-muted-foreground mr-auto self-center">
            {totalAcked} / {staff.length} staff acknowledged
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

// ── File upload field ─────────────────────────────────────────────────────────

function FileUploadField({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const urlRes = await apiFetch("/safe-track/request-upload", { method: "POST" });
      if (!urlRes.ok) throw new Error("Could not get upload URL");
      const { uploadUrl, objectPath } = await urlRes.json();
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload failed");
      setForm({ ...form, objectPath, fileName: file.name, fileSize: file.size, mimeType: file.type || "application/octet-stream" });
      toast({ title: "Document attached", description: file.name });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>Attached Document</Label>
      <input ref={inputRef} type="file" className="hidden" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
      {form.fileName ? (
        <div className="flex items-center gap-2 p-2 rounded-md border border-border bg-muted/30 text-sm">
          <FileText className="w-4 h-4 text-primary shrink-0" />
          <span className="flex-1 truncate text-xs">{form.fileName}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setForm({ ...form, objectPath: null, fileName: null, fileSize: null, mimeType: null })}>
            <X className="w-3 h-3" />
          </Button>
          <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => inputRef.current?.click()} disabled={uploading}>Replace</Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading} className="w-full justify-start gap-2">
          <Upload className="w-3.5 h-3.5" />
          {uploading ? "Uploading…" : "Attach Document (PDF, Word, etc.)"}
        </Button>
      )}
    </div>
  );
}

// ── Generic list table ────────────────────────────────────────────────────────

function ListTable({ headers, rows, onEdit, onDelete, onDownload, onAcknowledgements, canAdmin }: {
  headers: string[];
  rows: { id: number; cells: React.ReactNode[]; hasFile?: boolean; requiresAcknowledgement?: boolean }[];
  onEdit?: (id: number) => void;
  onDelete: (id: number) => void;
  onDownload?: (id: number) => void;
  onAcknowledgements?: (id: number) => void;
  canAdmin: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full">
        <thead className="bg-muted/50">
          <tr>
            {headers.map(h => <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">{h}</th>)}
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(r => (
            <tr key={r.id} className="hover:bg-muted/30 transition-colors">
              {r.cells.map((c, i) => <td key={i} className="px-4 py-3 text-sm">{c}</td>)}
              <td className="px-4 py-3">
                <div className="flex gap-1 justify-end">
                  {r.requiresAcknowledgement && onAcknowledgements && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600" title="Staff acknowledgements" onClick={() => onAcknowledgements(r.id)}>
                      <Users className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {r.hasFile && onDownload && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title="Download file" onClick={() => onDownload(r.id)}>
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {canAdmin && onEdit && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(r.id)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {canAdmin && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => onDelete(r.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Shared site picker ────────────────────────────────────────────────────────

function SiteSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: sites = [] } = useListSites();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">All sites (no assignment)</SelectItem>
        {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SafeTrackPage() {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { data: sites = [] } = useListSites();
  const { toast } = useToast();

  const [tab, setTab] = useState("risk");
  const [search, setSearch] = useState("");

  const [ras, setRas] = useState<RiskAssessment[]>([]);
  const [sops, setSops] = useState<Sop[]>([]);
  const [handbook, setHandbook] = useState<Handbook[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  // Acknowledgements dialog
  const [ackTarget, setAckTarget] = useState<{ id: number; title: string; sub: string } | null>(null);

  const base = "/safe-track";

  async function load() {
    setLoading(true);
    try {
      const [r1, r2, r3] = await Promise.all([
        apiFetch(`${base}/risk-assessments`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/sops`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/handbook`).then(r => r.ok ? r.json() : []),
      ]);
      setRas(r1); setSops(r2); setHandbook(r3);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [activeClientId]);

  function siteName(id?: number | null) {
    if (!id) return null;
    return sites.find(s => s.id === id)?.name ?? null;
  }

  function openCreate() { setEditing(null); setForm({}); setDialogOpen(true); }
  function openEdit(item: any) {
    setEditing(item);
    setForm({ ...item, siteId: item.siteId ? String(item.siteId) : "__none__" });
    setDialogOpen(true);
  }

  async function handleDelete(sub: string, id: number) {
    if (!confirm("Delete this record?")) return;
    await apiFetch(`${base}/${sub}/${id}`, { method: "DELETE" });
    load();
  }

  async function handleDownload(sub: string, id: number) {
    try {
      const res = await apiFetch(`${base}/${sub}/${id}/download-url`);
      if (!res.ok) throw new Error("Could not get download link");
      const { downloadUrl, fileName } = await res.json();
      const a = document.createElement("a");
      a.href = downloadUrl; a.download = fileName ?? "document"; a.target = "_blank";
      a.click();
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    }
  }

  async function handleSave(sub: string) {
    setSaving(true);
    const payload = { ...form, siteId: form.siteId && form.siteId !== "__none__" ? Number(form.siteId) : null };
    delete payload.id; delete payload.clientId; delete payload.createdBy;
    delete payload.createdAt; delete payload.updatedAt;
    try {
      if (editing) {
        await apiFetch(`${base}/${sub}/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch(`${base}/${sub}`, { method: "POST", body: JSON.stringify(payload) });
      }
      setDialogOpen(false);
      load();
    } finally { setSaving(false); }
  }

  const q = search.trim().toLowerCase();

  // ── Risk Assessments tab ──────────────────────────────────────────────────
  const raRows = ras
    .filter(r => !q || [r.title, r.assessedBy, r.status].some(v => v?.toLowerCase().includes(q)))
    .map(r => ({
      id: r.id,
      hasFile: !!r.objectPath,
      requiresAcknowledgement: r.requiresAcknowledgement,
      cells: [
        <div className="flex items-center gap-2">
          <span className="font-medium">{r.title}</span>
          {r.requiresAcknowledgement && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200 font-medium">
              <Users className="w-2.5 h-2.5" /> Req. reading
            </span>
          )}
        </div>,
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${RA_STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-700"}`}>{r.status.replace("_", " ")}</span>,
        <span className="text-muted-foreground">{r.assessedBy ?? "—"}</span>,
        <span className="text-muted-foreground">{r.reviewDate ?? "—"}</span>,
        <span className="text-muted-foreground">{siteName(r.siteId) ?? "All sites"}</span>,
      ],
    }));

  // ── SOPs tab ─────────────────────────────────────────────────────────────
  const sopRows = sops
    .filter(s => !q || [s.title, s.scope].some(v => v?.toLowerCase().includes(q)))
    .map(s => ({
      id: s.id,
      hasFile: !!s.objectPath,
      requiresAcknowledgement: s.requiresAcknowledgement,
      cells: [
        <div className="flex items-center gap-2">
          <span className="font-medium">{s.title}</span>
          {s.requiresAcknowledgement && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200 font-medium">
              <Users className="w-2.5 h-2.5" /> Req. reading
            </span>
          )}
        </div>,
        s.publishedAt ? <Badge className="bg-emerald-100 text-emerald-800 text-xs font-normal">Published</Badge> : <Badge variant="secondary" className="text-xs font-normal">Draft</Badge>,
        <span className="text-muted-foreground">v{s.version}</span>,
        <span className="text-muted-foreground">{s.scope ? s.scope.slice(0, 60) + (s.scope.length > 60 ? "…" : "") : "—"}</span>,
        <span className="text-muted-foreground">{siteName(s.siteId) ?? "All sites"}</span>,
      ],
    }));

  // ── Staff Handbook tab ────────────────────────────────────────────────────
  const handbookRows = handbook
    .filter(h => !q || [h.title, h.section].some(v => v?.toLowerCase().includes(q)))
    .map(h => ({
      id: h.id,
      hasFile: !!h.objectPath,
      requiresAcknowledgement: h.requiresAcknowledgement,
      cells: [
        <div className="flex items-center gap-2">
          <span className="font-medium">{h.title}</span>
          {h.requiresAcknowledgement && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200 font-medium">
              <Users className="w-2.5 h-2.5" /> Req. reading
            </span>
          )}
        </div>,
        h.publishedAt ? <Badge className="bg-emerald-100 text-emerald-800 text-xs font-normal">Published</Badge> : <Badge variant="secondary" className="text-xs font-normal">Draft</Badge>,
        <span className="text-muted-foreground">v{h.version}</span>,
        <span className="text-muted-foreground">{h.section ?? "—"}</span>,
        <span className="text-muted-foreground">{siteName(h.siteId) ?? "All sites"}</span>,
      ],
    }));

  const tabConfig = {
    risk:     { label: "Risk Assessments", singularLabel: "Risk Assessment",  icon: FileText,      sub: "risk-assessments", headers: ["Title", "Status", "Assessed By", "Review Date", "Site"], rows: raRows },
    sops:     { label: "SOPs",             singularLabel: "SOP",              icon: ClipboardList, sub: "sops",             headers: ["Title", "Status", "Version", "Scope", "Site"],            rows: sopRows },
    handbook: { label: "Staff Handbook",   singularLabel: "Handbook Entry",   icon: BookMarked,    sub: "handbook",         headers: ["Title", "Status", "Version", "Section", "Site"],          rows: handbookRows },
  } as const;

  type TabKey = keyof typeof tabConfig;
  const currentTab = tabConfig[tab as TabKey];

  function openAck(id: number, title: string) {
    setAckTarget({ id, title, sub: currentTab.sub });
  }

  return (
    <AppLayout title="SafeTrack">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">Risk assessments and standard operating procedures.</p>
        {canAdmin && (
          <Button onClick={openCreate} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
            <Plus className="w-4 h-4 mr-2" /> Add Record
          </Button>
        )}
      </div>

      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-card" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex-wrap h-auto gap-1">
          {Object.entries(tabConfig).map(([key, cfg]) => (
            <TabsTrigger key={key} value={key} className="gap-1.5 text-xs">
              <cfg.icon className="w-3.5 h-3.5" />{cfg.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {Object.keys(tabConfig).map(key => {
          const cfg = tabConfig[key as TabKey];
          return (
            <TabsContent key={key} value={key}>
              {loading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
                </div>
              ) : cfg.rows.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
                  <cfg.icon className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  No {cfg.label.toLowerCase()} yet.{canAdmin && " Click 'Add Record' to create one."}
                </div>
              ) : (
                <ListTable
                  headers={cfg.headers as unknown as string[]}
                  rows={cfg.rows}
                  onEdit={canAdmin ? id => openEdit((tab === "risk" ? ras : tab === "sops" ? sops : handbook).find((r: any) => r.id === id)) : undefined}
                  onDelete={id => handleDelete(cfg.sub, id)}
                  onDownload={id => handleDownload(cfg.sub, id)}
                  onAcknowledgements={id => {
                    const item = (tab === "risk" ? ras : tab === "sops" ? sops : handbook).find((r: any) => r.id === id);
                    if (item) openAck(id, item.title);
                  }}
                  canAdmin={canAdmin}
                />
              )}
            </TabsContent>
          );
        })}
      </Tabs>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">
              {editing ? "Edit" : "Add"} {currentTab?.singularLabel}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {tab === "risk"     && <RaForm form={form} setForm={setForm} />}
            {tab === "sops"     && <SopForm form={form} setForm={setForm} />}
            {tab === "handbook" && <HandbookForm form={form} setForm={setForm} />}

            <div className="space-y-1.5">
              <Label>Site (optional)</Label>
              <SiteSelect value={form.siteId ?? "__none__"} onChange={v => setForm({ ...form, siteId: v })} />
            </div>

            {/* Required reading toggle */}
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="requires-ack"
                checked={!!form.requiresAcknowledgement}
                onCheckedChange={v => setForm({ ...form, requiresAcknowledgement: !!v })}
              />
              <Label htmlFor="requires-ack" className="cursor-pointer font-normal">
                Requires staff acknowledgement
              </Label>
            </div>
            {form.requiresAcknowledgement && (
              <p className="text-xs text-muted-foreground -mt-2 ml-6">
                A <Users className="inline w-3 h-3" /> button will appear in the list so you can track which staff have confirmed they've read this.
              </p>
            )}

            <FileUploadField form={form} setForm={setForm} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} type="button">Cancel</Button>
            <Button onClick={() => handleSave(currentTab.sub)} disabled={saving}>
              {editing ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Acknowledgements dialog */}
      {ackTarget && (
        <AcknowledgementsDialog
          docId={ackTarget.id}
          docTitle={ackTarget.title}
          sub={ackTarget.sub}
          open={!!ackTarget}
          onClose={() => setAckTarget(null)}
        />
      )}
    </AppLayout>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

function RaForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Title *"><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Manual Handling Assessment" autoFocus /></F>
    <F label="Description"><Textarea value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} /></F>
    <F label="Assessed By"><Input value={form.assessedBy ?? ""} onChange={e => setForm({ ...form, assessedBy: e.target.value })} placeholder="Name" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Review Date"><Input type="date" value={form.reviewDate ?? ""} onChange={e => setForm({ ...form, reviewDate: e.target.value })} /></F>
      <F label="Version"><Input value={form.version ?? "1.0"} onChange={e => setForm({ ...form, version: e.target.value })} placeholder="1.0" /></F>
    </div>
    <F label="Status">
      <Select value={form.status ?? "draft"} onValueChange={v => setForm({ ...form, status: v })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="draft">Draft</SelectItem>
          <SelectItem value="published">Published</SelectItem>
          <SelectItem value="under_review">Under Review</SelectItem>
        </SelectContent>
      </Select>
    </F>
    <SignaturePad label="Assessor Signature" value={form.signature ?? null} onChange={sig => setForm({ ...form, signature: sig })} />
  </>;
}

function SopForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Title *"><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Food Allergen Control Procedure" autoFocus /></F>
    <F label="Scope"><Input value={form.scope ?? ""} onChange={e => setForm({ ...form, scope: e.target.value })} placeholder="Who this applies to" /></F>
    <F label="Content"><Textarea value={form.content ?? ""} onChange={e => setForm({ ...form, content: e.target.value })} rows={6} placeholder="Step-by-step procedure…" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Version"><Input value={form.version ?? "1.0"} onChange={e => setForm({ ...form, version: e.target.value })} /></F>
      <F label="Published">
        <Select value={form.publishedAt ? "yes" : "no"} onValueChange={v => setForm({ ...form, publishedAt: v === "yes" ? new Date().toISOString() : null })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="no">Draft</SelectItem>
            <SelectItem value="yes">Published</SelectItem>
          </SelectContent>
        </Select>
      </F>
    </div>
    <SignaturePad label="Manager Signature" value={form.signature ?? null} onChange={sig => setForm({ ...form, signature: sig })} />
  </>;
}

function HandbookForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Title *"><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Health & Safety Policy" autoFocus /></F>
    <F label="Section"><Input value={form.section ?? ""} onChange={e => setForm({ ...form, section: e.target.value })} placeholder="e.g. Chapter 3 — Fire Safety" /></F>
    <F label="Content"><Textarea value={form.content ?? ""} onChange={e => setForm({ ...form, content: e.target.value })} rows={8} placeholder="Handbook content…" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Version"><Input value={form.version ?? "1.0"} onChange={e => setForm({ ...form, version: e.target.value })} /></F>
      <F label="Status">
        <Select value={form.publishedAt ? "yes" : "no"} onValueChange={v => setForm({ ...form, publishedAt: v === "yes" ? new Date().toISOString() : null })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="no">Draft</SelectItem>
            <SelectItem value="yes">Published</SelectItem>
          </SelectContent>
        </Select>
      </F>
    </div>
    <SignaturePad label="Staff Signature" value={form.signature ?? null} onChange={sig => setForm({ ...form, signature: sig })} />
  </>;
}
