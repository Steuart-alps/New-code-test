import { useState, useMemo, useEffect, useCallback } from "react";
import { takeLinkParams } from "@/lib/deep-link";
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
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import {
  useGetGreenTrackConfig,
  getGetGreenTrackConfigQueryKey,
  useUpdateGreenTrackConfig,
  NSTS_SPRAYER_CATEGORIES,
  NSTS_TEST_INSPECTION_TYPE,
  isNstsSprayerCategory,
  nstsNextTestDate,
  nstsStatus,
  type NstsStatus,
} from "@workspace/api-client-react";
import {
  Tractor, Plus, AlertTriangle, CheckCircle2, Clock, Wrench,
  Pencil, Trash2, Lock, Search, Building2, Filter, ChevronDown, X,
  ShieldAlert, XCircle, CheckCheck, Gauge, Fuel, ClipboardCheck, Droplet, Settings,
  Upload, Download, SprayCan, Package, Mic, Loader2, Sunrise,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SpreadsheetDropZone, isSpreadsheetFile } from "@/components/spreadsheet-drop-zone";
import { ListReadNote, ListReadingPanel, isPhotoOrPdf, useListReading, type ListReadResult } from "@/components/ai-list-reader";
import { format } from "date-fns";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { RequiredRecordPhotoEvidence, useNewRecordPhotoEvidence } from "@/components/required-record-photo-evidence";
import { StaffPerformerSelect } from "@/components/staff-performer-select";
import { ModuleActionsPanel } from "@/components/module-actions-panel";
import { GreenSprayingTab, GreenStockTab } from "@/components/green-track-spraying";
import { SpeakToPickDialog } from "@/components/speak-to-pick-dialog";
import { dictationSupported } from "@/components/dictation-button";
import { getApiErrorMessage } from "@/lib/api";
import { usePhotoRequirements } from "@/hooks/use-photo-requirements";
import { DocumentField, downloadRegisterDocument, type DocumentValue } from "@/components/register-shared";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { GreenDailyChecksTab } from "@/components/green-daily-checks";
import { sortByLabel, sortedEntries } from "@/lib/sort-options";

// ─── Constants ────────────────────────────────────────────────────────────────

function useGreenTrackApi() {
  const request = useActiveClientApi();
  return useCallback(async <T = any,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(path, init);
    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response, `Request failed: ${response.status}`));
    }
    return response.json() as Promise<T>;
  }, [request]);
}

function fmt(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(new Date(d), "dd/MM/yyyy"); } catch { return d; }
}

/** The calendar day (YYYY-MM-DD) of a date or timestamp from the API. */
function isoDay(d: string | null | undefined): string | null {
  if (!d) return null;
  // The API sends dates as UTC midnight, so the first ten characters are the day.
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

function nstsIntervalText(category: string): string {
  if (!isNstsSprayerCategory(category)) return "";
  const c = NSTS_SPRAYER_CATEGORIES[category];
  if (!c.formalTest) return "competent-person check, yearly suggested";
  return `NSTS test before 5 years old, then every ${c.retestYears} years`;
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
  const newRow = useFocusNewRow();
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
          <div ref={newRow.ref} className="space-y-2">
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
            <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setDefaultOperators([...defaultOperators, ""]); }}>
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
  ride_on:           "Ride-on equipment",
  pedestrian:        "Pedestrian equipment",
  fairway_mower:     "Fairway mower",
  walk_behind:       "Walk-behind mower",
  tractor:           "Tractor",
  utility_vehicle:   "Utility vehicle",
  sprayer_spreader:  "Sprayer / spreader",
  aerator:           "Aerator",
  atv_quad:          "ATV / quad bike",
  blower:            "Blower",
  chainsaw:          "Chainsaw",
  hedge_trimmer:     "Hedge trimmer",
  topdresser:        "Topdresser",
  scarifier:         "Scarifier / verticut",
  roller:            "Roller",
  edger_strimmer:    "Edger / strimmer",
  other:             "Other",
};

const MACHINE_TYPES = sortByLabel(Object.keys(MACHINE_TYPE_LABELS), t => MACHINE_TYPE_LABELS[t]);

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
  [NSTS_TEST_INSPECTION_TYPE]: "NSTS sprayer test",
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
  /** NSTS category; only sprayers have one. */
  sprayerCategory: string | null;
  purchaseDate: string | null;
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
  checklistItems: Array<{
    key: string;
    label: string;
    section: string;
    status: "ok" | "fail" | "na";
    note?: string;
  }> | null;
  fuelLevel: string | null;
  hourMeter?: number | null;
  submittedAt: string | null;
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
  servicedByRosterId: number | null;
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
  reportedByRosterId: number | null;
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
  inspectorRosterId: number | null;
  inspectorCompany: string | null;
  certRef: string | null;
  safeToOperate: boolean;
  defectsFound: string | null;
  result: string;
  notes: string | null;
  certificateObjectPath: string | null;
  certificateFileName: string | null;
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
  filledByRosterId: number | null;
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
  /** Machines whose hour meter has reached the latest service's "next service at" hours. */
  overdueServiceByHours?: number;
  /** Active sprayers with an NSTS sprayer type, and when each is next due. */
  nstsSprayers?: NstsSprayerRow[];
  nstsOverdue?: number;
  /** Active products at or below their re-order level. */
  lowStockProducts?: number;
}

interface NstsSprayerRow extends NstsStatus {
  machineId: number;
  machineName: string;
  sprayerCategory: string;
  lastTestDate: string | null;
  lastTestId: number | null;
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
  const apiFetch = useGreenTrackApi();
  const isEdit = !!machine;
  const blank = { name: "", type: "other", make: "", model: "", serialNo: "", year: "", regNo: "", siteId: "", active: true, notes: "", sprayerCategory: "", purchaseDate: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(machine ? {
    name: machine.name, type: machine.type, make: machine.make ?? "",
    model: machine.model ?? "", serialNo: machine.serialNo ?? "",
    year: machine.year ? String(machine.year) : "", regNo: machine.regNo ?? "",
    siteId: machine.siteId ? String(machine.siteId) : "",
    active: machine.active, notes: machine.notes ?? "",
    sprayerCategory: machine.sprayerCategory ?? "", purchaseDate: isoDay(machine.purchaseDate) ?? "",
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
        sprayerCategory: form.type === "sprayer_spreader" ? form.sprayerCategory || null : null,
        purchaseDate: form.purchaseDate || null,
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
            {form.type === "sprayer_spreader" && (
              <div className="col-span-2">
                <Label>Sprayer type (sets the NSTS test interval)</Label>
                <Select value={form.sprayerCategory || "_none"} onValueChange={v => setForm(f => ({ ...f, sprayerCategory: v === "_none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm" data-testid="select-sprayer-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">— Not a pesticide sprayer / not set —</SelectItem>
                    {sortByLabel(Object.entries(NSTS_SPRAYER_CATEGORIES), ([, c]) => c.label).map(([key, c]) => (
                      <SelectItem key={key} value={key}>{c.label} · {nstsIntervalText(key)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label>Purchase date <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" type="date" value={form.purchaseDate} data-testid="input-purchase-date"
                onChange={e => setForm(f => ({ ...f, purchaseDate: e.target.value }))} />
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

type MachineImportRow = {
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  serialNo: string | null;
  year: number | null;
  regNo: string | null;
  siteId: number | null;
  notes: string | null;
  active: boolean;
};

function importHeaderKey(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function parseMachineRoster(
  table: string[][],
  sites: { id: number; name: string }[],
): { rows: MachineImportRow[]; errors: string[] } {
  if (table.length < 2) return { rows: [], errors: ["Add a header row and at least one equipment row."] };

  const aliases: Record<string, string[]> = {
    name: ["name", "machine_name", "equipment", "equipment_name", "description"],
    type: ["type", "machine_type", "equipment_type", "category", "class"],
    make: ["make", "manufacturer"],
    model: ["model"],
    serialNo: ["serial_no", "serial_number", "serial", "serialno"],
    regNo: ["reg_no", "registration", "fleet_no", "fleet_number", "asset_tag", "asset_no"],
    year: ["year", "manufacture_year"],
    site: ["site", "site_name", "location"],
    notes: ["notes", "note"],
    active: ["active", "status"],
  };
  const headers = table[0].map(importHeaderKey);
  const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [
    key,
    names.map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1,
  ])) as Record<string, number>;
  const errors: string[] = [];
  if (indexes.name < 0) errors.push("The spreadsheet needs a name or equipment column.");
  if (indexes.type < 0) errors.push("The spreadsheet needs a type or category column.");
  if (errors.length) return { rows: [], errors };

  const siteByName = new Map(sites.map(site => [site.name.trim().toLowerCase(), site.id]));
  const rows: MachineImportRow[] = [];
  table.slice(1).forEach((values, index) => {
    const rowNumber = index + 2;
    const value = (key: string) => indexes[key] >= 0 ? values[indexes[key]]?.trim() ?? "" : "";
    const siteName = value("site");
    const yearText = value("year");
    const activeText = value("active").toLowerCase();
    const siteId = siteName ? siteByName.get(siteName.toLowerCase()) : null;
    if (!value("name")) errors.push(`Row ${rowNumber}: name is required.`);
    if (!value("type")) errors.push(`Row ${rowNumber}: type is required.`);
    if (siteName && siteId === undefined) errors.push(`Row ${rowNumber}: site "${siteName}" was not found.`);
    if (yearText && (!/^\d{4}$/.test(yearText) || Number(yearText) < 1900 || Number(yearText) > 2100)) {
      errors.push(`Row ${rowNumber}: year must be between 1900 and 2100.`);
    }
    if (!value("name") || !value("type") || (siteName && siteId === undefined)) return;
    rows.push({
      name: value("name"),
      type: value("type"),
      make: value("make") || null,
      model: value("model") || null,
      serialNo: value("serialNo") || null,
      year: yearText ? Number(yearText) : null,
      regNo: value("regNo") || null,
      siteId: siteId ?? null,
      notes: value("notes") || null,
      active: !["false", "no", "inactive", "0"].includes(activeText),
    });
  });
  return { rows, errors };
}

async function downloadMachineRosterTemplate() {
  const { downloadExcel } = await import("@/lib/spreadsheet");
  downloadExcel("greentrack-equipment-template.xlsx", "Equipment", [
    ["name", "type", "make", "model", "serial_no", "reg_no", "year", "site", "notes", "active"],
    ["Greens mower 1", "ride-on", "Toro", "Reelmaster 5010", "RM-001", "GT-01", "2021", "", "Main cutting unit", "true"],
    ["Pedestrian mower 1", "pedestrian", "Honda", "HRX 537", "PM-001", "GT-02", "2022", "", "Walk-behind mower", "true"],
  ]);
}

function MachineImportDialog({
  open, onClose, sites, onImported,
}: {
  open: boolean;
  onClose: () => void;
  sites: { id: number; name: string }[];
  onImported: () => void;
}) {
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<MachineImportRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  // A photo or document of the equipment list read by ComplyTrack (AI add-on).
  const reading = useListReading("greentrack-equipment", open);
  const [readFromList, setReadFromList] = useState<ListReadResult | null>(null);
  const [readingList, setReadingList] = useState(false);

  const reset = () => {
    setFileName("");
    setRows([]);
    setErrors([]);
    setReadFromList(null);
  };

  const handleListFile = async (file: File) => {
    reset();
    setFileName(file.name);
    setReadingList(true);
    try {
      const read = await reading.read(file);
      const parsed = parseMachineRoster([read.headers, ...read.rows], sites);
      setRows(parsed.rows);
      setErrors(parsed.errors);
      setReadFromList(read);
    } catch (err) {
      setFileName("");
      toast({ title: "Could not read the list", description: err instanceof Error && err.message ? err.message : "Try again, or upload a spreadsheet.", variant: "destructive" });
    } finally {
      setReadingList(false);
    }
  };

  const downloadReadRows = async () => {
    if (!readFromList) return;
    const { downloadExcel } = await import("@/lib/spreadsheet");
    downloadExcel("greentrack-equipment-read-from-list.xlsx", "Equipment", [readFromList.headers, ...readFromList.rows]);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!isSpreadsheetFile(file)) {
      if (reading.canRead && isPhotoOrPdf(file)) return void handleListFile(file);
      toast({ title: "That isn't a spreadsheet", description: "Choose an Excel (.xlsx or .xls) or CSV file.", variant: "destructive" });
      return;
    }
    let table: string[][];
    try {
      // Excel or CSV, read in the browser from the first sheet.
      const { readSpreadsheet } = await import("@/lib/spreadsheet");
      const sheet = await readSpreadsheet(file);
      table = sheet.headers.length ? [sheet.headers, ...sheet.rows].map(row => row.map(cell => cell.trim())).filter(row => row.some(Boolean)) : [];
    } catch (err) {
      toast({ title: "Could not read file", description: err instanceof Error && err.message ? err.message : "Make sure it is an Excel (.xlsx or .xls) or CSV file.", variant: "destructive" });
      return;
    }
    const parsed = parseMachineRoster(table, sites);
    setReadFromList(null);
    setFileName(file.name);
    setRows(parsed.rows);
    setErrors(parsed.errors);
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const result = await apiFetch<{ imported: number; skipped: Array<{ name: string; reason: string }> }>(
        "/green-track/machines/import",
        { method: "POST", body: JSON.stringify({ rows }) },
      );
      toast({
        title: "Equipment roster imported",
        description: `${result.imported} added${result.skipped.length ? `, ${result.skipped.length} already in the fleet` : ""}.`,
      });
      onImported();
      onClose();
      reset();
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !importing) { onClose(); reset(); } }}>
      <DialogContent className="max-w-2xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload equipment roster</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Import the account&apos;s equipment list once, then staff can select the active machines in GreenTrack.
          </p>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-sm" onClick={downloadMachineRosterTemplate}>
              <Download className="w-3.5 h-3.5" /> Download Excel template
            </Button>
            {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
            {readingList && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Reading your list… this can take a minute</span>}
          </div>
          <SpreadsheetDropZone onFile={file => void handleFile(file)} testId="input-machine-roster-file" className="rounded-sm" />
          <ListReadingPanel reading={reading} kind="greentrack-equipment" noun="machines" disabled={readingList} onFile={file => void handleListFile(file)} />
          {readFromList && <ListReadNote result={readFromList} noun="machines" one="machine" kind="greentrack-equipment" onDownload={() => void downloadReadRows()} />}
          <p className="text-xs text-muted-foreground">
            Required columns: <strong>name</strong> and <strong>type</strong>. Supported broad types include
            <strong> ride-on</strong>, <strong>pedestrian</strong>, tractor, utility, and other approved GreenTrack types.
            Optional columns include make, model, serial number, fleet number, year, site, notes, and active.
            Use names staff would say, such as &quot;Fairway mower 1&quot;, so they can open a machine&apos;s pre-use check by saying its name.
          </p>
          {errors.length > 0 && (
            <div className="rounded-sm border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <p className="font-medium">Fix these rows before importing:</p>
              <ul className="mt-1 list-disc pl-5 space-y-0.5">{errors.slice(0, 8).map(error => <li key={error}>{error}</li>)}</ul>
              {errors.length > 8 && <p className="mt-1 text-xs">…and {errors.length - 8} more.</p>}
            </div>
          )}
          {rows.length > 0 && (
            <div className="overflow-hidden rounded-sm border border-border">
              <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium">
                Previewing {rows.length} equipment item{rows.length === 1 ? "" : "s"}
              </div>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="border-b border-border text-left text-muted-foreground">
                    <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Identifier</th><th className="px-3 py-2">Site</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.slice(0, 50).map(row => (
                      <tr key={`${row.name}-${row.serialNo ?? row.regNo ?? row.type}`}>
                        <td className="px-3 py-2 font-medium">{row.name}</td>
                        <td className="px-3 py-2">{MACHINE_TYPE_LABELS[row.type.toLowerCase()] ?? row.type}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.serialNo ?? row.regNo ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{sites.find(site => site.id === row.siteId)?.name ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 50 && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Showing the first 50 rows.</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); reset(); }} disabled={importing}>Cancel</Button>
          <Button onClick={handleImport} disabled={importing || rows.length === 0 || errors.length > 0}>
            {importing ? "Importing…" : `Import ${rows.length || ""} equipment`}
          </Button>
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
  open, onClose, check, machines, onSaved, presetMachineId,
}: {
  open: boolean; onClose: () => void;
  check?: PreUseCheck | null;
  machines: Machine[];
  onSaved: () => void;
  /** A new record for this machine (opened from a scanned QR label). */
  presetMachineId?: string;
}) {
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const { data: config } = useGetGreenTrackConfig();
  const photoEvidence = useNewRecordPhotoEvidence("green_pre_use_check", open && !check);
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", checkDate: today, operator: "", operatorRosterId: null as number | null,
    fluidLevelsOk: null as boolean | null, tyresOk: null as boolean | null,
    bladesOk: null as boolean | null, guardsOk: null as boolean | null,
    controlsOk: null as boolean | null, lightsOk: null as boolean | null,
    cleanlinessOk: null as boolean | null, notes: "", hourMeter: "",
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const photoEvidenceBlocked = photoEvidence.enabled && (
    !photoEvidence.ready || photoEvidence.loading || !!photoEvidence.error || photoEvidence.uploading ||
    (photoEvidence.required && photoEvidence.uploadIds.length < photoEvidence.minimum)
  );

  const reset = () => {
    photoEvidence.reset();
    setForm(check ? {
      machineId: String(check.machineId), checkDate: check.checkDate,
      operator: check.operator ?? "", operatorRosterId: (check as any).operatorRosterId ?? (check as any).operator_roster_id ?? null,
      fluidLevelsOk: check.fluidLevelsOk, tyresOk: check.tyresOk,
      bladesOk: check.bladesOk, guardsOk: check.guardsOk,
      controlsOk: check.controlsOk, lightsOk: check.lightsOk,
      cleanlinessOk: check.cleanlinessOk, notes: check.notes ?? "",
      hourMeter: (check.hourMeter ?? (check as any).hour_meter) != null ? String(check.hourMeter ?? (check as any).hour_meter) : "",
    } : { ...blank, machineId: presetMachineId ?? "" });
  };

  // N/A is represented at checklist-item level; the completed observation is
  // always canonical pass/fail.
  const autoResult = useMemo(() => {
    const vals = [form.fluidLevelsOk, form.tyresOk, form.bladesOk, form.guardsOk, form.controlsOk, form.lightsOk, form.cleanlinessOk];
    if (vals.some(v => v === false)) return "fail";
    return "pass";
  }, [form.fluidLevelsOk, form.tyresOk, form.bladesOk, form.guardsOk, form.controlsOk, form.lightsOk, form.cleanlinessOk]);

  const handleSave = async () => {
    if (!check && photoEvidenceBlocked) return;
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const vals: Record<string, boolean | null> = {};
      CHECK_ITEMS.forEach(ci => { vals[ci.key] = (form as any)[ci.key]; });
      const body = {
        machineId: parseInt(form.machineId, 10), checkDate: form.checkDate,
        operator: form.operator.trim() || null,
        operatorRosterId: form.operatorRosterId,
        ...vals,
        defectNoted: vals.guardsOk === false || vals.bladesOk === false || autoResult === "fail",
        result: autoResult, notes: form.notes.trim() || null,
        hourMeter: form.hourMeter.trim() ? Number(form.hourMeter) : null,
      };
      if (check) {
        await apiFetch(`/green-track/pre-use-checks/${check.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/pre-use-checks", {
          method: "POST",
          body: JSON.stringify({ ...body, photoUploadIds: photoEvidence.uploadIds }),
        });
        photoEvidence.consume();
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
                {sortByLabel(machines.filter(m => m.active), m => m.name).map(m => (
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
                return (
                  <StaffPerformerSelect label="Operator" value={form.operator}
                    onChange={(value) => setForm(f => ({ ...f, operator: value }))}
                    onRosterIdChange={(value) => setForm(f => ({ ...f, operatorRosterId: value }))} />
                );
              })()}
            </div>
            <div>
              <Label>Hour meter reading <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="number" step="0.1" min="0" inputMode="decimal" className="mt-1 rounded-sm" value={form.hourMeter}
                data-testid="input-pre-use-hour-meter"
                onChange={e => setForm(f => ({ ...f, hourMeter: e.target.value }))} placeholder="e.g. 1234.5" />
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
          <RequiredRecordPhotoEvidence evidence={photoEvidence} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (!check && photoEvidenceBlocked)}>
            {saving ? "Saving…" : check ? "Save changes" : "Record check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Service record dialog ────────────────────────────────────────────────────

function ServiceDialog({
  open, onClose, record, machines, onSaved, presetMachineId,
}: {
  open: boolean; onClose: () => void;
  record?: ServiceRecord | null;
  machines: Machine[];
  onSaved: () => void;
  /** A new record for this machine (opened from a scanned QR label). */
  presetMachineId?: string;
}) {
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const photoEvidence = useNewRecordPhotoEvidence("green_service", open && !record);
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", serviceDate: today, serviceType: "scheduled",
    hoursAtService: "", nextServiceHours: "", nextServiceDate: "",
    workPerformed: "", servicedBy: "", servicedByRosterId: null, costPounds: "", notes: "",
  };
  const [form, setForm] = useState({ ...blank, servicedByRosterId: null as number | null });
  const [saving, setSaving] = useState(false);
  const photoEvidenceBlocked = photoEvidence.enabled && (
    !photoEvidence.ready || photoEvidence.loading || !!photoEvidence.error || photoEvidence.uploading ||
    (photoEvidence.required && photoEvidence.uploadIds.length < photoEvidence.minimum)
  );

  const reset = () => {
    photoEvidence.reset();
    setForm(record ? {
      machineId: String(record.machineId), serviceDate: record.serviceDate,
      serviceType: record.serviceType, hoursAtService: record.hoursAtService ? String(record.hoursAtService) : "",
      nextServiceHours: record.nextServiceHours ? String(record.nextServiceHours) : "",
      nextServiceDate: record.nextServiceDate ?? "", workPerformed: record.workPerformed ?? "",
      servicedBy: record.servicedBy ?? "", servicedByRosterId: (record as any).servicedByRosterId ?? (record as any).serviced_by_roster_id ?? null,
      costPounds: record.costPence ? (record.costPence / 100).toFixed(2) : "",
      notes: record.notes ?? "",
    } : { ...blank, machineId: presetMachineId ?? "" });
  };

  const handleSave = async () => {
    if (!record && photoEvidenceBlocked) return;
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
        servicedBy: form.servicedBy.trim() || null, servicedByRosterId: form.servicedByRosterId,
        costPence: form.costPounds ? Math.round(parseFloat(form.costPounds) * 100) : null,
        notes: form.notes.trim() || null,
      };
      if (record) {
        await apiFetch(`/green-track/service-records/${record.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/service-records", {
          method: "POST",
          body: JSON.stringify({ ...body, photoUploadIds: photoEvidence.uploadIds }),
        });
        photoEvidence.consume();
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
                {sortByLabel(machines, m => m.name).map(m => (
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
                  {sortedEntries(SERVICE_TYPE_LABELS).map(([v, l]) => (
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
              <StaffPerformerSelect label="Serviced by" value={form.servicedBy}
                onChange={v => setForm(f => ({ ...f, servicedBy: v }))}
                onRosterIdChange={v => setForm(f => ({ ...f, servicedByRosterId: v }))} optional />
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
          <RequiredRecordPhotoEvidence evidence={photoEvidence} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (!record && photoEvidenceBlocked)}>
            {saving ? "Saving…" : record ? "Save changes" : "Log service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Defect dialog ────────────────────────────────────────────────────────────

function DefectDialog({
  open, onClose, defect, machines, onSaved, presetMachineId,
}: {
  open: boolean; onClose: () => void;
  defect?: Defect | null;
  machines: Machine[];
  onSaved: () => void;
  /** A new record for this machine (opened from a scanned QR label). */
  presetMachineId?: string;
}) {
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const photoEvidence = useNewRecordPhotoEvidence("green_defect", open && !defect);
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", reportDate: today, reportedBy: "", reportedByRosterId: null,
    description: "", severity: "minor", outOfService: false,
    status: "open", resolution: "", resolvedDate: "", notes: "",
  };
  const [form, setForm] = useState({ ...blank, reportedByRosterId: null as number | null });
  const [saving, setSaving] = useState(false);
  const photoEvidenceBlocked = photoEvidence.enabled && (
    !photoEvidence.ready || photoEvidence.loading || !!photoEvidence.error || photoEvidence.uploading ||
    (photoEvidence.required && photoEvidence.uploadIds.length < photoEvidence.minimum)
  );

  const reset = () => {
    photoEvidence.reset();
    setForm(defect ? {
      machineId: String(defect.machineId), reportDate: defect.reportDate,
      reportedBy: defect.reportedBy ?? "", reportedByRosterId: (defect as any).reportedByRosterId ?? (defect as any).reported_by_roster_id ?? null, description: defect.description,
      severity: defect.severity, outOfService: defect.outOfService,
      status: defect.status, resolution: defect.resolution ?? "",
      resolvedDate: defect.resolvedDate ?? "", notes: defect.notes ?? "",
    } : { ...blank, machineId: presetMachineId ?? "" });
  };

  const handleSave = async () => {
    if (!defect && photoEvidenceBlocked) return;
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    if (!form.description.trim()) { toast({ title: "Description is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10), reportDate: form.reportDate,
        reportedBy: form.reportedBy.trim() || null, reportedByRosterId: form.reportedByRosterId, description: form.description.trim(),
        severity: form.severity, outOfService: form.outOfService,
        status: form.status, resolution: form.resolution.trim() || null,
        resolvedDate: form.resolvedDate || null, notes: form.notes.trim() || null,
      };
      if (defect) {
        await apiFetch(`/green-track/defects/${defect.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/green-track/defects", {
          method: "POST",
          body: JSON.stringify({ ...body, photoUploadIds: photoEvidence.uploadIds }),
        });
        photoEvidence.consume();
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
                {sortByLabel(machines, m => m.name).map(m => (
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
              <StaffPerformerSelect label="Reported by" value={form.reportedBy}
                onChange={v => setForm(f => ({ ...f, reportedBy: v }))}
                onRosterIdChange={v => setForm(f => ({ ...f, reportedByRosterId: v }))} optional />
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
          <RequiredRecordPhotoEvidence evidence={photoEvidence} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (!defect && photoEvidenceBlocked)}
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
  open, onClose, inspection, machines, onSaved, defaults, presetMachineId,
}: {
  open: boolean; onClose: () => void;
  inspection?: PuwerInspection | null;
  machines: Machine[];
  onSaved: () => void;
  /** Starting machine and type for a new record (for example an NSTS test). */
  defaults?: { machineId: number; inspectionType: string } | null;
  /** A new record for this machine (opened from a scanned QR label). */
  presetMachineId?: string;
}) {
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", inspectionDate: today, nextInspectionDate: "",
    inspectionType: "thorough_examination", inspectorName: "", inspectorRosterId: null, inspectorCompany: "",
    certRef: "", safeToOperate: true, defectsFound: "", result: "pass", notes: "",
    certificate: { objectPath: null, fileName: null } as DocumentValue,
  };
  const [form, setForm] = useState({ ...blank, inspectorRosterId: null as number | null });
  const [saving, setSaving] = useState(false);
  // Until the next date is typed, an NSTS test's next date follows the sprayer type.
  const [nextTouched, setNextTouched] = useState(false);
  const selectedMachine = machines.find(m => String(m.id) === form.machineId) ?? null;
  const isNsts = form.inspectionType === NSTS_TEST_INSPECTION_TYPE;
  const autoNextDate = isNsts && form.inspectionDate
    ? nstsNextTestDate(selectedMachine?.sprayerCategory, form.inspectionDate)
    : null;
  useEffect(() => {
    if (isNsts && !nextTouched) setForm(f => ({ ...f, nextInspectionDate: autoNextDate ?? "" }));
  }, [isNsts, nextTouched, autoNextDate]);

  const reset = () => {
    setNextTouched(!!inspection);
    setForm(inspection ? {
      machineId: String(inspection.machineId), inspectionDate: isoDay(inspection.inspectionDate) ?? "",
      nextInspectionDate: isoDay(inspection.nextInspectionDate) ?? "",
      inspectionType: inspection.inspectionType, inspectorName: inspection.inspectorName ?? "", inspectorRosterId: (inspection as any).inspectorRosterId ?? (inspection as any).inspector_roster_id ?? null,
      inspectorCompany: inspection.inspectorCompany ?? "", certRef: inspection.certRef ?? "",
      safeToOperate: inspection.safeToOperate, defectsFound: inspection.defectsFound ?? "",
      result: inspection.result, notes: inspection.notes ?? "",
      certificate: { objectPath: inspection.certificateObjectPath ?? null, fileName: inspection.certificateFileName ?? null },
    } : defaults ? { ...blank, machineId: String(defaults.machineId), inspectionType: defaults.inspectionType } : { ...blank, machineId: presetMachineId ?? "" });
  };

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10),
        inspectionDate: form.inspectionDate,
        nextInspectionDate: form.nextInspectionDate || null,
        inspectionType: form.inspectionType,
        inspectorName: form.inspectorName.trim() || null, inspectorRosterId: form.inspectorRosterId,
        inspectorCompany: form.inspectorCompany.trim() || null,
        certRef: form.certRef.trim() || null,
        safeToOperate: form.safeToOperate,
        defectsFound: form.defectsFound.trim() || null,
        result: form.safeToOperate ? (form.defectsFound.trim() ? "advisory" : "pass") : "fail",
        notes: form.notes.trim() || null,
        certificateObjectPath: form.certificate.objectPath,
        certificateFileName: form.certificate.fileName,
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
          <DialogTitle>{inspection ? "Edit Inspection Record" : "Log Inspection or NSTS Test"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} onValueChange={v => setForm(f => ({ ...f, machineId: v === "_none" ? "" : v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {sortByLabel(machines, m => m.name).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
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
              <Label>{isNsts ? "Next test due" : "Next inspection due"}</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.nextInspectionDate} data-testid="input-next-inspection-date"
                onChange={e => { setNextTouched(true); setForm(f => ({ ...f, nextInspectionDate: e.target.value })); }} />
            </div>
            <div className="col-span-2">
              <Label>Inspection type</Label>
              <Select value={form.inspectionType} onValueChange={v => setForm(f => ({ ...f, inspectionType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm" data-testid="select-inspection-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sortedEntries(PUWER_INSPECTION_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isNsts && (
                <p className="text-xs text-muted-foreground mt-1.5" data-testid="text-nsts-next-hint">
                  {selectedMachine && isNstsSprayerCategory(selectedMachine.sprayerCategory)
                    ? `${NSTS_SPRAYER_CATEGORIES[selectedMachine.sprayerCategory].label}: ${nstsIntervalText(selectedMachine.sprayerCategory)}. The next date is filled in for you; change it if your tester or assurance scheme (for example Red Tractor, yearly) gives a different one.`
                    : "Set the sprayer type on this machine (Fleet, Edit) and the next test date is worked out for you. You can also type it."}
                </p>
              )}
            </div>
            <div>
              <Label>Inspector name <span className="text-muted-foreground text-xs">optional</span></Label>
              <StaffPerformerSelect label="Inspector" value={form.inspectorName}
                onChange={v => setForm(f => ({ ...f, inspectorName: v }))}
                onRosterIdChange={v => setForm(f => ({ ...f, inspectorRosterId: v }))} optional />
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
          <DocumentField label="Certificate or report (optional)" value={form.certificate} disabled={saving}
            onChange={certificate => setForm(f => ({ ...f, certificate }))} />
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

// ─── NSTS sprayer tests ───────────────────────────────────────────────────────

const NSTS_STATE_STYLES: Record<string, string> = {
  overdue:  "text-destructive font-medium",
  due_soon: "text-amber-600 dark:text-amber-400 font-medium",
  ok:       "text-emerald-600 dark:text-emerald-400",
  unknown:  "text-muted-foreground",
};

function NstsSprayerPanel({ sprayers, hasSprayers, canAdmin, onLogTest }: {
  sprayers: NstsSprayerRow[];
  hasSprayers: boolean;
  canAdmin: boolean;
  onLogTest: (machineId: number) => void;
}) {
  if (sprayers.length === 0) {
    if (!hasSprayers) return null;
    return (
      <div className="text-xs text-muted-foreground border border-dashed rounded-sm px-3 py-2" data-testid="nsts-panel-empty">
        NSTS sprayer tests: set the sprayer type on your sprayers (Fleet, Edit) to see when each test is due.
      </div>
    );
  }
  return (
    <Card className="border-border/50 shadow-sm" data-testid="nsts-panel">
      <CardContent className="p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">NSTS sprayer tests</p>
          <p className="text-xs text-muted-foreground">
            Pesticide sprayers need an NSTS test before they are 5 years old, then every 3 years (booms wider than 3 m and
            air-assisted sprayers) or every 6 years (other equipment). Knapsacks need a recorded competent-person check.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground text-xs">
                <th className="text-left font-medium py-1.5 pr-4">Sprayer</th>
                <th className="text-left font-medium py-1.5 pr-4 hidden sm:table-cell">Type</th>
                <th className="text-left font-medium py-1.5 pr-4">Last test</th>
                <th className="text-left font-medium py-1.5 pr-4">Next due</th>
                {canAdmin && <th className="w-24" />}
              </tr>
            </thead>
            <tbody>
              {sprayers.map(s => (
                <tr key={s.machineId} className="border-b last:border-0" data-testid={`nsts-row-${s.machineId}`}>
                  <td className="py-1.5 pr-4 font-medium">{s.machineName}</td>
                  <td className="py-1.5 pr-4 text-xs text-muted-foreground hidden sm:table-cell">
                    {isNstsSprayerCategory(s.sprayerCategory) ? NSTS_SPRAYER_CATEGORIES[s.sprayerCategory].label : s.sprayerCategory}
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums">{s.lastTestDate ? fmt(s.lastTestDate) : "Never tested"}</td>
                  <td className={cn("py-1.5 pr-4 tabular-nums", NSTS_STATE_STYLES[s.state])} data-testid={`nsts-due-${s.machineId}`}>
                    {s.state === "overdue" && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                    {s.dueDate
                      ? `${s.state === "overdue" ? "Overdue since " : ""}${fmt(s.dueDate)}${s.basis === "first_test" ? " (first test)" : ""}`
                      : "Add the purchase date or year"}
                  </td>
                  {canAdmin && (
                    <td className="py-1.5 text-right">
                      <Button size="sm" variant="outline" className="h-7 text-xs rounded-sm" onClick={() => onLogTest(s.machineId)}>
                        Log test
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Hour meter readings ──────────────────────────────────────────────────────

interface MachineHours {
  machineId: number;
  machineName: string;
  machineType: string;
  currentHours: number | null;
  lastReadingDate: string | null;
  hoursLast7Days: number | null;
  hoursLast30Days: number | null;
  lastServiceDate: string | null;
  nextServiceHours: number | null;
  hoursToService: number | null;
  serviceHoursState: "overdue" | "due_soon" | "ok" | "none";
}

interface HourReading {
  id: number | null;
  key: string;
  source: "reading" | "pre_use_check" | "fuel_log" | "service";
  sourceLabel: string;
  machineId: number;
  machineName: string;
  readingDate: string;
  hours: number;
  recordedBy: string | null;
  recordedByRosterId: number | null;
  notes: string | null;
}

const hoursText = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} h`;

function HourReadingDialog({
  open, onClose, reading, machines, hours, onSaved, presetMachineId,
}: {
  open: boolean; onClose: () => void;
  reading?: HourReading | null;
  machines: Machine[];
  hours: MachineHours[];
  onSaved: () => void;
  presetMachineId?: string;
}) {
  const { toast } = useToast();
  const request = useActiveClientApi();
  const today = new Date().toISOString().split("T")[0];
  const blank = { machineId: "", readingDate: today, hours: "", recordedBy: "", recordedByRosterId: null as number | null, notes: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  // Set when the server says the reading is lower than an earlier one.
  const [lowerWarning, setLowerWarning] = useState<string | null>(null);
  const [meterReplaced, setMeterReplaced] = useState(false);
  const last = hours.find(h => String(h.machineId) === form.machineId) ?? null;

  const reset = () => {
    setLowerWarning(null);
    setMeterReplaced(false);
    setForm(reading ? {
      machineId: String(reading.machineId), readingDate: reading.readingDate, hours: String(reading.hours),
      recordedBy: reading.recordedBy ?? "", recordedByRosterId: reading.recordedByRosterId, notes: reading.notes ?? "",
    } : { ...blank, machineId: presetMachineId ?? "" });
  };

  const handleSave = async () => {
    if (!form.machineId) { toast({ title: "Select a machine", variant: "destructive" }); return; }
    if (!form.hours.trim() || !(Number(form.hours) >= 0)) { toast({ title: "Enter the hour meter reading", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        machineId: parseInt(form.machineId, 10), readingDate: form.readingDate, hours: Number(form.hours),
        recordedBy: form.recordedBy.trim() || null, recordedByRosterId: form.recordedByRosterId,
        notes: form.notes.trim() || null, meterReplaced,
      };
      const response = await request(reading ? `/green-track/hour-readings/${reading.id}` : "/green-track/hour-readings", {
        method: reading ? "PUT" : "POST", body: JSON.stringify(body),
      });
      if (response.status === 409) {
        const data = await response.json().catch(() => null);
        if (data?.code === "HOURS_LOWER_THAN_EARLIER") { setLowerWarning(data.error); return; }
      }
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save the reading"));
      toast({ title: reading ? "Reading updated" : "Hour meter reading saved" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{reading ? "Edit Hour Meter Reading" : "Log Hour Meter Reading"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label>Machine *</Label>
            <Select value={form.machineId || "_none"} disabled={!!reading}
              onValueChange={v => { setLowerWarning(null); setForm(f => ({ ...f, machineId: v === "_none" ? "" : v })); }}>
              <SelectTrigger className="mt-1 rounded-sm" data-testid="select-hours-machine"><SelectValue placeholder="Select machine" /></SelectTrigger>
              <SelectContent>
                {sortByLabel(machines.filter(m => m.active), m => m.name).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {!reading && last?.currentHours != null && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-last-reading">
                Last reading {hoursText(last.currentHours)} on {fmt(last.lastReadingDate)}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.readingDate}
                onChange={e => { setLowerWarning(null); setForm(f => ({ ...f, readingDate: e.target.value })); }} />
            </div>
            <div>
              <Label>Hour meter *</Label>
              <Input type="number" step="0.1" min="0" inputMode="decimal" className="mt-1 rounded-sm" value={form.hours}
                data-testid="input-hours" placeholder="e.g. 1234.5"
                onChange={e => { setLowerWarning(null); setForm(f => ({ ...f, hours: e.target.value })); }} />
            </div>
          </div>
          <div>
            <StaffPerformerSelect label="Recorded by" value={form.recordedBy}
              onChange={v => setForm(f => ({ ...f, recordedBy: v }))}
              onRosterIdChange={v => setForm(f => ({ ...f, recordedByRosterId: v }))} optional />
          </div>
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes} rows={2}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          {lowerWarning && (
            <div role="alert" className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid="alert-hours-lower">
              <p>{lowerWarning}</p>
              <label className="mt-2 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={meterReplaced} onChange={e => setMeterReplaced(e.target.checked)} data-testid="checkbox-meter-replaced" />
                The hour meter was replaced or reset
              </label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (!!lowerWarning && !meterReplaced)}>
            {saving ? "Saving…" : reading ? "Save changes" : "Save reading"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SERVICE_HOURS_STYLES: Record<string, string> = {
  overdue:  "text-destructive font-medium",
  due_soon: "text-amber-600 dark:text-amber-400 font-medium",
  ok:       "",
  none:     "text-muted-foreground",
};

function HoursTab({ hours, readings, loading, filterMachine, q, canAdmin, onLog, onEdit, onDelete }: {
  hours: MachineHours[];
  readings: HourReading[];
  loading: boolean;
  filterMachine: string;
  q: string;
  canAdmin: boolean;
  onLog: (machineId?: number) => void;
  onEdit: (reading: HourReading) => void;
  onDelete: (reading: HourReading) => void;
}) {
  const shownMachines = hours.filter(h =>
    (!filterMachine || String(h.machineId) === filterMachine) && h.machineName.toLowerCase().includes(q));
  const shownReadings = readings.filter(r => r.machineName.toLowerCase().includes(q) || (r.recordedBy ?? "").toLowerCase().includes(q));
  if (loading) return <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading hours…</div>;
  return (
    <>
      <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2">
        <Gauge className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>Hours come from readings logged here, on pre-use checks, fuel logs and services. Fill in "Next service (hours)" when you log a service and GreenTrack shows when those hours are reached.</span>
      </div>
      {shownMachines.length === 0 ? (
        <div className="text-center py-10 border border-dashed rounded-sm">
          <Gauge className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">No active machines.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-machine-hours">
            <thead>
              <tr className="border-b text-muted-foreground text-xs">
                <th className="text-left font-medium py-2 pr-4">Machine</th>
                <th className="text-left font-medium py-2 pr-4">Hour meter</th>
                <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Last reading</th>
                <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Last 7 days</th>
                <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Last 30 days</th>
                <th className="text-left font-medium py-2 pr-4">Next service</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {shownMachines.map(h => (
                <tr key={h.machineId} className="border-b last:border-0" data-testid={`hours-row-${h.machineId}`}>
                  <td className="py-2 pr-4 font-medium">{h.machineName}</td>
                  <td className="py-2 pr-4 tabular-nums" data-testid={`hours-current-${h.machineId}`}>{hoursText(h.currentHours)}</td>
                  <td className="py-2 pr-4 tabular-nums hidden md:table-cell">{fmt(h.lastReadingDate)}</td>
                  <td className="py-2 pr-4 tabular-nums hidden sm:table-cell" data-testid={`hours-7-${h.machineId}`}>{hoursText(h.hoursLast7Days)}</td>
                  <td className="py-2 pr-4 tabular-nums hidden sm:table-cell">{hoursText(h.hoursLast30Days)}</td>
                  <td className={cn("py-2 pr-4 tabular-nums", SERVICE_HOURS_STYLES[h.serviceHoursState])} data-testid={`hours-service-${h.machineId}`}>
                    {h.nextServiceHours == null ? "—" : (
                      <>
                        {h.serviceHoursState === "overdue" && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                        at {hoursText(h.nextServiceHours)}
                        {h.hoursToService != null && (h.hoursToService > 0
                          ? ` (${hoursText(h.hoursToService)} to go)`
                          : ` (overdue by ${hoursText(-h.hoursToService)})`)}
                      </>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="outline" className="h-7 text-xs rounded-sm" onClick={() => onLog(h.machineId)}>
                      Log reading
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="space-y-2">
        <p className="text-sm font-semibold">Readings</p>
        {shownReadings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hour meter readings yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-hour-readings">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="text-left font-medium py-2 pr-4">Date</th>
                  <th className="text-left font-medium py-2 pr-4">Machine</th>
                  <th className="text-left font-medium py-2 pr-4">Hours</th>
                  <th className="text-left font-medium py-2 pr-4">From</th>
                  <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Recorded by</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {shownReadings.map(r => (
                  <tr key={r.key} className="border-b last:border-0">
                    <td className="py-2 pr-4 tabular-nums">{fmt(r.readingDate)}</td>
                    <td className="py-2 pr-4">{r.machineName}</td>
                    <td className="py-2 pr-4 tabular-nums">{hoursText(r.hours)}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{r.sourceLabel}</td>
                    <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{r.recordedBy ?? "—"}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {r.id != null && (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit reading" onClick={() => onEdit(r)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {canAdmin && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label="Delete reading" onClick={() => onDelete(r)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Fuel log dialog ──────────────────────────────────────────────────────────

function FuelLogDialog({
  open, onClose, log, machines, onSaved, presetMachineId,
}: {
  open: boolean; onClose: () => void;
  log?: FuelLog | null;
  machines: Machine[];
  onSaved: () => void;
  /** A new record for this machine (opened from a scanned QR label). */
  presetMachineId?: string;
}) {
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const today = new Date().toISOString().split("T")[0];
  const blank = {
    machineId: "", logDate: today, fuelType: "diesel",
    quantityLitres: "", engineHours: "", costPounds: "", filledBy: "", filledByRosterId: null, notes: "",
  };
  const [form, setForm] = useState({ ...blank, filledByRosterId: null as number | null });
  const [saving, setSaving] = useState(false);

  const reset = () => setForm(log ? {
    machineId: String(log.machineId), logDate: log.logDate, fuelType: log.fuelType,
    quantityLitres: log.quantityLitres != null ? String(log.quantityLitres) : "",
    engineHours: log.engineHours != null ? String(log.engineHours) : "",
    costPounds: log.costPence != null ? (log.costPence / 100).toFixed(2) : "",
    filledBy: log.filledBy ?? "", filledByRosterId: (log as any).filledByRosterId ?? (log as any).filled_by_roster_id ?? null, notes: log.notes ?? "",
  } : { ...blank, machineId: presetMachineId ?? "" });

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
        filledBy: form.filledBy.trim() || null, filledByRosterId: form.filledByRosterId, notes: form.notes.trim() || null,
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
                {sortByLabel(machines.filter(m => m.active), m => m.name).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
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
                  {sortedEntries(FUEL_TYPE_LABELS).map(([v, l]) => (
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
              <StaffPerformerSelect label="Filled by" value={form.filledBy}
                onChange={v => setForm(f => ({ ...f, filledBy: v }))}
                onRosterIdChange={v => setForm(f => ({ ...f, filledByRosterId: v }))} optional />
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

type Tab = "daily" | "fleet" | "pre-use" | "services" | "defects" | "puwer" | "hours" | "spraying" | "stock" | "fuel" | "actions";

export default function GreenTrackPage() {
  const { user, activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apiFetch = useGreenTrackApi();
  const clientApi = useActiveClientApi();
  const photoRequirements = usePhotoRequirements();

  const [activeTab, setActiveTab] = useState<Tab>("fleet");
  const [search, setSearch] = useState("");
  const [filterMachine, setFilterMachine] = useState("");

  // Dialogs
  const [machineImportDialog, setMachineImportDialog] = useState(false);
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
  const [puwerDefaults, setPuwerDefaults] = useState<{ machineId: number; inspectionType: string } | null>(null);
  const [fuelDialog, setFuelDialog] = useState(false);
  const [editFuel, setEditFuel] = useState<FuelLog | null>(null);
  const [hoursDialog, setHoursDialog] = useState(false);
  const [editReading, setEditReading] = useState<HourReading | null>(null);
  const [hoursMachineId, setHoursMachineId] = useState<string | undefined>();
  const [deleteId, setDeleteId] = useState<{ type: string; id: number } | null>(null);
  // A machine chosen by a scanned QR label, for the form the label opened.
  const [scanMachineId, setScanMachineId] = useState<string | undefined>();
  const [sprayingFromScan, setSprayingFromScan] = useState<{ machineId?: number } | null>(null);
  const [sayMachineDialog, setSayMachineDialog] = useState(false);
  // The site the Daily checks tab opens on (a dashboard or reminder link).
  const [dailySiteId, setDailySiteId] = useState<number | null>(null);

  useEffect(() => {
    const daily = takeLinkParams(["tab", "siteId"] as const);
    if (daily?.tab === "daily") {
      setActiveTab("daily");
      if (daily.siteId && /^\d+$/.test(daily.siteId)) setDailySiteId(Number(daily.siteId));
    }
    const link = takeLinkParams(["machine", "open"] as const);
    if (!link?.machine || !/^\d+$/.test(link.machine)) return;
    const machineId = link.machine;
    setScanMachineId(machineId);
    setFilterMachine(machineId);
    const open = link.open ?? "pre-use";
    if (open === "pre-use") { setActiveTab("pre-use"); setEditPreUse(null); setPreUseDialog(true); }
    else if (open === "defect") { setActiveTab("defects"); setEditDefect(null); setDefectDialog(true); }
    else if (open === "fuel") { setActiveTab("fuel"); setEditFuel(null); setFuelDialog(true); }
    else if (open === "hours") { setActiveTab("hours"); setEditReading(null); setHoursMachineId(machineId); setHoursDialog(true); }
    else if (open === "spraying") { setActiveTab("spraying"); setSprayingFromScan({ machineId: Number(machineId) }); }
    else if (open === "service" && canAdmin) { setActiveTab("services"); setEditService(null); setServiceDialog(true); }
    else if (open === "inspection" && canAdmin) { setActiveTab("puwer"); setEditPuwer(null); setPuwerDialog(true); }
  }, []);

  // Queries
  const { data: sites = [] } = useQuery({
    queryKey: ["sites", activeClientId], queryFn: () => apiFetch<{ id: number; name: string }[]>("/sites"),
  });
  const { data: machines = [], isLoading: machinesLoading } = useQuery({
    queryKey: ["green-machines", activeClientId],
    queryFn: () => apiFetch<Machine[]>("/green-track/machines"),
  });
  const { data: status } = useQuery({
    queryKey: ["green-status", activeClientId],
    queryFn: () => apiFetch<StatusData>("/green-track/status"),
    refetchInterval: 60_000,
  });
  const { data: preUseChecks = [], isLoading: preUseLoading } = useQuery({
    queryKey: ["green-pre-use", activeClientId, filterMachine],
    queryFn: () => apiFetch<PreUseCheck[]>(`/green-track/pre-use-checks${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "pre-use",
  });
  const { data: serviceRecords = [], isLoading: servicesLoading } = useQuery({
    queryKey: ["green-services", activeClientId, filterMachine],
    queryFn: () => apiFetch<ServiceRecord[]>(`/green-track/service-records${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "services",
  });
  const { data: defects = [], isLoading: defectsLoading } = useQuery({
    queryKey: ["green-defects", activeClientId, filterMachine],
    queryFn: () => apiFetch<Defect[]>(`/green-track/defects${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "defects",
  });
  const { data: puwerInspections = [], isLoading: puwerLoading } = useQuery({
    queryKey: ["green-puwer", activeClientId, filterMachine],
    queryFn: () => apiFetch<PuwerInspection[]>(`/green-track/puwer-inspections${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "puwer",
  });
  const { data: machineHours, isLoading: hoursLoading } = useQuery({
    queryKey: ["green-hours", activeClientId],
    queryFn: () => apiFetch<{ dueSoonHours: number; machines: MachineHours[] }>("/green-track/hours"),
    enabled: activeTab === "hours" || hoursDialog,
  });
  const { data: hourReadings = [] } = useQuery({
    queryKey: ["green-hour-readings", activeClientId, filterMachine],
    queryFn: () => apiFetch<HourReading[]>(`/green-track/hour-readings${filterMachine ? `?machineId=${filterMachine}` : ""}`),
    enabled: activeTab === "hours",
  });
  const { data: fuelLogs = [], isLoading: fuelLoading } = useQuery({
    queryKey: ["green-fuel", activeClientId, filterMachine],
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
    queryClient.invalidateQueries({ queryKey: ["green-hours"] });
    queryClient.invalidateQueries({ queryKey: ["green-hour-readings"] });
    queryClient.invalidateQueries({ queryKey: ["green-pre-start"] });
  };

  // Delete handler
  const handleDelete = async () => {
    if (!deleteId) return;
    const paths: Record<string, string> = {
      machine: `/green-track/machines/${deleteId.id}`,
      preUse: `/green-track/pre-use-checks/${deleteId.id}`,
      service: `/green-track/service-records/${deleteId.id}`,
      defect: `/green-track/defects/${deleteId.id}`,
      "puwer-inspections": `/green-track/puwer-inspections/${deleteId.id}`,
      "fuel-logs": `/green-track/fuel-logs/${deleteId.id}`,
      "hour-readings": `/green-track/hour-readings/${deleteId.id}`,
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
    { key: "daily",    label: "Daily checks", icon: Sunrise },
    { key: "fleet",    label: "Fleet",       icon: Tractor,        count: machines.length },
    { key: "pre-use",  label: "Pre-use",     icon: CheckCheck,     count: status?.checkedTodayCount },
    { key: "services", label: "Services",    icon: Wrench },
    { key: "defects",  label: "Defects",     icon: ShieldAlert,    count: status?.openDefects || undefined },
    { key: "puwer",    label: "Inspections", icon: ClipboardCheck, count: status?.nstsOverdue || undefined },
    { key: "hours",    label: "Hours",       icon: Gauge },
    { key: "spraying", label: "Spraying",    icon: SprayCan },
    { key: "stock",    label: "Stock",       icon: Package,        count: status?.lowStockProducts || undefined },
    { key: "actions",  label: "Actions",     icon: CheckCircle2 },
    ...(showFuelTab ? [{ key: "fuel" as Tab, label: "Fuel / Oil", icon: Fuel }] : []),
  ];

  const activeMachines = machines.filter(m => m.active);
  // A machine can also be said by its registration or its make and model.
  const sayMachineItems = useMemo(() => activeMachines.map(m => ({
    id: m.id, name: m.name, aliases: [m.regNo, [m.make, m.model].filter(Boolean).join(" ")],
  })), [machines]);

  return (
    <AppLayout title="GreenTrack">
      <div className="space-y-6">
        {photoRequirements.error && (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-sm border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <div>
              <p className="font-medium">Photo requirements could not be loaded.</p>
              <p className="mt-0.5">{photoRequirements.error.message} Existing record photo uploads may not reflect the configured rules.</p>
            </div>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={photoRequirements.retry}>
              Retry
            </Button>
          </div>
        )}
        {photoRequirements.isLoading && !photoRequirements.error && (
          <p role="status" className="text-xs text-muted-foreground">Loading GreenTrack photo requirements…</p>
        )}

        {(status?.nstsOverdue ?? 0) > 0 && (
          <div role="alert" data-testid="banner-nsts-overdue"
            className="flex items-center justify-between gap-3 rounded-sm border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {status!.nstsOverdue === 1 ? "1 sprayer is" : `${status!.nstsOverdue} sprayers are`} overdue for an NSTS test.
            </span>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setActiveTab("puwer")}>
              View sprayers
            </Button>
          </div>
        )}

        {(status?.lowStockProducts ?? 0) > 0 && activeTab !== "stock" && (
          <div role="status" data-testid="banner-low-stock"
            className="flex items-center justify-between gap-3 rounded-sm border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            <span className="flex items-center gap-2">
              <Package className="w-4 h-4 shrink-0" />
              {status!.lowStockProducts === 1 ? "1 product is" : `${status!.lowStockProducts} products are`} at or below the re-order level.
            </span>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setActiveTab("stock")}>
              View stock
            </Button>
          </div>
        )}

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
                sub: status.overdueServiceByHours ? `past next-service date or hours (${status.overdueServiceByHours} by hours)` : "past next-service date or hours",
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
            {activeTab !== "actions" && activeTab !== "daily" && <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search…" className="pl-8 h-8 w-44 rounded-sm text-sm" />
            </div>}
            {activeTab !== "fleet" && activeTab !== "actions" && activeTab !== "spraying" && activeTab !== "stock" && activeTab !== "daily" && (
              <Select value={filterMachine || "_all"} onValueChange={v => setFilterMachine(v === "_all" ? "" : v)}>
                <SelectTrigger className="h-8 rounded-sm text-sm w-44">
                  <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">All machines</SelectItem>
                  {sortByLabel(machines, m => m.name).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {activeTab === "fleet" && canAdmin && (
              <>
                <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8" onClick={() => setMachineImportDialog(true)}>
                  <Upload className="w-3.5 h-3.5" /> Upload roster
                </Button>
                <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditMachine(null); setMachineDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Add machine
                </Button>
              </>
            )}
            {(activeTab === "pre-use" || activeTab === "fleet") && dictationSupported && activeMachines.length > 0 && (
              <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8" data-testid="button-say-machine"
                title="Say the machine's name to open its pre-use check" onClick={() => setSayMachineDialog(true)}>
                <Mic className="w-3.5 h-3.5" /> Say machine
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
            {activeTab === "hours" && (
              <Button size="sm" className="rounded-sm gap-1.5 h-8" onClick={() => { setEditReading(null); setHoursMachineId(filterMachine || undefined); setHoursDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log hours
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

        {/* ── Daily checks tab ──────────────────────────────────────────── */}
        {activeTab === "daily" && (
          <GreenDailyChecksTab
            initialSiteId={dailySiteId}
            onCheckMachine={(machineId) => { setEditPreUse(null); setScanMachineId(String(machineId)); setPreUseDialog(true); }}
          />
        )}

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
                      {["Machine", "Date", "Result", "Operator", "Checklist", "Defect?", "Photos", ""].map(h => (
                        <th key={h} className={cn(
                          "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                          h === "Operator" && "hidden md:table-cell",
                          h === "Checklist" && "hidden lg:table-cell",
                          h === "Photos" && "hidden sm:table-cell",
                          h === "" && "w-20",
                        )}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredPreUse.map(c => (
                      <tr id={`green-source-green_pre_use_checks-${c.id}`} key={c.id} className="bg-white hover:bg-muted/20 transition-colors group">
                        <td className="px-4 py-3">
                          <p className="font-medium">{c.machineName}</p>
                          <p className="text-xs text-muted-foreground">{MACHINE_TYPE_LABELS[c.machineType] ?? c.machineType}</p>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(c.checkDate)}</td>
                        <td className="px-4 py-3"><ResultBadge result={c.result} /></td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{c.operator ?? "—"}</td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          {(() => {
                            const items = (c.checklistItems ?? (c as any).checklist_items ?? []) as PreUseCheck["checklistItems"];
                            const failed = items?.filter(item => item.status === "fail") ?? [];
                            const answered = items?.length ?? 0;
                            if (!answered) return <span className="text-xs text-muted-foreground">Legacy 7-point check</span>;
                            return (
                              <details className="max-w-[330px]">
                                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                                  {answered} items · {failed.length ? `${failed.length} failed` : "no failures"}
                                  {(c.fuelLevel ?? (c as any).fuel_level) ? ` · Fuel ${c.fuelLevel ?? (c as any).fuel_level}` : ""}
                                </summary>
                                <div className="mt-2 space-y-1.5 rounded-sm border border-border bg-muted/20 p-2 text-xs">
                                  {items?.map(item => (
                                    <div key={item.key} className="flex gap-2">
                                      <span className={cn(
                                        "font-semibold uppercase",
                                        item.status === "fail" ? "text-rose-700" : item.status === "ok" ? "text-emerald-700" : "text-muted-foreground",
                                      )}>
                                        {item.status === "na" ? "N/A" : item.status}
                                      </span>
                                      <span className="text-muted-foreground">
                                        {item.label}{item.note ? ` — ${item.note}` : ""}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            );
                          })()}
                        </td>
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
                          <CheckPhotoUploader entityType="green_pre_use_check" entityId={c.id} compact
                            required={photoRequirements.requirements.green_pre_use_check?.required ?? false}
                            minPhotos={photoRequirements.requirements.green_pre_use_check?.minPhotos ?? 1} />
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
                            <CheckPhotoUploader entityType="green_service" entityId={s.id} compact
                              required={photoRequirements.requirements.green_service?.required ?? false}
                              minPhotos={photoRequirements.requirements.green_service?.minPhotos ?? 1} />
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
                        <CheckPhotoUploader entityType="green_defect" entityId={d.id} compact
                          required={photoRequirements.requirements.green_defect?.required ?? false}
                          minPhotos={photoRequirements.requirements.green_defect?.minPhotos ?? 1} />
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
            <NstsSprayerPanel
              sprayers={(status?.nstsSprayers ?? []).filter(s => !filterMachine || String(s.machineId) === filterMachine)}
              hasSprayers={machines.some(m => m.active && m.type === "sprayer_spreader")}
              canAdmin={canAdmin}
              onLogTest={(machineId) => { setEditPuwer(null); setPuwerDefaults({ machineId, inspectionType: NSTS_TEST_INSPECTION_TYPE }); setPuwerDialog(true); }}
            />
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
                      <th className="text-left font-medium py-2 pr-4">Certificate</th>
                      {canAdmin && <th className="w-16" />}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPuwer.map(p => {
                      const today = new Date().toISOString().split("T")[0];
                      const nextDay = isoDay(p.nextInspectionDate);
                      const overdue = nextDay && nextDay < today;
                      const due30 = p.nextInspectionDate && !overdue &&
                        new Date(p.nextInspectionDate) <= new Date(Date.now() + 30 * 86400000);
                      return (
                        <tr id={`green-source-green_puwer_inspections-${p.id}`} key={p.id} className={`border-b last:border-0 ${!p.safeToOperate ? "bg-red-50 dark:bg-red-900/10" : ""}`}>
                          <td className="py-2 pr-4 font-medium">{p.machineName}</td>
                          <td className="py-2 pr-4 text-muted-foreground text-xs hidden sm:table-cell">
                            {PUWER_INSPECTION_TYPE_LABELS[p.inspectionType] ?? p.inspectionType}
                          </td>
                          <td className="py-2 pr-4 tabular-nums">{fmt(isoDay(p.inspectionDate))}</td>
                          <td className="py-2 pr-4 hidden md:table-cell">
                            {p.nextInspectionDate ? (
                              <span className={`tabular-nums ${overdue ? "text-destructive font-medium" : due30 ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                                {overdue && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                                {fmt(nextDay)}
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
                          <td className="py-2 pr-4">
                            {p.certificateObjectPath ? (
                              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" data-testid={`button-certificate-${p.id}`}
                                onClick={() => downloadRegisterDocument(clientApi, `/green-track/puwer-inspections/${p.id}/certificate-url`, `inspection-certificate-${p.id}`)
                                  .catch((err: Error) => toast({ title: "Download failed", description: err.message, variant: "destructive" }))}>
                                <Download className="w-3.5 h-3.5" /> View
                              </Button>
                            ) : <span className="text-muted-foreground">—</span>}
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

        {/* ── Hours tab ──────────────────────────────────────────────────── */}
        {activeTab === "hours" && (
          <HoursTab
            hours={machineHours?.machines ?? []} readings={hourReadings} loading={hoursLoading}
            filterMachine={filterMachine} q={q} canAdmin={canAdmin}
            onLog={(machineId) => { setEditReading(null); setHoursMachineId(machineId ? String(machineId) : undefined); setHoursDialog(true); }}
            onEdit={(reading) => { setEditReading(reading); setHoursDialog(true); }}
            onDelete={(reading) => reading.id != null && setDeleteId({ type: "hour-readings", id: reading.id })}
          />
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

        {activeTab === "spraying" && (
          <GreenSprayingTab q={q} canAdmin={canAdmin} machines={machines}
            openNew={sprayingFromScan} onOpenNewHandled={() => setSprayingFromScan(null)} />
        )}

        {activeTab === "stock" && <GreenStockTab q={q} canAdmin={canAdmin} />}

        {activeTab === "actions" && (
          <ModuleActionsPanel moduleKey="green" />
        )}

      <MachineImportDialog open={machineImportDialog} onClose={() => setMachineImportDialog(false)}
        sites={sites} onImported={invalidate} />

      <MachineDialog open={machineDialog} onClose={() => { setMachineDialog(false); setEditMachine(null); }}
        machine={editMachine} sites={sites} onSaved={invalidate} />

      <SpeakToPickDialog open={sayMachineDialog} onClose={() => setSayMachineDialog(false)}
        title="Say the machine"
        description={"Say the machine's name, for example \"fairway mower one\", and its pre-use check opens."}
        noun="machine"
        items={sayMachineItems}
        onPick={(machine) => {
          setSayMachineDialog(false);
          setActiveTab("pre-use");
          setEditPreUse(null);
          setScanMachineId(String(machine.id));
          setPreUseDialog(true);
        }} />

      <PreUseDialog open={preUseDialog} onClose={() => { setPreUseDialog(false); setEditPreUse(null); setScanMachineId(undefined); }}
        presetMachineId={scanMachineId}
        check={editPreUse} machines={activeMachines} onSaved={invalidate} />

      <ServiceDialog open={serviceDialog} onClose={() => { setServiceDialog(false); setEditService(null); setScanMachineId(undefined); }}
        presetMachineId={scanMachineId}
        record={editService} machines={machines} onSaved={invalidate} />

      <DefectDialog open={defectDialog} onClose={() => { setDefectDialog(false); setEditDefect(null); setScanMachineId(undefined); }}
        presetMachineId={scanMachineId}
        defect={editDefect} machines={machines} onSaved={invalidate} />

      <PuwerDialog open={puwerDialog} onClose={() => { setPuwerDialog(false); setEditPuwer(null); setPuwerDefaults(null); setScanMachineId(undefined); }}
        presetMachineId={scanMachineId}
        inspection={editPuwer} defaults={puwerDefaults} machines={machines} onSaved={invalidate} />

      <FuelLogDialog open={fuelDialog} onClose={() => { setFuelDialog(false); setEditFuel(null); setScanMachineId(undefined); }}
        presetMachineId={scanMachineId}
        log={editFuel} machines={machines} onSaved={invalidate} />

      <HourReadingDialog open={hoursDialog}
        onClose={() => { setHoursDialog(false); setEditReading(null); setHoursMachineId(undefined); setScanMachineId(undefined); }}
        reading={editReading} presetMachineId={hoursMachineId} machines={machines} hours={machineHours?.machines ?? []} onSaved={invalidate} />

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
