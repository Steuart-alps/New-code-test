import { useState, useMemo, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { format, formatDistanceToNow } from "date-fns";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Waves, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX,
  Lock, Pencil, Trash2, Filter, Droplets, Thermometer, Wind, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import {
  useListSites,
  getListSitesQueryKey,
  useGetPoolTrackConfig,
  getGetPoolTrackConfigQueryKey,
  useUpdatePoolTrackConfig,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";

// ── API helpers ───────────────────────────────────────────────────────────────

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, "");
async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Pool config dialog ────────────────────────────────────────────────────────

function PoolConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetPoolTrackConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdatePoolTrackConfig();

  const [poolName, setPoolName] = useState("");
  const [defaultPerformer, setDefaultPerformer] = useState("");
  const [showAirTemp, setShowAirTemp] = useState(true);
  const [phMin, setPhMin] = useState("7.2");
  const [phMax, setPhMax] = useState("7.6");
  const [freeChlorMin, setFreeChlorMin] = useState("1.0");
  const [freeChlorMax, setFreeChlorMax] = useState("3.0");
  const [tempMin, setTempMin] = useState("27");
  const [tempMax, setTempMax] = useState("32");

  useEffect(() => {
    if (!config || !open) return;
    setPoolName(config.pool_name ?? "");
    setDefaultPerformer(config.pool_default_performer ?? "");
    setShowAirTemp(config.pool_track_air_temp !== "false");
    setPhMin(config.pool_ph_min ?? "7.2");
    setPhMax(config.pool_ph_max ?? "7.6");
    setFreeChlorMin(config.pool_free_chlor_min ?? "1.0");
    setFreeChlorMax(config.pool_free_chlor_max ?? "3.0");
    setTempMin(config.pool_temp_min ?? "27");
    setTempMax(config.pool_temp_max ?? "32");
  }, [config, open]);

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          pool_name: poolName,
          pool_default_performer: defaultPerformer,
          pool_track_air_temp: showAirTemp ? "true" : "false",
          pool_ph_min: phMin,
          pool_ph_max: phMax,
          pool_free_chlor_min: freeChlorMin,
          pool_free_chlor_max: freeChlorMax,
          pool_temp_min: tempMin,
          pool_temp_max: tempMax,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPoolTrackConfigQueryKey() });
          toast({ title: "Template saved", description: "Pool settings updated." });
          setOpen(false);
        },
        onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="w-4 h-4 mr-2" />
          Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>PoolTrack Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure safe ranges and defaults for pool water testing.</p>
        </DialogHeader>

        <Tabs defaultValue="ranges" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0 w-full grid grid-cols-2">
            <TabsTrigger value="ranges">Safe Ranges</TabsTrigger>
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
          </TabsList>

          <TabsContent value="ranges" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <p className="text-xs text-muted-foreground">Set safe ranges for your pool. These appear as guidance text inside the testing form (PWTAG / HSG179 defaults shown).</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>pH minimum</Label>
                <Input value={phMin} onChange={e => setPhMin(e.target.value)} placeholder="7.2" type="number" step="0.1" className="rounded-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>pH maximum</Label>
                <Input value={phMax} onChange={e => setPhMax(e.target.value)} placeholder="7.6" type="number" step="0.1" className="rounded-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Free chlorine min (mg/L)</Label>
                <Input value={freeChlorMin} onChange={e => setFreeChlorMin(e.target.value)} placeholder="1.0" type="number" step="0.1" className="rounded-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Free chlorine max (mg/L)</Label>
                <Input value={freeChlorMax} onChange={e => setFreeChlorMax(e.target.value)} placeholder="3.0" type="number" step="0.1" className="rounded-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Water temp min (°C)</Label>
                <Input value={tempMin} onChange={e => setTempMin(e.target.value)} placeholder="27" type="number" className="rounded-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Water temp max (°C)</Label>
                <Input value={tempMax} onChange={e => setTempMax(e.target.value)} placeholder="32" type="number" className="rounded-sm" />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="defaults" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <div className="space-y-1.5">
              <Label>Pool name</Label>
              <Input value={poolName} onChange={e => setPoolName(e.target.value)}
                placeholder="e.g. Main pool" className="rounded-sm" />
              <p className="text-xs text-muted-foreground">Shown in the page header.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Default performed by</Label>
              <Input value={defaultPerformer} onChange={e => setDefaultPerformer(e.target.value)}
                placeholder="e.g. Pool supervisor" className="rounded-sm" />
              <p className="text-xs text-muted-foreground">Pre-fills the "Performed by" field on every new check.</p>
            </div>
            <div className="flex items-center justify-between rounded-sm border border-border p-3">
              <div>
                <p className="text-sm font-medium">Air temperature field</p>
                <p className="text-xs text-muted-foreground">Show air temp in the full weekly check form</p>
              </div>
              <Switch checked={showAirTemp} onCheckedChange={setShowAirTemp} />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="shrink-0 pt-2 border-t border-border mt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateConfig.isPending}>
            {updateConfig.isPending ? "Saving…" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Check type config ─────────────────────────────────────────────────────────

const CHECK_TYPE_LABELS: Record<string, string> = {
  routine:  "Routine water test",
  opening:  "Opening check",
  closing:  "Closing check",
  weekly:   "Full water balance (weekly)",
};

const CHECK_TYPE_FREQ: Record<string, string> = {
  routine: "Every 2 hours",
  opening: "Daily",
  closing: "Daily",
  weekly:  "Weekly",
};

// ── Chemistry validation ──────────────────────────────────────────────────────

type ValLevel = "ok" | "warn" | "fail";

function pHLevel(v: number | null): ValLevel {
  if (v === null) return "ok";
  if (v < 7.0 || v > 8.0) return "fail";
  if (v < 7.2 || v > 7.6) return "warn";
  return "ok";
}
function freeCl(v: number | null): ValLevel {
  if (v === null) return "ok";
  if (v < 0.5 || v > 5.0) return "fail";
  if (v < 1.0 || v > 3.0) return "warn";
  return "ok";
}
function combCl(v: number | null): ValLevel {
  if (v === null) return "ok";
  if (v >= 1.0) return "fail";
  if (v >= 0.5) return "warn";
  return "ok";
}
function turbLevel(v: string | null): ValLevel {
  if (!v) return "ok";
  if (v === "cloudy") return "fail";
  if (v === "hazy") return "warn";
  return "ok";
}
function waterTemp(v: number | null): ValLevel {
  if (v === null) return "ok";
  if (v > 30) return "warn";
  return "ok";
}

function autoResult(fields: {
  ph: number | null; free: number | null; combined: number | null;
  turb: string | null; temp: number | null;
}): "pass" | "fail" | "action_required" {
  const levels = [pHLevel(fields.ph), freeCl(fields.free), combCl(fields.combined),
                  turbLevel(fields.turb), waterTemp(fields.temp)];
  if (levels.includes("fail")) return "fail";
  if (levels.includes("warn")) return "action_required";
  return "pass";
}

function levelCls(level: ValLevel) {
  if (level === "fail") return "border-rose-400 bg-rose-50 focus:ring-rose-300";
  if (level === "warn") return "border-amber-400 bg-amber-50 focus:ring-amber-300";
  return "";
}

// ── Chemistry field with range hint ──────────────────────────────────────────

function ChemField({
  label, value, onChange, range, level, unit, step = "0.01", placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  range: string; level: ValLevel; unit: string; step?: string; placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs flex items-center justify-between">
        <span>{label}</span>
        <span className="text-muted-foreground font-normal">{range}</span>
      </Label>
      <div className="relative">
        <Input
          type="number"
          step={step}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? "—"}
          className={cn("rounded-sm pr-8 text-sm", levelCls(level))}
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">{unit}</span>
      </div>
    </div>
  );
}

// ── Record dialog ─────────────────────────────────────────────────────────────

interface PoolCheck {
  id: number;
  check_date: string;
  check_time: string | null;
  check_type: string;
  site_id: number | null;
  site_name?: string | null;
  ph_level: string | null;
  free_chlorine: string | null;
  combined_chlorine: string | null;
  water_temp_c: string | null;
  air_temp_c: string | null;
  turbidity: string | null;
  pool_open: boolean;
  performed_by: string | null;
  actions_taken: string | null;
  result: string;
  notes: string | null;
}

function RecordDialog({
  siteId,
  onSaved,
  existing,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultCheckType,
}: {
  siteId?: number;
  onSaved: () => void;
  existing?: PoolCheck;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  defaultCheckType?: string;
}) {
  const isEdit = !!existing;
  const { user } = useAuth();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (controlledOpen !== undefined) controlledOnOpenChange?.(v);
    else setInternalOpen(v);
  };
  const [checkType, setCheckType] = useState(existing?.check_type ?? "routine");

  // When opened via a status card click, pre-select that check type
  useEffect(() => {
    if (open && defaultCheckType && !isEdit) setCheckType(defaultCheckType);
  }, [open, defaultCheckType]);
  const [checkDate, setCheckDate] = useState(existing?.check_date ?? todayIso());
  const [checkTime, setCheckTime] = useState(existing?.check_time ?? nowTime());
  const [selectedSite, setSelectedSite] = useState<number | undefined>(existing?.site_id ?? siteId);
  const [ph, setPh] = useState(existing?.ph_level ?? "");
  const [freeChlor, setFreeChlor] = useState(existing?.free_chlorine ?? "");
  const [combChlor, setCombChlor] = useState(existing?.combined_chlorine ?? "");
  const [waterTemp2, setWaterTemp] = useState(existing?.water_temp_c ?? "");
  const [airTemp, setAirTemp] = useState(existing?.air_temp_c ?? "");
  const [turbidity, setTurbidity] = useState<string>(existing?.turbidity ?? "clear");
  const [poolOpen, setPoolOpen] = useState(existing?.pool_open ?? true);
  const [performedBy, setPerformedBy] = useState(existing?.performed_by ?? user?.name ?? "");
  const [actionsTaken, setActionsTaken] = useState(existing?.actions_taken ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [overrideResult, setOverrideResult] = useState<string | null>(null);

  const { toast } = useToast();
  const { data: sites } = useListSites();
  const { data: config } = useGetPoolTrackConfig();

  // Pre-fill from template (new records only)
  useEffect(() => {
    if (!open || isEdit || !config) return;
    if (!performedBy && config.pool_default_performer) setPerformedBy(config.pool_default_performer);
  }, [open]);

  const parsedPh = ph ? parseFloat(ph) : null;
  const parsedFree = freeChlor ? parseFloat(freeChlor) : null;
  const parsedComb = combChlor ? parseFloat(combChlor) : null;
  const parsedWT = waterTemp2 ? parseFloat(waterTemp2) : null;

  const suggested = autoResult({ ph: parsedPh, free: parsedFree, combined: parsedComb, turb: turbidity === "clear" ? null : turbidity, temp: parsedWT });
  const effectiveResult = overrideResult ?? suggested;

  const phLvl = pHLevel(parsedPh);
  const freeLvl = freeCl(parsedFree);
  const combLvl = combCl(parsedComb);
  const turbLvl = turbLevel(turbidity === "clear" ? null : turbidity);

  const hasValues = !!(ph || freeChlor || combChlor);

  const handleSubmit = async () => {
    try {
      const payload = {
        checkType, checkDate, checkTime: checkTime || undefined,
        siteId: selectedSite,
        phLevel: parsedPh, freeChlorine: parsedFree, combinedChlorine: parsedComb,
        waterTempC: parsedWT, airTempC: airTemp ? parseFloat(airTemp) : null,
        turbidity: turbidity || null, poolOpen, performedBy: performedBy || undefined,
        actionsTaken: actionsTaken || undefined, result: effectiveResult,
        notes: notes || undefined,
      };
      if (isEdit) {
        await apiFetch(`/pool-track/${existing!.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/pool-track", { method: "POST", body: JSON.stringify(payload) });
      }
      toast({ title: isEdit ? "Record updated" : "Check recorded" });
      setOpen(false); onSaved();
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); }}>
      <DialogTrigger asChild>
        {isEdit
          ? <Button variant="ghost" size="sm"><Pencil className="w-3.5 h-3.5" /></Button>
          : <Button className="shadow-lg shadow-primary/20"><Plus className="w-4 h-4 mr-2" />Record Check</Button>
        }
      </DialogTrigger>
      <DialogContent className="max-w-xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{isEdit ? "Edit Pool Check" : "Record Pool Check"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {!isEdit && (
            <div className="space-y-1.5">
              <Label>Check Type</Label>
              <Select value={checkType} onValueChange={setCheckType}>
                <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CHECK_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label>Date</Label>
              <Input type="date" value={checkDate} onChange={e => setCheckDate(e.target.value)} className="rounded-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Time</Label>
              <Input type="time" value={checkTime} onChange={e => setCheckTime(e.target.value)} className="rounded-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Performed by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input value={performedBy} onChange={e => setPerformedBy(e.target.value)} placeholder="Name" className="rounded-sm" />
            </div>
            {sites && sites.length > 0 && (
              <div className="space-y-1.5">
                <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={selectedSite ? String(selectedSite) : "none"} onValueChange={v => setSelectedSite(v === "none" ? undefined : Number(v))}>
                  <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No specific site</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* ── Chemistry ──────────────────────────────────────────────── */}
          <div className="border border-border rounded-sm p-3 space-y-3 bg-muted/20">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <Droplets className="w-4 h-4 text-primary" /> Water chemistry
              <span className="text-xs text-muted-foreground font-normal ml-1">Enter readings where applicable</span>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <ChemField label="pH" range="Target 7.2–7.6" value={ph} onChange={setPh} level={phLvl} unit="pH" step="0.1" placeholder="7.4" />
              <ChemField label="Free chlorine" range="1.0–3.0 mg/L" value={freeChlor} onChange={setFreeChlor} level={freeLvl} unit="mg/L" placeholder="2.0" />
              <ChemField label="Combined chlorine" range="< 0.5 mg/L" value={combChlor} onChange={setCombChlor} level={combLvl} unit="mg/L" placeholder="0.1" />
              <ChemField label="Water temp" range="≤ 30 °C" value={waterTemp2} onChange={setWaterTemp} level={waterTemp(parsedWT)} unit="°C" step="0.5" placeholder="28" />
              <ChemField label="Air temp" range="optional" value={airTemp} onChange={setAirTemp} level="ok" unit="°C" step="0.5" placeholder="—" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center justify-between">
                <span>Water clarity</span>
                <span className="text-muted-foreground font-normal">Close pool if bottom not visible</span>
              </Label>
              <div className="flex gap-1.5 flex-wrap">
                {(["clear", "slightly_hazy", "hazy", "cloudy"] as const).map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setTurbidity(v)}
                    className={cn(
                      "px-3 py-1.5 rounded-sm border text-xs font-medium transition-colors",
                      turbidity === v
                        ? v === "clear"        ? "bg-emerald-600 border-emerald-600 text-white"
                        : v === "slightly_hazy"? "bg-amber-400 border-amber-400 text-white"
                        : v === "hazy"         ? "bg-amber-600 border-amber-600 text-white"
                        :                        "bg-rose-600 border-rose-600 text-white"
                        : "bg-background text-muted-foreground border-border hover:border-primary/40"
                    )}
                  >
                    {v === "clear" ? "Clear" : v === "slightly_hazy" ? "Slightly hazy" : v === "hazy" ? "Hazy" : "Cloudy"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Auto-result ────────────────────────────────────────────── */}
          {hasValues && (
            <div className={cn("rounded-sm border px-3 py-2 text-xs font-medium",
              suggested === "pass"           ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : suggested === "action_required" ? "bg-amber-50 border-amber-200 text-amber-800"
              :                                   "bg-rose-50 border-rose-200 text-rose-800"
            )}>
              Suggested result: <span className="font-bold">{suggested === "pass" ? "Pass" : suggested === "action_required" ? "Action Required" : "Fail"}</span>
              {suggested !== "pass" && (
                <span className="font-normal ml-1">based on chemistry values</span>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Overall result</Label>
            <Select value={effectiveResult} onValueChange={v => setOverrideResult(v)}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="action_required">Action Required</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Label className="text-sm">Pool status:</Label>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setPoolOpen(true)}
                className={cn("px-3 py-1.5 rounded-sm border text-xs font-medium transition-colors",
                  poolOpen ? "bg-emerald-600 border-emerald-600 text-white" : "bg-background text-muted-foreground border-border hover:border-primary/40"
                )}>Open</button>
              <button type="button" onClick={() => setPoolOpen(false)}
                className={cn("px-3 py-1.5 rounded-sm border text-xs font-medium transition-colors",
                  !poolOpen ? "bg-rose-600 border-rose-600 text-white" : "bg-background text-muted-foreground border-border hover:border-primary/40"
                )}>Closed</button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Actions taken <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={actionsTaken} onChange={e => setActionsTaken(e.target.value)} rows={2} placeholder="e.g. Added 0.5L shock treatment, adjusted pH with HCl" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit}>{isEdit ? "Update" : "Record Check"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Chemistry badge ───────────────────────────────────────────────────────────

function ChemBadge({ label, value, unit, level }: { label: string; value: string | null; unit: string; level: ValLevel }) {
  if (!value) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded border font-medium",
      level === "fail" ? "bg-rose-50 text-rose-700 border-rose-200" :
      level === "warn" ? "bg-amber-50 text-amber-700 border-amber-200" :
                         "bg-emerald-50 text-emerald-700 border-emerald-200"
    )}>
      {label}: {value}{unit}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PoolTrackPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasPool = hasService("pooltrack");

  const [filterType, setFilterType] = useState("");
  const [filterSite, setFilterSite] = useState<number | undefined>();
  const [recordOpen, setRecordOpen] = useState(false);
  const [quickCheckType, setQuickCheckType] = useState<string | undefined>(undefined);
  const [checks, setChecks] = useState<PoolCheck[]>([]);
  const [status, setStatus] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<any>(null);

  const { data: sites } = useListSites({ query: { enabled: hasPool, queryKey: getListSitesQueryKey() } });

  const fetchAll = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterType) params.set("checkType", filterType);
      if (filterSite) params.set("siteId", String(filterSite));
      const [checksData, statusData] = await Promise.all([
        apiFetch<PoolCheck[]>(`/pool-track?${params}`),
        apiFetch<any[]>(`/pool-track/status${filterSite ? `?siteId=${filterSite}` : ""}`),
      ]);
      setChecks(checksData);
      setStatus(statusData);
      setStatusError(null);
    } catch (err: any) {
      setStatusError(err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch when hasPool and when filter changes
  useMemo(() => { if (hasPool) fetchAll(); }, [hasPool, filterType, filterSite]);

  const { toast } = useToast();

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this check record?")) return;
    try {
      await apiFetch(`/pool-track/${id}`, { method: "DELETE" });
      toast({ title: "Record deleted" }); fetchAll();
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    }
  };

  if (!hasPool || statusError?.status === 403) {
    return (
      <AppLayout title="PoolTrack — Swimming Pool Logbook">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium mb-2">PoolTrack</h2>
                <p className="text-muted-foreground mb-1">Swimming pool water testing logbook. Record pH, chlorine, temperature and clarity checks in line with PWTAG and HSG179.</p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin
                  ? <Link href="/settings"><Button size="lg" className="w-full sm:w-auto">Enable PoolTrack</Button></Link>
                  : <p className="text-sm text-muted-foreground">Ask your account admin to enable this service.</p>
                }
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const overdueItems = status.filter(s => s.status === "overdue");
  const dueSoonItems = status.filter(s => s.status === "due_soon");

  return (
    <AppLayout title="PoolTrack — Swimming Pool Logbook">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <Waves className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">Swimming pool water testing and safety logbook (PWTAG / HSG179)</p>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && <PoolConfigDialog />}
            <RecordDialog siteId={filterSite} onSaved={fetchAll} open={recordOpen} onOpenChange={setRecordOpen} defaultCheckType={quickCheckType} />
          </div>
        </div>

        {/* Status grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="animate-pulse"><CardContent className="p-4 h-20" /></Card>
              ))
            : status.map(item => (
                <Card
                  key={item.checkType}
                  className={cn(
                    "border-l-4 transition-all hover:shadow-md cursor-pointer group",
                    item.status === "overdue"  ? "border-l-rose-500 bg-rose-50/50" :
                    item.status === "due_soon" ? "border-l-amber-500 bg-amber-50/50" :
                    item.status === "never"    ? "border-l-slate-400 bg-slate-50/50" :
                                                 "border-l-emerald-500 bg-emerald-50/50"
                  )}
                  onClick={() => { setQuickCheckType(item.checkType); setRecordOpen(true); }}
                >
                  <CardHeader className="pb-1 pt-3 px-4">
                    <CardTitle className="text-xs font-medium leading-snug">{CHECK_TYPE_LABELS[item.checkType] ?? item.checkType}</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3 px-4 space-y-0.5">
                    <div className="text-xs text-muted-foreground">{CHECK_TYPE_FREQ[item.checkType]}</div>
                    {item.lastDate && (
                      <div className="text-xs text-muted-foreground">
                        Last: {format(new Date(item.lastDate), "dd/MM/yy")}
                        {item.lastTime && ` ${item.lastTime}`}
                      </div>
                    )}
                    {item.status === "never" && <div className="text-xs text-muted-foreground italic">Not recorded yet</div>}
                    {item.result && (
                      <Badge variant="outline" className={cn("text-xs mt-0.5",
                        item.result === "pass"           ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                        item.result === "action_required"? "bg-amber-50 text-amber-700 border-amber-200" :
                                                           "bg-rose-50 text-rose-700 border-rose-200"
                      )}>
                        {item.result === "pass" ? "Pass" : item.result === "action_required" ? "Action Req." : "Fail"}
                      </Badge>
                    )}
                    <div className="text-[11px] text-primary opacity-0 group-hover:opacity-100 transition-opacity pt-0.5 font-medium">
                      + Record check →
                    </div>
                  </CardContent>
                </Card>
              ))
          }
        </div>

        {/* Alert banners */}
        {(overdueItems.length > 0 || dueSoonItems.length > 0) && (
          <div className="space-y-3">
            {overdueItems.length > 0 && (
              <div className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Overdue checks</div>
                <div className="text-xs">{overdueItems.map(s => CHECK_TYPE_LABELS[s.checkType] ?? s.checkType).join(", ")}</div>
              </div>
            )}
            {dueSoonItems.length > 0 && (
              <div className="rounded-sm border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5"><Clock className="w-4 h-4" /> Due soon</div>
                <div className="text-xs">{dueSoonItems.map(s => CHECK_TYPE_LABELS[s.checkType] ?? s.checkType).join(", ")}</div>
              </div>
            )}
          </div>
        )}

        {/* Filter */}
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Check Type</Label>
                <Select value={filterType || "all"} onValueChange={v => setFilterType(v === "all" ? "" : v)}>
                  <SelectTrigger className="rounded-sm"><SelectValue placeholder="All types" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {Object.entries(CHECK_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {sites && sites.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Site</Label>
                  <Select value={filterSite ? String(filterSite) : "all"} onValueChange={v => setFilterSite(v === "all" ? undefined : Number(v))}>
                    <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sites</SelectItem>
                      {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* History */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="font-display">Check Log</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-12 flex justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
              </div>
            ) : checks.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Waves className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No pool checks recorded yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {checks.map(check => {
                  const ph = check.ph_level ? parseFloat(check.ph_level) : null;
                  const free = check.free_chlorine ? parseFloat(check.free_chlorine) : null;
                  const combined = check.combined_chlorine ? parseFloat(check.combined_chlorine) : null;
                  return (
                    <div key={check.id} className="p-4 hover:bg-muted/20 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{CHECK_TYPE_LABELS[check.check_type] ?? check.check_type}</span>
                            <Badge variant="outline" className={cn("text-xs",
                              check.result === "pass"           ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                              check.result === "action_required"? "bg-amber-50 text-amber-700 border-amber-200" :
                                                                  "bg-rose-50 text-rose-700 border-rose-200"
                            )}>
                              {check.result === "pass" ? "Pass" : check.result === "action_required" ? "Action Required" : "Fail"}
                            </Badge>
                            {!check.pool_open && <Badge variant="outline" className="text-xs bg-slate-50 text-slate-600">Pool closed</Badge>}
                            {check.site_name && <Badge variant="outline" className="text-xs">{check.site_name}</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground space-y-0.5">
                            <div>
                              <span className="font-medium">Date:</span> {format(new Date(check.check_date), "dd/MM/yyyy")}
                              {check.check_time && ` at ${check.check_time}`}
                            </div>
                            {check.performed_by && <div><span className="font-medium">By:</span> {check.performed_by}</div>}
                          </div>
                          {/* Chemistry badges */}
                          {(ph !== null || free !== null || combined !== null || check.turbidity) && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              <ChemBadge label="pH" value={check.ph_level} unit="" level={pHLevel(ph)} />
                              <ChemBadge label="FCl" value={check.free_chlorine} unit=" mg/L" level={freeCl(free)} />
                              <ChemBadge label="CCl" value={check.combined_chlorine} unit=" mg/L" level={combCl(combined)} />
                              {check.water_temp_c && <ChemBadge label="Temp" value={check.water_temp_c} unit="°C" level={waterTemp(parseFloat(check.water_temp_c))} />}
                              {check.turbidity && check.turbidity !== "clear" && (
                                <Badge variant="outline" className={cn("text-xs",
                                  check.turbidity === "cloudy" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-amber-50 text-amber-700 border-amber-200"
                                )}>
                                  {check.turbidity === "slightly_hazy" ? "Slightly hazy" : check.turbidity === "hazy" ? "Hazy" : "Cloudy"}
                                </Badge>
                              )}
                            </div>
                          )}
                          {check.actions_taken && (
                            <div className="text-xs text-muted-foreground"><span className="font-medium">Actions:</span> {check.actions_taken}</div>
                          )}
                          {check.notes && (
                            <div className="text-xs text-muted-foreground"><span className="font-medium">Notes:</span> {check.notes}</div>
                          )}
                          {/* Photos */}
                          <CheckPhotoUploader entityType="pool_check" entityId={check.id} compact />
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <RecordDialog existing={check} onSaved={fetchAll} />
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(check.id)}
                            className="text-destructive hover:bg-destructive/10">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
