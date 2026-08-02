import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import {
  TreePine, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX,
  Pencil, Trash2, Lock, Search, Building2, Filter, CalendarDays,
  UserCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

const CHECK_TYPES = [
  "visual_assessment",
  "detailed_assessment",
  "post_storm",
  "remedial_works",
  "risk_assessment",
] as const;

type CheckType = (typeof CHECK_TYPES)[number];
type CheckResult = "pass" | "monitor" | "action_required" | "urgent_action";
type CheckStatus = "ok" | "due_soon" | "overdue" | "never";

interface TreeInspection {
  id: number;
  clientId: number;
  siteId: number | null;
  checkType: string;
  checkDate: string;
  result: string;
  treeRef: string | null;
  location: string | null;
  inspector: string | null;
  followUpDate: string | null;
  notes: string | null;
  createdAt: string;
}

interface StatusRow {
  checkType: string;
  frequencyDays: number;
  lastDate: string | null;
  dueDate: string | null;
  status: CheckStatus;
}

interface Site { id: number; name: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  visual_assessment:   "Visual tree assessment (VTA)",
  detailed_assessment: "Detailed / close inspection",
  post_storm:          "Post-storm / adverse weather check",
  remedial_works:      "Remedial works record",
  risk_assessment:     "Tree risk assessment review",
};

const CHECK_TYPE_HINTS: Record<CheckType, string> = {
  visual_assessment:   "Routine ground-level walking survey of all trees. Minimum annually per BS 3998:2010. High-risk trees may require more frequent checks.",
  detailed_assessment: "Close inspection required when anomalies (deadwood, cracks, fungal bodies, lean) are found during a VTA. May require climbing inspection or specialist assessment.",
  post_storm:          "Carry out a walk-over inspection after any storm or severe weather event to identify newly fallen branches, uprooted or leaning trees, or structural failures.",
  remedial_works:      "Record of arboricultural works carried out — crown reduction, deadwood removal, felling, stump grinding, cable bracing, etc.",
  risk_assessment:     "Full BS 3998:2010 / NTSG tree risk assessment. Identifies likelihood of failure and potential consequences. Required before remedial works.",
};

const RESULT_CFG: Record<CheckResult, { label: string; badge: string }> = {
  pass:            { label: "Pass",           badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  monitor:         { label: "Monitor",        badge: "bg-blue-50 text-blue-700 border-blue-200" },
  action_required: { label: "Action Required", badge: "bg-amber-50 text-amber-700 border-amber-200" },
  urgent_action:   { label: "Urgent Action",  badge: "bg-rose-50 text-rose-700 border-rose-200" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error ?? `${res.status}`); }
  if (res.status === 204) return null;
  return res.json();
}

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function daysUntil(d: string | null) {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(d).getTime() - today.getTime()) / 86400000);
}

function ResultBadge({ result }: { result: string }) {
  const cfg = RESULT_CFG[result as CheckResult] ?? { label: result, badge: "bg-slate-50 text-slate-700 border-slate-200" };
  const Icon = result === "pass" ? CheckCircle2
    : result === "monitor" ? Clock
    : AlertTriangle;
  return (
    <Badge variant="outline" className={cfg.badge}>
      <Icon className="w-3 h-3 mr-1" /> {cfg.label}
    </Badge>
  );
}

function StatusBadge({ status }: { status: CheckStatus }) {
  if (status === "ok") return (
    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
      <CheckCircle2 className="w-3 h-3 mr-1" /> OK
    </Badge>
  );
  if (status === "due_soon") return (
    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
      <Clock className="w-3 h-3 mr-1" /> Due Soon
    </Badge>
  );
  if (status === "overdue") return (
    <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
      <AlertTriangle className="w-3 h-3 mr-1" /> Overdue
    </Badge>
  );
  return (
    <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200">
      <CalendarX className="w-3 h-3 mr-1" /> Never Done
    </Badge>
  );
}

const emptyForm = () => ({
  checkType: "visual_assessment" as CheckType,
  checkDate: new Date().toISOString().slice(0, 10),
  result: "pass" as CheckResult,
  treeRef: "",
  location: "",
  inspector: "",
  followUpDate: "",
  siteId: "",
  notes: "",
});

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TreeTrackPage() {
  const { toast } = useToast();
  const { activeClientId, hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const qc = useQueryClient();
  const hasTrees = hasService("treetrack");

  const [filterType, setFilterType] = useState<CheckType | "all">("all");
  const [filterSite, setFilterSite] = useState("all");
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<TreeInspection | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());

  // ── Data ───────────────────────────────────────────────────────────────────

  const { data: records = [], isLoading } = useQuery<TreeInspection[]>({
    queryKey: ["tree-track", activeClientId],
    queryFn: () => apiFetch("/tree-track"),
    enabled: !!activeClientId && hasTrees,
  });

  const { data: statuses = [] } = useQuery<StatusRow[]>({
    queryKey: ["tree-track-status", activeClientId],
    queryFn: () => apiFetch("/tree-track/status"),
    enabled: !!activeClientId && hasTrees,
    retry: (count, err: any) => err?.status !== 403 && count < 3,
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: () => apiFetch("/sites"),
    enabled: !!activeClientId,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const urgentCount = useMemo(
    () => records.filter(r => r.result === "urgent_action").length,
    [records],
  );
  const actionCount = useMemo(
    () => records.filter(r => r.result === "action_required").length,
    [records],
  );

  const filtered = useMemo(() => {
    let rows = records;
    if (filterType !== "all") rows = rows.filter(r => r.checkType === filterType);
    if (filterSite !== "all") rows = rows.filter(r => String(r.siteId) === filterSite);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        (r.treeRef ?? "").toLowerCase().includes(q) ||
        (r.location ?? "").toLowerCase().includes(q) ||
        (r.inspector ?? "").toLowerCase().includes(q) ||
        (r.notes ?? "").toLowerCase().includes(q) ||
        CHECK_TYPE_LABELS[r.checkType as CheckType]?.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [records, filterType, filterSite, search]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tree-track"] });
    qc.invalidateQueries({ queryKey: ["tree-track-status"] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/tree-track/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Record deleted" }); setDeleteId(null); },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ── Dialog ─────────────────────────────────────────────────────────────────

  function openAdd() {
    setEditItem(null);
    setForm(emptyForm());
    setShowDialog(true);
  }

  function openEdit(r: TreeInspection) {
    setEditItem(r);
    setForm({
      checkType: r.checkType as CheckType,
      checkDate: r.checkDate?.slice(0, 10) ?? "",
      result: r.result as CheckResult,
      treeRef: r.treeRef ?? "",
      location: r.location ?? "",
      inspector: r.inspector ?? "",
      followUpDate: r.followUpDate?.slice(0, 10) ?? "",
      siteId: r.siteId ? String(r.siteId) : "",
      notes: r.notes ?? "",
    });
    setShowDialog(true);
  }

  async function handleSave() {
    if (!form.checkDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body: any = {
        checkType: form.checkType,
        checkDate: form.checkDate,
        result: form.result,
        treeRef: form.treeRef.trim() || null,
        location: form.location.trim() || null,
        inspector: form.inspector.trim() || null,
        followUpDate: form.followUpDate || null,
        siteId: form.siteId ? Number(form.siteId) : null,
        notes: form.notes.trim() || null,
      };
      if (editItem) {
        const { checkType, ...updateBody } = body;
        await apiFetch(`/tree-track/${editItem.id}`, { method: "PUT", body: JSON.stringify(updateBody) });
        toast({ title: "Record updated" });
      } else {
        await apiFetch("/tree-track", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Inspection recorded" });
      }
      invalidate();
      setShowDialog(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Locked ─────────────────────────────────────────────────────────────────

  if (!hasTrees) {
    return (
      <AppLayout title="TreeTrack">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">TreeTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital tree inspection logbook — record visual assessments, detailed surveys, post-storm checks and remedial works in line with BS 3998:2010 and NTSG guidance.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button className="rounded-sm">Activate TreeTrack</Button>
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">Ask your administrator to activate this module.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <AppLayout title="TreeTrack">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground mt-1">
          Tree inspection logbook — visual assessments, detailed surveys, post-storm checks and remedial works records
        </p>
        <Button onClick={openAdd} className="gap-2 rounded-sm flex-shrink-0">
          <Plus className="w-4 h-4" /> Record Inspection
        </Button>
      </div>

      {/* Status overview */}
      {statuses.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {statuses.map(s => {
            const cfg = {
              ok:        { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", icon: CheckCircle2 },
              due_soon:  { bg: "bg-amber-50 border-amber-200",     text: "text-amber-700",   icon: Clock },
              overdue:   { bg: "bg-rose-50 border-rose-200",       text: "text-rose-700",    icon: AlertTriangle },
              never:     { bg: "bg-slate-50 border-slate-200",     text: "text-slate-500",   icon: CalendarX },
            }[s.status];
            const Icon = cfg.icon;
            const days = daysUntil(s.dueDate);
            return (
              <button
                key={s.checkType}
                onClick={() => setFilterType(filterType === s.checkType ? "all" : s.checkType as CheckType)}
                className={cn(
                  "p-3 rounded-sm border text-left transition-all hover:shadow-sm",
                  cfg.bg,
                  filterType === s.checkType && "ring-2 ring-offset-1 ring-primary"
                )}
              >
                <div className={cn("flex items-center gap-1 mb-1.5", cfg.text)}>
                  <Icon className="w-3.5 h-3.5" />
                  <StatusBadge status={s.status} />
                </div>
                <div className="text-xs font-medium text-foreground leading-snug">
                  {CHECK_TYPE_LABELS[s.checkType as CheckType] ?? s.checkType}
                </div>
                {s.dueDate && days !== null && (
                  <div className={cn("text-xs mt-1", cfg.text)}>
                    {s.status === "overdue"
                      ? `${Math.abs(days)}d overdue`
                      : s.status === "due_soon"
                      ? `Due in ${days}d`
                      : `Next ${fmt(s.dueDate)}`}
                  </div>
                )}
                {s.status === "never" && (
                  <div className="text-xs mt-1 text-slate-400">Not yet recorded</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Action banners */}
      {urgentCount > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-rose-50 border-rose-300 text-rose-800 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{urgentCount} record{urgentCount !== 1 ? "s" : ""}</strong> marked as <strong>Urgent Action</strong> — these trees require immediate attention.
          </span>
        </div>
      )}
      {actionCount > 0 && urgentCount === 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-amber-50 border-amber-300 text-amber-800 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{actionCount} record{actionCount !== 1 ? "s" : ""}</strong> marked as <strong>Action Required</strong> — schedule remedial works.
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {sites.length > 0 && (
          <Select value={filterSite} onValueChange={setFilterSite}>
            <SelectTrigger className="w-40 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterType} onValueChange={v => setFilterType(v as CheckType | "all")}>
          <SelectTrigger className="w-56 rounded-sm">
            <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All inspection types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All inspection types</SelectItem>
            {CHECK_TYPES.map(t => <SelectItem key={t} value={t}>{CHECK_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search tree ref, location, inspector…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 rounded-sm"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border rounded-sm">
          <TreePine className="w-9 h-9 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {records.length === 0
              ? "No tree inspection records yet. Record your first inspection above."
              : "No records match the current filter."}
          </p>
          {records.length === 0 && (
            <Button onClick={openAdd} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
              <Plus className="w-4 h-4" /> Record Inspection
            </Button>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                {["Inspection Type", "Date", "Result", "Tree Ref", "Location", "Inspector", "Follow-up", ""].map(h => (
                  <th key={h} className={cn(
                    "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                    h === "Tree Ref" && "hidden sm:table-cell",
                    h === "Location" && "hidden md:table-cell",
                    h === "Inspector" && "hidden lg:table-cell",
                    h === "Follow-up" && "hidden lg:table-cell",
                    h === "" && "w-20",
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(r => {
                const days = daysUntil(r.followUpDate);
                const followUpUrgent = days !== null && days <= 14;
                return (
                  <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-sm bg-green-100 flex items-center justify-center flex-shrink-0">
                          <TreePine className="w-3.5 h-3.5 text-green-700" />
                        </div>
                        <span className="font-medium">{CHECK_TYPE_LABELS[r.checkType as CheckType] ?? r.checkType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(r.checkDate)}</td>
                    <td className="px-4 py-3"><ResultBadge result={r.result} /></td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                      {r.treeRef ?? <span className="opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {r.location ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Building2 className="w-3 h-3 opacity-50" />{r.location}
                        </span>
                      ) : <span className="text-muted-foreground opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {r.inspector ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <UserCheck className="w-3 h-3 opacity-50" />{r.inspector}
                        </span>
                      ) : <span className="text-muted-foreground opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {r.followUpDate ? (
                        <span className={cn(
                          "flex items-center gap-1 text-sm",
                          followUpUrgent ? "text-amber-600 font-medium" : "text-muted-foreground"
                        )}>
                          <CalendarDays className="w-3 h-3 opacity-60" />
                          {fmt(r.followUpDate)}
                          {days !== null && days <= 0 && <span className="text-rose-600 text-xs">(overdue)</span>}
                        </span>
                      ) : <span className="text-muted-foreground opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={() => openEdit(r)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(r.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
            Showing {filtered.length} of {records.length} record{records.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* Guidance footer */}
      <div className="bg-green-50 border border-green-200 rounded-sm p-4 text-xs text-green-900">
        <p className="font-semibold mb-1">Regulatory guidance: BS 3998:2010 / NTSG / Occupiers' Liability Act</p>
        <p>Occupiers have a duty of care to ensure trees on their land do not pose an unreasonable risk to people or property. As a minimum, all trees should receive an annual visual tree assessment (VTA). Trees showing signs of structural defect, disease, or significant deadwood should be subject to a detailed inspection by a qualified arborist. All inspections and remedial works should be documented.</p>
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={showDialog} onOpenChange={v => { if (!saving) setShowDialog(v); }}>
        <DialogContent className="max-w-lg rounded-sm">
          <DialogHeader>
            <DialogTitle>{editItem ? "Edit Inspection Record" : "Record Tree Inspection"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">

            {/* Inspection type */}
            {!editItem ? (
              <div>
                <Label>Inspection Type *</Label>
                <Select value={form.checkType} onValueChange={v => setForm(f => ({ ...f, checkType: v as CheckType }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHECK_TYPES.map(t => <SelectItem key={t} value={t}>{CHECK_TYPE_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground italic mt-1">{CHECK_TYPE_HINTS[form.checkType]}</p>
              </div>
            ) : (
              <div className="px-3 py-2 bg-muted/40 rounded-sm text-sm text-muted-foreground">
                {CHECK_TYPE_LABELS[editItem.checkType as CheckType] ?? editItem.checkType}
              </div>
            )}

            {/* Date */}
            <div>
              <Label htmlFor="checkDate">Date *</Label>
              <Input id="checkDate" type="date" value={form.checkDate}
                onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Result */}
            <div>
              <Label>Result *</Label>
              <Select value={form.result} onValueChange={v => setForm(f => ({ ...f, result: v as CheckResult }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass — No significant concerns</SelectItem>
                  <SelectItem value="monitor">Monitor — Minor concerns, re-inspect</SelectItem>
                  <SelectItem value="action_required">Action Required — Works needed</SelectItem>
                  <SelectItem value="urgent_action">Urgent Action — Immediate risk</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Tree reference */}
            <div>
              <Label htmlFor="treeRef">Tree Reference / Tag</Label>
              <Input id="treeRef" placeholder="e.g. T1, Oak-North, Group A…"
                value={form.treeRef}
                onChange={e => setForm(f => ({ ...f, treeRef: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Location */}
            <div>
              <Label htmlFor="location">Location on Site</Label>
              <Input id="location" placeholder="e.g. Car park perimeter, East boundary, Front garden…"
                value={form.location}
                onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Inspector */}
            <div>
              <Label htmlFor="inspector">Inspector / Arborist</Label>
              <Input id="inspector" placeholder="Name or company"
                value={form.inspector}
                onChange={e => setForm(f => ({ ...f, inspector: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Site */}
            {sites.length > 0 && (
              <div>
                <Label>Site</Label>
                <Select value={form.siteId} onValueChange={v => setForm(f => ({ ...f, siteId: v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No specific site</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Follow-up date */}
            <div>
              <Label htmlFor="followUpDate">Follow-up / Re-inspection Date</Label>
              <Input id="followUpDate" type="date" value={form.followUpDate}
                onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Notes */}
            <div>
              <Label htmlFor="notes">Observations / Recommended Works</Label>
              <Textarea id="notes" placeholder="Describe findings, structural defects, deadwood, fungal bodies, recommended actions…"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="mt-1 rounded-sm" rows={3} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving} className="rounded-sm">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="rounded-sm">
              {saving ? "Saving…" : editItem ? "Save Changes" : "Record Inspection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete record?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the inspection record. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-sm bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
