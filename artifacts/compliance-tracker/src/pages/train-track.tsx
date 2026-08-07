import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/auth-context";
import {
  Award,
  CheckSquare,
  Hammer,
  Plus,
  Search,
  Pencil,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Minus,
  User,
  CalendarDays,
  Building2,
  BookOpen,
  ShieldCheck,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SignaturePad } from "@/components/signature-pad";

// ─── Types ────────────────────────────────────────────────────────────────────

type RecordType = "certificate" | "signoff" | "internal";

interface TrainingRecord {
  id: number;
  client_id: number;
  site_id: number | null;
  site_name: string | null;
  record_type: RecordType;
  staff_name: string;
  training_type: string | null;
  document_title: string | null;
  document_type: string | null;
  provider: string | null;
  trainer: string | null;
  completed_date: string;
  expiry_date: string | null;
  notes: string | null;
  created_at: string;
}

interface Site {
  id: number;
  name: string;
}

type CertStatus = "expired" | "expiring_soon" | "valid" | "no_expiry";

// ─── Constants ────────────────────────────────────────────────────────────────

const TRAINING_TYPES = [
  "Fire Safety Awareness",
  "Food Hygiene (Level 2)",
  "Food Hygiene (Level 3)",
  "Manual Handling",
  "First Aid at Work",
  "Emergency First Aid at Work",
  "COSHH Awareness",
  "Health & Safety Induction",
  "Working at Height",
  "RIDDOR Awareness",
  "Asbestos Awareness",
  "Display Screen Equipment (DSE)",
  "Other",
];

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  risk_assessment: "Risk Assessment",
  sop: "SOP",
  policy: "Policy",
  procedure: "Procedure",
  other: "Other",
};

const STATUS_CFG = {
  expired:       { label: "Expired",       badge: "bg-red-100 text-red-700 border-red-200",     dot: "bg-red-500",    icon: AlertTriangle, text: "text-red-600" },
  expiring_soon: { label: "Expiring Soon",  badge: "bg-amber-100 text-amber-700 border-amber-200", dot: "bg-amber-500", icon: Clock,          text: "text-amber-600" },
  valid:         { label: "Valid",          badge: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", icon: CheckCircle2, text: "text-emerald-600" },
  no_expiry:     { label: "No Expiry",      badge: "bg-slate-100 text-slate-500 border-slate-200", dot: "bg-slate-400", icon: Minus,           text: "text-slate-500" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCertStatus(expiryDate: string | null): CertStatus {
  if (!expiryDate) return "no_expiry";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(expiryDate);
  if (exp < today) return "expired";
  const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
  if (exp <= in30) return "expiring_soon";
  return "valid";
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function daysUntil(d: string | null) {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(d).getTime() - today.getTime()) / 86400000);
}

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

// ─── Empty forms ──────────────────────────────────────────────────────────────

const emptyCert     = () => ({ staffName: "", trainingType: "", customType: "", provider: "", completedDate: "", expiryDate: "", siteId: "", notes: "", signature: null as string | null });
const emptySignoff  = () => ({ staffName: "", documentTitle: "", documentType: "", completedDate: "", siteId: "", notes: "", signature: null as string | null });
const emptyInternal = () => ({ staffName: "", trainingType: "", customType: "", trainer: "", completedDate: "", siteId: "", notes: "", signature: null as string | null });

// ─── Sub-components ───────────────────────────────────────────────────────────

function SiteName({ record }: { record: TrainingRecord }) {
  if (!record.site_name) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <Building2 className="w-3 h-3 opacity-50 flex-shrink-0" />
      {record.site_name}
    </span>
  );
}

function ActionsCell({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={onEdit}>
        <Pencil className="w-3.5 h-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10" onClick={onDelete}>
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TrainTrackPage() {
  const { toast } = useToast();
  const { activeClientId } = useAuth();
  const qc = useQueryClient();

  const [tab, setTab]           = useState<RecordType>("certificate");
  const [siteFilter, setSite]   = useState("all");
  const [search, setSearch]     = useState("");
  const [certStatus, setCertStatus] = useState<"all" | CertStatus>("all");

  const [showDialog, setShowDialog]   = useState(false);
  const [editRecord, setEditRecord]   = useState<TrainingRecord | null>(null);
  const [deleteId, setDeleteId]       = useState<number | null>(null);
  const [saving, setSaving]           = useState(false);

  // forms per type
  const [certForm,     setCertForm]     = useState(emptyCert());
  const [signoffForm,  setSignoffForm]  = useState(emptySignoff());
  const [internalForm, setInternalForm] = useState(emptyInternal());

  // ── Data ───────────────────────────────────────────────────────────────────

  const { data: allRecords = [], isLoading } = useQuery<TrainingRecord[]>({
    queryKey: ["train-track-records", activeClientId],
    queryFn: () => apiFetch("/train-track/records"),
    enabled: !!activeClientId,
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: () => apiFetch("/sites"),
    enabled: !!activeClientId,
  });

  // split by type
  const certs     = useMemo(() => allRecords.filter(r => r.record_type === "certificate"), [allRecords]);
  const signoffs  = useMemo(() => allRecords.filter(r => r.record_type === "signoff"),     [allRecords]);
  const internals = useMemo(() => allRecords.filter(r => r.record_type === "internal"),    [allRecords]);

  // cert expiry counts
  const certCounts = useMemo(() => ({
    expired:       certs.filter(r => getCertStatus(r.expiry_date) === "expired").length,
    expiring_soon: certs.filter(r => getCertStatus(r.expiry_date) === "expiring_soon").length,
    valid:         certs.filter(r => getCertStatus(r.expiry_date) === "valid").length,
    no_expiry:     certs.filter(r => getCertStatus(r.expiry_date) === "no_expiry").length,
  }), [certs]);

  function applyCommonFilters(rows: TrainingRecord[]) {
    let r = rows;
    if (siteFilter !== "all") r = r.filter(x => String(x.site_id) === siteFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(x =>
        x.staff_name.toLowerCase().includes(q) ||
        (x.training_type ?? "").toLowerCase().includes(q) ||
        (x.document_title ?? "").toLowerCase().includes(q) ||
        (x.provider ?? "").toLowerCase().includes(q) ||
        (x.trainer ?? "").toLowerCase().includes(q)
      );
    }
    return r;
  }

  const filteredCerts     = useMemo(() => {
    let rows = applyCommonFilters(certs);
    if (certStatus !== "all") rows = rows.filter(r => getCertStatus(r.expiry_date) === certStatus);
    return rows;
  }, [certs, siteFilter, search, certStatus]);

  const filteredSignoffs  = useMemo(() => applyCommonFilters(signoffs),  [signoffs,  siteFilter, search]);
  const filteredInternals = useMemo(() => applyCommonFilters(internals), [internals, siteFilter, search]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => qc.invalidateQueries({ queryKey: ["train-track-records"] });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/train-track/records/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Record deleted" }); setDeleteId(null); },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ── Dialog ─────────────────────────────────────────────────────────────────

  function openAdd() {
    setEditRecord(null);
    setCertForm(emptyCert());
    setSignoffForm(emptySignoff());
    setInternalForm(emptyInternal());
    setShowDialog(true);
  }

  function openEdit(r: TrainingRecord) {
    setEditRecord(r);
    if (r.record_type === "certificate") {
      const isCustom = r.training_type ? !TRAINING_TYPES.slice(0, -1).includes(r.training_type) : false;
      setCertForm({
        staffName: r.staff_name,
        trainingType: isCustom ? "Other" : (r.training_type ?? ""),
        customType: isCustom ? (r.training_type ?? "") : "",
        provider: r.provider ?? "",
        completedDate: r.completed_date?.slice(0, 10) ?? "",
        expiryDate: r.expiry_date?.slice(0, 10) ?? "",
        siteId: r.site_id ? String(r.site_id) : "",
        notes: r.notes ?? "",
        signature: (r as any).signature ?? null,
      });
    } else if (r.record_type === "signoff") {
      setSignoffForm({
        staffName: r.staff_name,
        documentTitle: r.document_title ?? "",
        documentType: r.document_type ?? "",
        completedDate: r.completed_date?.slice(0, 10) ?? "",
        siteId: r.site_id ? String(r.site_id) : "",
        notes: r.notes ?? "",
        signature: (r as any).signature ?? null,
      });
    } else {
      const isCustom = r.training_type ? !TRAINING_TYPES.slice(0, -1).includes(r.training_type) : false;
      setInternalForm({
        staffName: r.staff_name,
        trainingType: isCustom ? "Other" : (r.training_type ?? ""),
        customType: isCustom ? (r.training_type ?? "") : "",
        trainer: r.trainer ?? "",
        completedDate: r.completed_date?.slice(0, 10) ?? "",
        siteId: r.site_id ? String(r.site_id) : "",
        notes: r.notes ?? "",
        signature: (r as any).signature ?? null,
      });
    }
    setShowDialog(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      let body: any;

      if (tab === "certificate") {
        const f = certForm;
        if (!f.staffName.trim()) throw new Error("Staff name is required");
        if (!f.trainingType) throw new Error("Training type is required");
        if (!f.provider.trim()) throw new Error("Provider is required");
        if (!f.completedDate) throw new Error("Completed date is required");
        const trainingType = f.trainingType === "Other" && f.customType.trim() ? f.customType.trim() : f.trainingType;
        body = {
          recordType: "certificate",
          staffName: f.staffName.trim(),
          trainingType,
          provider: f.provider.trim(),
          completedDate: f.completedDate,
          expiryDate: f.expiryDate || null,
          siteId: f.siteId ? Number(f.siteId) : null,
          notes: f.notes.trim() || null,
          signature: f.signature || null,
        };
      } else if (tab === "signoff") {
        const f = signoffForm;
        if (!f.staffName.trim())     throw new Error("Staff name is required");
        if (!f.documentTitle.trim()) throw new Error("Document title is required");
        if (!f.completedDate)        throw new Error("Date signed is required");
        body = {
          recordType: "signoff",
          staffName: f.staffName.trim(),
          documentTitle: f.documentTitle.trim(),
          documentType: f.documentType || null,
          completedDate: f.completedDate,
          siteId: f.siteId ? Number(f.siteId) : null,
          notes: f.notes.trim() || null,
          signature: f.signature || null,
        };
      } else {
        const f = internalForm;
        if (!f.staffName.trim())  throw new Error("Staff name is required");
        if (!f.trainingType)      throw new Error("Training / equipment is required");
        if (!f.trainer.trim())    throw new Error("Delivered by is required");
        if (!f.completedDate)     throw new Error("Date is required");
        const trainingType = f.trainingType === "Other" && f.customType.trim() ? f.customType.trim() : f.trainingType;
        body = {
          recordType: "internal",
          staffName: f.staffName.trim(),
          trainingType,
          trainer: f.trainer.trim(),
          completedDate: f.completedDate,
          siteId: f.siteId ? Number(f.siteId) : null,
          notes: f.notes.trim() || null,
          signature: f.signature || null,
        };
      }

      if (editRecord) {
        const { recordType, ...updateBody } = body;
        await apiFetch(`/train-track/records/${editRecord.id}`, { method: "PATCH", body: JSON.stringify(updateBody) });
        toast({ title: "Record updated" });
      } else {
        await apiFetch("/train-track/records", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Record added" });
      }

      invalidate();
      setShowDialog(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  const tabDef = [
    { key: "certificate" as RecordType, label: "Certificates",      Icon: Award,       count: certs.length },
    { key: "signoff"     as RecordType, label: "Document Sign-offs", Icon: CheckSquare, count: signoffs.length },
    { key: "internal"    as RecordType, label: "Internal Training",  Icon: Hammer,      count: internals.length },
  ];

  const SiteFilter = sites.length > 0 ? (
    <Select value={siteFilter} onValueChange={setSite}>
      <SelectTrigger className="w-40 rounded-sm">
        <SelectValue placeholder="All sites" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All sites</SelectItem>
        {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
  ) : null;

  const SearchBar = (
    <div className="relative flex-1">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <Input
        placeholder="Search…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="pl-9 rounded-sm"
      />
    </div>
  );

  function EmptyState({ message }: { message: string }) {
    return (
      <div className="text-center py-16 border border-dashed border-border rounded-sm">
        <BookOpen className="w-9 h-9 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button onClick={openAdd} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
          <Plus className="w-4 h-4" /> Add Record
        </Button>
      </div>
    );
  }

  // ── Table header ───────────────────────────────────────────────────────────

  function TableWrap({ headers, children, footer }: { headers: string[]; children: React.ReactNode; footer: string }) {
    return (
      <div className="border border-border rounded-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b border-border">
            <tr>
              {headers.map(h => (
                <th key={h} className={cn(
                  "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                  h === "" && "w-20"
                )}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">{children}</tbody>
        </table>
        <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">{footer}</div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <AppLayout title="TrainTrack">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground mt-1">
          Training certificates, document sign-offs, and internal training records
        </p>
        <Button onClick={openAdd} className="gap-2 rounded-sm">
          <Plus className="w-4 h-4" /> Add Record
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {tabDef.map(({ key, label, Icon, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors -mb-px",
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
            <span className={cn(
              "text-xs px-1.5 py-0.5 rounded-full",
              tab === key ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
            )}>{count}</span>
          </button>
        ))}
      </div>

      {/* ── CERTIFICATES TAB ── */}
      {tab === "certificate" && (
        <>
          {/* Expiry status cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {(["expired", "expiring_soon", "valid", "no_expiry"] as const).map(s => {
              const cfg = STATUS_CFG[s];
              const Icon = cfg.icon;
              return (
                <button
                  key={s}
                  onClick={() => setCertStatus(certStatus === s ? "all" : s)}
                  className={cn(
                    "text-left p-4 rounded-sm border transition-all hover:shadow-sm",
                    certStatus === s ? "ring-2 ring-offset-1" : "",
                    s === "expired"       ? "bg-red-50 border-red-200"     : "",
                    s === "expiring_soon" ? "bg-amber-50 border-amber-200" : "",
                    s === "valid"         ? "bg-emerald-50 border-emerald-200" : "",
                    s === "no_expiry"     ? "bg-slate-50 border-slate-200"  : ""
                  )}
                >
                  <div className={cn("flex items-center gap-1.5 mb-1", cfg.text)}>
                    <Icon className="w-4 h-4" />
                    <span className="text-xs font-medium uppercase tracking-wider">{cfg.label}</span>
                  </div>
                  <div className={cn("text-2xl font-bold", cfg.text)}>{certCounts[s]}</div>
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <div className="flex gap-2">
            {SiteFilter}
            {SearchBar}
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : filteredCerts.length === 0 ? (
            <EmptyState message={certs.length === 0 ? "No certificates yet. Add your first one." : "No certificates match the current filter."} />
          ) : (
            <TableWrap
              headers={["Staff Member", "Training", "Provider", "Site", "Completed", "Expires", "Status", ""]}
              footer={`Showing ${filteredCerts.length} of ${certs.length} certificate${certs.length !== 1 ? "s" : ""}`}
            >
              {filteredCerts.map(r => {
                const status = getCertStatus(r.expiry_date);
                const cfg = STATUS_CFG[status];
                const Icon = cfg.icon;
                const days = daysUntil(r.expiry_date);
                return (
                  <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-[#162D42]/10 flex items-center justify-center flex-shrink-0">
                          <User className="w-3.5 h-3.5 text-[#162D42]/60" />
                        </div>
                        <span className="font-medium">{r.staff_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.training_type}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{r.provider ?? <span className="opacity-40">—</span>}</td>
                    <td className="px-4 py-3 hidden md:table-cell"><SiteName record={r} /></td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(r.completed_date)}</td>
                    <td className="px-4 py-3">
                      {r.expiry_date ? (
                        <div>
                          <div className="text-foreground text-sm">{formatDate(r.expiry_date)}</div>
                          {days !== null && (
                            <div className={cn("text-xs mt-0.5", cfg.text)}>
                              {days < 0 ? `${Math.abs(days)}d ago` : days === 0 ? "Today" : `${days}d`}
                            </div>
                          )}
                        </div>
                      ) : <span className="text-muted-foreground/40 text-sm">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium border", cfg.badge)}>
                        <Icon className="w-3 h-3" />{cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <CheckPhotoUploader entityType="training_record" entityId={r.id} compact />
                      <ActionsCell onEdit={() => openEdit(r)} onDelete={() => setDeleteId(r.id)} />
                    </td>
                  </tr>
                );
              })}
            </TableWrap>
          )}
        </>
      )}

      {/* ── SIGN-OFFS TAB ── */}
      {tab === "signoff" && (
        <>
          <div className="flex gap-2">
            {SiteFilter}
            {SearchBar}
          </div>

          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : filteredSignoffs.length === 0 ? (
            <EmptyState message={signoffs.length === 0 ? "No sign-offs yet. Add the first one." : "No sign-offs match the current filter."} />
          ) : (
            <TableWrap
              headers={["Staff Member", "Document", "Type", "Site", "Date Signed", "Notes", ""]}
              footer={`Showing ${filteredSignoffs.length} of ${signoffs.length} sign-off${signoffs.length !== 1 ? "s" : ""}`}
            >
              {filteredSignoffs.map(r => (
                <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                        <User className="w-3.5 h-3.5 text-emerald-700" />
                      </div>
                      <span className="font-medium">{r.staff_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
                      <span className="font-medium text-foreground">{r.document_title}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    {r.document_type ? (
                      <span className="inline-flex px-2 py-0.5 rounded-sm text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                        {DOCUMENT_TYPE_LABELS[r.document_type] ?? r.document_type}
                      </span>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell"><SiteName record={r} /></td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <CalendarDays className="w-3 h-3 opacity-50" />{formatDate(r.completed_date)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-sm max-w-[200px] truncate hidden lg:table-cell">
                    {r.notes ?? <span className="opacity-40">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <CheckPhotoUploader entityType="training_record" entityId={r.id} compact />
                    <ActionsCell onEdit={() => openEdit(r)} onDelete={() => setDeleteId(r.id)} />
                  </td>
                </tr>
              ))}
            </TableWrap>
          )}
        </>
      )}

      {/* ── INTERNAL TRAINING TAB ── */}
      {tab === "internal" && (
        <>
          <div className="flex gap-2">
            {SiteFilter}
            {SearchBar}
          </div>

          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : filteredInternals.length === 0 ? (
            <EmptyState message={internals.length === 0 ? "No internal training records yet." : "No records match the current filter."} />
          ) : (
            <TableWrap
              headers={["Staff Member", "Training / Equipment", "Delivered By", "Site", "Date", "Notes", ""]}
              footer={`Showing ${filteredInternals.length} of ${internals.length} record${internals.length !== 1 ? "s" : ""}`}
            >
              {filteredInternals.map(r => (
                <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
                        <User className="w-3.5 h-3.5 text-violet-700" />
                      </div>
                      <span className="font-medium">{r.staff_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium text-foreground">{r.training_type}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{r.trainer}</td>
                  <td className="px-4 py-3 hidden md:table-cell"><SiteName record={r} /></td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <CalendarDays className="w-3 h-3 opacity-50" />{formatDate(r.completed_date)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-sm max-w-[180px] truncate hidden lg:table-cell">
                    {r.notes ?? <span className="opacity-40">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <CheckPhotoUploader entityType="training_record" entityId={r.id} compact />
                    <ActionsCell onEdit={() => openEdit(r)} onDelete={() => setDeleteId(r.id)} />
                  </td>
                </tr>
              ))}
            </TableWrap>
          )}
        </>
      )}

      {/* ── ADD / EDIT DIALOG ── */}
      <Dialog open={showDialog} onOpenChange={v => { if (!saving) setShowDialog(v); }}>
        <DialogContent className="max-w-lg rounded-sm">
          <DialogHeader>
            <DialogTitle>
              {editRecord
                ? `Edit ${editRecord.record_type === "certificate" ? "Certificate" : editRecord.record_type === "signoff" ? "Sign-off" : "Internal Training"}`
                : "Add Training Record"
              }
            </DialogTitle>
          </DialogHeader>

          {/* Type selector — only when adding new */}
          {!editRecord && (
            <div className="flex gap-2 pb-2 border-b border-border">
              {tabDef.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-1 py-3 px-2 rounded-sm border text-xs font-medium transition-colors",
                    tab === key
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
                  )}
                >
                  <Icon className="w-5 h-5" />
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-4 py-1">
            {/* Staff name — common to all */}
            <div>
              <Label htmlFor="staffName">Staff Member *</Label>
              <Input
                id="staffName"
                placeholder="Full name"
                value={tab === "certificate" ? certForm.staffName : tab === "signoff" ? signoffForm.staffName : internalForm.staffName}
                onChange={e => {
                  const v = e.target.value;
                  if (tab === "certificate") setCertForm(f => ({ ...f, staffName: v }));
                  else if (tab === "signoff") setSignoffForm(f => ({ ...f, staffName: v }));
                  else setInternalForm(f => ({ ...f, staffName: v }));
                }}
                className="mt-1 rounded-sm"
              />
            </div>

            {/* ── CERTIFICATE fields ── */}
            {tab === "certificate" && (
              <>
                <div>
                  <Label>Training Type *</Label>
                  <Select value={certForm.trainingType} onValueChange={v => setCertForm(f => ({ ...f, trainingType: v, customType: "" }))}>
                    <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      {TRAINING_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {certForm.trainingType === "Other" && (
                    <Input placeholder="Describe the training…" value={certForm.customType}
                      onChange={e => setCertForm(f => ({ ...f, customType: e.target.value }))}
                      className="mt-2 rounded-sm" />
                  )}
                </div>
                <div>
                  <Label htmlFor="provider">Training Provider *</Label>
                  <Input id="provider" placeholder="e.g. St John Ambulance, RSPH, Highfield…"
                    value={certForm.provider}
                    onChange={e => setCertForm(f => ({ ...f, provider: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>
                {sites.length > 0 && (
                  <div>
                    <Label>Site</Label>
                    <Select value={certForm.siteId} onValueChange={v => setCertForm(f => ({ ...f, siteId: v }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">No site</SelectItem>
                        {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="completedDate">Completed *</Label>
                    <Input id="completedDate" type="date" value={certForm.completedDate}
                      onChange={e => setCertForm(f => ({ ...f, completedDate: e.target.value }))}
                      className="mt-1 rounded-sm" />
                  </div>
                  <div>
                    <Label htmlFor="expiryDate">Expiry Date</Label>
                    <Input id="expiryDate" type="date" value={certForm.expiryDate}
                      onChange={e => setCertForm(f => ({ ...f, expiryDate: e.target.value }))}
                      className="mt-1 rounded-sm" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="certNotes">Notes</Label>
                  <Textarea id="certNotes" placeholder="Certificate number, renewal notes…"
                    value={certForm.notes}
                    onChange={e => setCertForm(f => ({ ...f, notes: e.target.value }))}
                    className="mt-1 rounded-sm" rows={2} />
                </div>
                <SignaturePad
                  label="Staff Signature"
                  value={certForm.signature}
                  onChange={sig => setCertForm(f => ({ ...f, signature: sig }))}
                />
              </>
            )}

            {/* ── SIGN-OFF fields ── */}
            {tab === "signoff" && (
              <>
                <div>
                  <Label htmlFor="docTitle">Document Title *</Label>
                  <Input id="docTitle" placeholder="e.g. Kitchen Risk Assessment, Manual Handling SOP…"
                    value={signoffForm.documentTitle}
                    onChange={e => setSignoffForm(f => ({ ...f, documentTitle: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>
                <div>
                  <Label>Document Type</Label>
                  <Select value={signoffForm.documentType} onValueChange={v => setSignoffForm(f => ({ ...f, documentType: v }))}>
                    <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select type (optional)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Not specified</SelectItem>
                      {Object.entries(DOCUMENT_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {sites.length > 0 && (
                  <div>
                    <Label>Site</Label>
                    <Select value={signoffForm.siteId} onValueChange={v => setSignoffForm(f => ({ ...f, siteId: v }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">No site</SelectItem>
                        {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <Label htmlFor="signedDate">Date Signed *</Label>
                  <Input id="signedDate" type="date" value={signoffForm.completedDate}
                    onChange={e => setSignoffForm(f => ({ ...f, completedDate: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>
                <div>
                  <Label htmlFor="signoffNotes">Notes</Label>
                  <Textarea id="signoffNotes" placeholder="Any additional comments…"
                    value={signoffForm.notes}
                    onChange={e => setSignoffForm(f => ({ ...f, notes: e.target.value }))}
                    className="mt-1 rounded-sm" rows={2} />
                </div>
                <SignaturePad
                  label="Staff Signature"
                  value={signoffForm.signature}
                  onChange={sig => setSignoffForm(f => ({ ...f, signature: sig }))}
                />
              </>
            )}

            {/* ── INTERNAL TRAINING fields ── */}
            {tab === "internal" && (
              <>
                <div>
                  <Label>Training / Equipment *</Label>
                  <Select value={internalForm.trainingType} onValueChange={v => setInternalForm(f => ({ ...f, trainingType: v, customType: "" }))}>
                    <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select or describe…" /></SelectTrigger>
                    <SelectContent>
                      {TRAINING_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {internalForm.trainingType === "Other" && (
                    <Input placeholder="e.g. Commercial dishwasher operation, Fryer changeover, Lone worker procedure…"
                      value={internalForm.customType}
                      onChange={e => setInternalForm(f => ({ ...f, customType: e.target.value }))}
                      className="mt-2 rounded-sm" />
                  )}
                </div>
                <div>
                  <Label htmlFor="trainer">Delivered By *</Label>
                  <Input id="trainer" placeholder="Name of trainer, supervisor, or manager"
                    value={internalForm.trainer}
                    onChange={e => setInternalForm(f => ({ ...f, trainer: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>
                {sites.length > 0 && (
                  <div>
                    <Label>Site</Label>
                    <Select value={internalForm.siteId} onValueChange={v => setInternalForm(f => ({ ...f, siteId: v }))}>
                      <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">No site</SelectItem>
                        {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <Label htmlFor="internalDate">Date *</Label>
                  <Input id="internalDate" type="date" value={internalForm.completedDate}
                    onChange={e => setInternalForm(f => ({ ...f, completedDate: e.target.value }))}
                    className="mt-1 rounded-sm" />
                </div>
                <div>
                  <Label htmlFor="internalNotes">Notes</Label>
                  <Textarea id="internalNotes" placeholder="What was covered, equipment demonstrated, outcome…"
                    value={internalForm.notes}
                    onChange={e => setInternalForm(f => ({ ...f, notes: e.target.value }))}
                    className="mt-1 rounded-sm" rows={2} />
                </div>
                <SignaturePad
                  label="Staff Signature"
                  value={internalForm.signature}
                  onChange={sig => setInternalForm(f => ({ ...f, signature: sig }))}
                />
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving} className="rounded-sm">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="rounded-sm">
              {saving ? "Saving…" : editRecord ? "Save Changes" : "Add Record"}
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
