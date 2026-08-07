import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { apiFetch as sharedApiFetch } from "@/lib/api";
import { useFormOptions, pickOptions } from "@/hooks/use-form-options";
import { FormOptionsEditor } from "@/components/form-options-editor";
import {
  Building2, Plus, CheckCircle2, Clock, Pencil, Trash2,
  Search, X, Printer, ClipboardCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, parseISO, isValid } from "date-fns";

// ─── Constants ─────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  routine:      "Routine inspection",
  hazard:       "Hazard / slip-trip-fall",
  fault:        "Maintenance fault",
  housekeeping: "Housekeeping",
  signage:      "Signage",
};

const STATUSES = ["open", "actioned", "closed"] as const;
const STATUS_LABELS: Record<string, string> = {
  open: "Open", actioned: "Actioned", closed: "Closed",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Route every PremisesTrack request through the shared, active-client-aware
// apiFetch helper so the consultant's currently-selected clientId is attached
// (matching the established pattern used by the other module pages). The
// clientId is appended to the query string so it is honoured on GET reads and
// POST/PUT/DELETE mutations alike.
function usePremisesApi() {
  const { activeClientId } = useAuth();
  return async function call<T = any>(path: string, opts?: RequestInit): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const suffix = activeClientId ? `${sep}clientId=${activeClientId}` : "";
    const res = await sharedApiFetch(`/premises-track${path}${suffix}`, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? `Request failed (${res.status})`);
    }
    if (res.status === 204) return null as T;
    return res.json();
  };
}

function fmt(d: string | null | undefined) {
  if (!d) return null;
  const p = parseISO(d);
  return isValid(p) ? format(p, "dd MMM yyyy") : null;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(
      "rounded-sm text-xs font-medium",
      status === "open"     && "border-amber-300 text-amber-700 bg-amber-50",
      status === "actioned" && "border-blue-300 text-blue-700 bg-blue-50",
      status === "closed"   && "border-green-300 text-green-700 bg-green-50",
    )}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PremisesInspection {
  id: number;
  client_id: number;
  site_id: number | null;
  inspection_date: string;
  inspection_type: string;
  area: string | null;
  findings: string | null;
  hazard_details: string | null;
  action_required: string | null;
  action_taken: string | null;
  status: string;
  inspected_by: string | null;
  created_at: string;
}

interface PremisesSummary {
  open: number;
  actioned: number;
  closed: number;
  overdue: number;
  total: number;
}

// ─── InspectionDialog ───────────────────────────────────────────────────────────

function InspectionDialog({ open, inspection, onClose, onSaved, sites }: {
  open: boolean;
  inspection: PremisesInspection | null;
  onClose: () => void;
  onSaved: () => void;
  sites: { id: number; name: string }[];
}) {
  const { toast } = useToast();
  const apiFetch = usePremisesApi();
  const { data: formOptions } = useFormOptions();
  const inspectionTypes = pickOptions(formOptions, "premises_inspection_types");
  const isEdit = !!inspection;
  const [saving, setSaving] = useState(false);
  // Keep the record's stored type selectable even if it was later removed from
  // the effective list, so editing other fields doesn't force a type change.
  const currentType = inspection?.inspection_type;
  const formInspectionTypes = currentType && !inspectionTypes.includes(currentType)
    ? [...inspectionTypes, currentType]
    : inspectionTypes;
  const [form, setForm] = useState(() => ({
    inspectionDate: inspection?.inspection_date ?? new Date().toISOString().slice(0, 10),
    inspectionType: inspection?.inspection_type ?? "routine",
    area:           inspection?.area ?? "",
    findings:       inspection?.findings ?? "",
    hazardDetails:  inspection?.hazard_details ?? "",
    actionRequired: inspection?.action_required ?? "",
    actionTaken:    inspection?.action_taken ?? "",
    status:         inspection?.status ?? "open",
    inspectedBy:    inspection?.inspected_by ?? "",
    siteId:         String(inspection?.site_id ?? ""),
  }));

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.inspectionDate) { toast({ title: "Inspection date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const payload = {
        inspectionDate: form.inspectionDate,
        inspectionType: form.inspectionType,
        area:           form.area || null,
        findings:       form.findings || null,
        hazardDetails:  form.hazardDetails || null,
        actionRequired: form.actionRequired || null,
        actionTaken:    form.actionTaken || null,
        status:         form.status,
        inspectedBy:    form.inspectedBy || null,
        siteId:         form.siteId ? parseInt(form.siteId, 10) : null,
      };
      if (isEdit) {
        await apiFetch(`/${inspection.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/", { method: "POST", body: JSON.stringify(payload) });
      }
      toast({ title: isEdit ? "Inspection updated" : "Inspection logged" });
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
            <ClipboardCheck className="w-4 h-4" />
            {isEdit ? "Edit inspection" : "Log premises inspection"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>Inspection date <span className="text-destructive">*</span></Label>
            <Input type="date" value={form.inspectionDate} onChange={set("inspectionDate")} className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={form.inspectionType} onValueChange={v => setForm(f => ({ ...f, inspectionType: v }))}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {formInspectionTypes.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t] ?? t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Area / location</Label>
            <Input value={form.area} onChange={set("area")} placeholder="e.g. Reception, stairwell, car park" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Inspected by</Label>
            <Input value={form.inspectedBy} onChange={set("inspectedBy")} placeholder="Staff name" className="rounded-sm" />
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
            <Label>Status</Label>
            <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Findings</Label>
            <Textarea rows={2} value={form.findings} onChange={set("findings")} placeholder="What was observed during the inspection" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Hazard details</Label>
            <Textarea rows={2} value={form.hazardDetails} onChange={set("hazardDetails")} placeholder="Describe any hazard identified (slip, trip, fall, obstruction, etc.)" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Action required</Label>
            <Textarea rows={2} value={form.actionRequired} onChange={set("actionRequired")} placeholder="Remedial action needed" className="rounded-sm" />
          </div>
          <div className="col-span-full space-y-1.5">
            <Label>Action taken</Label>
            <Textarea rows={2} value={form.actionTaken} onChange={set("actionTaken")} placeholder="What was done in response" className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Log inspection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function PremisesTrackPage() {
  const { user, activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiFetch = usePremisesApi();
  const { data: formOptions } = useFormOptions();
  const inspectionTypes = pickOptions(formOptions, "premises_inspection_types");

  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter]     = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [siteFilter, setSiteFilter]     = useState<string>("all");
  const [fromDate, setFromDate]         = useState("");
  const [toDate, setToDate]             = useState("");

  const [dialog, setDialog]         = useState(false);
  const [editItem, setEditItem]     = useState<PremisesInspection | null>(null);
  const [deleteId, setDeleteId]     = useState<number | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────

  const listParams = () => {
    const p = new URLSearchParams();
    if (fromDate) p.set("from", fromDate);
    if (toDate) p.set("to", toDate);
    if (siteFilter !== "all") p.set("siteId", siteFilter);
    if (typeFilter !== "all") p.set("type", typeFilter);
    if (statusFilter !== "all") p.set("status", statusFilter);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const { data: summary } = useQuery<PremisesSummary>({
    queryKey: ["/api/premises-track/summary", activeClientId],
    queryFn: () => apiFetch("/summary"),
  });

  const { data: inspections = [] } = useQuery<PremisesInspection[]>({
    queryKey: ["/api/premises-track", activeClientId, fromDate, toDate, siteFilter, typeFilter, statusFilter],
    queryFn: () => apiFetch(`/${listParams()}`),
  });

  const { data: sites = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/sites", activeClientId],
    queryFn: async () => {
      const res = await sharedApiFetch(`/sites${activeClientId ? `?clientId=${activeClientId}` : ""}`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/premises-track/summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/premises-track"] });
  };

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await apiFetch(`/${deleteId}`, { method: "DELETE" });
      toast({ title: "Inspection deleted" });
      refetchAll();
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally { setDeleteId(null); }
  };

  const setStatus = async (row: PremisesInspection, status: string) => {
    try {
      await apiFetch(`/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          inspectionDate: row.inspection_date,
          inspectionType: row.inspection_type,
          area:           row.area,
          findings:       row.findings,
          hazardDetails:  row.hazard_details,
          actionRequired: row.action_required,
          actionTaken:    row.action_taken,
          status,
          inspectedBy:    row.inspected_by,
          siteId:         row.site_id,
        }),
      });
      toast({ title: `Marked ${STATUS_LABELS[status] ?? status}` });
      refetchAll();
    } catch (err: any) {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    }
  };

  // ── Filtered list (text search on client) ────────────────────────────────────

  const filtered = inspections.filter(r =>
    !q || [r.area, r.findings, r.hazard_details, r.action_required, r.action_taken, r.inspected_by]
      .some(s => s?.toLowerCase().includes(q.toLowerCase()))
  );

  const today = new Date().toISOString().slice(0, 10);

  // ── Export printable register ─────────────────────────────────────────────────

  const siteName = (id: number | null) =>
    id == null ? "All sites" : sites.find(s => s.id === id)?.name ?? `Site #${id}`;

  const esc = (s: string | null | undefined) =>
    (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const handleExportLog = () => {
    const sorted = [...inspections].sort((a, b) => (a.inspection_date < b.inspection_date ? 1 : -1));
    const openCount = inspections.filter(r => r.status === "open").length;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Premises Safety Logbook</title>
<style>
  body { font-family: Georgia, serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 24px 0 8px; border-bottom: 1px solid #999; padding-bottom: 4px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-top: 6px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0ede2; font-weight: bold; }
  .empty { font-size: 11px; color: #777; font-style: italic; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<h1>Premises Safety Logbook</h1>
<div class="meta">${esc(user?.name ?? "")} — generated ${format(new Date(), "dd MMM yyyy")} — premises safety inspection register</div>
<div class="meta">Inspections: ${sorted.length} (${openCount} open)</div>

<h2>Inspection records</h2>
${sorted.length === 0 ? `<p class="empty">No inspections recorded.</p>` : `<table>
<tr><th>Date</th><th>Site</th><th>Type</th><th>Area</th><th>Findings</th><th>Hazard</th><th>Action required</th><th>Action taken</th><th>Inspected by</th><th>Status</th></tr>
${sorted.map(r => `<tr>
  <td>${fmt(r.inspection_date) ?? esc(r.inspection_date)}</td>
  <td>${esc(siteName(r.site_id))}</td>
  <td>${esc(TYPE_LABELS[r.inspection_type] ?? r.inspection_type)}</td>
  <td>${esc(r.area)}</td>
  <td>${esc(r.findings)}</td>
  <td>${esc(r.hazard_details)}</td>
  <td>${esc(r.action_required)}</td>
  <td>${esc(r.action_taken)}</td>
  <td>${esc(r.inspected_by)}</td>
  <td>${esc(STATUS_LABELS[r.status] ?? r.status)}</td>
</tr>`).join("")}
</table>`}
</body></html>`;
    const win = window.open("", "_blank");
    if (!win) {
      toast({ title: "Pop-up blocked", description: "Allow pop-ups for this site to export the logbook.", variant: "destructive" });
      return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  };

  return (
    <AppLayout title="PremisesTrack">
      <div className="space-y-6">

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-sm bg-violet-50 border border-violet-200 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-violet-700" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">PremisesTrack</h1>
              <p className="text-xs text-muted-foreground">Digital premises safety logbook</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <FormOptionsEditor
              optionKey="premises_inspection_types"
              title="Inspection types"
              triggerLabel="Customise types"
              labelFor={v => TYPE_LABELS[v] ?? v}
            />
            <Button variant="outline" size="sm" className="rounded-sm gap-1.5 h-8 text-xs"
              onClick={handleExportLog}
              title="Print or save the full premises safety logbook">
              <Printer className="w-3.5 h-3.5" /> Export logbook
            </Button>
            <Button size="sm" className="rounded-sm gap-1.5 h-8 text-xs"
              onClick={() => { setEditItem(null); setDialog(true); }}>
              <Plus className="w-3.5 h-3.5" /> Log inspection
            </Button>
          </div>
        </div>

        {/* ── Summary cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className={cn("border rounded-sm p-4", (summary?.open ?? 0) > 0 ? "border-amber-300 bg-amber-50" : "border-border")}>
            <p className={cn("text-xs mb-1", (summary?.open ?? 0) > 0 ? "text-amber-700" : "text-muted-foreground")}>Open</p>
            <p className={cn("text-2xl font-bold", (summary?.open ?? 0) > 0 ? "text-amber-800" : "")}>{summary?.open ?? 0}</p>
            <p className="text-xs text-muted-foreground">awaiting action</p>
          </div>
          <div className="border border-border rounded-sm p-4">
            <p className="text-xs text-muted-foreground mb-1">Actioned</p>
            <p className="text-2xl font-bold text-blue-700">{summary?.actioned ?? 0}</p>
            <p className="text-xs text-muted-foreground">in progress</p>
          </div>
          <div className="border border-border rounded-sm p-4">
            <p className="text-xs text-muted-foreground mb-1">Closed</p>
            <p className="text-2xl font-bold text-green-700">{summary?.closed ?? 0}</p>
            <p className="text-xs text-muted-foreground">resolved</p>
          </div>
          <div className={cn("border rounded-sm p-4", (summary?.overdue ?? 0) > 0 ? "border-red-300 bg-red-50" : "border-border")}>
            <p className={cn("text-xs mb-1", (summary?.overdue ?? 0) > 0 ? "text-red-600" : "text-muted-foreground")}>Overdue</p>
            <p className={cn("text-2xl font-bold", (summary?.overdue ?? 0) > 0 ? "text-red-700" : "")}>{summary?.overdue ?? 0}</p>
            <p className="text-xs text-muted-foreground">open &amp; past due</p>
          </div>
        </div>

        {/* ── Filters ──────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
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
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="rounded-sm h-8 text-xs w-40"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {inspectionTypes.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t] ?? t}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="rounded-sm h-8 text-xs w-32"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          {sites.length > 0 && (
            <Select value={siteFilter} onValueChange={setSiteFilter}>
              <SelectTrigger className="rounded-sm h-8 text-xs w-36"><SelectValue placeholder="All sites" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sites</SelectItem>
                {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="rounded-sm h-8 text-xs w-36" title="From date" />
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="rounded-sm h-8 text-xs w-36" title="To date" />
          {(fromDate || toDate || typeFilter !== "all" || statusFilter !== "all" || siteFilter !== "all") && (
            <Button variant="ghost" size="sm" className="rounded-sm h-8 text-xs"
              onClick={() => { setFromDate(""); setToDate(""); setTypeFilter("all"); setStatusFilter("all"); setSiteFilter("all"); }}>
              Clear filters
            </Button>
          )}
        </div>

        {/* ── List ─────────────────────────────────────────────────────────── */}
        {filtered.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center">
            <Building2 className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">
              {q ? "No inspections match your search" : "No inspections logged yet"}
            </p>
            {!q && (
              <p className="text-xs text-muted-foreground mt-1">
                Log your first premises safety inspection to start building your logbook.
              </p>
            )}
            {!q && (
              <Button size="sm" className="rounded-sm mt-4 gap-1.5 text-xs" onClick={() => { setEditItem(null); setDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log inspection
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
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden sm:table-cell">Area</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hidden md:table-cell">Findings</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-2.5 w-40"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const isOverdue = r.status === "open" && r.inspection_date <= today;
                  return (
                    <tr key={r.id} className={cn("group border-t border-border hover:bg-muted/20", i === 0 && "border-t-0")}>
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium">{fmt(r.inspection_date)}</p>
                        {r.inspected_by && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[120px]">{r.inspected_by}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs">{TYPE_LABELS[r.inspection_type] ?? r.inspection_type}</td>
                      <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">
                        {r.area ?? <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <p className="text-xs text-muted-foreground line-clamp-2 max-w-xs">
                          {r.findings ?? r.hazard_details ?? <span className="text-muted-foreground/40">—</span>}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={r.status} />
                        {isOverdue && <span className="ml-1.5 text-[10px] font-bold uppercase text-red-600">Overdue</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                          {!canAdmin ? null : (
                            <>
                              {r.status !== "actioned" && (
                                <Button variant="ghost" size="sm" className="h-7 rounded-sm text-xs text-blue-700 hover:bg-blue-50"
                                  onClick={() => setStatus(r, "actioned")} title="Mark actioned">
                                  <Clock className="w-3.5 h-3.5" />
                                </Button>
                              )}
                              {r.status !== "closed" && (
                                <Button variant="ghost" size="sm" className="h-7 rounded-sm text-xs text-green-700 hover:bg-green-50"
                                  onClick={() => setStatus(r, "closed")} title="Mark closed">
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                onClick={() => { setEditItem(r); setDialog(true); }}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteId(r.id)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </>
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
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────────── */}
      <InspectionDialog
        open={dialog}
        inspection={editItem}
        sites={sites}
        onSaved={refetchAll}
        onClose={() => { setDialog(false); setEditItem(null); }}
      />

      {/* ── Confirm delete ───────────────────────────────────────────────────── */}
      <AlertDialog open={!!deleteId} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete inspection record?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="rounded-sm bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
