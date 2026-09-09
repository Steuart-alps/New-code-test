import { useState, useEffect, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  ArrowLeft, CheckCircle2, AlertTriangle, Loader2, Clock,
  MapPin, User, FileText, Send, Camera, Wrench
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DrawnSignatureDialog } from "@/components/drawn-signature-dialog";

// ── Types & Constants ─────────────────────────────────────────────────────────

interface IssueNote {
  id: number;
  note: string;
  createdBy: string;
  createdAt: string;
  isLegacy?: boolean;
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
  resolvedByName?: string | null;
  resolverSignature?: string | null;
  solutionNotes?: string | null;
  completionDocumentPath?: string | null;
  emailRequestMode?: string | null;
  emailRequestStatus?: string | null;
  emailRequestedAt?: string | null;
  mediaUrls: string[];
  siteId?: number | null;
  siteName?: string | null;
  createdAt: string;
  updatedAt?: string;
  statusEvents?: Array<{ status: string; createdAt: string }>;
  notes?: IssueNote[];
}

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

function humanizeType(value: string): string {
  return value.split("_").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

function issueTypeMeta(key: string): { label: string; color: string } {
  return ISSUE_TYPES[key] ?? { label: humanizeType(key), color: "bg-slate-100 text-slate-800 border-slate-200" };
}

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

// ── Status Timeline Component ─────────────────────────────────────────────────

function StatusTimeline({ issue }: { issue: Issue }) {
  const eventDate = (status: string) =>
    issue.statusEvents?.find(event => event.status === status)?.createdAt ?? null;
  const steps = [
    { key: "reported", label: "Reported", date: eventDate("reported") || issue.reportedDate || issue.createdAt },
    { key: "in_progress", label: "In Progress", date: eventDate("in_progress") },
    { key: "resolved", label: "Resolved", date: eventDate("resolved") },
    { key: "closed", label: "Closed", date: eventDate("closed") }
  ];

  const currentIndex = steps.findIndex(s => s.key === issue.status);
  const currentStep = currentIndex === -1 ? 0 : currentIndex;
  let completedThrough = -1;
  for (const [index, step] of steps.entries()) {
    if (!step.date) break;
    completedThrough = index;
  }
  const progress = Math.max(completedThrough, 0);

  return (
    <div className="relative pt-6 pb-2">
      {/* Background line */}
      <div className="absolute top-10 left-6 right-6 h-0.5 bg-border -z-10" />
      {/* Progress line */}
      <div 
        className="absolute top-10 left-6 h-0.5 bg-primary -z-10 transition-all duration-500 ease-in-out" 
        style={{ width: `calc(${(progress / (steps.length - 1)) * 100}% - ${progress === 0 ? '1.5rem' : '3rem'})` }}
      />

      <div className="flex justify-between relative z-0">
        {steps.map((step, idx) => {
          const isCompleted = Boolean(step.date);
          const isCurrent = idx === currentStep;
          
          return (
            <div key={step.key} className="flex flex-col items-center gap-2 w-1/4">
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors duration-300",
                isCompleted ? "bg-primary border-primary text-primary-foreground" : "bg-card border-muted text-muted-foreground",
                isCurrent && "ring-4 ring-primary/20"
              )}>
                {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />}
              </div>
              <div className="text-center">
                <p className={cn("text-[11px] font-medium uppercase tracking-wide", isCurrent ? "text-primary" : (isCompleted ? "text-foreground" : "text-muted-foreground"))}>
                  {step.label}
                </p>
                {step.date ? (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {format(new Date(step.date), "MMM d")}
                  </p>
                ) : isCompleted ? (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Completed</p>
                ) : (
                  <p className="text-[10px] text-transparent mt-0.5 select-none">Pending</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Media Viewer Component ────────────────────────────────────────────────────

function MediaGallery({ urls }: { urls: string[] }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [initialIndex, setInitialIndex] = useState(0);

  if (!urls || urls.length === 0) return null;

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2 snap-x">
        {urls.map((url, idx) => {
          const isVideo = /\.(mp4|mov|webm|avi)$/i.test(url);
          const src = `/api/storage/objects/${url}`;
          
          return (
            <button
              key={url}
              onClick={() => { setInitialIndex(idx); setViewerOpen(true); }}
              className="relative w-28 h-28 flex-shrink-0 rounded-xl overflow-hidden border border-border bg-muted/30 snap-start active:scale-95 transition-transform"
            >
              {isVideo ? (
                <div className="w-full h-full bg-black/10 flex items-center justify-center">
                  <div className="w-8 h-8 rounded-full bg-background/80 flex items-center justify-center backdrop-blur-sm">
                    <div className="w-0 h-0 border-t-4 border-t-transparent border-l-6 border-l-foreground border-b-4 border-b-transparent ml-1" />
                  </div>
                </div>
              ) : (
                <img src={src} alt="Issue media" className="w-full h-full object-cover" />
              )}
            </button>
          );
        })}
      </div>

      {viewerOpen && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-200">
          <div className="p-4 flex justify-between items-center bg-background/50 border-b absolute top-0 left-0 right-0 z-10">
            <p className="font-medium text-sm">Media Viewer</p>
            <Button variant="ghost" size="sm" onClick={() => setViewerOpen(false)}>Close</Button>
          </div>
          
          <div className="flex-1 flex overflow-x-auto snap-x snap-mandatory pt-16">
            {urls.map((url, idx) => {
              const isVideo = /\.(mp4|mov|webm|avi)$/i.test(url);
              const src = `/api/storage/objects/${url}`;
              
              return (
                <div 
                  key={url} 
                  className="w-full flex-shrink-0 flex items-center justify-center p-4 snap-center"
                  ref={el => { if (el && idx === initialIndex) el.scrollIntoView(); }}
                >
                  {isVideo ? (
                    <video src={src} controls className="max-w-full max-h-full rounded-lg" autoPlay={idx === initialIndex} />
                  ) : (
                    <img src={src} alt="Full view" className="max-w-full max-h-full object-contain rounded-lg shadow-xl" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Page Component ───────────────────────────────────────────────────────

export default function FixTrackDetailPage() {
  const [, params] = useRoute("/fix-track/:id");
  const { user, hasService } = useAuth();
  const hasFixtrack = hasService("fixtrack");
  const canEdit = user?.role !== "client_viewer";
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [issue, setIssue] = useState<Issue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  
  const bottomRef = useRef<HTMLDivElement>(null);

  async function loadIssue() {
    try {
      const res = await apiFetch(`/fix-track/issues/${params?.id}`);
      if (!res.ok) throw new Error("Not found");
      const data = await res.json();
      setIssue(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!hasFixtrack) {
      setLocation("/fix-track");
      return;
    }
    if (params?.id) loadIssue();
  }, [params?.id, hasFixtrack]);

  async function handleStatusChange(newStatus: string, resolverSignature?: string) {
    if (!issue || statusBusy) return;
    if (newStatus === "resolved" && !resolverSignature) {
      setSignatureOpen(true);
      return;
    }
    setStatusBusy(true);
    try {
      const payload = { status: newStatus, ...(resolverSignature ? { resolverSignature } : {}) };
      
      const res = await apiFetch(`/fix-track/issues/${issue.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update status");
      
      toast({ title: `Status updated to ${STATUSES[newStatus]?.label ?? newStatus}` });
      await loadIssue();
    } catch (err: any) {
      toast({ title: "Error updating status", description: err.message, variant: "destructive" });
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleAddNote() {
    if (!noteText.trim() || !issue || savingNote) return;
    setSavingNote(true);
    try {
      const res = await apiFetch(`/fix-track/issues/${issue.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ note: noteText.trim() }),
      });
      
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to add note");
      
      setNoteText("");
      toast({ title: "Note added" });
      await loadIssue();
      
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    } catch (err: any) {
      toast({ title: "Error adding note", description: err.message, variant: "destructive" });
    } finally {
      setSavingNote(false);
    }
  }

  if (loading) {
    return (
      <AppLayout title="FixTrack — Loading">
        <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh]">
          <Loader2 className="w-8 h-8 text-primary animate-spin mb-4" />
          <p className="text-muted-foreground">Loading issue details…</p>
        </div>
      </AppLayout>
    );
  }

  if (error || !issue) {
    return (
      <AppLayout title="FixTrack — Not Found">
        <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] text-center space-y-4">
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-medium">Issue Not Found</h2>
            <p className="text-muted-foreground text-sm">The maintenance issue could not be loaded or doesn't exist.</p>
          </div>
          <Button variant="outline" onClick={() => setLocation("/fix-track")}>
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to List
          </Button>
        </div>
      </AppLayout>
    );
  }

  const statusMeta   = STATUSES[issue.status]      ?? STATUSES.reported;
  const StatusIcon   = statusMeta.icon;
  const typeMeta     = issueTypeMeta(issue.issueType);
  const priorityMeta = PRIORITIES[issue.priority]  ?? PRIORITIES.medium;
  const hasNextStatus = issue.status !== "closed";

  const allNotes: IssueNote[] = [...(issue.notes ?? [])];
  if (allNotes.length === 0 && issue.solutionNotes) {
    allNotes.push({ id: 0, note: issue.solutionNotes, createdBy: issue.resolvedByName ? `Resolved by ${issue.resolvedByName}` : "Resolution", createdAt: issue.resolvedDate || issue.updatedAt || issue.createdAt, isLegacy: true });
  }
  allNotes.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <AppLayout title={`FixTrack — ${issue.title}`}>
      <div className="max-w-3xl mx-auto pb-24 space-y-6">
        {/* Navigation & Actions */}
        <div className="flex items-center justify-between">
          <button 
            onClick={() => setLocation("/fix-track")} 
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back to list
          </button>
        </div>

        {/* Header Section */}
        <div className="bg-card border rounded-2xl p-5 sm:p-8 space-y-6 shadow-sm">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <span className={cn("inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border font-medium shadow-sm", statusMeta.color)}>
                <StatusIcon className="w-3.5 h-3.5" />{statusMeta.label}
              </span>
              <span className={cn("text-xs px-2.5 py-1 rounded-md border font-medium shadow-sm", typeMeta.color)}>{typeMeta.label}</span>
              <span className={cn("text-xs px-2.5 py-1 rounded-md border font-medium shadow-sm", priorityMeta.color)}>{priorityMeta.label}</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-display font-medium text-foreground tracking-tight leading-tight flex items-center gap-3">
              <span>{issue.title}</span>
              <span className="text-lg text-muted-foreground font-sans">#{issue.id}</span>
            </h1>

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" /> {issue.location}
              </div>
              {issue.siteName && (
                <div className="flex items-center gap-1.5">
                  <Wrench className="w-4 h-4" /> {issue.siteName}
                </div>
              )}
            </div>
          </div>

          <StatusTimeline issue={issue} />
          
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t">
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Reported By</p>
              <p className="font-medium text-sm truncate" title={issue.reportedBy}>{issue.reportedBy}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Reported Date</p>
              <p className="font-medium text-sm">{format(new Date(issue.reportedDate), "dd MMM yyyy")}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Assigned To</p>
              <p className="font-medium text-sm truncate">{issue.assignedTo || "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Contractor</p>
              <p className="font-medium text-sm truncate" title={issue.contractorName || ""}>{issue.contractorName || "—"}</p>
            </div>
          </div>
        </div>

        {/* Description & Media */}
        <div className="space-y-6">
          {issue.description && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" /> Details
              </h3>
              <div className="bg-card border rounded-xl p-5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm">
                {issue.description}
              </div>
            </div>
          )}

          {((issue.mediaUrls && issue.mediaUrls.length > 0) || issue.completionDocumentPath) && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Camera className="w-4 h-4 text-muted-foreground" /> Attachments
              </h3>
              {issue.mediaUrls && issue.mediaUrls.length > 0 && <MediaGallery urls={issue.mediaUrls} />}
              {issue.completionDocumentPath && (
                <a
                  href={`/api/storage/objects/${issue.completionDocumentPath}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 mt-2 px-3 py-2 text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-lg hover:underline transition-all hover:bg-blue-100"
                >
                  <FileText className="w-4 h-4" /> View Completion Document
                </a>
              )}
            </div>
          )}
        </div>

        {/* Activity & Notes */}
        <div className="space-y-4 pt-6">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" /> Activity & Notes
          </h3>
          
          <div className="space-y-4">
            {allNotes.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground bg-muted/30 border border-dashed rounded-xl">
                <p className="text-sm">No notes have been added yet.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {allNotes.map((n, idx) => (
                  <div key={n.id || `legacy-${idx}`} className={cn(
                    "flex gap-3",
                    n.isLegacy ? "p-4 bg-emerald-50/50 border border-emerald-100 rounded-xl" : ""
                  )}>
                    {!n.isLegacy && (
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <User className="w-4 h-4 text-primary" />
                      </div>
                    )}
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className={cn("text-xs font-medium", n.isLegacy ? "text-emerald-700" : "text-foreground")}>
                          {n.createdBy}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {n.createdAt ? format(new Date(n.createdAt), "dd MMM yyyy HH:mm") : ""}
                        </p>
                      </div>
                      <p className={cn("text-sm whitespace-pre-wrap leading-relaxed", n.isLegacy ? "text-emerald-900" : "text-muted-foreground")}>
                        {n.note}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>

      {/* Floating Action Bar / Reply box */}
      {canEdit && (
        <div className="fixed bottom-0 left-0 right-0 sm:left-64 bg-background/80 backdrop-blur-xl border-t p-3 sm:p-4 z-40 shadow-[0_-10px_30px_-15px_rgba(0,0,0,0.1)]">
          <div className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-3 items-end sm:items-center">
            
            {/* Status transitions */}
            {hasNextStatus && (
              <div className="flex w-full sm:w-auto gap-2">
                {issue.status === "reported" && (
                  <Button 
                    size="sm" 
                    onClick={() => handleStatusChange("in_progress")} 
                    disabled={statusBusy}
                    className="flex-1 sm:flex-none bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
                  >
                    {statusBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Loader2 className="w-4 h-4" />}
                    Start Work
                  </Button>
                )}
                {issue.status === "in_progress" && (
                  <Button 
                    size="sm" 
                    onClick={() => handleStatusChange("resolved")} 
                    disabled={statusBusy}
                    className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                  >
                    {statusBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    Resolve
                  </Button>
                )}
                {issue.status === "resolved" && (
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => handleStatusChange("closed")} 
                    disabled={statusBusy}
                    className="flex-1 sm:flex-none gap-1.5"
                  >
                    {statusBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                    Close
                  </Button>
                )}
              </div>
            )}
            {issue.resolvedByName && ["resolved", "closed"].includes(issue.status) && (
              <div className="w-full text-xs text-muted-foreground">
                <p>Signed off as complete by <strong className="text-foreground">{issue.resolvedByName}</strong></p>
                {issue.resolverSignature && <img src={issue.resolverSignature} alt={`Signature of ${issue.resolvedByName}`} className="mt-2 h-14 max-w-52 rounded-sm border bg-white object-contain" />}
              </div>
            )}
            
            <div className="flex-1 flex gap-2 w-full">
              <Textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a note or update…"
                className="min-h-[40px] h-[40px] max-h-[120px] resize-none py-2 px-3 text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAddNote();
                  }
                }}
              />
              <Button 
                size="icon" 
                className="h-[40px] w-[40px] shrink-0" 
                onClick={handleAddNote}
                disabled={!noteText.trim() || savingNote}
              >
                {savingNote ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
            
          </div>
        </div>
      )}
      <DrawnSignatureDialog open={signatureOpen} busy={statusBusy} onCancel={() => setSignatureOpen(false)} onConfirm={async signature => {
        await handleStatusChange("resolved", signature);
        setSignatureOpen(false);
      }} />
    </AppLayout>
  );
}
