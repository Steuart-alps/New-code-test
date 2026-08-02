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
  Waves, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX,
  Pencil, Trash2, Lock, ThermometerSun, Beaker, Search, Building2,
  Filter,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export const CHECK_TYPES = [
  "water_chemistry",
  "temperature",
  "filter_clean",
  "cover_inspection",
  "drain_refill",
  "microbiological_test",
  "risk_assessment",
] as const;

type CheckType = (typeof CHECK_TYPES)[number];
type CheckResult = "pass" | "fail" | "action_required";
type CheckStatus = "ok" | "due_soon" | "overdue" | "never";

interface HotTubCheck {
  id: number;
  clientId: number;
  siteId: number | null;
  checkType: string;
  checkDate: string;
  result: string;
  phValue: string | null;
  sanitiserLevel: string | null;
  temperature: string | null;
  location: string | null;
  performedBy: string | null;
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
  water_chemistry:       "Water chemistry test (pH & sanitiser)",
  temperature:           "Water temperature check",
  filter_clean:          "Filter clean / rinse",
  cover_inspection:      "Cover & seal inspection",
  drain_refill:          "Drain, clean & refill",
  microbiological_test:  "Microbiological water test",
  risk_assessment:       "HSG282 risk assessment review",
};

const CHECK_TYPE_HINTS: Record<CheckType, string> = {
  water_chemistry:       "pH 7.2–7.8 · Free chlorine 3–5 ppm (or bromine 4–6 ppm). Log at least twice daily when in use.",
  temperature:           "Must not exceed 40°C. Check and log daily. Maintain ≥35°C for bather comfort.",
  filter_clean:          "Rinse cartridge weekly; deep-clean monthly. Replace when visually degraded.",
  cover_inspection:      "Check cover is undamaged, seals intact and there is no excess heat loss.",
  drain_refill:          "Full drain and disinfect every 3 months, or sooner when TDS exceeds recommended levels.",
  microbiological_test:  "Quarterly water sample for bacteria count per PWTAG / HSG282 guidance.",
  risk_assessment:       "Annual review of the HSG282 / PWTAG spa pool risk assessment.",
};

const FREQ_LABELS: Record<CheckType, string> = {
  water_chemistry:       "Daily",
  temperature:           "Daily",
  filter_clean:          "Weekly",
  cover_inspection:      "Weekly",
  drain_refill:          "Quarterly",
  microbiological_test:  "Quarterly",
  risk_assessment:       "Annual",
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
  if (result === "pass") return (
    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
      <CheckCircle2 className="w-3 h-3 mr-1" /> Pass
    </Badge>
  );
  if (result === "action_required") return (
    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
      <AlertTriangle className="w-3 h-3 mr-1" /> Action Required
    </Badge>
  );
  return (
    <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
      <AlertTriangle className="w-3 h-3 mr-1" /> Fail
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
      <CalendarX className="w-3 h-3 mr-1" /> Never
    </Badge>
  );
}

// ─── Empty form ───────────────────────────────────────────────────────────────

const emptyForm = () => ({
  checkType: "water_chemistry" as CheckType,
  checkDate: new Date().toISOString().slice(0, 10),
  result: "pass" as CheckResult,
  phValue: "",
  sanitiserLevel: "",
  temperature: "",
  siteId: "",
  location: "",
  performedBy: "",
  notes: "",
});

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HotTubPage() {
  const { toast } = useToast();
  const { activeClientId, hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const qc = useQueryClient();
  const hasHotTub = hasService("hottubtrack");

  const [filterType, setFilterType] = useState<CheckType | "all">("all");
  const [filterSite, setFilterSite] = useState("all");
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<HotTubCheck | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());

  // ── Data ───────────────────────────────────────────────────────────────────

  const { data: checks = [], isLoading } = useQuery<HotTubCheck[]>({
    queryKey: ["hot-tub-checks", activeClientId],
    queryFn: () => apiFetch("/hot-tub"),
    enabled: !!activeClientId && hasHotTub,
  });

  const { data: statuses = [] } = useQuery<StatusRow[]>({
    queryKey: ["hot-tub-status", activeClientId],
    queryFn: () => apiFetch("/hot-tub/status"),
    enabled: !!activeClientId && hasHotTub,
    retry: (count, err: any) => err?.status !== 403 && count < 3,
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: () => apiFetch("/sites"),
    enabled: !!activeClientId,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const overdue = useMemo(() => statuses.filter(s => s.status === "overdue").length, [statuses]);
  const dueSoon = useMemo(() => statuses.filter(s => s.status === "due_soon").length, [statuses]);

  const filtered = useMemo(() => {
    let rows = checks;
    if (filterType !== "all") rows = rows.filter(r => r.checkType === filterType);
    if (filterSite !== "all") rows = rows.filter(r => String(r.siteId) === filterSite);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        CHECK_TYPE_LABELS[r.checkType as CheckType]?.toLowerCase().includes(q) ||
        (r.location ?? "").toLowerCase().includes(q) ||
        (r.performedBy ?? "").toLowerCase().includes(q) ||
        (r.notes ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [checks, filterType, filterSite, search]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["hot-tub-checks"] });
    qc.invalidateQueries({ queryKey: ["hot-tub-status"] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/hot-tub/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Record deleted" }); setDeleteId(null); },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ── Dialog ─────────────────────────────────────────────────────────────────

  function openAdd() {
    setEditItem(null);
    setForm(emptyForm());
    setShowDialog(true);
  }

  function openEdit(r: HotTubCheck) {
    setEditItem(r);
    setForm({
      checkType: r.checkType as CheckType,
      checkDate: r.checkDate?.slice(0, 10) ?? "",
      result: r.result as CheckResult,
      phValue: r.phValue ?? "",
      sanitiserLevel: r.sanitiserLevel ?? "",
      temperature: r.temperature ?? "",
      siteId: r.siteId ? String(r.siteId) : "",
      location: r.location ?? "",
      performedBy: r.performedBy ?? "",
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
        phValue: form.phValue !== "" ? parseFloat(form.phValue) : null,
        sanitiserLevel: form.sanitiserLevel !== "" ? parseFloat(form.sanitiserLevel) : null,
        temperature: form.temperature !== "" ? parseFloat(form.temperature) : null,
        siteId: form.siteId ? Number(form.siteId) : null,
        location: form.location.trim() || null,
        performedBy: form.performedBy.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (editItem) {
        const { checkType, ...updateBody } = body;
        await apiFetch(`/hot-tub/${editItem.id}`, { method: "PUT", body: JSON.stringify(updateBody) });
        toast({ title: "Record updated" });
      } else {
        await apiFetch("/hot-tub", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Record saved" });
      }
      invalidate();
      setShowDialog(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Locked / upsell ────────────────────────────────────────────────────────

  if (!hasHotTub) {
    return (
      <AppLayout title="TubTrack">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">TubTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital hot tub & spa pool maintenance logbook — daily water chemistry, temperature, filter and drain records based on HSG282 and PWTAG guidance.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button className="rounded-sm">Activate TubTrack</Button>
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

  const isChemCheck = form.checkType === "water_chemistry";
  const isTempCheck = form.checkType === "temperature" || form.checkType === "water_chemistry";

  return (
    <AppLayout title="HotTubTrack">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground mt-1">
            Hot tub & spa maintenance logbook — water chemistry, temperature checks and HSG282 compliance
          </p>
        </div>
        <Button onClick={openAdd} className="gap-2 rounded-sm flex-shrink-0">
          <Plus className="w-4 h-4" /> Record Check
        </Button>
      </div>

      {/* Status overview */}
      {statuses.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
          {statuses.map(s => {
            const statusCfg = {
              ok:        { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", icon: CheckCircle2 },
              due_soon:  { bg: "bg-amber-50 border-amber-200",   text: "text-amber-700",   icon: Clock },
              overdue:   { bg: "bg-rose-50 border-rose-200",     text: "text-rose-700",    icon: AlertTriangle },
              never:     { bg: "bg-slate-50 border-slate-200",   text: "text-slate-500",   icon: CalendarX },
            }[s.status];
            const Icon = statusCfg.icon;
            return (
              <button
                key={s.checkType}
                onClick={() => setFilterType(filterType === s.checkType ? "all" : s.checkType as CheckType)}
                className={cn(
                  "p-3 rounded-sm border text-left transition-all hover:shadow-sm",
                  statusCfg.bg,
                  filterType === s.checkType && "ring-2 ring-offset-1 ring-primary"
                )}
              >
                <div className={cn("flex items-center gap-1 mb-1", statusCfg.text)}>
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                </div>
                <div className="text-xs font-medium text-foreground leading-snug line-clamp-2">
                  {CHECK_TYPE_LABELS[s.checkType as CheckType] ?? s.checkType}
                </div>
                <div className={cn("text-xs mt-1", statusCfg.text)}>
                  {FREQ_LABELS[s.checkType as CheckType]}
                  {s.dueDate && (
                    <span className="block">
                      {s.status === "overdue"
                        ? `${Math.abs(daysUntil(s.dueDate) ?? 0)}d overdue`
                        : s.status === "due_soon"
                        ? `Due in ${daysUntil(s.dueDate)}d`
                        : `Next ${fmt(s.dueDate)}`}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Alert banner */}
      {(overdue > 0 || dueSoon > 0) && (
        <div className={cn(
          "flex items-start gap-3 px-4 py-3 rounded-sm border text-sm",
          overdue > 0 ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-amber-50 border-amber-200 text-amber-800"
        )}>
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            {overdue > 0
              ? `${overdue} check type${overdue !== 1 ? "s are" : " is"} overdue.`
              : `${dueSoon} check type${dueSoon !== 1 ? "s are" : " is"} due soon.`}{" "}
            Review the maintenance schedule above.
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {sites.length > 0 && (
          <Select value={filterSite} onValueChange={setFilterSite}>
            <SelectTrigger className="w-40 rounded-sm">
              <SelectValue placeholder="All sites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterType} onValueChange={v => setFilterType(v as CheckType | "all")}>
          <SelectTrigger className="w-52 rounded-sm">
            <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All check types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All check types</SelectItem>
            {CHECK_TYPES.map(t => <SelectItem key={t} value={t}>{CHECK_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search…"
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
          <Waves className="w-9 h-9 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {checks.length === 0
              ? "No tub records yet. Record your first check above."
              : "No records match the current filter."}
          </p>
          {checks.length === 0 && (
            <Button onClick={openAdd} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
              <Plus className="w-4 h-4" /> Record Check
            </Button>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                {["Check Type", "Date", "Result", "pH", "Sanitiser (ppm)", "Temp (°C)", "Location", "Performed By", ""].map(h => (
                  <th key={h} className={cn(
                    "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                    ["pH", "Sanitiser (ppm)", "Temp (°C)"].includes(h) && "hidden lg:table-cell",
                    h === "Location" && "hidden md:table-cell",
                    h === "Performed By" && "hidden sm:table-cell",
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(r => (
                <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-sm bg-cyan-100 flex items-center justify-center flex-shrink-0">
                        <Waves className="w-3.5 h-3.5 text-cyan-600" />
                      </div>
                      <span className="font-medium">{CHECK_TYPE_LABELS[r.checkType as CheckType] ?? r.checkType}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(r.checkDate)}</td>
                  <td className="px-4 py-3"><ResultBadge result={r.result} /></td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{r.phValue ?? <span className="opacity-40">—</span>}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{r.sanitiserLevel ?? <span className="opacity-40">—</span>}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {r.temperature ? (
                      <span className="flex items-center gap-1">
                        <ThermometerSun className="w-3 h-3" />{r.temperature}°C
                      </span>
                    ) : <span className="opacity-40">—</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                    {r.location ? (
                      <span className="flex items-center gap-1">
                        <Building2 className="w-3 h-3 opacity-50" />{r.location}
                      </span>
                    ) : <span className="opacity-40">—</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{r.performedBy ?? <span className="opacity-40">—</span>}</td>
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
              ))}
            </tbody>
          </table>
          <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
            Showing {filtered.length} of {checks.length} record{checks.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* HSG282 guidance footer */}
      <div className="bg-cyan-50 border border-cyan-200 rounded-sm p-4 text-xs text-cyan-900">
        <p className="font-semibold mb-1">Regulatory guidance: HSG282 / PWTAG</p>
        <p>Hot tub and spa pool water must be tested at least twice daily when in use. pH should be maintained between 7.2 and 7.8. Free chlorine should be 3–5 ppm (or bromine 4–6 ppm). Water temperature must not exceed 40°C. Full drain and disinfect is required every 3 months or when TDS exceeds safe levels.</p>
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={showDialog} onOpenChange={v => { if (!saving) setShowDialog(v); }}>
        <DialogContent className="max-w-lg rounded-sm">
          <DialogHeader>
            <DialogTitle>{editItem ? "Edit Record" : "Record Tub / Spa Check"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">

            {/* Check type — only on new record */}
            {!editItem && (
              <div>
                <Label>Check Type *</Label>
                <Select value={form.checkType} onValueChange={v => setForm(f => ({ ...f, checkType: v as CheckType }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHECK_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{CHECK_TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground italic mt-1">{CHECK_TYPE_HINTS[form.checkType]}</p>
              </div>
            )}

            {editItem && (
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
                  <SelectItem value="pass">Pass</SelectItem>
                  <SelectItem value="fail">Fail</SelectItem>
                  <SelectItem value="action_required">Action Required</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Water chemistry fields */}
            {isChemCheck && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="phValue">
                    <Beaker className="w-3.5 h-3.5 inline mr-1 opacity-60" />pH (7.2–7.8)
                  </Label>
                  <Input id="phValue" type="number" step="0.1" min="0" max="14"
                    value={form.phValue}
                    onChange={e => setForm(f => ({ ...f, phValue: e.target.value }))}
                    placeholder="e.g. 7.4"
                    className="mt-1 rounded-sm" />
                </div>
                <div>
                  <Label htmlFor="sanitiserLevel">Sanitiser (ppm)</Label>
                  <Input id="sanitiserLevel" type="number" step="0.1" min="0"
                    value={form.sanitiserLevel}
                    onChange={e => setForm(f => ({ ...f, sanitiserLevel: e.target.value }))}
                    placeholder="e.g. 4.0"
                    className="mt-1 rounded-sm" />
                </div>
              </div>
            )}

            {/* Temperature */}
            {isTempCheck && (
              <div>
                <Label htmlFor="temperature">
                  <ThermometerSun className="w-3.5 h-3.5 inline mr-1 opacity-60" />Temperature (°C)
                </Label>
                <Input id="temperature" type="number" step="0.1" min="0" max="50"
                  value={form.temperature}
                  onChange={e => setForm(f => ({ ...f, temperature: e.target.value }))}
                  placeholder="e.g. 38.5"
                  className="mt-1 rounded-sm" />
              </div>
            )}

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

            {/* Location */}
            <div>
              <Label htmlFor="location">Tub / Pool Name</Label>
              <Input id="location" placeholder="e.g. Spa 1, Outdoor Tub, Main Pool…"
                value={form.location}
                onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Performed by */}
            <div>
              <Label htmlFor="performedBy">Performed By</Label>
              <Input id="performedBy" placeholder="Name of staff member"
                value={form.performedBy}
                onChange={e => setForm(f => ({ ...f, performedBy: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Notes */}
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" placeholder="Corrective actions taken, observations…"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="mt-1 rounded-sm" rows={2} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving} className="rounded-sm">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="rounded-sm">
              {saving ? "Saving…" : editItem ? "Save Changes" : "Record Check"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete record?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the record. This cannot be undone.</AlertDialogDescription>
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
