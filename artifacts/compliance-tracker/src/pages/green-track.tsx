import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
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
import {
  useGetGreenTrackConfig,
  getGetGreenTrackConfigQueryKey,
  useUpdateGreenTrackConfig,
} from "@workspace/api-client-react";
import {
  Tractor, Plus, AlertTriangle, CheckCircle2, Clock, Wrench,
  Pencil, Trash2, Lock, Search, Building2, Filter, ChevronDown, X,
  ShieldAlert, XCircle, CheckCheck, Gauge, Fuel, ClipboardCheck, Droplet, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";

// ─── Constants ────────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

function fmt(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(new Date(d), "dd/MM/yyyy"); } catch { return d; }
}

function daysUntil(d: string | null | undefined): number | null {
  if (!d) return null;
  const diff = new Date(d).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

// ─── Green Config Dialog ──────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T[]; } catch { return fallback; }
}

function GreenConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetGreenTrackConfig();
  const { toast } = useToast();
  const qc = useQueryClient();
  const updateConfig = useUpdateGreenTrackConfig();

  const [defaultOperators, setDefaultOperators] = useState<string[]>([]);
  const [showFuel, setShowFuel] = useState(true);

  useEffect(() => {
    if (!config || !open) return;
    setDefaultOperators(parseJsonArray<string>(config.green_default_operators));
    setShowFuel(config.green_show_fuel !== "false");
  }, [config, open]);

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          green_default_operators: JSON.stringify(defaultOperators.filter(Boolean)),
          green_show_fuel: showFuel ? "true" : "false",
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGreenTrackConfigQueryKey() });
          toast({ title: "Template saved", description: "GreenTrack settings updated." });
          setOpen(false);
        },
        onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-sm h-8 gap-1.5">
          <Settings className="w-3.5 h-3.5" />
          Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>GreenTrack Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure defaults for pre-use checks.</p>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label>Default operators</Label>
            <p className="text-xs text-muted-foreground">These appear as suggestions in the operator field on pre-use checks.</p>
            {defaultOperators.map((op, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input value={op} placeholder="Operator name" className="h-8 text-sm rounded-sm"
                  onChange={e => { const n = [...defaultOperators]; n[i] = e.target.value; setDefaultOperators(n); }} />
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
                  onClick={() => setDefaultOperators(defaultOperators.filter((_, x) => x !== i))}>
                  <X className="w-3.5 h-3.5 text-destructive" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setDefaultOperators([...defaultOperators, ""])}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Add operator
            </Button>
          </div>
          <div className="flex items-center justify-between rounded-sm border border-border p-3">
            <div>
              <p className="text-sm font-medium">Fuel &amp; oil log</p>
              <p className="text-xs text-muted-foreground">Show the fuel/oil tab in GreenTrack</p>
            </div>
            <Switch checked={showFuel} onCheckedChange={setShowFuel} />
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

// ─── Machine types ────────────────────────────────────────────────────────────

const MACHINE_TYPE_LABELS: Record<string, string> = {
  ride_on_cylinder:  "Ride-on (cylinder)",
  ride_on_rotary:    "Ride-on (rotary)",
  fairway_mower:     "Fairway mower",
  walk_behind:       "Walk-behind mower",
  tractor:           "Tractor",
  utility_vehicle:   "Utility vehicle",
  sprayer_spreader:  "Sprayer / spreader",
  aerator:           "Aerator",
  scarifier:         "Scarifier / verticut",
  roller:            "Roller",
  edger_strimmer:    "Edger / strimmer",
  other:             "Other",
};

const MACHINE_TYPES = Object.keys(MACHINE_TYPE_LABELS);

const SERVICE_TYPE_LABELS: Record<string, string> = {
  scheduled:  "Scheduled service",
  annual:     "Annual service",
  unscheduled: "Unscheduled / repair",
};

const SEVERITY_LABELS: Record<string, string> = {
  minor:    "Minor",
  major:    "Major",
  critical: "Critical",
};

const DEFECT_STATUS_LABELS: Record<string, string> = {
  open:         "Open",
  under_repair: "Under repair",
  resolved:     "Resolved",
};

const PUWER_INSPECTION_TYPE_LABELS: Record<string, string> = {
  thorough_examination: "Thorough examination (PUWER)",
  loler_examination:    "Thorough examination (LOLER)",
  annual_inspection:    "Annual inspection",
  periodic_inspection:  "Periodic inspection",
  other:                "Other",
};

const FUEL_TYPE_LABELS: Record<string, string> = {
  diesel:  "Diesel",
  petrol:  "Petrol",
  oil:     "Engine oil",
  hyd_oil: "Hydraulic oil",
  other:   "Other fluid",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Machine {
  id: number;
  clientId: number;
  siteId: number | null;
  siteName: string | null;
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  serialNo: string | null;
  year: number | null;
  regNo: string | null;
  active: boolean;
  notes: string | null;
}

interface PreUseCheck {
  id: number;
  machineId: number;
  machineName: string;
  machineType: string;
  checkDate: string;
  operator: string | null;
  fluidLevelsOk: boolean | null;
  tyresOk: boolean | null;
  bladesOk: boolean | null;
  guardsOk: boolean | null;
  controlsOk: boolean | null;
  lightsOk: boolean | null;
  cleanlinessOk: boolean | null;
  defectNoted: boolean;
  result: string;
  notes: string | null;
}

interface ServiceRecord {
  id: number;
  machineId: number;
  machineName: string;
  machineType: string;
  serviceDate: string;
  serviceType: string;
  hoursAtService: number | null;
  nextServiceHours: number | null;
  nextServiceDate: string | null;
  workPerformed: string | null;
  servicedBy: string | null;
  costPence: number | null;
  notes: string | null;
}

interface Defect {
  id: number;
  machineId: number;
  machineName: string;
  machineType: string;
  reportDate: string;
  reportedBy: string | null;
  description: string;
  severity: string;
  outOfService: boolean;
  status: string;
  resolution: string | null;
  resolvedDate: string | null;
  notes: string | null;
}

interface PuwerInspection {
  id: number;
  machineId: number;
  machineName: string;
  machineType: string;
  inspectionDate: string;
  nextInspectionDate: string | null;
  inspectionType: string;
  inspectorName: string | null;
  inspectorCompany: string | null;
  certRef: string | null;
  safeToOperate: boolean;
  defectsFound: string | null;
  result: string;
  notes: string | null;
}

interface FuelLog {
  id: number;
  machineId: number;
  machineName: string;
  machineType: string;
  logDate: string;
  fuelType: string;
  quantityLitres: number | null;
  engineHours: number | null;
  costPence: number | null;
  filledBy: string | null;
  notes: string | null;
}

interface StatusData {
  totalMachines: number;
  activeMachines: number;
  openDefects: number;
  outOfService: number;
  criticalDefects: number;
  checkedTodayCount: number;
  overdueService: number;
}

// ─── Tri-state check cell ─────────────────────────────────────────────────────

function CheckCell({
  label, value, onChange,
}: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  const cycle = () => onChange(value === null ? true : value === true ? false : null);
  return (
    <button
      type="button"
      onClick={cycle}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-xs font-medium border transition-colors w-full",
        value === true  && "bg-emerald-50 border-emerald-300 text-emerald-700",
        value === false && "bg-rose-50 border-rose-300 text-rose-700",
        value === null  && "bg-muted/30 border-border text-muted-foreground",
      )}
    >
      {value === true  && <CheckCheck className="w-3 h-3 flex-shrink-0" />}
      {value === false && <XCircle    className="w-3 h-3 flex-shrink-0" />}
      {value === null  && <span className="w-3 h-3 flex-shrink-0 opacity-40">·</span>}
      {label}
    </button>
  );
}

// ─── Result badge ─────────────────────────────────────────────────────────────

function ResultBadge({ result }: { result: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pass:     { label: "Pass",     cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    advisory: { label: "Advisory", cls: "bg-amber-50  text-amber-700  border-amber-200" },
    fail:     { label: "Fail",     cls: "bg-rose-50   text-rose-700   border-rose-200" },
  };
  const s = map[result] ?? { label: result, cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={cn("text-[11px]", s.cls)}>{s.label}</Badge>;
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    minor:    "bg-blue-50   text-blue-700   border-blue-200",
    major:    "bg-amber-50  text-amber-700  border-amber-200",
    critical: "bg-rose-50   text-rose-700   border-rose-200",
  };
  return (
    <Badge variant="outline" className={cn("text-[11px]", map[severity] ?? "bg-muted text-muted-foreground border-border")}>
      {SEVERITY_LABELS[severity] ?? severity}
    </Badge>
  );
}

function DefectStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open:         "bg-rose-50   text-rose-700   border-rose-200",
    under_repair: "bg-amber-50  text-amber-700  border-amber-200",
    resolved:     "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <Badge variant="outline" className={cn("text-[11px]", map[status] ?? "bg-muted text-muted-foreground")}>
      {DEFECT_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

// ─── Machine dialog ───────────────────────────────────────────────────────────

function MachineDialog({
  open, onClose, machine, sites, onSaved,
}: {
  open: boolean; onClose: () => void;
  machine?: Machine | null;
  sites: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!machine;
  const blank = { name: "", type: "other", make: "", model: "", serialNo: "", year: "", regNo: "", siteId: "", active: true, notes: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(machine ? {
    name: machine.name, type: machine.type, make: machine.make ?? "",
    model: machine.model ?? "", serialNo: machine.serialNo ?? "",
    year: machine.year ? String(machine.year) : "", regNo: machine.regNo ?? "",
    siteId: machine.siteId ? String(machine.siteId) : "",
    active: machine.active, notes: machine.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.name.trim()) { toast({ title: "Machine name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), type: form.type,
        make: form.make.trim() || null, model: form.model.trim() || null,
        serialNo: form.serialNo.trim() || null, year: form.year ? parseInt(form.year, 10) : null,
        regNo: form.regNo.trim() || null, siteId: form.siteId ? parseInt(form.siteId, 10) : null,
        active: form.active, notes: form.notes.trim() || null,
      };
      if (isEdit) {
        await apiFetch(`/green-track/machines/${machine!.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/machines", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: isEdit ? "Machine updated" : "Machine added" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) { onClose(); } }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Machine" : "Add Machine to Fleet"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Machine name / description *</Label>
              <Input className="mt-1 rounded-sm" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder='e.g. "Toro Reelmaster 5010 H"' />
            </div>
            <div>
              <Label>Type *</Label>
              <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MACHINE_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{MACHINE_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Year <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.year} type="number" min={1980} max={2040}
                onChange={e => setForm(f => ({ ...f, year: e.target.value }))} placeholder="e.g. 2019" />
            </div>
            <div>
              <Label>Make <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.make}
                onChange={e => setForm(f => ({ ...f, make: e.target.value }))} placeholder="e.g. Toro" />
            </div>
            <div>
              <Label>Model <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.model}
                onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="e.g. Reelmaster 5010" />
            </div>
            <div>
              <Label>Serial number <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.serialNo}
                onChange={e => setForm(f => ({ ...f, serialNo: e.target.value }))} />
            </div>
            <div>
              <Label>Reg / fleet no. <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.regNo}
                onChange={e => setForm(f => ({ ...f, regNo: e.target.value }))} placeholder="e.g. GT01" />
            </div>
            <div>
              <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
              <Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">— No site —</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {isEdit && (
              <div className="flex items-center gap-2 pt-1">
                <input type="checkbox" id="active" checked={form.active}
                  onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="rounded" />
                <Label htmlFor="active">Active (in-fleet)</Label>
              </div>
            )}
            <div className="col-span-2">
              <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
              <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Colour, attachments, quirks, assigned operator…" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : isEdit ? "Save changes" : "Add machine"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pre-use check dialog ─────────────────────────────────────────────────────

const CHECK_ITEMS = [
  { key: "fluidLevelsOk", label: "Fluid levels (oil, coolant, hydraulic)" },
  { key: "tyresOk",       label: "Tyres / tracks condition" },
  { key: "bladesOk",      label: "Blades / cutters / reels" },
  { key: "guardsOk",      label: "Safety guards in place" },
  { key: "controlsOk",   label: "Controls / ROPS / seatbelt" },
  { key: "lightsOk",     label: "Lights & warning devices" },
  { key: "cleanlinessOk", label: "General cleanliness / condition" },
] as const;

type CheckItemKey = typeof CHECK_ITEMS[number]["key"];

function PreUseDialog({
  open, onClose, check, machines, onSaved,
}: {
  open: boolean; onClose: () => void;
  check?: PreUseCheck | null;
  machines: Machine[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { data: config } = useGetGreenTrackConfig();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", checkDate: today, operator: "",
    fluidLevelsOk: null as boolean | null, tyresOk: null as boolean | null,
    bladesOk: null as boolean | null, guardsOk: null as boolean | null,
    controlsOk: null as boolean | null, lightsOk: null as boolean | null,
    cleanlinessOk: null as boolean | null, notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(check ? {
    machineId: String(check.machineId), checkDate: check.checkDate,
    operator: check.operator ?? "",
    fluidLevelsOk: check.fluidLevelsOk, tyresOk: check.tyresOk,
    bladesOk: check.bladesOk, guardsOk: check.guardsOk,
    controlsOk: check.controlsOk, lightsOk: check.lightsOk,
    cleanlinessOk: check.cleanlinessOk, notes: check.notes ?? "",
  } : blank);

  // Auto-compute result: any false = fail, any null advisory items present = advisory, else pass
  const autoResult = useMemo(() => {
    const vals = [form.fluidLevelsOk, form.tyresOk, form.bladesOk, form.guardsOk, form.controlsOk, form.lightsOk, form.cleanlinessOk];
    if (vals.some(v => v === false)) return "fail";
    if (vals.every(v => v === true)) return "pass";
    return "advisory";
  }, [form.fluidLevelsOk, form.tyresOk, form.bladesOk, form.guardsOk, form.controlsOk, form.lightsOk, form.cleanlinessOk]);

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const vals: Record<string, boolean | null> = {};
      CHECK_ITEMS.forEach(ci => { vals[ci.key] = (form as any)[ci.key]; });
      const body = {
        machineId: parseInt(form.machineId, 10), checkDate: form.checkDate,
        operator: form.operator.trim() || null,
        ...vals,
        defectNoted: vals.guardsOk === false || vals.bladesOk === false || autoResult === "fail",
        result: autoResult, notes: form.notes.trim() || null,
      };
      if (check) {
        await apiFetch(`/green-track/pre-use-checks/${check.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/pre-use-checks", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: check ? "Check updated" : "Pre-use check recorded" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{check ? "Edit Pre-use Check" : "Record Pre-use Check"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {machines.filter(m => m.active).map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name} <span className="opacity-50">({MACHINE_TYPE_LABELS[m.type] ?? m.type})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.checkDate}
                onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))} />
            </div>
            <div>
              <Label>Operator <span className="text-muted-foreground text-xs">optional</span></Label>
              {(() => {
                const ops = parseJsonArray<string>(config?.green_default_operators);
                return (
                  <>
                    {ops.length > 0 && <datalist id="green-operators-list">{ops.map(op => <option key={op} value={op} />)}</datalist>}
                    <Input className="mt-1 rounded-sm" value={form.operator}
                      list={ops.length > 0 ? "green-operators-list" : undefined}
                      onChange={e => setForm(f => ({ ...f, operator: e.target.value }))} placeholder="Staff name" />
                  </>
                );
              })()}
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Inspection checklist <span className="text-xs text-muted-foreground font-normal">— tap to cycle ✓ / ✗ / n/a</span></Label>
            <div className="grid grid-cols-2 gap-1.5">
              {CHECK_ITEMS.map(ci => (
                <CheckCell
                  key={ci.key}
                  label={ci.label}
                  value={(form as any)[ci.key]}
                  onChange={v => setForm(f => ({ ...f, [ci.key]: v }))}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 px-3 py-2 rounded-sm border bg-muted/20">
            <span className="text-xs text-muted-foreground">Auto-computed result:</span>
            <ResultBadge result={autoResult} />
          </div>

          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Any faults observed, corrective action taken…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : check ? "Save changes" : "Record check"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Service record dialog ────────────────────────────────────────────────────

function ServiceDialog({
  open, onClose, record, machines, onSaved,
}: {
  open: boolean; onClose: () => void;
  record?: ServiceRecord | null;
  machines: Machine[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", serviceDate: today, serviceType: "scheduled",
    hoursAtService: "", nextServiceHours: "", nextServiceDate: "",
    workPerformed: "", servicedBy: "", costPounds: "", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(record ? {
    machineId: String(record.machineId), serviceDate: record.serviceDate,
    serviceType: record.serviceType, hoursAtService: record.hoursAtService ? String(record.hoursAtService) : "",
    nextServiceHours: record.nextServiceHours ? String(record.nextServiceHours) : "",
    nextServiceDate: record.nextServiceDate ?? "", workPerformed: record.workPerformed ?? "",
    servicedBy: record.servicedBy ?? "",
    costPounds: record.costPence ? (record.costPence / 100).toFixed(2) : "",
    notes: record.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10), serviceDate: form.serviceDate,
        serviceType: form.serviceType,
        hoursAtService: form.hoursAtService ? parseInt(form.hoursAtService, 10) : null,
        nextServiceHours: form.nextServiceHours ? parseInt(form.nextServiceHours, 10) : null,
        nextServiceDate: form.nextServiceDate || null,
        workPerformed: form.workPerformed.trim() || null,
        servicedBy: form.servicedBy.trim() || null,
        costPence: form.costPounds ? Math.round(parseFloat(form.costPounds) * 100) : null,
        notes: form.notes.trim() || null,
      };
      if (record) {
        await apiFetch(`/green-track/service-records/${record.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/service-records", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: record ? "Service record updated" : "Service record logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{record ? "Edit Service Record" : "Log Service"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {machines.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Service date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.serviceDate}
                onChange={e => setForm(f => ({ ...f, serviceDate: e.target.value }))} />
            </div>
            <div>
              <Label>Service type</Label>
              <Select value={form.serviceType} onValueChange={v => setForm(f => ({ ...f, serviceType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SERVICE_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Hours at service <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" className="mt-1 rounded-sm" value={form.hoursAtService}
                onChange={e => setForm(f => ({ ...f, hoursAtService: e.target.value }))} placeholder="e.g. 450" />
            </div>
            <div>
              <Label>Next service (hours) <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" className="mt-1 rounded-sm" value={form.nextServiceHours}
                onChange={e => setForm(f => ({ ...f, nextServiceHours: e.target.value }))} placeholder="e.g. 550" />
            </div>
            <div>
              <Label>Next service date <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.nextServiceDate}
                onChange={e => setForm(f => ({ ...f, nextServiceDate: e.target.value }))} />
            </div>
            <div>
              <Label>Serviced by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.servicedBy}
                onChange={e => setForm(f => ({ ...f, servicedBy: e.target.value }))} placeholder="Technician / company" />
            </div>
            <div>
              <Label>Cost (£) <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" step="0.01" min="0" className="mt-1 rounded-sm" value={form.costPounds}
                onChange={e => setForm(f => ({ ...f, costPounds: e.target.value }))} placeholder="0.00" />
            </div>
          </div>
          <div>
            <Label>Work performed <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.workPerformed} rows={2}
              onChange={e => setForm(f => ({ ...f, workPerformed: e.target.value }))}
              placeholder="Oil & filter change, blade sharpening, belt replacement…" />
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : record ? "Save changes" : "Log service"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Defect dialog ────────────────────────────────────────────────────────────

function DefectDialog({
  open, onClose, defect, machines, onSaved,
}: {
  open: boolean; onClose: () => void;
  defect?: Defect | null;
  machines: Machine[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", reportDate: today, reportedBy: "",
    description: "", severity: "minor", outOfService: false,
    status: "open", resolution: "", resolvedDate: "", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(defect ? {
    machineId: String(defect.machineId), reportDate: defect.reportDate,
    reportedBy: defect.reportedBy ?? "", description: defect.description,
    severity: defect.severity, outOfService: defect.outOfService,
    status: defect.status, resolution: defect.resolution ?? "",
    resolvedDate: defect.resolvedDate ?? "", notes: defect.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    if (!form.description.trim()) { toast({ title: "Description is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10), reportDate: form.reportDate,
        reportedBy: form.reportedBy.trim() || null, description: form.description.trim(),
        severity: form.severity, outOfService: form.outOfService,
        status: form.status, resolution: form.resolution.trim() || null,
        resolvedDate: form.resolvedDate || null, notes: form.notes.trim() || null,
      };
      if (defect) {
        await apiFetch(`/green-track/defects/${defect.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/defects", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: defect ? "Defect updated" : "Defect reported" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const isResolved = form.status === "resolved";

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{defect ? "Update Defect Report" : "Report a Defect"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {machines.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Report date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.reportDate}
                onChange={e => setForm(f => ({ ...f, reportDate: e.target.value }))} />
            </div>
            <div>
              <Label>Reported by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.reportedBy}
                onChange={e => setForm(f => ({ ...f, reportedBy: e.target.value }))} placeholder="Staff name" />
            </div>
            <div>
              <Label>Severity</Label>
              <Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SEVERITY_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(DEFECT_STATUS_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="oos" checked={form.outOfService}
              onChange={e => setForm(f => ({ ...f, outOfService: e.target.checked }))} className="rounded" />
            <Label htmlFor="oos" className="text-sm cursor-pointer">
              Take machine <strong>out of service</strong> until repaired
            </Label>
          </div>
          <div>
            <Label>Defect description *</Label>
            <Textarea className="mt-1 rounded-sm" value={form.description} rows={3}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Describe the fault, damage, or safety concern…" />
          </div>
          {(defect || isResolved) && (
            <>
              <div>
                <Label>Resolution / corrective action</Label>
                <Textarea className="mt-1 rounded-sm" value={form.resolution} rows={2}
                  onChange={e => setForm(f => ({ ...f, resolution: e.target.value }))}
                  placeholder="Work carried out to resolve the defect…" />
              </div>
              {isResolved && (
                <div>
                  <Label>Resolved date</Label>
                  <Input type="date" className="mt-1 rounded-sm" value={form.resolvedDate}
                    onChange={e => setForm(f => ({ ...f, resolvedDate: e.target.value }))} />
                </div>
              )}
            </>
          )}
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}
            variant={form.severity === "critical" && form.status !== "resolved" ? "destructive" : "default"}>
            {saving ? "Saving…" : defect ? "Save changes" : "Report defect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════


// ─── PUWER inspection dialog ──────────────────────────────────────────────────

function PuwerDialog({
  open, onClose, inspection, machines, onSaved,
}: {
  open: boolean; onClose: () => void;
  inspection?: PuwerInspection | null;
  machines: Machine[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", inspectionDate: today, nextInspectionDate: "",
    inspectionType: "thorough_examination", inspectorName: "", inspectorCompany: "",
    certRef: "", safeToOperate: true, defectsFound: "", result: "pass", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(inspection ? {
    machineId: String(inspection.machineId), inspectionDate: inspection.inspectionDate,
    nextInspectionDate: inspection.nextInspectionDate ?? "",
    inspectionType: inspection.inspectionType, inspectorName: inspection.inspectorName ?? "",
    inspectorCompany: inspection.inspectorCompany ?? "", certRef: inspection.certRef ?? "",
    safeToOperate: inspection.safeToOperate, defectsFound: inspection.defectsFound ?? "",
    result: inspection.result, notes: inspection.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10),
        inspectionDate: form.inspectionDate,
        nextInspectionDate: form.nextInspectionDate || null,
        inspectionType: form.inspectionType,
        inspectorName: form.inspectorName.trim() || null,
        inspectorCompany: form.inspectorCompany.trim() || null,
        certRef: form.certRef.trim() || null,
        safeToOperate: form.safeToOperate,
        defectsFound: form.defectsFound.trim() || null,
        result: form.safeToOperate ? (form.defectsFound.trim() ? "advisory" : "pass") : "fail",
        notes: form.notes.trim() || null,
      };
      if (inspection) {
        await apiFetch(`/green-track/puwer-inspections/${inspection.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/puwer-inspections", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: inspection ? "Inspection updated" : "Inspection logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{inspection ? "Edit Inspection Record" : "Log PUWER Inspection"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {machines.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Inspection date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.inspectionDate}
                onChange={e => setForm(f => ({ ...f, inspectionDate: e.target.value }))} />
            </div>
            <div>
              <Label>Next inspection due</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.nextInspectionDate}
                onChange={e => setForm(f => ({ ...f, nextInspectionDate: e.target.value }))} />
            </div>
            <div className="col-span-2">
              <Label>Inspection type</Label>
              <Select value={form.inspectionType} onValueChange={v => setForm(f => ({ ...f, inspectionType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PUWER_INSPECTION_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Inspector name <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.inspectorName}
                onChange={e => setForm(f => ({ ...f, inspectorName: e.target.value }))} />
            </div>
            <div>
              <Label>Inspector company <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.inspectorCompany}
                onChange={e => setForm(f => ({ ...f, inspectorCompany: e.target.value }))} />
            </div>
            <div>
              <Label>Certificate / report ref <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.certRef}
                onChange={e => setForm(f => ({ ...f, certRef: e.target.value }))}
                placeholder="e.g. PUWER-2024-001" />
            </div>
            <div className="flex items-center gap-2 pt-4">
              <input type="checkbox" id="safeToOp" checked={form.safeToOperate}
                onChange={e => setForm(f => ({ ...f, safeToOperate: e.target.checked }))} className="rounded" />
              <Label htmlFor="safeToOp" className="text-sm cursor-pointer">Safe to continue operating</Label>
            </div>
          </div>
          <div>
            <Label>Defects / observations <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.defectsFound} rows={2}
              onChange={e => setForm(f => ({ ...f, defectsFound: e.target.value }))}
              placeholder="Any defects identified during inspection…" />
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : inspection ? "Save changes" : "Log inspection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Fuel log dialog ──────────────────────────────────────────────────────────

function FuelLogDialog({
  open, onClose, log, machines, onSaved,
}: {
  open: boolean; onClose: () => void;
  log?: FuelLog | null;
  machines: Machine[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", logDate: today, fuelType: "diesel",
    quantityLitres: "", engineHours: "", costPounds: "", filledBy: "", notes: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(log ? {
    machineId: String(log.machineId), logDate: log.logDate, fuelType: log.fuelType,
    quantityLitres: log.quantityLitres != null ? String(log.quantityLitres) : "",
    engineHours: log.engineHours != null ? String(log.engineHours) : "",
    costPounds: log.costPence != null ? (log.costPence / 100).toFixed(2) : "",
    filledBy: log.filledBy ?? "", notes: log.notes ?? "",
  } : blank);

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10), logDate: form.logDate,
        fuelType: form.fuelType,
        quantityLitres: form.quantityLitres ? parseFloat(form.quantityLitres) : null,
        engineHours: form.engineHours ? parseInt(form.engineHours, 10) : null,
        costPence: form.costPounds ? Math.round(parseFloat(form.costPounds) * 100) : null,
        filledBy: form.filledBy.trim() || null, notes: form.notes.trim() || null,
      };
      if (log) {
        await apiFetch(`/green-track/fuel-logs/${log.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/fuel-logs", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: log ? "Log updated" : "Fuel/oil logged" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{log ? "Edit Fuel / Oil Log" : "Log Fuel / Oil"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {machines.filter(m => m.active).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.logDate}
                onChange={e => setForm(f => ({ ...f, logDate: e.target.value }))} />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.fuelType} onValueChange={v => setForm(f => ({ ...f, fuelType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(FUEL_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Quantity (litres) <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" step="0.1" min="0" className="mt-1 rounded-sm" value={form.quantityLitres}
                onChange={e => setForm(f => ({ ...f, quantityLitres: e.target.value }))} placeholder="e.g. 25.0" />
            </div>
            <div>
              <Label>Engine hours <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" className="mt-1 rounded-sm" value={form.engineHours}
                onChange={e => setForm(f => ({ ...f, engineHours: e.target.value }))} placeholder="e.g. 512" />
            </div>
            <div>
              <Label>Cost (£) <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" step="0.01" min="0" className="mt-1 rounded-sm" value={form.costPounds}
                onChange={e => setForm(f => ({ ...f, costPounds: e.target.value }))} placeholder="0.00" />
            </div>
            <div>
              <Label>Filled by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.filledBy}
                onChange={e => setForm(f => ({ ...f, filledBy: e.target.value }))} placeholder="Staff name" />
            </div>
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : log ? "Save changes" : "Log it"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Tab = "fleet" | "pre-use" | "services" | "defects" | "puwer" | "fuel";

export default function GreenTrackPage() {
  const { user } = useAuth();
  const canAdmin = useCanAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("fleet");
  const [search, setSearch] = useState("");
  const [filterMachine, setFilterMachine] = useState("");

  // Dialogs
  const [machineDialog, setMachineDialog] = useState(false);
  const [editMachine, setEditMachine] = useState<Machine | null>(null);
  const [preUseDialog, setPreUseDialog] = useState(false);
  const [editPreUse, setEditPreUse] = useState<PreUseCheck | null>(null);
  const [serviceDialog, setServiceDialog] = useState(false);
  const [editService, setEditService] = useState<ServiceRecord | null>(null);
  const [defectDialog, setDefectDialog] = useState(false);
  const [editDefect, setEditDefect] = useState<Defect | null>(null);
  const [puwerDialog, setPuwerDialog] = useState(false);
  const [editPuwer, setEditPuwer] = useState<PuwerInspection | null>(null);
  const [fuelDialog, setFuelDialog] = useState(false);
  const [editFuel, setEditFuel] = useState<FuelLog | null>(null);
  const [deleteId, setDeleteId] = useState<{ type: string; id: number } | null>(null);

  // Queries
  const { data: sites = [] } = useQuery({
    queryKey: ["sites"], queryFn: () => apiFetch<{ id: number; name: string }[]>("/sites"),
  });
  const { data: machines = [], isLoading: machinesLoading } = useQuery({
    queryKey: ["green-machines"],
    queryFn: () => apiFetch<Machine[]>("/green-track/machines"),
  });
  const { data: status } = useQuery({
    queryKey: ["green-status"],
    queryFn: () => apiFetch<StatusData>("/green-track/status"),
    refetchInterval: 60_000,
  });
  const { data: preUseChecks = [], isLoading: preUseLoading } = useQuery({
    queryKey: ["green-pre-use", filterMachine],
    queryFn: () => apiFetch<PreUseCheck[]>(`/green-track/pre-use-checks${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "pre-use",
  });
  const { data: serviceRecords = [], isLoading: servicesLoading } = useQuery({
    queryKey: ["green-services", filterMachine],
    queryFn: () => apiFetch<ServiceRecord[]>(`/green-track/service-records${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "services",
  });
  const { data: defects = [], isLoading: defectsLoading } = useQuery({
    queryKey: ["green-defects", filterMachine],
    queryFn: () => apiFetch<Defect[]>(`/green-track/defects${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "defects",
  });
  const { data: puwerInspections = [], isLoading: puwerLoading } = useQuery({
    queryKey: ["green-puwer", filterMachine],
    queryFn: () => apiFetch<PuwerInspection[]>(`/green-track/puwer-inspections${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "puwer",
  });
  const { data: fuelLogs = [], isLoading: fuelLoading } = useQuery({
    queryKey: ["green-fuel", filterMachine],
    queryFn: () => apiFetch<FuelLog[]>(`/green-track/fuel-logs${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "fuel",
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["green-machines"] });
    queryClient.invalidateQueries({ queryKey: ["green-pre-use"] });
    queryClient.invalidateQueries({ queryKey: ["green-services"] });
    queryClient.invalidateQueries({ queryKey: ["green-defects"] });
    queryClient.invalidateQueries({ queryKey: ["green-puwer"] });
    queryClient.invalidateQueries({ queryKey: ["green-fuel"] });
    queryClient.invalidateQueries({ queryKey: ["green-status"] });
  };

  // Delete handler
  const handleDelete = async () => {
    if (!deleteId) return;
    const paths: Record<string, string> = {
      machine: `/green-track/machines/${deleteId.id}`,
      preUse: `/green-track/pre-use-checks/${deleteId.id}`,
      service: `/green-track/service-records/${deleteId.id}`,
      defect: `/green-track/defects/${deleteId.id}`,
    };
    try {
      await apiFetch(paths[deleteId.type], { method: "DELETE" });
      toast({ title: "Deleted" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    } finally { setDeleteId(null); }
  };

  // Filtered datasets
  const q = search.toLowerCase();
  const filteredMachines = useMemo(() =>
    machines.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.make ?? "").toLowerCase().includes(q) ||
      (m.model ?? "").toLowerCase().includes(q) ||
      (m.serialNo ?? "").toLowerCase().includes(q) ||
      (m.regNo ?? "").toLowerCase().includes(q)
    ), [machines, q]);

  const filteredPreUse = useMemo(() =>
    preUseChecks.filter(c =>
      c.machineName.toLowerCase().includes(q) ||
      (c.operator ?? "").toLowerCase().includes(q)
    ), [preUseChecks, q]);

  const filteredServices = useMemo(() =>
    serviceRecords.filter(s =>
      s.machineName.toLowerCase().includes(q) ||
      (s.servicedBy ?? "").toLowerCase().includes(q)
    ), [serviceRecords, q]);

  const filteredDefects = useMemo(() =>
    defects.filter(d =>
      d.machineName.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      (d.reportedBy ?? "").toLowerCase().includes(q)
    ), [defects, q]);

  const filteredPuwer = useMemo(() =>
    puwerInspections.filter(p =>
      p.machineName.toLowerCase().includes(q) ||
      (p.inspectorName ?? "").toLowerCase().includes(q) ||
      (p.inspectorCompany ?? "").toLowerCase().includes(q)
    ), [puwerInspections, q]);

  const filteredFuel = useMemo(() =>
    fuelLogs.filter(f =>
      f.machineName.toLowerCase().includes(q) ||
      (f.filledBy ?? "").toLowerCase().includes(q)
    ), [fuelLogs, q]);

  const { data: greenConfig } = useGetGreenTrackConfig();
  const showFuelTab = greenConfig?.green_show_fuel !== "false";

  const TABS: { key: Tab; label: string; icon: any; count?: number }[] = [
    { key: "fleet",    label: "Fleet",       icon: Tractor,        count: machines.length },
    { key: "pre-use",  label: "Pre-use",     icon: CheckCheck,     count: status?.checkedTodayCount },
    { key: "services", label: "Services",    icon: Wrench },
    { key: "defects",  label: "Defects",     icon: ShieldAlert,    count: status?.openDefects || undefined },
    { key: "puwer",    label: "Inspections", icon: ClipboardCheck },
    ...(showFuelTab ? [{ key: "fuel" as Tab, label: "Fuel / Oil", icon: Fuel }] : []),
  ];

  const activeMachines = machines.filter(m => m.active);

  return (
    <AppLayout title="GreenTrack">
      <div className="space-y-6">

        {/* ── Status strip ──────────────────────────────────────────────── */}
        {status && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              {
                label: "Fleet size",
                value: `${status.activeMachines} active`,
                sub: `${status.totalMachines} total`,
                icon: Tractor,
                cls: "text-primary",
              },
              {
                label: "Open defects",
                value: status.openDefects,
                sub: status.criticalDefects > 0 ? `${status.criticalDefects} critical` : "none critical",
                icon: ShieldAlert,
                cls: status.openDefects > 0 ? "text-amber-600" : "text-emerald-600",
              },
              {
                label: "Out of service",
                value: status.outOfService,
                sub: "machines grounded",
                icon: XCircle,
                cls: status.outOfService > 0 ? "text-rose-600" : "text-emerald-600",
              },
              {
                label: "Services overdue",
                value: status.overdueService,
                sub: "past next-service date",
                icon: Gauge,
                cls: status.overdueService > 0 ? "text-amber-600" : "text-emerald-600",
              },
            ].map(s => (
              <Card key={s.label} className="border-border/50 shadow-sm">
                <CardContent className="p-4 flex items-start gap-3">
                  <s.icon className={cn("w-5 h-5 mt-0.5 flex-shrink-0", s.cls)} />
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={cn("text-2xl font-bold", s.cls)}>{s.value}</p>
                    <p className="text-xs text-muted-foreground">{s.sub}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* ── Tabs + toolbar ────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1 rounded-sm border border-border overflow-hidden">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                  activeTab === t.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                )}>
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className={cn(
                    "ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                    activeTab === t.key ? "bg-white/20 text-white" : "bg-muted text-muted-foreground"
                  )}>{t.count}</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search…" className="pl-8 h-8 w-44 rounded-sm text-sm" />
            </div>
            {activeTab !== "fleet" && (
              <Select value={filterMachine || "_all"} onValueChange={v => setFilterMachine(v === "_all" ? "" : v)}>
                <SelectTrigger className="h-8 rounded-sm text-sm w-44">
                  <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">All machines</SelectItem>
                  {machines.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {activeTab === "fleet" && canAdmin && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditMachine(null); setMachineDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Add machine
              </Button>
            )}
            {activeTab === "pre-use" && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditPreUse(null); setPreUseDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Record check
              </Button>
            )}
            {activeTab === "services" && canAdmin && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditService(null); setServiceDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log service
              </Button>
            )}
            {activeTab === "defects" && (
              <Button size="sm" variant="destructive" className="rounded-sm gap-1.5 h-8"
                onClick={() => { setEditDefect(null); setDefectDialog(true); }}>
                <ShieldAlert className="w-3.5 h-3.5" /> Report defect
              </Button>
            )}
            {activeTab === "puwer" && canAdmin && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditPuwer(null); setPuwerDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log inspection
              </Button>
            )}
            {activeTab === "fuel" && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditFuel(null); setFuelDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log fuel/oil
              </Button>
            )}
            {canAdmin && <GreenConfigDialog />}
          </div>
        </div>

        {/* ── Fleet tab ─────────────────────────────────────────────────── */}
        {activeTab === "fleet" && (
          <>
            {machinesLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading fleet…</div>
            ) : filteredMachines.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Tractor className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No machines in the fleet yet.</p>
                {canAdmin && (
                  <Button onClick={() => { setEditMachine(null); setMachineDialog(true); }}
                    variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                    <Plus className="w-3.5 h-3.5" /> Add first machine
                  </Button>
                )}
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      {["Machine", "Type", "Make / Model", "Serial / Reg", "Site", "Status", ""].map(h => (
                        <th key={h} className={cn(
                          "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                          h === "Make / Model" && "hidden md:table-cell",
                          h === "Serial / Reg" && "hidden lg:table-cell",
                          h === "Site" && "hidden sm:table-cell",
                          h === "" && "w-20",
                        )}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredMachines.map(m => {
                      // Find open defects for this machine
                      const openDefects = defects.filter(d => d.machineId === m.id && d.status !== "resolved");
                      return (
                        <tr key={m.id} className="bg-white hover:bg-muted/20 transition-colors group">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-sm bg-green-100 flex items-center justify-center flex-shrink-0">
                                <Tractor className="w-4 h-4 text-green-700" />
                              </div>
                              <div>
                                <p className="font-semibold text-sm">{m.name}</p>
                                {m.year && <p className="text-xs text-muted-foreground">{m.year}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-[11px] bg-slate-50 text-slate-600 border-slate-200">
                              {MACHINE_TYPE_LABELS[m.type] ?? m.type}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                            {[m.make, m.model].filter(Boolean).join(" ") || "—"}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell text-xs">
                            {m.serialNo || m.regNo ? (
                              <div>
                                {m.serialNo && <div>S/N: {m.serialNo}</div>}
                                {m.regNo && <div>Ref: {m.regNo}</div>}
                              </div>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell text-xs">
                            {m.siteName ?? "—"}
                          </td>
                          <td className="px-4 py-3">
                            {!m.active ? (
                              <Badge variant="outline" className="text-[11px] bg-slate-50 text-slate-500 border-slate-200">Inactive</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[11px] bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {canAdmin && (
                                <>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                    onClick={() => { setEditMachine(m); setMachineDialog(true); }}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => setDeleteId({ type: "machine", id: m.id })}>
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
                <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
                  {filteredMachines.length} machine{filteredMachines.length !== 1 ? "s" : ""}
                  {" · "}{activeMachines.length} active
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Pre-use checks tab ────────────────────────────────────────── */}
        {activeTab === "pre-use" && (
          <>
            {preUseLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading checks…</div>
            ) : filteredPreUse.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <CheckCheck className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No pre-use checks recorded yet.</p>
                <p className="text-xs text-muted-foreground mt-1">PUWER requires operators to check machinery before each use.</p>
                <Button onClick={() => { setEditPreUse(null); setPreUseDialog(true); }}
                  variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                  <Plus className="w-3.5 h-3.5" /> Record first check
                </Button>
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      {["Machine", "Date", "Result", "Operator", "Defect?", "Photos", ""].map(h => (
                        <th key={h} className={cn(
                          "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                          h === "Operator" && "hidden md:table-cell",
                          h === "Photos" && "hidden sm:table-cell",
                          h === "" && "w-20",
                        )}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredPreUse.map(c => (
                      <tr key={c.id} className="bg-white hover:bg-muted/20 transition-colors group">
                        <td className="px-4 py-3">
                          <p className="font-medium">{c.machineName}</p>
                          <p className="text-xs text-muted-foreground">{MACHINE_TYPE_LABELS[c.machineType] ?? c.machineType}</p>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(c.checkDate)}</td>
                        <td className="px-4 py-3"><ResultBadge result={c.result} /></td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{c.operator ?? "—"}</td>
                        <td className="px-4 py-3">
                          {c.defectNoted ? (
                            <Badge variant="outline" className="text-[11px] bg-amber-50 text-amber-700 border-amber-200">
                              <AlertTriangle className="w-2.5 h-2.5 mr-1" />Yes
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <CheckPhotoUploader entityType="green_pre_use_check" entityId={c.id} compact />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                              onClick={() => { setEditPreUse(c); setPreUseDialog(true); }}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            {canAdmin && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteId({ type: "preUse", id: c.id })}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
                  Showing {filteredPreUse.length} check{filteredPreUse.length !== 1 ? "s" : ""}
                </div>
              </div>
            )}
            <div className="bg-green-50 border border-green-200 rounded-sm p-4 text-xs text-green-900">
              <p className="font-semibold mb-1">Regulatory guidance: PUWER 1998 Regulation 5</p>
              <p>Work equipment must be maintained in an efficient state, in efficient working order and in good repair. Operators must carry out a pre-use check before operating any machinery. Defects must be reported immediately and machines taken out of service until repaired.</p>
            </div>
          </>
        )}

        {/* ── Services tab ──────────────────────────────────────────────── */}
        {activeTab === "services" && (
          <>
            {servicesLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading records…</div>
            ) : filteredServices.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Wrench className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No service records yet.</p>
                {canAdmin && (
                  <Button onClick={() => { setEditService(null); setServiceDialog(true); }}
                    variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                    <Plus className="w-3.5 h-3.5" /> Log first service
                  </Button>
                )}
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      {["Machine", "Date", "Type", "Serviced By", "Next Due", "Cost", "Photos", ""].map(h => (
                        <th key={h} className={cn(
                          "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                          h === "Serviced By" && "hidden md:table-cell",
                          h === "Next Due" && "hidden md:table-cell",
                          h === "Cost" && "hidden lg:table-cell",
                          h === "Photos" && "hidden sm:table-cell",
                          h === "" && "w-20",
                        )}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredServices.map(s => {
                      const days = daysUntil(s.nextServiceDate);
                      const overdue = days !== null && days < 0;
                      const dueSoon = days !== null && !overdue && days <= 14;
                      return (
                        <tr key={s.id} className="bg-white hover:bg-muted/20 transition-colors group">
                          <td className="px-4 py-3">
                            <p className="font-medium">{s.machineName}</p>
                            <p className="text-xs text-muted-foreground">{MACHINE_TYPE_LABELS[s.machineType] ?? s.machineType}</p>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(s.serviceDate)}</td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className={cn("text-[11px]",
                              s.serviceType === "annual"      ? "bg-blue-50 text-blue-700 border-blue-200" :
                              s.serviceType === "scheduled"   ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                              "bg-slate-50 text-slate-600 border-slate-200"
                            )}>
                              {SERVICE_TYPE_LABELS[s.serviceType] ?? s.serviceType}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{s.servicedBy ?? "—"}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            {s.nextServiceDate ? (
                              <span className={cn("text-xs font-medium",
                                overdue ? "text-rose-600" : dueSoon ? "text-amber-600" : "text-muted-foreground"
                              )}>
                                {overdue ? `⚠ ${Math.abs(days!)}d overdue` : dueSoon ? `Due in ${days}d` : fmt(s.nextServiceDate)}
                              </span>
                            ) : <span className="text-muted-foreground opacity-40">—</span>}
                          </td>
                          <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                            {s.costPence ? `£${(s.costPence / 100).toFixed(2)}` : "—"}
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell">
                            <CheckPhotoUploader entityType="green_service" entityId={s.id} compact />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {canAdmin && (
                                <>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                    onClick={() => { setEditService(s); setServiceDialog(true); }}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => setDeleteId({ type: "service", id: s.id })}>
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
                <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
                  {filteredServices.length} service record{filteredServices.length !== 1 ? "s" : ""}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Defects tab ───────────────────────────────────────────────── */}
        {activeTab === "defects" && (
          <>
            {defectsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading defects…</div>
            ) : filteredDefects.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <ShieldAlert className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No defects reported.</p>
                <Button onClick={() => { setEditDefect(null); setDefectDialog(true); }}
                  variant="outline" size="sm" className="mt-3 gap-1.5 rounded-sm">
                  <ShieldAlert className="w-3.5 h-3.5" /> Report a defect
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredDefects.map(d => (
                  <div key={d.id} className={cn(
                    "border rounded-sm p-4",
                    d.status === "resolved" ? "bg-muted/10 border-border/50 opacity-75" :
                    d.severity === "critical" ? "bg-rose-50 border-rose-200" :
                    d.severity === "major" ? "bg-amber-50 border-amber-200" : "bg-white border-border",
                  )}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm">{d.machineName}</span>
                          <SeverityBadge severity={d.severity} />
                          <DefectStatusBadge status={d.status} />
                          {d.outOfService && (
                            <Badge variant="outline" className="text-[11px] bg-rose-50 text-rose-700 border-rose-200">
                              <XCircle className="w-2.5 h-2.5 mr-1" />Out of service
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm">{d.description}</p>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <div><span className="font-medium">Reported:</span> {fmt(d.reportDate)}{d.reportedBy ? ` by ${d.reportedBy}` : ""}</div>
                          {d.resolution && <div><span className="font-medium">Resolution:</span> {d.resolution}</div>}
                          {d.resolvedDate && <div><span className="font-medium">Resolved:</span> {fmt(d.resolvedDate)}</div>}
                          {d.notes && <div><span className="font-medium">Notes:</span> {d.notes}</div>}
                        </div>
                        <CheckPhotoUploader entityType="green_defect" entityId={d.id} compact />
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                          onClick={() => { setEditDefect(d); setDefectDialog(true); }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        {canAdmin && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteId({ type: "defect", id: d.id })}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="bg-green-50 border border-green-200 rounded-sm p-4 text-xs text-green-900">
              <p className="font-semibold mb-1">Regulatory guidance: PUWER 1998 Regulation 5 / HSE guidance</p>
              <p>Any defect that could affect the safe operation of work equipment must be reported immediately. The machine must be taken out of service until the defect is repaired by a competent person. All defects and repairs must be recorded.</p>
            </div>
          </>
        )}
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
        {/* ── PUWER Inspections tab ──────────────────────────────────────── */}
        {activeTab === "puwer" && (
          <>
            <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2">
              <ClipboardCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>PUWER thorough examinations must be carried out by a competent person at least every 12 months (or as specified by risk assessment). Records must be retained and available for inspection.</span>
            </div>
            {puwerLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading inspections…</div>
            ) : filteredPuwer.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <ClipboardCheck className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No inspection records yet.</p>
                {canAdmin && (
                  <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5"
                    onClick={() => { setEditPuwer(null); setPuwerDialog(true); }}>
                    <Plus className="w-3.5 h-3.5" /> Log first inspection
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left font-medium py-2 pr-4">Machine</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Type</th>
                      <th className="text-left font-medium py-2 pr-4">Date</th>
                      <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Next due</th>
                      <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Inspector</th>
                      <th className="text-left font-medium py-2 pr-4">Result</th>
                      <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Safe to op?</th>
                      {canAdmin && <th className="w-16" />}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPuwer.map(p => {
                      const today = new Date().toISOString().split("T")[0];
                      const overdue = p.nextInspectionDate && p.nextInspectionDate < today;
                      const due30 = p.nextInspectionDate && !overdue &&
                        new Date(p.nextInspectionDate) <= new Date(Date.now() + 30 * 86400000);
                      return (
                        <tr key={p.id} className={`border-b last:border-0 ${!p.safeToOperate ? "bg-red-50 dark:bg-red-900/10" : ""}`}>
                          <td className="py-2 pr-4 font-medium">{p.machineName}</td>
                          <td className="py-2 pr-4 text-muted-foreground text-xs hidden sm:table-cell">
                            {PUWER_INSPECTION_TYPE_LABELS[p.inspectionType] ?? p.inspectionType}
                          </td>
                          <td className="py-2 pr-4 tabular-nums">{p.inspectionDate}</td>
                          <td className="py-2 pr-4 hidden md:table-cell">
                            {p.nextInspectionDate ? (
                              <span className={`tabular-nums ${overdue ? "text-destructive font-medium" : due30 ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                                {overdue && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                                {p.nextInspectionDate}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-2 pr-4 text-muted-foreground hidden lg:table-cell">
                            {p.inspectorName ?? "—"}{p.inspectorCompany ? ` (${p.inspectorCompany})` : ""}
                          </td>
                          <td className="py-2 pr-4">
                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                              p.result === "pass" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                              p.result === "advisory" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                              "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                            }`}>
                              {p.result === "pass" ? <CheckCircle2 className="w-3 h-3" /> :
                               p.result === "advisory" ? <AlertTriangle className="w-3 h-3" /> :
                               <XCircle className="w-3 h-3" />}
                              {p.result.charAt(0).toUpperCase() + p.result.slice(1)}
                            </span>
                          </td>
                          <td className="py-2 pr-4 hidden sm:table-cell">
                            {p.safeToOperate
                              ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                              : <XCircle className="w-4 h-4 text-destructive" />}
                          </td>
                          {canAdmin && (
                            <td className="py-2 text-right">
                              <Button size="icon" variant="ghost" className="h-7 w-7"
                                onClick={() => { setEditPuwer(p); setPuwerDialog(true); }}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                                onClick={() => setDeleteId({ type: "puwer-inspections", id: p.id })}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── Fuel / Oil log tab ─────────────────────────────────────────── */}
        {activeTab === "fuel" && (
          <>
            {fuelLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading fuel logs…</div>
            ) : filteredFuel.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Fuel className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No fuel or oil logs yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5"
                  onClick={() => { setEditFuel(null); setFuelDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Log first entry
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left font-medium py-2 pr-4">Machine</th>
                      <th className="text-left font-medium py-2 pr-4">Date</th>
                      <th className="text-left font-medium py-2 pr-4">Type</th>
                      <th className="text-right font-medium py-2 pr-4 hidden sm:table-cell">Litres</th>
                      <th className="text-right font-medium py-2 pr-4 hidden md:table-cell">Hours</th>
                      <th className="text-right font-medium py-2 pr-4 hidden md:table-cell">Cost</th>
                      <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Filled by</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFuel.map(f => (
                      <tr key={f.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">{f.machineName}</td>
                        <td className="py-2 pr-4 tabular-nums">{f.logDate}</td>
                        <td className="py-2 pr-4">
                          <span className="flex items-center gap-1 text-xs">
                            <Droplet className="w-3 h-3 text-blue-500" />
                            {FUEL_TYPE_LABELS[f.fuelType] ?? f.fuelType}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">
                          {f.quantityLitres != null ? `${f.quantityLitres}L` : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden md:table-cell">
                          {f.engineHours != null ? `${f.engineHours}h` : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden md:table-cell">
                          {f.costPence != null ? `£${(f.costPence / 100).toFixed(2)}` : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground hidden lg:table-cell">{f.filledBy ?? "—"}</td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => { setEditFuel(f); setFuelDialog(true); }}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {canAdmin && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => setDeleteId({ type: "fuel-logs", id: f.id })}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

      <MachineDialog open={machineDialog} onClose={() => { setMachineDialog(false); setEditMachine(null); }}
        machine={editMachine} sites={sites} onSaved={invalidate} />

      <PreUseDialog open={preUseDialog} onClose={() => { setPreUseDialog(false); setEditPreUse(null); }}
        check={editPreUse} machines={activeMachines} onSaved={invalidate} />

      <ServiceDialog open={serviceDialog} onClose={() => { setServiceDialog(false); setEditService(null); }}
        record={editService} machines={machines} onSaved={invalidate} />

      <DefectDialog open={defectDialog} onClose={() => { setDefectDialog(false); setEditDefect(null); }}
        defect={editDefect} machines={machines} onSaved={invalidate} />

      <PuwerDialog open={puwerDialog} onClose={() => { setPuwerDialog(false); setEditPuwer(null); }}
        inspection={editPuwer} machines={machines} onSaved={invalidate} />

      <FuelLogDialog open={fuelDialog} onClose={() => { setFuelDialog(false); setEditFuel(null); }}
        log={editFuel} machines={machines} onSaved={invalidate} />

      <AlertDialog open={!!deleteId} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
