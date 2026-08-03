import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListSites } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  Lock, Plus, Pencil, Trash2, Search, Wrench, AlertTriangle, CheckCircle2,
  Clock, Loader2, ImagePlus, X, ImageOff, Send, UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

// ── Constants ─────────────────────────────────────────────────────────────────

const ISSUE_TYPES: Record<string, { label: string; color: string }> = {
  electrical:    { label: "Electrical",    color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  plumbing:      { label: "Plumbing",      color: "bg-blue-100 text-blue-800 border-blue-200" },
  gas:           { label: "Gas",           color: "bg-orange-100 text-orange-800 border-orange-200" },
  structural:    { label: "Structural",    color: "bg-stone-100 text-stone-800 border-stone-200" },
  equipment:     { label: "Equipment",     color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  hvac:          { label: "HVAC",          color: "bg-sky-100 text-sky-800 border-sky-200" },
  it_comms:      { label: "IT / Comms",    color: "bg-violet-100 text-violet-800 border-violet-200" },
  safety_hazard: { label: "Safety Hazard", color: "bg-rose-100 text-rose-800 border-rose-200" },
  cleaning:      { label: "Cleaning",      color: "bg-teal-100 text-teal-800 border-teal-200" },
  general:       { label: "General",       color: "bg-slate-100 text-slate-800 border-slate-200" },
};

/** Default priority auto-applied when an issue type is selected. */
const AUTO_PRIORITY: Record<string, string> = {
  gas:           "urgent",
  safety_hazard: "urgent",
  electrical:    "high",
  structural:    "high",
  hvac:          "medium",
  plumbing:      "medium",
  equipment:     "medium",
  it_comms:      "low",
  cleaning:      "low",
  general:       "low",
};

const PRIORITIES: Record<string, { label: string; color: string }> = {
  low:    { label: "Low",    color: "bg-slate-100 text-slate-700 border-slate-200" },
  medium: { label: "Medium", color: "bg-blue-100 text-blue-700 border-blue-200" },
  high:   { label: "High",   color: "bg-amber-100 text-amber-700 border-amber-200" },
  urgent: { label: "Urgent", color: "bg-rose-100 text-rose-700 border-rose-200" },
};

const STATUSES: Record<string, { label: string; icon: any; color: string }> = {
  reported:    { label: "Reported",    icon: AlertTriangle, color: "bg-rose-50 text-rose-700 border-rose-200" },
  in_progress: { label: "In Progress", icon: Loader2,       color: "bg-amber-50 text-amber-700 border-amber-200" },
  resolved:    { label: "Resolved",    icon: CheckCircle2,  color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  closed:      { label: "Closed",      icon: Clock,         color: "bg-slate-50 text-slate-700 border-slate-200" },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContractorRecord {
  id: number;
  name: string;
  email: string;
  company?: string | null;
  trades?: string[];
}

interface Issue {
  id: number;
  title: string;
  issueType: string;
  location: string;
  description?: string | null;
  priority: string;
  status: string;
  reportedBy: string;
  reportedDate: string;
  assignedTo?: string | null;
  contractorId?: number | null;
  contractorName?: string | null;
  contractorEmail?: string | null;
  targetDate?: string | null;
  resolvedDate?: string | null;
  solutionNotes?: string | null;
  mediaUrls: string[];
  siteId?: number | null;
  siteName?: string | null;
  createdAt: string;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

function MediaThumb({ path, onRemove }: { path: string; onRemove?: () => void }) {
  const isVideo = /\.(mp4|mov|webm|avi)$/i.test(path);
  const src = `/api/storage/objects/${path}`;
  return (
    <div className="relative w-20 h-20 rounded-lg overflow-hidden border border-border bg-muted group flex-shrink-0">
      {isVideo
        ? <video src={src} className="w-full h-full object-cover" />
        : <img src={src} alt="" className="w-full h-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />}
      {onRemove && (
        <button type="button" onClick={onRemove}
          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ── IssueForm ─────────────────────────────────────────────────────────────────

function IssueForm({ form, setForm, issueId, isNew }: {
  form: Record<string, any>;
  setForm: (f: Record<string, any>) => void;
  issueId?: number;
  isNew?: boolean;
}) {
  const { data: sites = [] } = useListSites();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading]     = useState(false);
  const [contractors, setContractors] = useState<ContractorRecord[]>([]);

  useEffect(() => {
    apiFetch("/contractors")
      .then(r => r.ok ? r.json() : [])
      .then(setContractors)
      .catch(() => {});
  }, []);

  const mediaUrls: string[] = form.mediaUrls ?? [];

  function handleTypeChange(v: string) {
    const autoPri = AUTO_PRIORITY[v] ?? "medium";
    setForm({ ...form, issueType: v, priority: autoPri });
  }

  const matchingContractors = contractors.filter(c =>
    Array.isArray(c.trades) && c.trades.includes(form.issueType),
  );

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (!issueId) {
      toast({ title: "Save the issue first to attach media", variant: "destructive" });
      return;
    }
    setUploading(true);
    const newPaths: string[] = [];
    for (const file of files) {
      try {
        const res = await apiFetch(`/fix-track/issues/${issueId}/request-upload`, {
          method: "POST",
          body: JSON.stringify({ name: file.name, contentType: file.type }),
        });
        if (!res.ok) throw new Error("Could not get upload URL");
        const { uploadUrl, objectPath } = await res.json();
        const up = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
        if (!up.ok) throw new Error("Upload failed");
        newPaths.push(objectPath);
      } catch (err: any) {
        toast({ title: "Upload failed", description: err?.message, variant: "destructive" });
      }
    }
    setForm({ ...form, mediaUrls: [...mediaUrls, ...newPaths] });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeMedia(path: string) {
    setForm({ ...form, mediaUrls: mediaUrls.filter(p => p !== path) });
  }

  return (
    <div className="space-y-4">
      <F label="Title *">
        <Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })}
          placeholder="e.g. Leaking pipe in kitchen, Broken window latch" autoFocus />
      </F>

      <div className="grid grid-cols-2 gap-4">
        <F label="Issue Type *">
          <Select value={form.issueType ?? "general"} onValueChange={handleTypeChange}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(ISSUE_TYPES).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </F>
        <F label="Priority *">
          <Select value={form.priority ?? "medium"} onValueChange={v => setForm({ ...form, priority: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(PRIORITIES).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isNew && (
            <p className="text-xs text-muted-foreground">
              Auto-set from issue type
            </p>
          )}
        </F>
      </div>

      <F label="Location *">
        <Input value={form.location ?? ""} onChange={e => setForm({ ...form, location: e.target.value })}
          placeholder="e.g. Kitchen, Room 12, Ground Floor Corridor" />
      </F>

      <F label="Description">
        <Textarea value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })}
          rows={3} placeholder="Describe the issue in detail…" />
      </F>

      <div className="grid grid-cols-2 gap-4">
        <F label="Reported By *">
          <Input value={form.reportedBy ?? ""} onChange={e => setForm({ ...form, reportedBy: e.target.value })}
            placeholder="Staff name" />
        </F>
        <F label="Reported Date *">
          <Input type="date" value={form.reportedDate ?? ""} onChange={e => setForm({ ...form, reportedDate: e.target.value })} />
        </F>
      </div>

      {/* Contractor picker */}
      <F label="Contractor">
        <Select
          value={form.contractorId ? String(form.contractorId) : "__none__"}
          onValueChange={v => setForm({ ...form, contractorId: v === "__none__" ? null : Number(v) })}
        >
          <SelectTrigger><SelectValue placeholder="No contractor assigned" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">No contractor</SelectItem>
            {matchingContractors.length > 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground font-medium">
                Matching {ISSUE_TYPES[form.issueType]?.label ?? "this type"}
              </div>
            )}
            {matchingContractors.map(c => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}{c.company ? ` (${c.company})` : ""}
              </SelectItem>
            ))}
            {matchingContractors.length > 0 && contractors.length > matchingContractors.length && (
              <div className="px-2 py-1 text-xs text-muted-foreground font-medium border-t mt-1 pt-1">Other contractors</div>
            )}
            {contractors
              .filter(c => !matchingContractors.includes(c))
              .map(c => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}{c.company ? ` (${c.company})` : ""}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {form.issueType && matchingContractors.length === 0 && contractors.length > 0 && (
          <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
            <AlertTriangle className="w-3 h-3" />
            No contractor set up for {ISSUE_TYPES[form.issueType]?.label ?? "this type"} — add trades in Contractors
          </p>
        )}
      </F>

      <div className="grid grid-cols-2 gap-4">
        <F label="Assigned To (internal)">
          <Input value={form.assignedTo ?? ""} onChange={e => setForm({ ...form, assignedTo: e.target.value })}
            placeholder="Internal person responsible" />
        </F>
        <F label="Target Date">
          <Input type="date" value={form.targetDate ?? ""} onChange={e => setForm({ ...form, targetDate: e.target.value })} />
        </F>
      </div>

      <F label="Status">
        <Select value={form.status ?? "reported"} onValueChange={v => setForm({ ...form, status: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUSES).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </F>

      <div className="grid grid-cols-2 gap-4">
        <F label="Resolved Date">
          <Input type="date" value={form.resolvedDate ?? ""} onChange={e => setForm({ ...form, resolvedDate: e.target.value })} />
        </F>
        <F label="Site">
          <Select value={form.siteId ? String(form.siteId) : "__none__"} onValueChange={v => setForm({ ...form, siteId: v === "__none__" ? null : Number(v) })}>
            <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No specific site</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </F>
      </div>

      <F label="Solution / Resolution Notes">
        <Textarea value={form.solutionNotes ?? ""} onChange={e => setForm({ ...form, solutionNotes: e.target.value })}
          rows={2} placeholder="What was done to resolve the issue…" />
      </F>

      {/* Media attachments */}
      <div className="space-y-2">
        <Label>Photos / Videos</Label>
        {!issueId && (
          <p className="text-xs text-muted-foreground">Create the issue first, then re-open it to attach photos and videos.</p>
        )}
        {mediaUrls.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {mediaUrls.map(path => (
              <MediaThumb key={path} path={path} onRemove={() => removeMedia(path)} />
            ))}
          </div>
        )}
        {issueId && (
          <div>
            <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={handleFileChange} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}
              disabled={uploading} className="gap-1.5">
              {uploading
                ? <div className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                : <ImagePlus className="w-3.5 h-3.5" />}
              {uploading ? "Uploading…" : "Attach Photo / Video"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FixTrackPage() {
  const { hasService, user } = useAuth();
  const canAdmin = useCanAdmin();
  const hasFixtrack = hasService("fixtrack");
  const { toast } = useToast();

  const [issues, setIssues]               = useState<Issue[]>([]);
  const [loading, setLoading]             = useState(true);
  const [search, setSearch]               = useState("");
  const [filterStatus, setFilterStatus]   = useState("");
  const [filterType, setFilterType]       = useState("");
  const [filterPriority, setFilterPriority] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing]       = useState<Issue | null>(null);
  const [form, setForm]             = useState<Record<string, any>>({});
  const [saving, setSaving]         = useState(false);
  const [notifying, setNotifying]   = useState<Record<number, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch("/fix-track/issues");
      if (res.ok) setIssues(await res.json());
    } finally { setLoading(false); }
  }

  useEffect(() => { if (hasFixtrack) load(); }, [hasFixtrack]);

  function openCreate() {
    const today = new Date().toISOString().slice(0, 10);
    setEditing(null);
    setForm({
      issueType:    "general",
      priority:     AUTO_PRIORITY["general"] ?? "low",
      status:       "reported",
      reportedDate: today,
      reportedBy:   user?.name ?? "",
      mediaUrls:    [],
    });
    setDialogOpen(true);
  }

  function openEdit(issue: Issue) {
    setEditing(issue);
    setForm({ ...issue });
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Record<string, any> = {
        ...form,
        siteId:        form.siteId        || null,
        contractorId:  form.contractorId  ? Number(form.contractorId) : null,
        assignedTo:    form.assignedTo    || null,
        targetDate:    form.targetDate    || null,
        resolvedDate:  form.resolvedDate  || null,
        description:   form.description   || null,
        solutionNotes: form.solutionNotes || null,
      };
      // Strip server-only / display fields
      delete payload.siteName;
      delete payload.contractorName;
      delete payload.contractorEmail;
      delete payload.createdAt;
      delete payload.updatedAt;
      delete payload.createdBy;

      if (editing) {
        const res = await apiFetch(`/fix-track/issues/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      } else {
        const res = await apiFetch("/fix-track/issues", { method: "POST", body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json()).error ?? "Create failed");
        const created = await res.json();
        setEditing(created);
        setForm({ ...created });
        await load();
        setSaving(false);
        return; // keep dialog open so media can be attached
      }
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this issue report?")) return;
    await apiFetch(`/fix-track/issues/${id}`, { method: "DELETE" });
    await load();
    toast({ title: "Issue deleted" });
  }

  async function quickStatus(issue: Issue, newStatus: string) {
    await apiFetch(`/fix-track/issues/${issue.id}`, {
      method: "PUT",
      body: JSON.stringify({
        status: newStatus,
        resolvedDate: (newStatus === "resolved" || newStatus === "closed")
          ? new Date().toISOString().slice(0, 10) : issue.resolvedDate,
      }),
    });
    await load();
  }

  async function handleNotify(issue: Issue) {
    setNotifying(n => ({ ...n, [issue.id]: true }));
    try {
      const res = await apiFetch(`/fix-track/issues/${issue.id}/send-to-contractor`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to send");
      toast({ title: "Email sent", description: `Contractor notified for "${issue.title}"` });
    } catch (err: any) {
      toast({ title: "Could not send email", description: err.message, variant: "destructive" });
    } finally {
      setNotifying(n => ({ ...n, [issue.id]: false }));
    }
  }

  if (!hasFixtrack) {
    return (
      <AppLayout title="FixTrack — Maintenance Issues">
        <div className="max-w-2xl mx-auto mt-12">
          <div className="border-2 border-primary/20 bg-primary/5 rounded-xl p-8 text-center space-y-6">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h2 className="text-2xl font-display font-medium mb-2">FixTrack</h2>
              <p className="text-muted-foreground mb-1">Staff maintenance issue reporting — log faults, attach photos, track resolution.</p>
              <p className="font-medium text-primary">£10 per site per month</p>
            </div>
            {canAdmin && (
              <Link href="/settings">
                <Button size="lg" className="w-full sm:w-auto font-medium">Enable FixTrack</Button>
              </Link>
            )}
          </div>
        </div>
      </AppLayout>
    );
  }

  const q = search.trim().toLowerCase();
  const filtered = issues.filter(i => {
    if (filterStatus   && i.status    !== filterStatus)   return false;
    if (filterType     && i.issueType !== filterType)     return false;
    if (filterPriority && i.priority  !== filterPriority) return false;
    if (q && ![i.title, i.location, i.reportedBy, i.description, i.assignedTo, i.contractorName]
      .some(v => v?.toLowerCase().includes(q))) return false;
    return true;
  });

  const openCount   = issues.filter(i => i.status === "reported" || i.status === "in_progress").length;
  const urgentCount = issues.filter(i => i.priority === "urgent" && (i.status === "reported" || i.status === "in_progress")).length;

  return (
    <AppLayout title="FixTrack — Maintenance Issues">
      <div className="space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <Wrench className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">Report and track maintenance issues across your sites</p>
          </div>
          <Button onClick={openCreate} className="shadow-lg shadow-primary/20 gap-1.5 w-full sm:w-auto">
            <Plus className="w-4 h-4" /> Report Issue
          </Button>
        </div>

        {/* Summary pills */}
        {issues.length > 0 && (
          <div className="flex flex-wrap gap-3">
            <div className={cn("px-3 py-1.5 rounded-full text-xs font-medium border",
              openCount > 0 ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-emerald-50 text-emerald-700 border-emerald-200")}>
              {openCount} open issue{openCount !== 1 ? "s" : ""}
            </div>
            {urgentCount > 0 && (
              <div className="px-3 py-1.5 rounded-full text-xs font-medium border bg-rose-50 text-rose-700 border-rose-200">
                <AlertTriangle className="w-3 h-3 inline mr-1" />{urgentCount} urgent
              </div>
            )}
            <div className="px-3 py-1.5 rounded-full text-xs font-medium border bg-muted text-muted-foreground">
              {issues.length} total
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search issues…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-card" />
          </div>
          <Select value={filterStatus || "all"} onValueChange={v => setFilterStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="bg-card"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(STATUSES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterType || "all"} onValueChange={v => setFilterType(v === "all" ? "" : v)}>
            <SelectTrigger className="bg-card"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {Object.entries(ISSUE_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterPriority || "all"} onValueChange={v => setFilterPriority(v === "all" ? "" : v)}>
            <SelectTrigger className="bg-card"><SelectValue placeholder="All priorities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              {Object.entries(PRIORITIES).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Issue list */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
            <Wrench className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium mb-1">{issues.length === 0 ? "No issues reported yet" : "No issues match your filters"}</p>
            {issues.length === 0 && <p className="text-xs">Click 'Report Issue' to log your first maintenance fault.</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(issue => {
              const statusMeta   = STATUSES[issue.status]    ?? STATUSES.reported;
              const StatusIcon   = statusMeta.icon;
              const typeMeta     = ISSUE_TYPES[issue.issueType] ?? ISSUE_TYPES.general;
              const priorityMeta = PRIORITIES[issue.priority]   ?? PRIORITIES.medium;
              const isOpen       = issue.status === "reported" || issue.status === "in_progress";

              return (
                <div key={issue.id} className={cn(
                  "bg-card border rounded-xl p-4 transition-shadow hover:shadow-md",
                  issue.priority === "urgent" && isOpen ? "border-l-4 border-l-rose-500" : "border-border",
                )}>
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="font-semibold text-sm">{issue.title}</div>
                      <div className="flex flex-wrap gap-1.5">
                        <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border font-medium", statusMeta.color)}>
                          <StatusIcon className="w-3 h-3" /> {statusMeta.label}
                        </span>
                        <span className={cn("text-xs px-2 py-0.5 rounded-md border font-medium", typeMeta.color)}>{typeMeta.label}</span>
                        <span className={cn("text-xs px-2 py-0.5 rounded-md border font-medium", priorityMeta.color)}>{priorityMeta.label}</span>
                        {issue.siteName && <span className="text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground">{issue.siteName}</span>}
                      </div>
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        <div><span className="font-medium">Location:</span> {issue.location}</div>
                        {issue.description && <div className="line-clamp-2">{issue.description}</div>}
                        <div className="flex flex-wrap gap-3 mt-1">
                          <span>Reported by <span className="font-medium">{issue.reportedBy}</span> on {format(new Date(issue.reportedDate), "dd/MM/yyyy")}</span>
                          {issue.contractorName && (
                            <span className="flex items-center gap-1">
                              <UserCog className="w-3 h-3" />
                              <span className="font-medium">{issue.contractorName}</span>
                            </span>
                          )}
                          {issue.assignedTo && <span>Assigned: <span className="font-medium">{issue.assignedTo}</span></span>}
                          {issue.targetDate && <span>Target: {format(new Date(issue.targetDate), "dd/MM/yyyy")}</span>}
                          {issue.resolvedDate && <span>Resolved: {format(new Date(issue.resolvedDate), "dd/MM/yyyy")}</span>}
                        </div>
                        {issue.solutionNotes && (
                          <div className="mt-1 p-2 bg-emerald-50 rounded text-emerald-800 line-clamp-2">
                            <span className="font-medium">Resolution: </span>{issue.solutionNotes}
                          </div>
                        )}
                      </div>

                      {issue.mediaUrls?.length > 0 && (
                        <div className="flex gap-2 flex-wrap pt-1">
                          {issue.mediaUrls.map(path => <MediaThumb key={path} path={path} />)}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      {issue.status === "reported" && (
                        <Button variant="outline" size="sm" onClick={() => quickStatus(issue, "in_progress")}
                          className="text-xs h-7 px-2 whitespace-nowrap">Start</Button>
                      )}
                      {issue.status === "in_progress" && (
                        <Button variant="outline" size="sm" onClick={() => quickStatus(issue, "resolved")}
                          className="text-xs h-7 px-2 whitespace-nowrap text-emerald-700 border-emerald-300 hover:bg-emerald-50">Resolve</Button>
                      )}
                      {issue.status === "resolved" && (
                        <Button variant="outline" size="sm" onClick={() => quickStatus(issue, "closed")}
                          className="text-xs h-7 px-2 whitespace-nowrap">Close</Button>
                      )}

                      {/* Notify contractor */}
                      {issue.contractorId && canAdmin && (
                        <Button
                          variant="outline" size="sm"
                          onClick={() => handleNotify(issue)}
                          disabled={notifying[issue.id]}
                          className="text-xs h-7 px-2 whitespace-nowrap text-blue-700 border-blue-300 hover:bg-blue-50 gap-1"
                          title={`Notify ${issue.contractorName ?? "contractor"}`}
                        >
                          {notifying[issue.id]
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Send className="w-3 h-3" />}
                          Notify
                        </Button>
                      )}

                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(issue)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      {canAdmin && (
                        <Button variant="ghost" size="icon"
                          className="h-7 w-7 text-destructive hover:bg-destructive/10"
                          onClick={() => handleDelete(issue.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">{editing ? "Edit Issue" : "Report Maintenance Issue"}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <IssueForm form={form} setForm={setForm} issueId={editing?.id} isNew={!editing} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} type="button">
              {editing ? "Close" : "Cancel"}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save Changes" : "Create Issue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
