import { useState, useMemo, useEffect } from "react";
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import {
  useGetBikeTrackConfig,
  getGetBikeTrackConfigQueryKey,
  useUpdateBikeTrackConfig,
} from "@workspace/api-client-react";
import {
  Bike, Plus, AlertTriangle, CheckCircle2, Clock, Wrench, Lock,
  User, Phone, Calendar, ChevronRight, ChevronLeft, Pencil, Trash2,
  Search, Check, X, Minus, RotateCcw, Archive, Filter, ClipboardCheck, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BikeRow {
  id: number;
  clientId: number;
  siteId: number | null;
  ref: string;
  name: string | null;
  type: string;
  status: string;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

interface HireRow {
  id: number;
  bikeId: number;
  bikeRef: string;
  bikeName: string | null;
  bikeType: string;
  guestName: string;
  guestContact: string | null;
  hireDate: string;
  returnDateExpected: string | null;
  returnDateActual: string | null;
  depositPence: number | null;
  depositReturned: boolean;
  status: string;
  notes: string | null;
  preCheckId: number | null;
  preResult: string | null;
  postCheckId: number | null;
  postResult: string | null;
  createdAt: string;
}

interface Summary {
  bikes: { available: number; hired: number; maintenance: number; retired: number; total: number };
  hires: { active_hires: number; overdue: number };
  services?: { overdue_service: number };
}

interface ServiceRow {
  id: number;
  clientId: number;
  bikeId: number;
  bikeRef: string;
  bikeName: string | null;
  bikeType: string;
  serviceDate: string;
  serviceType: string;
  servicedBy: string | null;
  nextServiceDate: string | null;
  costPence: number | null;
  notes: string | null;
  createdAt: string;
}

interface LatestService {
  bikeId: number;
  serviceDate: string;
  serviceType: string;
  servicedBy: string | null;
  nextServiceDate: string | null;
}

interface Site { id: number; name: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const BIKE_TYPES: Record<string, string> = {
  hybrid:   "Hybrid",
  road:     "Road",
  mountain: "Mountain",
  ebike:    "E-Bike",
  kids:     "Kids",
  cargo:    "Cargo",
  other:    "Other",
};

const CHECK_ITEMS: { key: string; label: string; icon?: string }[] = [
  { key: "brakesFront",    label: "Front brakes" },
  { key: "brakesRear",     label: "Rear brakes" },
  { key: "tyreFront",      label: "Front tyre (pressure & condition)" },
  { key: "tyreRear",       label: "Rear tyre (pressure & condition)" },
  { key: "chainGears",     label: "Chain & gears" },
  { key: "lightsFront",    label: "Front light" },
  { key: "lightsRear",     label: "Rear light / reflector" },
  { key: "frame",          label: "Frame (no cracks or damage)" },
  { key: "saddleSeatpost", label: "Saddle & seatpost (secure)" },
  { key: "handlebars",     label: "Handlebars & grips (secure)" },
  { key: "pedals",         label: "Pedals" },
  { key: "helmetProvided", label: "Helmet provided to guest" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
  return body;
}

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDeposit(p: number | null) {
  if (!p) return null;
  return `£${(p / 100).toFixed(2)}`;
}

function daysUntil(d: string | null): number | null {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(d).getTime() - today.getTime()) / 86400000);
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function autoNextService(serviceDate: string, serviceType: string): string | null {
  if (!serviceDate) return null;
  const d = new Date(serviceDate);
  if (serviceType === "annual")  { d.setFullYear(d.getFullYear() + 1); }
  else if (serviceType === "interim") { d.setMonth(d.getMonth() + 6); }
  else return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyCheckItems() {
  return Object.fromEntries(CHECK_ITEMS.map(i => [i.key, "pass"])) as Record<string, string>;
}

function autoOverallResult(items: Record<string, string>): "pass" | "fail" | "action_required" {
  const vals = Object.values(items);
  if (vals.some(v => v === "fail")) return "fail";
  return "pass";
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function BikeStatusBadge({ status }: { status: string }) {
  const cfg = {
    available:   { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2, label: "Available" },
    hired:       { cls: "bg-blue-50 text-blue-700 border-blue-200",           icon: Bike,         label: "On Hire" },
    maintenance: { cls: "bg-amber-50 text-amber-700 border-amber-200",        icon: Wrench,       label: "Maintenance" },
    retired:     { cls: "bg-slate-50 text-slate-500 border-slate-200",        icon: Archive,      label: "Retired" },
  }[status] ?? { cls: "bg-slate-50 text-slate-500 border-slate-200", icon: Minus, label: status };
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={cfg.cls}>
      <Icon className="w-3 h-3 mr-1" />{cfg.label}
    </Badge>
  );
}

function ResultBadge({ result }: { result: string | null }) {
  if (!result) return null;
  if (result === "pass") return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[11px]"><Check className="w-2.5 h-2.5 mr-1" />Pass</Badge>;
  if (result === "fail") return <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[11px]"><X className="w-2.5 h-2.5 mr-1" />Fail</Badge>;
  return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[11px]"><AlertTriangle className="w-2.5 h-2.5 mr-1" />Action</Badge>;
}

// ─── Check Items Editor ───────────────────────────────────────────────────────

function CheckItemsEditor({
  items,
  onChange,
}: {
  items: Record<string, string>;
  onChange: (items: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-2">
      {CHECK_ITEMS.map(item => (
        <div key={item.key} className="flex items-center gap-2">
          <span className="flex-1 text-sm">{item.label}</span>
          <div className="flex gap-1">
            {(["pass", "fail", "na"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => onChange({ ...items, [item.key]: v })}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-sm border font-medium transition-colors",
                  items[item.key] === v
                    ? v === "pass"  ? "bg-emerald-600 text-white border-emerald-600"
                    : v === "fail"  ? "bg-rose-600 text-white border-rose-600"
                    :                 "bg-slate-400 text-white border-slate-400"
                    : "bg-background text-muted-foreground border-border hover:border-primary/50"
                )}
              >
                {v === "pass" ? "✓" : v === "fail" ? "✗" : "N/A"}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Bike Config Dialog ───────────────────────────────────────────────────────

function BikeConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetBikeTrackConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateBikeTrackConfig();

  const [defaultDepositPounds, setDefaultDepositPounds] = useState("");
  const [hireDurationHours, setHireDurationHours] = useState("");
  const [requireHelmet, setRequireHelmet] = useState(false);

  useEffect(() => {
    if (!config || !open) return;
    const pence = config.bike_default_deposit_pence;
    setDefaultDepositPounds(pence ? (parseInt(pence, 10) / 100).toFixed(2) : "");
    setHireDurationHours(config.bike_hire_duration_hours ?? "");
    setRequireHelmet(config.bike_require_helmet === "true");
  }, [config, open]);

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          bike_default_deposit_pence: defaultDepositPounds
            ? String(Math.round(parseFloat(defaultDepositPounds) * 100))
            : "",
          bike_hire_duration_hours: hireDurationHours,
          bike_require_helmet: requireHelmet ? "true" : "false",
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetBikeTrackConfigQueryKey() });
          toast({ title: "Template saved", description: "New hires will use these defaults." });
          setOpen(false);
        },
        onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-sm">
          <Settings className="w-4 h-4 mr-2" />
          Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>BikeTrack Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure defaults for new bike hire records.</p>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Default deposit (£)</Label>
            <Input value={defaultDepositPounds} onChange={e => setDefaultDepositPounds(e.target.value)}
              placeholder="e.g. 20.00" type="number" step="0.01" min="0" className="rounded-sm" />
            <p className="text-xs text-muted-foreground">Pre-fills the deposit field when recording a new hire.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Default hire duration (hours)</Label>
            <Input value={hireDurationHours} onChange={e => setHireDurationHours(e.target.value)}
              placeholder="e.g. 4" type="number" min="0" className="rounded-sm" />
            <p className="text-xs text-muted-foreground">Used to calculate the expected return time.</p>
          </div>
          <div className="flex items-center justify-between rounded-sm border border-border p-3">
            <div>
              <p className="text-sm font-medium">Require helmet</p>
              <p className="text-xs text-muted-foreground">Add helmet check to pre-hire checklist</p>
            </div>
            <Switch checked={requireHelmet} onCheckedChange={setRequireHelmet} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateConfig.isPending}>
            {updateConfig.isPending ? "Saving…" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── New Hire Dialog (3 steps) ────────────────────────────────────────────────

function NewHireDialog({
  open,
  onClose,
  bikes,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  bikes: BikeRow[];
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  // Step 1 — bike selection
  const [selectedBikeId, setSelectedBikeId] = useState<number | null>(null);

  // Step 2 — guest details
  const [guestName, setGuestName] = useState("");
  const [guestContact, setGuestContact] = useState("");
  const [hireDate, setHireDate] = useState(todayIso());
  const [returnExpected, setReturnExpected] = useState("");
  const [depositPence, setDepositPence] = useState("");

  // Step 3 — pre-hire checklist
  const { user } = useAuth();
  const [checkItems, setCheckItems] = useState(emptyCheckItems());
  const [performedBy, setPerformedBy] = useState(user?.name ?? "");
  const [checkNotes, setCheckNotes] = useState("");
  const [skipCheck, setSkipCheck] = useState(false);

  const { data: config } = useGetBikeTrackConfig();
  const availableBikes = useMemo(() => bikes.filter(b => b.active && b.status === "available"), [bikes]);
  const selectedBike = useMemo(() => bikes.find(b => b.id === selectedBikeId), [bikes, selectedBikeId]);

  // Pre-fill from template on first open
  useEffect(() => {
    if (!open || !config) return;
    if (!depositPence && config.bike_default_deposit_pence) {
      const p = parseInt(config.bike_default_deposit_pence, 10);
      if (!isNaN(p) && p > 0) setDepositPence((p / 100).toFixed(2));
    }
    if (!returnExpected && config.bike_hire_duration_hours) {
      const hours = parseFloat(config.bike_hire_duration_hours);
      if (!isNaN(hours) && hours > 0) {
        const d = new Date();
        d.setHours(d.getHours() + hours);
        setReturnExpected(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
    }
  }, [open]);

  function reset() {
    setStep(1); setSelectedBikeId(null);
    setGuestName(""); setGuestContact(""); setHireDate(todayIso()); setReturnExpected(""); setDepositPence("");
    setCheckItems(emptyCheckItems()); setPerformedBy(""); setCheckNotes(""); setSkipCheck(false);
    setSaving(false);
  }

  async function handleSubmit() {
    if (!selectedBikeId || !guestName.trim()) return;
    setSaving(true);
    try {
      const body: any = {
        bikeId: selectedBikeId,
        guestName: guestName.trim(),
        guestContact: guestContact.trim() || null,
        hireDate,
        returnDateExpected: returnExpected || null,
        depositPence: depositPence ? Math.round(parseFloat(depositPence) * 100) : null,
      };
      if (!skipCheck) {
        body.preHireCheck = {
          ...checkItems,
          performedBy: performedBy.trim() || null,
          checkDate: hireDate,
          overallResult: autoOverallResult(checkItems),
          checkNotes: checkNotes.trim() || null,
        };
      }
      await apiFetch("/bike-track/hires", { method: "POST", body: JSON.stringify(body) });
      toast({ title: "Hire recorded", description: `${selectedBike?.ref} hired to ${guestName.trim()}` });
      reset();
      onCreated();
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to record hire", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) { reset(); onClose(); } }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bike className="w-4 h-4 text-primary" />
            New Bike Hire
            <span className="ml-auto text-xs font-normal text-muted-foreground">Step {step} of 3</span>
          </DialogTitle>
          {/* Step indicators */}
          <div className="flex gap-1.5 pt-1">
            {[1, 2, 3].map(s => (
              <div key={s} className={cn("h-1 flex-1 rounded-full transition-colors", s <= step ? "bg-primary" : "bg-muted")} />
            ))}
          </div>
        </DialogHeader>

        <div className="py-2 max-h-[60vh] overflow-y-auto pr-1">

          {/* Step 1 — Select bike */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Select an available bike to hire out.</p>
              {availableBikes.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground border border-dashed rounded-sm">
                  No bikes available for hire right now.
                </div>
              ) : (
                <div className="grid gap-2">
                  {availableBikes.map(b => (
                    <button
                      key={b.id}
                      onClick={() => setSelectedBikeId(b.id)}
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-sm border text-left transition-all",
                        selectedBikeId === b.id
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40 bg-background"
                      )}
                    >
                      <div className={cn("w-9 h-9 rounded-sm flex items-center justify-center flex-shrink-0",
                        selectedBikeId === b.id ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                      )}>
                        <Bike className="w-4.5 h-4.5" />
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-sm">{b.ref}{b.name ? ` — ${b.name}` : ""}</p>
                        <p className="text-xs text-muted-foreground">{BIKE_TYPES[b.type] ?? b.type}</p>
                      </div>
                      {selectedBikeId === b.id && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2 — Guest details */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="p-2.5 rounded-sm bg-muted/50 text-sm flex items-center gap-2">
                <Bike className="w-4 h-4 text-primary flex-shrink-0" />
                <span><strong>{selectedBike?.ref}</strong>{selectedBike?.name ? ` — ${selectedBike.name}` : ""} · {BIKE_TYPES[selectedBike?.type ?? ""] ?? selectedBike?.type}</span>
              </div>
              <div className="space-y-1.5">
                <Label>Guest name *</Label>
                <Input value={guestName} onChange={e => setGuestName(e.target.value)} placeholder="Full name" className="rounded-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Contact (phone / email) <span className="text-muted-foreground text-xs">optional</span></Label>
                <Input value={guestContact} onChange={e => setGuestContact(e.target.value)} placeholder="07700 900000 or guest@email.com" className="rounded-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Hire date *</Label>
                  <Input type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} className="rounded-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label>Expected return <span className="text-muted-foreground text-xs">optional</span></Label>
                  <Input type="date" value={returnExpected} onChange={e => setReturnExpected(e.target.value)} className="rounded-sm" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Deposit (£) <span className="text-muted-foreground text-xs">optional</span></Label>
                <Input type="number" step="0.01" min="0" value={depositPence} onChange={e => setDepositPence(e.target.value)} placeholder="e.g. 20.00" className="rounded-sm" />
              </div>
            </div>
          )}

          {/* Step 3 — Pre-hire check */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Pre-hire safety check</p>
                <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={skipCheck} onChange={e => setSkipCheck(e.target.checked)} className="rounded" />
                  Skip check
                </label>
              </div>
              {!skipCheck && (
                <>
                  <div className="space-y-1.5">
                    <Label>Checked by <span className="text-muted-foreground text-xs">optional</span></Label>
                    <Input value={performedBy} onChange={e => setPerformedBy(e.target.value)} placeholder="Staff member name" className="rounded-sm" />
                  </div>
                  <div className="border rounded-sm p-3 space-y-2">
                    <CheckItemsEditor items={checkItems} onChange={setCheckItems} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
                    <Textarea value={checkNotes} onChange={e => setCheckNotes(e.target.value)} placeholder="Any issues found, corrective actions…" rows={2} className="rounded-sm" />
                  </div>
                  <div className={cn("text-xs px-3 py-2 rounded-sm border font-medium",
                    autoOverallResult(checkItems) === "pass"
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-rose-50 text-rose-700 border-rose-200"
                  )}>
                    Overall result: {autoOverallResult(checkItems) === "pass" ? "✓ Pass" : "✗ Fail — do not hire until resolved"}
                  </div>
                </>
              )}
              {skipCheck && (
                <p className="text-sm text-muted-foreground border border-dashed rounded-sm p-3">
                  No pre-hire check will be recorded. You can add a standalone check later from the Checks log.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {step > 1 && (
            <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={saving} className="rounded-sm gap-1.5">
              <ChevronLeft className="w-3.5 h-3.5" /> Back
            </Button>
          )}
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={saving} className="rounded-sm">Cancel</Button>
          {step < 3 ? (
            <Button
              onClick={() => setStep(s => s + 1)}
              disabled={step === 1 && !selectedBikeId || step === 2 && !guestName.trim()}
              className="rounded-sm gap-1.5"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button onClick={handleSubmit} disabled={saving || !guestName.trim()} className="rounded-sm">
              {saving ? "Saving…" : "Confirm Hire"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Return Dialog ────────────────────────────────────────────────────────────

function ReturnDialog({
  hire,
  onClose,
  onReturned,
}: {
  hire: HireRow | null;
  onClose: () => void;
  onReturned: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [checkItems, setCheckItems] = useState(emptyCheckItems());
  const [performedBy, setPerformedBy] = useState(user?.name ?? "");
  const [checkNotes, setCheckNotes] = useState("");
  const [skipCheck, setSkipCheck] = useState(false);
  const [depositReturned, setDepositReturned] = useState(false);
  const [notes, setNotes] = useState("");
  const [returnDate, setReturnDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);

  async function handleReturn() {
    if (!hire) return;
    setSaving(true);
    try {
      const body: any = {
        returnDateActual: returnDate,
        depositReturned,
        notes: notes.trim() || null,
      };
      if (!skipCheck) {
        body.postReturnCheck = {
          ...checkItems,
          performedBy: performedBy.trim() || null,
          checkDate: returnDate,
          overallResult: autoOverallResult(checkItems),
          checkNotes: checkNotes.trim() || null,
        };
      }
      const result = await apiFetch(`/bike-track/hires/${hire.id}/return`, { method: "POST", body: JSON.stringify(body) });
      const bikeStatus = result?.bikeStatus ?? "available";
      toast({
        title: "Bike returned",
        description: bikeStatus === "maintenance"
          ? `${hire.bikeRef} marked for maintenance — post-return check had issues.`
          : `${hire.bikeRef} is now available.`,
      });
      onReturned();
      onClose();
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!hire) return null;

  return (
    <Dialog open={!!hire} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-primary" /> Return Bike
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto py-1 pr-1">
          <div className="p-2.5 rounded-sm bg-muted/50 text-sm space-y-0.5">
            <p><strong>{hire.bikeRef}</strong>{hire.bikeName ? ` — ${hire.bikeName}` : ""}</p>
            <p className="text-muted-foreground">Hired by {hire.guestName} on {fmt(hire.hireDate)}</p>
            {hire.depositPence && (
              <p className="text-muted-foreground">Deposit: {fmtDeposit(hire.depositPence)}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Return date</Label>
              <Input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} className="rounded-sm" />
            </div>
            {hire.depositPence && (
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={depositReturned} onChange={e => setDepositReturned(e.target.checked)} className="rounded" />
                  Deposit returned
                </label>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Return notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any damage, issues, or comments…" rows={2} className="rounded-sm" />
          </div>

          {/* Post-return check */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Post-return safety check</p>
              <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={skipCheck} onChange={e => setSkipCheck(e.target.checked)} className="rounded" />
                Skip check
              </label>
            </div>
            {!skipCheck && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Checked by <span className="text-muted-foreground text-xs">optional</span></Label>
                  <Input value={performedBy} onChange={e => setPerformedBy(e.target.value)} placeholder="Staff member name" className="rounded-sm" />
                </div>
                <div className="border rounded-sm p-3">
                  <CheckItemsEditor items={checkItems} onChange={setCheckItems} />
                </div>
                <Textarea value={checkNotes} onChange={e => setCheckNotes(e.target.value)} placeholder="Damage noted, actions required…" rows={2} className="rounded-sm" />
                <div className={cn("text-xs px-3 py-2 rounded-sm border font-medium",
                  autoOverallResult(checkItems) === "pass"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-rose-50 text-rose-700 border-rose-200"
                )}>
                  {autoOverallResult(checkItems) === "pass"
                    ? "✓ Pass — bike will be marked available"
                    : "✗ Fail — bike will be moved to maintenance"}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleReturn} disabled={saving} className="rounded-sm">
            {saving ? "Processing…" : "Confirm Return"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bike Form Dialog ─────────────────────────────────────────────────────────

function BikeFormDialog({
  open,
  bike,
  sites,
  onClose,
  onSaved,
}: {
  open: boolean;
  bike: BikeRow | null;
  sites: Site[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [ref, setRef] = useState(bike?.ref ?? "");
  const [name, setName] = useState(bike?.name ?? "");
  const [type, setType] = useState(bike?.type ?? "hybrid");
  const [siteId, setSiteId] = useState(bike?.siteId ? String(bike.siteId) : "");
  const [notes, setNotes] = useState(bike?.notes ?? "");
  const [saving, setSaving] = useState(false);

  // Sync form when bike changes
  useMemo(() => {
    setRef(bike?.ref ?? ""); setName(bike?.name ?? ""); setType(bike?.type ?? "hybrid");
    setSiteId(bike?.siteId ? String(bike.siteId) : ""); setNotes(bike?.notes ?? "");
  }, [bike]);

  async function handleSave() {
    if (!ref.trim()) return;
    setSaving(true);
    try {
      const body = { ref: ref.trim(), name: name.trim() || null, type, siteId: siteId ? Number(siteId) : null, notes: notes.trim() || null };
      if (bike) {
        await apiFetch(`/bike-track/bikes/${bike.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Bike updated" });
      } else {
        await apiFetch("/bike-track/bikes", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Bike added" });
      }
      onSaved(); onClose();
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{bike ? "Edit Bike" : "Add Bike"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Bike ID / Reference *</Label>
            <Input value={ref} onChange={e => setRef(e.target.value)} placeholder="e.g. BIKE-01, MTB-3" className="rounded-sm" autoFocus />
            <p className="text-xs text-muted-foreground">This is what's marked on the bike itself.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Name <span className="text-muted-foreground text-xs">optional</span></Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Blue Trek Marlin, Giant Escape" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(BIKE_TYPES).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="No specific site" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No specific site</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Colour, size, any identifying features…" rows={2} className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !ref.trim()} className="rounded-sm">
            {saving ? "Saving…" : bike ? "Save Changes" : "Add Bike"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Log Service Dialog ───────────────────────────────────────────────────────

function LogServiceDialog({
  open,
  service,
  bikes,
  onClose,
  onSaved,
}: {
  open: boolean;
  service: ServiceRow | null;
  bikes: BikeRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [bikeId, setBikeId] = useState(service ? String(service.bikeId) : "");
  const [serviceDate, setServiceDate] = useState(service?.serviceDate?.slice(0, 10) ?? todayIso());
  const [serviceType, setServiceType] = useState(service?.serviceType ?? "annual");
  const [servicedBy, setServicedBy] = useState(service?.servicedBy ?? "");
  const [nextServiceDate, setNextServiceDate] = useState(service?.nextServiceDate?.slice(0, 10) ?? "");
  const [costPence, setCostPence] = useState(service?.costPence ? String(service.costPence / 100) : "");
  const [notes, setNotes] = useState(service?.notes ?? "");
  const [saving, setSaving] = useState(false);

  // Auto-fill next service date when type or date changes, unless editing existing
  useMemo(() => {
    if (!service) {
      const auto = autoNextService(serviceDate, serviceType);
      setNextServiceDate(auto ?? "");
    }
  }, [serviceDate, serviceType, service]);

  // Sync form when service changes (edit mode)
  useMemo(() => {
    setBikeId(service ? String(service.bikeId) : "");
    setServiceDate(service?.serviceDate?.slice(0, 10) ?? todayIso());
    setServiceType(service?.serviceType ?? "annual");
    setServicedBy(service?.servicedBy ?? "");
    setNextServiceDate(service?.nextServiceDate?.slice(0, 10) ?? "");
    setCostPence(service?.costPence ? String(service.costPence / 100) : "");
    setNotes(service?.notes ?? "");
  }, [service]);

  async function handleSave() {
    if (!bikeId && !service) return;
    setSaving(true);
    try {
      const body: any = {
        serviceDate,
        serviceType,
        servicedBy: servicedBy.trim() || null,
        nextServiceDate: nextServiceDate || null,
        costPence: costPence ? Math.round(parseFloat(costPence) * 100) : null,
        notes: notes.trim() || null,
      };
      if (service) {
        await apiFetch(`/bike-track/services/${service.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Service record updated" });
      } else {
        body.bikeId = parseInt(bikeId);
        await apiFetch("/bike-track/services", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Service logged" });
      }
      onSaved();
      onClose();
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const activeBikes = useMemo(() => bikes.filter(b => b.active), [bikes]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-primary" />
            {service ? "Edit Service Record" : "Log a Service"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          {!service && (
            <div className="space-y-1.5">
              <Label>Bike *</Label>
              <Select value={bikeId} onValueChange={setBikeId}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="Select a bike…" /></SelectTrigger>
                <SelectContent>
                  {activeBikes.map(b => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.ref}{b.name ? ` — ${b.name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {service && (
            <div className="px-3 py-2 rounded-sm bg-muted/50 text-sm">
              <strong>{service.bikeRef}</strong>{service.bikeName ? ` — ${service.bikeName}` : ""}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Service type</Label>
              <Select value={serviceType} onValueChange={setServiceType}>
                <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="annual">Annual</SelectItem>
                  <SelectItem value="interim">Interim (6-month)</SelectItem>
                  <SelectItem value="adhoc">Ad-hoc / Repair</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Service date</Label>
              <Input type="date" value={serviceDate} onChange={e => setServiceDate(e.target.value)} className="rounded-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Next service due <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="date" value={nextServiceDate} onChange={e => setNextServiceDate(e.target.value)} className="rounded-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Cost (£) <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" step="0.01" min="0" value={costPence} onChange={e => setCostPence(e.target.value)} placeholder="e.g. 45.00" className="rounded-sm" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Serviced by <span className="text-muted-foreground text-xs">optional</span></Label>
            <Input value={servicedBy} onChange={e => setServicedBy(e.target.value)} placeholder="Technician name or company" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Work carried out, parts replaced, observations…" rows={3} className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (!service && !bikeId)} className="rounded-sm">
            {saving ? "Saving…" : service ? "Save Changes" : "Log Service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "overview" | "fleet" | "hires" | "services";

export default function BikeTrackPage() {
  const { activeClientId, hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const qc = useQueryClient();
  const hasBikeTrack = hasService("biketrack");

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [hireFilter, setHireFilter] = useState<"active" | "returned" | "all">("active");
  const [search, setSearch] = useState("");
  const [showNewHire, setShowNewHire] = useState(false);
  const [returnHire, setReturnHire] = useState<HireRow | null>(null);
  const [editBike, setEditBike] = useState<BikeRow | null | "new">(null);
  const [deleteBikeId, setDeleteBikeId] = useState<number | null>(null);
  const [logService, setLogService] = useState<ServiceRow | "new" | null>(null);
  const [deleteServiceId, setDeleteServiceId] = useState<number | null>(null);

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: bikes = [], isLoading: bikesLoading } = useQuery<BikeRow[]>({
    queryKey: ["bikes", activeClientId],
    queryFn: () => apiFetch("/bike-track/bikes"),
    enabled: !!activeClientId && hasBikeTrack,
  });

  const { data: hires = [], isLoading: hiresLoading } = useQuery<HireRow[]>({
    queryKey: ["bike-hires", activeClientId, hireFilter === "all" ? undefined : hireFilter],
    queryFn: () => apiFetch(`/bike-track/hires${hireFilter !== "all" ? `?status=${hireFilter}` : ""}`),
    enabled: !!activeClientId && hasBikeTrack,
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ["bike-summary", activeClientId],
    queryFn: () => apiFetch("/bike-track/summary"),
    enabled: !!activeClientId && hasBikeTrack,
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: () => apiFetch("/sites"),
    enabled: !!activeClientId,
  });

  const { data: services = [], isLoading: servicesLoading } = useQuery<ServiceRow[]>({
    queryKey: ["bike-services", activeClientId],
    queryFn: () => apiFetch("/bike-track/services"),
    enabled: !!activeClientId && hasBikeTrack,
  });

  const { data: latestServicesArr = [] } = useQuery<LatestService[]>({
    queryKey: ["bike-services-latest", activeClientId],
    queryFn: () => apiFetch("/bike-track/services/latest"),
    enabled: !!activeClientId && hasBikeTrack,
  });

  const latestServiceMap = useMemo(() => {
    const m: Record<number, LatestService> = {};
    for (const s of latestServicesArr) m[s.bikeId] = s;
    return m;
  }, [latestServicesArr]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["bikes"] });
    qc.invalidateQueries({ queryKey: ["bike-hires"] });
    qc.invalidateQueries({ queryKey: ["bike-summary"] });
    qc.invalidateQueries({ queryKey: ["bike-services"] });
    qc.invalidateQueries({ queryKey: ["bike-services-latest"] });
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  const deleteBikeMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/bike-track/bikes/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Bike removed" }); setDeleteBikeId(null); },
    onError: (e: any) => { toast({ title: "Cannot delete", description: e.message, variant: "destructive" }); setDeleteBikeId(null); },
  });

  async function setStatus(bike: BikeRow, status: string) {
    try {
      await apiFetch(`/bike-track/bikes/${bike.id}`, { method: "PUT", body: JSON.stringify({ status }) });
      qc.invalidateQueries({ queryKey: ["bikes"] });
      qc.invalidateQueries({ queryKey: ["bike-summary"] });
    } catch (e: any) {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const filteredHires = useMemo(() => {
    let rows = hires;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(h =>
        h.bikeRef.toLowerCase().includes(q) ||
        h.guestName.toLowerCase().includes(q) ||
        (h.guestContact ?? "").toLowerCase().includes(q) ||
        (h.bikeName ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [hires, search]);

  const filteredBikes = useMemo(() => {
    if (!search.trim()) return bikes;
    const q = search.toLowerCase();
    return bikes.filter(b =>
      b.ref.toLowerCase().includes(q) ||
      (b.name ?? "").toLowerCase().includes(q) ||
      b.type.toLowerCase().includes(q)
    );
  }, [bikes, search]);

  const activeHires = useMemo(() => hires.filter(h => h.status === "active"), [hires]);
  const overdueHires = useMemo(() => activeHires.filter(h => h.returnDateExpected && (daysUntil(h.returnDateExpected) ?? 1) < 0), [activeHires]);

  // ── Upsell ───────────────────────────────────────────────────────────────────

  if (!hasBikeTrack) {
    return (
      <AppLayout title="BikeTrack">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">BikeTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Bike hire logbook — manage your fleet, record guest hires, and complete pre-hire and post-return safety checks.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings"><Button className="rounded-sm">Activate BikeTrack</Button></Link>
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

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <AppLayout title="BikeTrack">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground mt-1">
          Bike hire logbook — fleet management, guest hires, safety checks &amp; annual servicing
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canAdmin && <BikeConfigDialog />}
          <Button onClick={() => setShowNewHire(true)} className="gap-2 rounded-sm">
            <Plus className="w-4 h-4" /> New Hire
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "Available",       value: summary.bikes.available,                          color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200" },
            { label: "On Hire",         value: summary.bikes.hired,                              color: "text-blue-600",    bg: "bg-blue-50 border-blue-200" },
            { label: "Maintenance",     value: summary.bikes.maintenance,                        color: "text-amber-600",   bg: "bg-amber-50 border-amber-200" },
            { label: "Overdue Returns", value: Number(summary.hires.overdue ?? 0),               color: "text-rose-600",    bg: "bg-rose-50 border-rose-200" },
            { label: "Service Overdue", value: Number(summary.services?.overdue_service ?? 0),   color: "text-violet-600",  bg: "bg-violet-50 border-violet-200" },
          ].map(c => (
            <div key={c.label} className={cn("rounded-sm border p-4", c.bg)}>
              <p className={cn("text-2xl font-bold", c.color)}>{c.value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{c.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Overdue banners */}
      {overdueHires.length > 0 && activeTab !== "services" && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-rose-50 border-rose-200 text-rose-800 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{overdueHires.length} hire{overdueHires.length !== 1 ? "s are" : " is"} overdue — expected return date has passed.</span>
        </div>
      )}
      {Number(summary?.services?.overdue_service ?? 0) > 0 && activeTab !== "services" && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-violet-50 border-violet-200 text-violet-800 text-sm cursor-pointer"
          onClick={() => setActiveTab("services")}>
          <Wrench className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{summary!.services!.overdue_service} bike{Number(summary!.services!.overdue_service) !== 1 ? "s are" : " is"} overdue for servicing — view Services tab →</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border gap-0">
        {([["overview", "Overview"], ["fleet", "Fleet"], ["hires", "Hires"], ["services", "Services"]] as [Tab, string][]).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Overview tab ─────────────────────────────────────────────────────── */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Active Hires</h3>
          {activeHires.length === 0 ? (
            <div className="text-center py-10 border border-dashed rounded-sm">
              <Bike className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">No active hires right now.</p>
              <Button onClick={() => setShowNewHire(true)} variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                <Plus className="w-3.5 h-3.5" /> Record a Hire
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {activeHires.slice(0, 8).map(h => {
                const due = daysUntil(h.returnDateExpected);
                const isOverdue = due !== null && due < 0;
                const isDueSoon = due !== null && due >= 0 && due <= 1;
                return (
                  <div key={h.id} className={cn(
                    "flex items-center gap-3 p-3 rounded-sm border bg-background",
                    isOverdue ? "border-rose-200 bg-rose-50" : isDueSoon ? "border-amber-200 bg-amber-50" : "border-border"
                  )}>
                    <div className="w-8 h-8 rounded-sm bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Bike className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{h.bikeRef}{h.bikeName ? ` — ${h.bikeName}` : ""}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        <User className="w-3 h-3 inline mr-1 opacity-60" />{h.guestName}
                        {h.guestContact && <span> · {h.guestContact}</span>}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {h.returnDateExpected && (
                        <p className={cn("text-xs font-medium", isOverdue ? "text-rose-700" : isDueSoon ? "text-amber-700" : "text-muted-foreground")}>
                          {isOverdue ? `${Math.abs(due!)}d overdue` : due === 0 ? "Due today" : due === 1 ? "Due tomorrow" : `Due ${fmt(h.returnDateExpected)}`}
                        </p>
                      )}
                      <Button
                        size="sm" variant="outline"
                        className="rounded-sm mt-1 h-7 text-xs"
                        onClick={() => setReturnHire(h)}
                      >
                        <RotateCcw className="w-3 h-3 mr-1" /> Return
                      </Button>
                    </div>
                  </div>
                );
              })}
              {activeHires.length > 8 && (
                <button onClick={() => setActiveTab("hires")} className="text-xs text-primary hover:underline">
                  +{activeHires.length - 8} more — view all hires →
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Fleet tab ────────────────────────────────────────────────────────── */}
      {activeTab === "fleet" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {canAdmin && (
              <Button onClick={() => setEditBike("new")} size="sm" className="rounded-sm gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add Bike
              </Button>
            )}
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search bikes…" className="pl-8 h-8 rounded-sm text-sm" />
            </div>
          </div>

          {bikesLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : filteredBikes.length === 0 ? (
            <div className="text-center py-10 border border-dashed rounded-sm">
              <Bike className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">{bikes.length === 0 ? "No bikes in the fleet yet." : "No bikes match your search."}</p>
              {canAdmin && bikes.length === 0 && (
                <Button onClick={() => setEditBike("new")} variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                  <Plus className="w-3.5 h-3.5" /> Add your first bike
                </Button>
              )}
            </div>
          ) : (
            <div className="border border-border rounded-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Ref / Name</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Type</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell">Last Service</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Notes</th>
                    {canAdmin && <th className="px-4 py-3" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredBikes.map(b => (
                    <tr key={b.id} className="bg-white hover:bg-muted/20 transition-colors group">
                      <td className="px-4 py-3">
                        <p className="font-semibold">{b.ref}</p>
                        {b.name && <p className="text-xs text-muted-foreground">{b.name}</p>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{BIKE_TYPES[b.type] ?? b.type}</td>
                      <td className="px-4 py-3"><BikeStatusBadge status={b.status} /></td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {(() => {
                          const ls = latestServiceMap[b.id];
                          if (!ls) return <span className="text-xs text-muted-foreground/60">Never serviced</span>;
                          const overdue = ls.nextServiceDate && (daysUntil(ls.nextServiceDate) ?? 1) < 0;
                          const dueSoon = ls.nextServiceDate && !overdue && (daysUntil(ls.nextServiceDate) ?? 999) <= 30;
                          return (
                            <div>
                              <p className="text-xs text-muted-foreground">{fmt(ls.serviceDate)}</p>
                              {ls.nextServiceDate && (
                                <p className={cn("text-xs font-medium",
                                  overdue ? "text-violet-700" : dueSoon ? "text-amber-600" : "text-muted-foreground"
                                )}>
                                  {overdue ? "⚠ Service overdue" : dueSoon ? `Due ${fmt(ls.nextServiceDate)}` : `Next ${fmt(ls.nextServiceDate)}`}
                                </p>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell truncate max-w-[200px]">{b.notes ?? "—"}</td>
                      {canAdmin && (
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {b.status === "maintenance" && (
                              <Button variant="ghost" size="sm" className="h-7 rounded-sm text-xs gap-1 text-emerald-700 hover:text-emerald-700 hover:bg-emerald-50"
                                onClick={() => setStatus(b, "available")}>
                                <Check className="w-3 h-3" /> Ready
                              </Button>
                            )}
                            {b.status === "available" && (
                              <Button variant="ghost" size="sm" className="h-7 rounded-sm text-xs gap-1 text-amber-700 hover:text-amber-700 hover:bg-amber-50"
                                onClick={() => setStatus(b, "maintenance")}>
                                <Wrench className="w-3 h-3" /> Maintenance
                              </Button>
                            )}
                            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={() => setEditBike(b)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            {b.status !== "hired" && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteBikeId(b.id)}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
                {filteredBikes.length} bike{filteredBikes.length !== 1 ? "s" : ""} in fleet
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Hires tab ────────────────────────────────────────────────────────── */}
      {activeTab === "hires" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-sm border border-border overflow-hidden">
              {([["active", "Active"], ["returned", "Returned"], ["all", "All"]] as const).map(([v, l]) => (
                <button
                  key={v}
                  onClick={() => setHireFilter(v)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium transition-colors",
                    hireFilter === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >{l}</button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[160px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search guest or bike…" className="pl-8 h-8 rounded-sm text-sm" />
            </div>
            <Button onClick={() => setShowNewHire(true)} size="sm" className="rounded-sm gap-1.5 ml-auto">
              <Plus className="w-3.5 h-3.5" /> New Hire
            </Button>
          </div>

          {hiresLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : filteredHires.length === 0 ? (
            <div className="text-center py-10 border border-dashed rounded-sm">
              <Calendar className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">{hires.length === 0 ? "No hire records yet." : "No records match your filter."}</p>
            </div>
          ) : (
            <div className="border border-border rounded-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Bike</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Guest</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Hire Date</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Return</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Checks</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredHires.map(h => {
                    const due = daysUntil(h.returnDateExpected);
                    const isOverdue = h.status === "active" && due !== null && due < 0;
                    return (
                      <tr key={h.id} className={cn("transition-colors group", isOverdue ? "bg-rose-50 hover:bg-rose-100" : "bg-white hover:bg-muted/20")}>
                        <td className="px-4 py-3">
                          <p className="font-semibold">{h.bikeRef}</p>
                          {h.bikeName && <p className="text-xs text-muted-foreground">{h.bikeName}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium">{h.guestName}</p>
                          {h.guestContact && <p className="text-xs text-muted-foreground">{h.guestContact}</p>}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell whitespace-nowrap">{fmt(h.hireDate)}</td>
                        <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap">
                          {h.status === "returned"
                            ? <span className="text-muted-foreground">{fmt(h.returnDateActual)}</span>
                            : h.returnDateExpected
                            ? <span className={cn("text-xs font-medium", isOverdue ? "text-rose-700" : "text-muted-foreground")}>
                                {isOverdue ? `${Math.abs(due!)}d overdue` : `${fmt(h.returnDateExpected)}`}
                              </span>
                            : <span className="opacity-40">—</span>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <div className="flex gap-1">
                            {h.preCheckId && <span className="text-[11px] text-muted-foreground">Pre: <ResultBadge result={h.preResult} /></span>}
                            {h.postCheckId && <span className="text-[11px] text-muted-foreground">Post: <ResultBadge result={h.postResult} /></span>}
                            {!h.preCheckId && !h.postCheckId && <span className="opacity-30 text-xs">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={cn("text-[11px]",
                            h.status === "active"    ? "bg-blue-50 text-blue-700 border-blue-200" :
                            h.status === "returned"  ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                            h.status === "overdue"   ? "bg-rose-50 text-rose-700 border-rose-200" :
                            "bg-slate-50 text-slate-500 border-slate-200"
                          )}>
                            {h.status.charAt(0).toUpperCase() + h.status.slice(1)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {h.status === "active" && (
                            <Button size="sm" variant="outline" className="rounded-sm h-7 text-xs gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => setReturnHire(h)}>
                              <RotateCcw className="w-3 h-3" /> Return
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
                {filteredHires.length} record{filteredHires.length !== 1 ? "s" : ""}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Services tab ─────────────────────────────────────────────────────── */}
      {activeTab === "services" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button onClick={() => setLogService("new")} size="sm" className="rounded-sm gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Log Service
            </Button>
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search bike or technician…" className="pl-8 h-8 rounded-sm text-sm" />
            </div>
          </div>

          {/* Overdue service list */}
          {(() => {
            const overdueServiceBikes = bikes.filter(b => {
              const ls = latestServiceMap[b.id];
              return b.active && ls?.nextServiceDate && (daysUntil(ls.nextServiceDate) ?? 1) < 0;
            });
            if (overdueServiceBikes.length === 0) return null;
            return (
              <div className="p-3 rounded-sm border bg-violet-50 border-violet-200 space-y-2">
                <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> Overdue servicing
                </p>
                <div className="flex flex-wrap gap-2">
                  {overdueServiceBikes.map(b => {
                    const ls = latestServiceMap[b.id]!;
                    const days = Math.abs(daysUntil(ls.nextServiceDate) ?? 0);
                    return (
                      <button key={b.id}
                        onClick={() => setLogService("new")}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-medium bg-white border border-violet-200 text-violet-800 hover:bg-violet-50 transition-colors">
                        <Bike className="w-3 h-3" /> {b.ref} — {days}d overdue
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {servicesLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : services.length === 0 ? (
            <div className="text-center py-10 border border-dashed rounded-sm">
              <Wrench className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">No service records yet. Log your first annual service to start tracking.</p>
              <Button onClick={() => setLogService("new")} variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                <Plus className="w-3.5 h-3.5" /> Log a Service
              </Button>
            </div>
          ) : (
            <div className="border border-border rounded-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Bike</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Serviced By</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Next Due</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell">Cost</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Photos</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {services
                    .filter(s => {
                      if (!search.trim()) return true;
                      const q = search.toLowerCase();
                      return s.bikeRef.toLowerCase().includes(q) ||
                        (s.bikeName ?? "").toLowerCase().includes(q) ||
                        (s.servicedBy ?? "").toLowerCase().includes(q);
                    })
                    .map(s => {
                      const overdue = s.nextServiceDate && (daysUntil(s.nextServiceDate) ?? 1) < 0;
                      const dueSoon = s.nextServiceDate && !overdue && (daysUntil(s.nextServiceDate) ?? 999) <= 30;
                      return (
                        <tr key={s.id} className="bg-white hover:bg-muted/20 transition-colors group">
                          <td className="px-4 py-3">
                            <p className="font-semibold">{s.bikeRef}</p>
                            {s.bikeName && <p className="text-xs text-muted-foreground">{s.bikeName}</p>}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className={cn("text-[11px]",
                              s.serviceType === "annual"  ? "bg-blue-50 text-blue-700 border-blue-200" :
                              s.serviceType === "interim" ? "bg-cyan-50 text-cyan-700 border-cyan-200" :
                              "bg-slate-50 text-slate-600 border-slate-200"
                            )}>
                              {s.serviceType === "annual" ? "Annual" : s.serviceType === "interim" ? "Interim" : "Ad-hoc"}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(s.serviceDate)}</td>
                          <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{s.servicedBy ?? "—"}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            {s.nextServiceDate ? (
                              <span className={cn("text-xs font-medium",
                                overdue ? "text-violet-700" : dueSoon ? "text-amber-600" : "text-muted-foreground"
                              )}>
                                {overdue ? `⚠ ${Math.abs(daysUntil(s.nextServiceDate)!)}d overdue` : fmt(s.nextServiceDate)}
                              </span>
                            ) : <span className="opacity-40">—</span>}
                          </td>
                          <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                            {s.costPence ? `£${(s.costPence / 100).toFixed(2)}` : "—"}
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell">
                            <CheckPhotoUploader entityType="bike_service" entityId={s.id} compact />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={() => setLogService(s)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteServiceId(s.id)}>
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
                {services.length} service record{services.length !== 1 ? "s" : ""}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────────────── */}
      <NewHireDialog
        open={showNewHire}
        onClose={() => setShowNewHire(false)}
        bikes={bikes}
        onCreated={invalidate}
      />

      <ReturnDialog
        hire={returnHire}
        onClose={() => setReturnHire(null)}
        onReturned={invalidate}
      />

      <BikeFormDialog
        open={editBike !== null}
        bike={editBike === "new" ? null : editBike}
        sites={sites}
        onClose={() => setEditBike(null)}
        onSaved={invalidate}
      />

      <AlertDialog open={deleteBikeId !== null} onOpenChange={v => { if (!v) setDeleteBikeId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove bike?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the bike from the fleet. Hire history will be kept.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-sm bg-destructive hover:bg-destructive/90"
              onClick={() => deleteBikeId !== null && deleteBikeMutation.mutate(deleteBikeId)}
            >Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LogServiceDialog
        open={logService !== null}
        service={logService === "new" ? null : logService}
        bikes={bikes}
        onClose={() => setLogService(null)}
        onSaved={invalidate}
      />

      <AlertDialog open={deleteServiceId !== null} onOpenChange={v => { if (!v) setDeleteServiceId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete service record?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove this service record. The bike's service history will reflect the change.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-sm bg-destructive hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteServiceId) return;
                try {
                  await apiFetch(`/bike-track/services/${deleteServiceId}`, { method: "DELETE" });
                  invalidate();
                  toast({ title: "Service record deleted" });
                } catch (e: any) {
                  toast({ title: "Delete failed", description: e.message, variant: "destructive" });
                } finally {
                  setDeleteServiceId(null);
                }
              }}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </AppLayout>
  );
}
