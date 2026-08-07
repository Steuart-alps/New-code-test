import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import {
  Bug, Plus, AlertTriangle, CheckCircle2, Clock, Pencil, Trash2,
  Lock, Search, Settings, X, CalendarDays, ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, parseISO, isValid, differenceInDays } from "date-fns";

// ─── Constants ─────────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const PEST_TYPES = ["rodent", "insect", "bird", "other"] as const;
const PEST_TYPE_LABELS: Record<string, string> = {
  rodent: "Rodent", insect: "Insect", bird: "Bird", other: "Other",
};

const EVIDENCE_TYPES = [
  "live_sighting", "droppings", "damage", "nest", "tracks", "other",
] as const;
const EVIDENCE_LABELS: Record<string, string> = {
  live_sighting: "Live sighting",
  droppings:     "Droppings",
  damage:        "Damage",
  nest:          "Nest / harbourage",
  tracks:        "Tracks / smear marks",
  other:         "Other",
};

const SEVERITY_LABELS: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${baseUrl}/api/pest-track${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

function fmt(d: string | null | undefined) {
  if (!d) return null;
  const p = parseISO(d);
  return isValid(p) ? format(p, "dd MMM yyyy") : null;
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge variant="outline" className={cn(
      "rounded-sm text-xs font-medium",
      severity === "high"   && "border-red-300 text-red-700 bg-red-50",
      severity === "medium" && "border-amber-300 text-amber-700 bg-amber-50",
      severity === "low"    && "border-green-300 text-green-700 bg-green-50",
    )}>
      {SEVERITY_LABELS[severity] ?? severity}
    </Badge>
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PestVisit {
  id: number;
  client_id: number;
  site_id: number | null;
  visit_date: string;
  contractor_name: string | null;
  contractor_company: string | null;
  areas_inspected: string | null;
  findings: string | null;
  treatments_applied: string | null;
  recommendations: string | null;
  next_visit_date: string | null;
  signed_off_by: string | null;
  notes: string | null;
  created_at: string;
}

interface PestActivity {
  id: number;
  client_id: number;
  site_id: number | null;
  recorded_date: string;
  pest_type: string;
  evidence_type: string;
  location: string | null;
  severity: string;
  action_taken: string | null;
  recorded_by: string | null;
  resolved: boolean;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
}

interface PestStatus {
  last_visit_date: string | null;
  last_contractor_name: string | null;
  next_visit_date: string | null;
  next_visit_overdue: boolean;
  open_activity_count: number;
  visits_this_year: number;
}

// ─── VisitDialog ──────────────────────────────────────────────────────────────

const EMPTY_VISIT = {
  visitDate: "", contractorName: "", contractorCompany: "",
  areasInspected: "", findings: "", treatmentsApplied: "",
  recommendations: "", nextVisitDate: "", signedOffBy: "", notes: "",
  siteId: "",
};

function VisitDialog({ open, visit, onClose, onSaved, sites, config }: {
  open: boolean;
  visit: PestVisit | null;
  onClose: () => void;
  onSaved: () => void;
  sites: { id: number; name: string }[];
  config: Record<string, string>;
}) {
  const { toast } = useToast();
  const isEdit = !!visit;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    visitDate:          visit?.visit_date ?? new Date().toISOString().slice(0, 10),
    contractorName:     visit?.contractor_name ?? config.pest_contractor_name ?? "",
    contractorCompany:  visit?.contractor_company ?? config.pest_contractor_company ?? "",
    areasInspected:     visit?.areas_inspected ?? "",
    findings:           visit?.findings ?? "",
    treatmentsApplied:  visit?.treatments_applied ?? "",
    recommendations:    visit?.recommendations ?? "",
    nextVisitDate:      visit?.next_visit_date ?? "",
    signedOffBy:        visit?.signed_off_by ?? "",
    notes:              visit?.notes ?? "",
    siteId:             String(visit?.site_id ?? ""),
  }));

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.visitDate) { toast({ title: "Visit date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const payload = {
        visitDate:          form.visitDate,
        contractorName:     form.contractorName || null,
        contractorCompany:  form.contractorCompany || null,
        areasInspected:     form.areasInspected || null,
        findings:           form.findings || null,
        treatmentsApplied:  form.treatmentsApplied || null,
        recommendations:    form.recommendations || null,
        nextVisitDate:      form.nextVisitDate || null,
        signedOffBy:        form.signedOffBy || null,
        notes:              form.notes || null,
        siteId:             form.siteId ? parseInt(form.siteId, 10) : null,
      };
      if (isEdit) {
        await apiFetch(`/visits/${visit.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/visits", { method: "POST", body: JSON.stringify(payload) });
      }
      toast({ title: isEdit ? "Visit updated" : "Visit logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving && !v) onClose(); }}>
      <DialogContent className="max-w-2xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4" />
            {isEdit ? "Edit contractor visit" : "Log contractor visit"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>Visit date <span className="text-destructive">*</span></Label>
            <Input type="date" value={form.visitDate} onChange={set("visitDate")} className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Next scheduled visit</Label>
            <Input type="date" value={form.nextVisitDate} onChange={set("nextVisitDate")} className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Contractor name</Label>
            <Input value={form.contractorName} onChange={set("contractorName")} placeholder="e.g. John Smith" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Contractor company</Label>
            <Input value={form.contractorCompany} onChange={set("contractorCompany")} placeholder="e.g. ABC Pest Control" className="rounded-sm" />
          </div>
          {sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site</Label>
              <Select value={form.siteId} onValueChange={v => setForm(f => ({ ...f, siteId: v }))}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All sites</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Signed off by</Label>
            <Input value={form.signedOffBy} onChange={set("signedOffBy")} placeholder="e.g. Site manager name" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Areas inspected / treated</Label>
            <Textarea rows={2} value={form.areasInspected} onChange={set("areasInspected")} placeholder="e.g. Kitchen, cellar, external bin store, perimeter" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Findings</Label>
            <Textarea rows={3} value={form.findings} onChange={set("findings")} placeholder="Describe any pest activity observed, evidence found, or if no activity was identified" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Treatments applied</Label>
            <Textarea rows={2} value={form.treatmentsApplied} onChange={set("treatmentsApplied")} placeholder="e.g. Rodenticide bait replenished at stations 1–6; fly unit serviced" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Recommendations / remedial actions</Label>
            <Textarea rows={2} value={form.recommendations} onChange={set("recommendations")} placeholder="e.g. Seal gap under back door; remove food waste from yard daily" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={2} value={form.notes} onChange={set("notes")} className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Log visit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ActivityDialog ───────────────────────────────────────────────────────────

function ActivityDialog({ open, activity, onClose, onSaved, sites }: {
  open: boolean;
  activity: PestActivity | null;
  onClose: () => void;
  onSaved: () => void;
  sites: { id: number; name: string }[];
}) {
  const { toast } = useToast();
  const isEdit = !!activity;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    recordedDate: activity?.recorded_date ?? new Date().toISOString().slice(0, 10),
    pestType:     activity?.pest_type ?? "rodent",
    evidenceType: activity?.evidence_type ?? "live_sighting",
    location:     activity?.location ?? "",
    severity:     activity?.severity ?? "low",
    actionTaken:  activity?.action_taken ?? "",
    recordedBy:   activity?.recorded_by ?? "",
    resolved:     activity?.resolved ?? false,
    notes:        activity?.notes ?? "",
    siteId:       String(activity?.site_id ?? ""),
  }));

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.recordedDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const payload = {
        recordedDate: form.recordedDate,
        pestType:     form.pestType,
        evidenceType: form.evidenceType,
        location:     form.location || null,
        severity:     form.severity,
        actionTaken:  form.actionTaken || null,
        recordedBy:   form.recordedBy || null,
        resolved:     form.resolved,
        notes:        form.notes || null,
        siteId:       form.siteId ? parseInt(form.siteId, 10) : null,
      };
      if (isEdit) {
        await apiFetch(`/activity/${activity.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/activity", { method: "POST", body: JSON.stringify(payload) });
      }
      toast({ title: isEdit ? "Record updated" : "Activity logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving && !v) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            {isEdit ? "Edit activity record" : "Log pest activity"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>Date recorded <span className="text-destructive">*</span></Label>
            <Input type="date" value={form.recordedDate} onChange={set("recordedDate")} className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Pest type</Label>
            <Select value={form.pestType} onValueChange={v => setForm(f => ({ ...f, pestType: v }))}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PEST_TYPES.map(t => <SelectItem key={t} value={t}>{PEST_TYPE_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Evidence type</Label>
            <Select value={form.evidenceType} onValueChange={v => setForm(f => ({ ...f, evidenceType: v }))}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVIDENCE_TYPES.map(t => <SelectItem key={t} value={t}>{EVIDENCE_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v }))}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["low", "medium", "high"].map(s => <SelectItem key={s} value={s}>{SEVERITY_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Location / area</Label>
            <Input value={form.location} onChange={set("location")} placeholder="e.g. Kitchen, bin store" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Recorded by</Label>
            <Input value={form.recordedBy} onChange={set("recordedBy")} placeholder="Staff name" className="rounded-sm" />
          </div>
          {sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site</Label>
              <Select value={form.siteId} onValueChange={v => setForm(f => ({ ...f, siteId: v }))}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All sites</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="col-span-full space-y-1.5">
            <Label>Action taken</Label>
            <Textarea rows={2} value={form.actionTaken} onChange={set("actionTaken")} placeholder="What was done in response?" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={2} value={form.notes} onChange={set("notes")} className="rounded-sm" />
          </div>
          <div className="col-span-full flex items-center justify-between border border-border rounded-sm px-3 py-2">
            <div>
              <p className="text-sm font-medium">Resolved</p>
              <p className="text-xs text-muted-foreground">Mark as resolved when pest activity has been dealt with</p>
            </div>
            <Switch checked={form.resolved} onCheckedChange={v => setForm(f => ({ ...f, resolved: v }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Log activity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ConfigDialog ─────────────────────────────────────────────────────────────

function ConfigDialog({ open, onClose, config, onSaved }: {
  open: boolean;
  onClose: () => void;
  config: Record<string, string>;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    pest_contractor_name:           config.pest_contractor_name ?? "",
    pest_contractor_company:        config.pest_contractor_company ?? "",
    pest_visit_frequency_months:    config.pest_visit_frequency_months ?? "3",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch("/config", { method: "PUT", body: JSON.stringify(form) });
      toast({ title: "Settings saved" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving && !v) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            PestTrack settings
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Default contractor name</Label>
            <Input value={form.pest_contractor_name} onChange={set("pest_contractor_name")} placeholder="e.g. John Smith" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Default contractor company</Label>
            <Input value={form.pest_contractor_company} onChange={set("pest_contractor_company")} placeholder="e.g. ABC Pest Control Ltd" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Visit frequency (months)</Label>
            <Input type="number" min={1} max={24} value={form.pest_visit_frequency_months} onChange={set("pest_visit_frequency_months")} className="rounded-sm w-28" />
            <p className="text-xs text-muted-foreground">Used to calculate when the next visit is due if no date is set on the last visit record.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">Save settings</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function PestTrackPage() {
  const { user } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [activeTab, setActiveTab] = useState<"visits" | "activity">("visits");

  const [visitDialog, setVisitDialog]       = useState(false);
  const [activityDialog, setActivityDialog] = useState(false);
  const [configDialog, setConfigDialog]     = useState(false);
  const [editVisit, setEditVisit]           = useState<PestVisit | null>(null);
  const [editActivity, setEditActivity]     = useState<PestActivity | null>(null);
  const [deleteVisitId, setDeleteVisitId]   = useState<number | null>(null);
  const [deleteActivityId, setDeleteActivityId] = useState<number | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: status } = useQuery<PestStatus>({
    queryKey: ["/api/pest-track/status"],
    queryFn: () => apiFetch("/status"),
  });

  const { data: visits = [] } = useQuery<PestVisit[]>({
    queryKey: ["/api/pest-track/visits"],
    queryFn: () => apiFetch("/visits"),
  });

  const { data: activity = [] } = useQuery<PestActivity[]>({
    queryKey: ["/api/pest-track/activity"],
    queryFn: () => apiFetch("/activity"),
  });

  const { data: config = {} } = useQuery<Record<string, string>>({
    queryKey: ["/api/pest-track/config"],
    queryFn: () => apiFetch("/config"),
  });

  const { data: sites = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/sites"],
    queryFn: async () => {
      const res = await fetch(`${baseUrl}/api/sites`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/pest-track/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/pest-track/visits"] });
    queryClient.invalidateQueries({ queryKey: ["/api/pest-track/activity"] });
    queryClient.invalidateQueries({ queryKey: ["/api/pest-track/config"] });
  };

  // ── Delete handlers ────────────────────────────────────────────────────────

  const handleDeleteVisit = async () => {
    if (!deleteVisitId) return;
    try {
      await apiFetch(`/visits/${deleteVisitId}`, { method: "DELETE" });
      toast({ title: "Visit deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/pest-track/visits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pest-track/status"] });
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally { setDeleteVisitId(null); }
  };

  const handleDeleteActivity = async () => {
    if (!deleteActivityId) return;
    try {
      await apiFetch(`/activity/${deleteActivityId}`, { method: "DELETE" });
      toast({ title: "Record deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/pest-track/activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pest-track/status"] });
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally { setDeleteActivityId(null); }
  };

  // ── Filtered lists ─────────────────────────────────────────────────────────

  const filteredVisits = visits.filter(v =>
    !q || [v.contractor_name, v.contractor_company, v.areas_inspected, v.findings]
      .some(s => s?.toLowerCase().includes(q.toLowerCase()))
  );

  const filteredActivity = activity.filter(a =>
    !q || [a.pest_type, a.evidence_type, a.location, a.action_taken, a.recorded_by]
      .some(s => s?.toLowerCase().includes(q.toLowerCase()))
  );

  const openActivity = activity.filter(a => !a.resolved);
  const today = new Date().toISOString().slice(0, 10);

  // ── Status cards ───────────────────────────────────────────────────────────

  const nextVisitOverdue = status?.next_visit_overdue;
  const nextVisitSoon = status?.next_visit_date && !nextVisitOverdue
    && differenceInDays(parseISO(status.next_visit_date), new Date()) <= 14;

  return (
    <AppLayout title="PestTrack">
      <div className="space-y-6">

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-sm bg-emerald-50 border border-emerald-200 flex items-center justify-center">
              <Bug className="w-4 h-4 text-emerald-700" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">PestTrack</h1>
              <p className="text-xs text-muted-foreground">Pest control visits and activity log</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && (
              <Button variant="outline" size="sm" className="rounded-sm gap-1.5 h-8 text-xs"
                onClick={() => setConfigDialog(true)}>
                <Settings className="w-3.5 h-3.5" /> Settings
              </Button>
            )}
          </div>
        </div>

        {/* ── Status strip ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Last visit */}
          <div className="border border-border rounded-sm p-4">
            <p className="text-xs text-muted-foreground mb-1">Last contractor visit</p>
            {status?.last_visit_date ? (
              <>
                <p className="text-sm font-semibold">{fmt(status.last_visit_date)}</p>
                {status.last_contractor_name && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{status.last_contractor_name}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No visits yet</p>
            )}
          </div>

          {/* Next visit due */}
          <div className={cn(
            "border rounded-sm p-4",
            nextVisitOverdue ? "border-red-300 bg-red-50" : nextVisitSoon ? "border-amber-300 bg-amber-50" : "border-border",
          )}>
            <p className={cn("text-xs mb-1", nextVisitOverdue ? "text-red-600" : nextVisitSoon ? "text-amber-700" : "text-muted-foreground")}>
              Next visit due
            </p>
            {status?.next_visit_date ? (
              <p className={cn("text-sm font-semibold", nextVisitOverdue ? "text-red-700" : nextVisitSoon ? "text-amber-800" : "")}>
                {fmt(status.next_visit_date)}
                {nextVisitOverdue && <span className="ml-1.5 text-[10px] font-bold uppercase text-red-600">Overdue</span>}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Not scheduled</p>
            )}
          </div>

          {/* Open activity */}
          <div className={cn(
            "border rounded-sm p-4",
            (status?.open_activity_count ?? 0) > 0 ? "border-amber-300 bg-amber-50" : "border-border",
          )}>
            <p className={cn("text-xs mb-1", (status?.open_activity_count ?? 0) > 0 ? "text-amber-700" : "text-muted-foreground")}>
              Open activity
            </p>
            <p className={cn("text-2xl font-bold", (status?.open_activity_count ?? 0) > 0 ? "text-amber-800" : "")}>
              {status?.open_activity_count ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">unresolved</p>
          </div>

          {/* Visits this year */}
          <div className="border border-border rounded-sm p-4">
            <p className="text-xs text-muted-foreground mb-1">Visits this year</p>
            <p className="text-2xl font-bold">{status?.visits_this_year ?? 0}</p>
            <p className="text-xs text-muted-foreground">contractor visits</p>
          </div>
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────────── */}
        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as any)}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <TabsList className="rounded-sm">
              <TabsTrigger value="visits" className="rounded-sm text-xs">Contractor visits</TabsTrigger>
              <TabsTrigger value="activity" className="rounded-sm text-xs gap-1.5">
                Activity log
                {openActivity.length > 0 && (
                  <span className="bg-amber-500 text-white text-[10px] rounded-full px-1.5 py-0.5 leading-none font-bold">
                    {openActivity.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search…"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  className="pl-8 h-8 text-xs rounded-sm w-44"
                />
                {q && (
                  <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              {activeTab === "visits" ? (
                <Button size="sm" className="rounded-sm gap-1.5 h-8 text-xs" onClick={() => { setEditVisit(null); setVisitDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Log visit
                </Button>
              ) : (
                <Button size="sm" className="rounded-sm gap-1.5 h-8 text-xs" onClick={() => { setEditActivity(null); setActivityDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Log activity
                </Button>
              )}
            </div>
          </div>

          {/* ── Visits tab ────────────────────────────────────────────────── */}
          <TabsContent value="visits" className="mt-4">
            {filteredVisits.length === 0 ? (
              <div className="border border-dashed border-border rounded-sm p-12 text-center">
                <CalendarDays className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm font-medium text-muted-foreground">
                  {q ? "No visits match your search" : "No contractor visits logged yet"}
                </p>
                {!q && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Log your first pest control contractor visit to start building your audit record.
                  </p>
                )}
                {!q && (
                  <Button size="sm" className="rounded-sm mt-4 gap-1.5 text-xs" onClick={() => { setEditVisit(null); setVisitDialog(true); }}>
                    <Plus className="w-3.5 h-3.5" /> Log visit
                  </Button>
                )}
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Date</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden sm:table-cell">Contractor</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden md:table-cell">Findings summary</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden lg:table-cell">Next visit</th>
                      <th className="px-2 py-2.5 w-14"></th>
                      <th className="px-4 py-2.5 w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVisits.map((v, i) => {
                      const isNextOverdue = v.next_visit_date && v.next_visit_date < today;
                      return (
                        <tr key={v.id} className={cn("group border-t border-border hover:bg-muted/20", i === 0 && "border-t-0")}>
                          <td className="px-4 py-3">
                            <p className="text-sm font-medium">{fmt(v.visit_date)}</p>
                            {v.areas_inspected && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[120px]">{v.areas_inspected}</p>}
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell">
                            <p className="text-sm">{v.contractor_name ?? <span className="text-muted-foreground/40">—</span>}</p>
                            {v.contractor_company && <p className="text-xs text-muted-foreground">{v.contractor_company}</p>}
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <p className="text-xs text-muted-foreground line-clamp-2 max-w-xs">
                              {v.findings ?? <span className="text-muted-foreground/40">—</span>}
                            </p>
                          </td>
                          <td className="px-4 py-3 hidden lg:table-cell">
                            {v.next_visit_date ? (
                              <p className={cn("text-xs", isNextOverdue ? "text-red-600 font-medium" : "text-muted-foreground")}>
                                {fmt(v.next_visit_date)}
                                {isNextOverdue && <span className="ml-1 font-bold">Overdue</span>}
                              </p>
                            ) : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-2 py-3">
                            <CheckPhotoUploader entityType="pest_visit" entityId={v.id} compact />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {canAdmin && (
                                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                  onClick={() => { setEditVisit(v); setVisitDialog(true); }}>
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                              )}
                              {canAdmin && (
                                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => setDeleteVisitId(v.id)}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* ── Activity tab ─────────────────────────────────────────────── */}
          <TabsContent value="activity" className="mt-4">
            {filteredActivity.length === 0 ? (
              <div className="border border-dashed border-border rounded-sm p-12 text-center">
                <ShieldAlert className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm font-medium text-muted-foreground">
                  {q ? "No activity matches your search" : "No pest activity logged"}
                </p>
                {!q && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Log any pest sightings, evidence, or activity observed between contractor visits.
                  </p>
                )}
                {!q && (
                  <Button size="sm" className="rounded-sm mt-4 gap-1.5 text-xs" onClick={() => { setEditActivity(null); setActivityDialog(true); }}>
                    <Plus className="w-3.5 h-3.5" /> Log activity
                  </Button>
                )}
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Date</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Type</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden sm:table-cell">Location</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Severity</th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden md:table-cell">Status</th>
                      <th className="px-4 py-2.5 w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActivity.map((a, i) => (
                      <tr key={a.id} className={cn("group border-t border-border hover:bg-muted/20", i === 0 && "border-t-0")}>
                        <td className="px-4 py-3 text-sm">{fmt(a.recorded_date)}</td>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium">{PEST_TYPE_LABELS[a.pest_type] ?? a.pest_type}</p>
                          <p className="text-xs text-muted-foreground">{EVIDENCE_LABELS[a.evidence_type] ?? a.evidence_type}</p>
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">
                          {a.location ?? <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-4 py-3"><SeverityBadge severity={a.severity} /></td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          {a.resolved ? (
                            <span className="flex items-center gap-1 text-xs text-green-700">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Resolved
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-amber-700">
                              <AlertTriangle className="w-3.5 h-3.5" /> Open
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {canAdmin && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                onClick={() => { setEditActivity(a); setActivityDialog(true); }}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {canAdmin && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteActivityId(a.id)}>
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
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────────── */}
      <VisitDialog
        open={visitDialog}
        visit={editVisit}
        sites={sites}
        config={config}
        onSaved={refetchAll}
        onClose={() => { setVisitDialog(false); setEditVisit(null); }}
      />
      <ActivityDialog
        open={activityDialog}
        activity={editActivity}
        sites={sites}
        onSaved={refetchAll}
        onClose={() => { setActivityDialog(false); setEditActivity(null); }}
      />
      {canAdmin && (
        <ConfigDialog
          open={configDialog}
          config={config}
          onSaved={refetchAll}
          onClose={() => setConfigDialog(false)}
        />
      )}

      {/* ── Confirm delete visit ─────────────────────────────────────────── */}
      <AlertDialog open={!!deleteVisitId} onOpenChange={v => { if (!v) setDeleteVisitId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete visit record?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteVisit} className="rounded-sm bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm delete activity ──────────────────────────────────────── */}
      <AlertDialog open={!!deleteActivityId} onOpenChange={v => { if (!v) setDeleteActivityId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete activity record?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteActivity} className="rounded-sm bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
