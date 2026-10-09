import { useState, useMemo, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import {
  Waves, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX,
  Lock, Pencil, Trash2, Droplets, Thermometer, Settings,
  Activity, HeartPulse, ShieldAlert, Search, XCircle, Anchor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListSites,
  getListSitesQueryKey,
  useGetPoolTrackConfig,
  getGetPoolTrackConfigQueryKey,
  useUpdatePoolTrackConfig,
} from "@workspace/api-client-react";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { StaffPerformerSelect } from "@/components/staff-performer-select";
import { WaterMonitoringPlan } from "@/components/water-monitoring-plan";

// ── API helpers ────────────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════════
// WATER QUALITY (PoolTrack)
// ═══════════════════════════════════════════════════════════════════════════════

const CHECK_TYPE_LABELS: Record<string, string> = {
  routine: "Routine water test",
  opening: "Opening check",
  closing:  "Closing check",
  weekly:  "Full water balance (weekly)",
};
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
}): "pass" | "fail" {
  const levels = [pHLevel(fields.ph), freeCl(fields.free), combCl(fields.combined),
                  turbLevel(fields.turb), waterTemp(fields.temp)];
  if (levels.includes("fail")) return "fail";
  if (levels.includes("warn")) return "fail";
  return "pass";
}
function levelCls(level: ValLevel) {
  if (level === "fail") return "border-rose-400 bg-rose-50 focus:ring-rose-300";
  if (level === "warn") return "border-amber-400 bg-amber-50 focus:ring-amber-300";
  return "";
}

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
        <Input type="number" step={step} value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? "—"}
          className={cn("rounded-sm pr-8 text-sm", levelCls(level))} />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">{unit}</span>
      </div>
    </div>
  );
}

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

function PoolConfigDialog({ onChanged }: { onChanged: () => void }) {
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
      { data: { pool_name: poolName, pool_default_performer: defaultPerformer,
          pool_track_air_temp: showAirTemp ? "true" : "false",
          pool_ph_min: phMin, pool_ph_max: phMax,
          pool_free_chlor_min: freeChlorMin, pool_free_chlor_max: freeChlorMax,
          pool_temp_min: tempMin, pool_temp_max: tempMax } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPoolTrackConfigQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["water-monitoring-plan", "pool-track"] });
          onChanged();
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
        <Button variant="outline" size="sm"><Settings className="w-4 h-4 mr-2" />Template</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Water Quality Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure safe ranges and defaults for pool water testing (PWTAG / HSG179).</p>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Pool name</Label>
            <Input value={poolName} onChange={e => setPoolName(e.target.value)} placeholder="e.g. Main pool" className="rounded-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>Default performed by</Label>
            <Input value={defaultPerformer} onChange={e => setDefaultPerformer(e.target.value)} placeholder="e.g. Pool supervisor" className="rounded-sm" />
          </div>
          <div className="flex items-center justify-between rounded-sm border border-border p-3">
            <div>
              <p className="text-sm font-medium">Air temperature field</p>
              <p className="text-xs text-muted-foreground">Show air temp in the full weekly check form</p>
            </div>
            <Switch checked={showAirTemp} onCheckedChange={setShowAirTemp} />
          </div>
          <p className="text-xs text-muted-foreground font-medium pt-1">Safe ranges</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>pH min</Label><Input value={phMin} onChange={e => setPhMin(e.target.value)} type="number" step="0.1" className="rounded-sm" /></div>
            <div className="space-y-1.5"><Label>pH max</Label><Input value={phMax} onChange={e => setPhMax(e.target.value)} type="number" step="0.1" className="rounded-sm" /></div>
            <div className="space-y-1.5"><Label>Free Cl min (mg/L)</Label><Input value={freeChlorMin} onChange={e => setFreeChlorMin(e.target.value)} type="number" step="0.1" className="rounded-sm" /></div>
            <div className="space-y-1.5"><Label>Free Cl max (mg/L)</Label><Input value={freeChlorMax} onChange={e => setFreeChlorMax(e.target.value)} type="number" step="0.1" className="rounded-sm" /></div>
            <div className="space-y-1.5"><Label>Water temp min (°C)</Label><Input value={tempMin} onChange={e => setTempMin(e.target.value)} type="number" className="rounded-sm" /></div>
            <div className="space-y-1.5"><Label>Water temp max (°C)</Label><Input value={tempMax} onChange={e => setTempMax(e.target.value)} type="number" className="rounded-sm" /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateConfig.isPending}>{updateConfig.isPending ? "Saving…" : "Save template"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PoolRecordDialog({
  siteId, onSaved, existing, open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultCheckType,
}: {
  siteId?: number; onSaved: () => void; existing?: PoolCheck;
  open?: boolean; onOpenChange?: (v: boolean) => void; defaultCheckType?: string;
}) {
  const isEdit = !!existing;
  const { user } = useAuth();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => { if (controlledOpen !== undefined) controlledOnOpenChange?.(v); else setInternalOpen(v); };
  const [checkType, setCheckType] = useState(existing?.check_type ?? "routine");

  useEffect(() => { if (open && defaultCheckType && !isEdit) setCheckType(defaultCheckType); }, [open, defaultCheckType]);

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
  const [staffRosterId, setStaffRosterId] = useState<number | null>((existing as any)?.staff_roster_id ?? null);
  const [actionsTaken, setActionsTaken] = useState(existing?.actions_taken ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [overrideResult, setOverrideResult] = useState<string | null>(null);
  const { toast } = useToast();
  const { data: sites } = useListSites();
  const { data: config } = useGetPoolTrackConfig();

  useEffect(() => { if (!open || isEdit || !config) return; if (!performedBy && config.pool_default_performer) setPerformedBy(config.pool_default_performer); }, [open]);

  const parsedPh = ph ? parseFloat(ph) : null;
  const parsedFree = freeChlor ? parseFloat(freeChlor) : null;
  const parsedComb = combChlor ? parseFloat(combChlor) : null;
  const parsedWT = waterTemp2 ? parseFloat(waterTemp2) : null;
  const suggested = autoResult({ ph: parsedPh, free: parsedFree, combined: parsedComb, turb: turbidity === "clear" ? null : turbidity, temp: parsedWT });
  const effectiveResult = overrideResult ?? suggested;
  const phLvl = pHLevel(parsedPh);
  const freeLvl = freeCl(parsedFree);
  const combLvl = combCl(parsedComb);
  const hasValues = !!(ph || freeChlor || combChlor);

  const handleSubmit = async () => {
    try {
      const payload = {
        checkType, checkDate, checkTime: checkTime || undefined, siteId: selectedSite,
        phLevel: parsedPh, freeChlorine: parsedFree, combinedChlorine: parsedComb,
        waterTempC: parsedWT, airTempC: airTemp ? parseFloat(airTemp) : null,
        turbidity: turbidity || null, poolOpen, performedBy: performedBy || null, staffRosterId: staffRosterId,
        actionsTaken: actionsTaken || undefined, result: effectiveResult, notes: notes || undefined,
      };
      if (isEdit) await apiFetch(`/pool-track/${existing!.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await apiFetch("/pool-track", { method: "POST", body: JSON.stringify(payload) });
      toast({ title: isEdit ? "Record updated" : "Check recorded" });
      setOpen(false); onSaved();
    } catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }); }
  };

  return (
    <Dialog open={open} onOpenChange={o => setOpen(o)}>
      <DialogTrigger asChild>
        {isEdit
          ? <Button variant="ghost" size="sm"><Pencil className="w-3.5 h-3.5" /></Button>
          : <Button className="shadow-lg shadow-primary/20"><Plus className="w-4 h-4 mr-2" />Record Check</Button>
        }
      </DialogTrigger>
      <DialogContent className="max-w-xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display">{isEdit ? "Edit Pool Check" : "Record Pool Check"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-4">
          {!isEdit && (
            <div className="space-y-1.5">
              <Label>Check Type</Label>
              <Select value={checkType} onValueChange={setCheckType}>
                <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(CHECK_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5 col-span-2"><Label>Date</Label><Input type="date" value={checkDate} onChange={e => setCheckDate(e.target.value)} className="rounded-sm" /></div>
            <div className="space-y-1.5"><Label>Time</Label><Input type="time" value={checkTime} onChange={e => setCheckTime(e.target.value)} className="rounded-sm" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <StaffPerformerSelect value={performedBy} onChange={setPerformedBy} onRosterIdChange={setStaffRosterId} optional />
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
          <div className="border border-border rounded-sm p-3 space-y-3 bg-muted/20">
            <p className="text-sm font-medium flex items-center gap-1.5"><Droplets className="w-4 h-4 text-primary" /> Water chemistry</p>
            <div className="grid grid-cols-2 gap-3">
              <ChemField label="pH" range="Target 7.2–7.6" value={ph} onChange={setPh} level={phLvl} unit="pH" step="0.1" placeholder="7.4" />
              <ChemField label="Free chlorine" range="1.0–3.0 mg/L" value={freeChlor} onChange={setFreeChlor} level={freeLvl} unit="mg/L" placeholder="2.0" />
              <ChemField label="Combined chlorine" range="< 0.5 mg/L" value={combChlor} onChange={setCombChlor} level={combLvl} unit="mg/L" placeholder="0.1" />
              <ChemField label="Water temp" range="≤ 30 °C" value={waterTemp2} onChange={setWaterTemp} level={waterTemp(parsedWT)} unit="°C" step="0.5" placeholder="28" />
              <ChemField label="Air temp" range="optional" value={airTemp} onChange={setAirTemp} level="ok" unit="°C" step="0.5" placeholder="—" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Water clarity</Label>
              <div className="flex gap-1.5 flex-wrap">
                {(["clear", "slightly_hazy", "hazy", "cloudy"] as const).map(v => (
                  <button key={v} type="button" onClick={() => setTurbidity(v)}
                    className={cn("px-3 py-1.5 rounded-sm border text-xs font-medium transition-colors",
                      turbidity === v
                        ? v === "clear" ? "bg-emerald-600 border-emerald-600 text-white"
                          : v === "slightly_hazy" ? "bg-amber-400 border-amber-400 text-white"
                          : v === "hazy" ? "bg-amber-600 border-amber-600 text-white"
                          : "bg-rose-600 border-rose-600 text-white"
                        : "bg-background text-muted-foreground border-border hover:border-primary/40"
                    )}>
                    {v === "clear" ? "Clear" : v === "slightly_hazy" ? "Slightly hazy" : v === "hazy" ? "Hazy" : "Cloudy"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {hasValues && (
            <div className={cn("rounded-sm border px-3 py-2 text-xs font-medium",
              suggested === "pass" ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-rose-50 border-rose-200 text-rose-800"
            )}>
              Suggested result: <span className="font-bold">{suggested === "pass" ? "Pass" : "Fail"}</span>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Check result</Label>
            <Select value={effectiveResult} onValueChange={v => setOverrideResult(v)}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">A Fail automatically opens an Action Required item to track remediation.</p>
          </div>
          <div className="flex items-center gap-3">
            <Label className="text-sm">Pool status:</Label>
            <div className="flex gap-1.5">
              {[true, false].map(val => (
                <button key={String(val)} type="button" onClick={() => setPoolOpen(val)}
                  className={cn("px-3 py-1.5 rounded-sm border text-xs font-medium transition-colors",
                    poolOpen === val
                      ? val ? "bg-emerald-600 border-emerald-600 text-white" : "bg-rose-600 border-rose-600 text-white"
                      : "bg-background text-muted-foreground border-border hover:border-primary/40"
                  )}>{val ? "Open" : "Closed"}</button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Actions taken <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={actionsTaken} onChange={e => setActionsTaken(e.target.value)} rows={2} className="rounded-sm" />
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

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS / SAFETY (SwimTrack)
// ═══════════════════════════════════════════════════════════════════════════════

const SESSION_TYPE_LABELS: Record<string, string> = {
  public_swim: "Public swim", lane_swim: "Lane swim", club_session: "Club session",
  lessons: "Lessons", private_hire: "Private hire", aquafit: "Aquafit / class", other: "Other",
};
const INCIDENT_TYPE_LABELS: Record<string, string> = {
  near_miss: "Near miss", minor_injury: "Minor injury", major_injury: "Major injury",
  drowning_rescue: "Drowning / rescue", pool_evacuation: "Pool evacuation",
  medical: "Medical emergency", other: "Other",
};
const SEVERITY_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
const FIRST_AID_ITEMS = [
  { key: "aedOk", label: "AED / defibrillator" }, { key: "firstAidKitOk", label: "First-aid kit" },
  { key: "rescuePoleOk", label: "Rescue pole" }, { key: "throwBagOk", label: "Throw bag / rope" },
  { key: "spineBoardOk", label: "Spine board" }, { key: "ringBuoyOk", label: "Ring buoy" },
  { key: "oxygenKitOk", label: "Oxygen kit" },
] as const;

interface SwimSession { id: number; siteId: number | null; siteName: string | null; sessionDate: string; sessionType: string; lifeguardName: string | null; openTime: string | null; closeTime: string | null; maxBathers: number | null; batherCountPeak: number | null; preSessionResult: string; preSessionNotes: string | null; poolClosed: boolean; closureReason: string | null; notes: string | null; result: string; }
interface SurveillanceCheck { id: number; sessionId: number | null; siteId: number | null; siteName: string | null; checkDate: string; checkTime: string | null; batherCount: number | null; scanCompleted: boolean; observations: string | null; checkedBy: string | null; result: string; }
interface FirstAidCheck { id: number; siteId: number | null; siteName: string | null; checkDate: string; aedOk: boolean; firstAidKitOk: boolean; rescuePoleOk: boolean; throwBagOk: boolean; spineBoardOk: boolean; ringBuoyOk: boolean; oxygenKitOk: boolean; checkedBy: string | null; defectsFound: string | null; notes: string | null; result: string; }
interface Incident { id: number; siteId: number | null; siteName: string | null; incidentDate: string; incidentTime: string | null; incidentType: string; severity: string; personsInvolved: string | null; description: string; actionTaken: string | null; reportedTo: string | null; reportedDate: string | null; outcome: string | null; notes: string | null; }
interface SwimStatus { sessionsToday: number; poolsClosedToday: number; surveillanceToday: number; firstAidLast30d: number; firstAidActionRequired: number; lastFirstAidCheck: string | null; openIncidents: number; }

function SessionDialog({ open, onClose, session, sites, onSaved }: { open: boolean; onClose: () => void; session?: SwimSession | null; sites: { id: number; name: string }[]; onSaved: () => void; }) {
  const { toast } = useToast();
  const today = todayIso();
  const blank = { siteId: "", sessionDate: today, sessionType: "public_swim", lifeguardName: "", openTime: "", closeTime: "", maxBathers: "", batherCountPeak: "", preSessionResult: "pass", preSessionNotes: "", poolClosed: false, closureReason: "", notes: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm(session ? { siteId: session.siteId ? String(session.siteId) : "", sessionDate: session.sessionDate, sessionType: session.sessionType, lifeguardName: session.lifeguardName ?? "", openTime: session.openTime ?? "", closeTime: session.closeTime ?? "", maxBathers: session.maxBathers != null ? String(session.maxBathers) : "", batherCountPeak: session.batherCountPeak != null ? String(session.batherCountPeak) : "", preSessionResult: session.preSessionResult === "pass" ? "pass" : "fail", preSessionNotes: session.preSessionNotes ?? "", poolClosed: session.poolClosed, closureReason: session.closureReason ?? "", notes: session.notes ?? "" } : blank);
  const handleSave = async () => {
    if (!form.sessionDate) { toast({ title: "Session date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { siteId: form.siteId ? parseInt(form.siteId, 10) : null, sessionDate: form.sessionDate, sessionType: form.sessionType, lifeguardName: form.lifeguardName.trim() || null, openTime: form.openTime || null, closeTime: form.closeTime || null, maxBathers: form.maxBathers ? parseInt(form.maxBathers, 10) : null, batherCountPeak: form.batherCountPeak ? parseInt(form.batherCountPeak, 10) : null, preSessionResult: form.preSessionResult, preSessionNotes: form.preSessionNotes.trim() || null, poolClosed: form.poolClosed, closureReason: form.closureReason.trim() || null, notes: form.notes.trim() || null, result: form.poolClosed ? "fail" : form.preSessionResult };
      if (session) await apiFetch(`/swim-track/sessions/${session.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await apiFetch("/swim-track/sessions", { method: "POST", body: JSON.stringify(body) });
      toast({ title: session ? "Session updated" : "Session logged" });
      onSaved(); onClose();
    } catch (err: any) { toast({ title: "Failed to save", description: err.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{session ? "Edit Session" : "Log Pool Session"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Date *</Label><Input type="date" className="mt-1 rounded-sm" value={form.sessionDate} onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))} /></div>
            <div><Label>Session type</Label>
              <Select value={form.sessionType} onValueChange={v => setForm(f => ({ ...f, sessionType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {sites.length > 0 && (
              <div className="col-span-2"><Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                  <SelectContent><SelectItem value="_none">— All sites —</SelectItem>{sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div><Label>Lifeguard on duty <span className="text-muted-foreground text-xs">optional</span></Label><Input className="mt-1 rounded-sm" value={form.lifeguardName} onChange={e => setForm(f => ({ ...f, lifeguardName: e.target.value }))} /></div>
            <div><Label>Pre-session result</Label>
              <Select value={form.preSessionResult} onValueChange={v => setForm(f => ({ ...f, preSessionResult: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="pass">Pass</SelectItem><SelectItem value="fail">Fail</SelectItem></SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">A Fail automatically opens an Action Required item to track remediation.</p>
            </div>
            <div><Label>Open time <span className="text-muted-foreground text-xs">optional</span></Label><Input type="time" className="mt-1 rounded-sm" value={form.openTime} onChange={e => setForm(f => ({ ...f, openTime: e.target.value }))} /></div>
            <div><Label>Close time <span className="text-muted-foreground text-xs">optional</span></Label><Input type="time" className="mt-1 rounded-sm" value={form.closeTime} onChange={e => setForm(f => ({ ...f, closeTime: e.target.value }))} /></div>
            <div><Label>Capacity limit <span className="text-muted-foreground text-xs">optional</span></Label><Input type="number" min="0" className="mt-1 rounded-sm" value={form.maxBathers} onChange={e => setForm(f => ({ ...f, maxBathers: e.target.value }))} /></div>
            <div><Label>Peak bather count <span className="text-muted-foreground text-xs">optional</span></Label><Input type="number" min="0" className="mt-1 rounded-sm" value={form.batherCountPeak} onChange={e => setForm(f => ({ ...f, batherCountPeak: e.target.value }))} /></div>
          </div>
          <div><Label>Pre-session notes <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.preSessionNotes} onChange={e => setForm(f => ({ ...f, preSessionNotes: e.target.value }))} /></div>
          <div className="flex items-center gap-2"><input type="checkbox" id="poolClosed" checked={form.poolClosed} onChange={e => setForm(f => ({ ...f, poolClosed: e.target.checked }))} className="rounded" /><Label htmlFor="poolClosed" className="cursor-pointer text-sm">Pool closed / session cancelled</Label></div>
          {form.poolClosed && <div><Label>Closure reason</Label><Input className="mt-1 rounded-sm" value={form.closureReason} onChange={e => setForm(f => ({ ...f, closureReason: e.target.value }))} /></div>}
          <div><Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : session ? "Save changes" : "Log session"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SurveillanceDialog({ open, onClose, check, sites, onSaved }: { open: boolean; onClose: () => void; check?: SurveillanceCheck | null; sites: { id: number; name: string }[]; onSaved: () => void; }) {
  const { toast } = useToast();
  const today = todayIso();
  const now = nowTime();
  const blank = { siteId: "", checkDate: today, checkTime: now, batherCount: "", scanCompleted: true, observations: "", checkedBy: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm(check ? { siteId: check.siteId ? String(check.siteId) : "", checkDate: check.checkDate, checkTime: check.checkTime ?? "", batherCount: check.batherCount != null ? String(check.batherCount) : "", scanCompleted: check.scanCompleted, observations: check.observations ?? "", checkedBy: check.checkedBy ?? "" } : blank);
  const handleSave = async () => {
    if (!form.checkDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { siteId: form.siteId ? parseInt(form.siteId, 10) : null, checkDate: form.checkDate, checkTime: form.checkTime || null, batherCount: form.batherCount ? parseInt(form.batherCount, 10) : null, scanCompleted: form.scanCompleted, observations: form.observations.trim() || null, checkedBy: form.checkedBy.trim() || null, result: form.scanCompleted ? "pass" : "fail" };
      if (check) await apiFetch(`/swim-track/surveillance/${check.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await apiFetch("/swim-track/surveillance", { method: "POST", body: JSON.stringify(body) });
      toast({ title: check ? "Check updated" : "Surveillance check logged" });
      onSaved(); onClose();
    } catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{check ? "Edit Surveillance Check" : "Log Surveillance Check"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Date *</Label><Input type="date" className="mt-1 rounded-sm" value={form.checkDate} onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))} /></div>
            <div><Label>Time</Label><Input type="time" className="mt-1 rounded-sm" value={form.checkTime} onChange={e => setForm(f => ({ ...f, checkTime: e.target.value }))} /></div>
            {sites.length > 0 && (<div className="col-span-2"><Label>Site <span className="text-muted-foreground text-xs">optional</span></Label><Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}><SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger><SelectContent><SelectItem value="_none">— All sites —</SelectItem>{sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent></Select></div>)}
            <div><Label>Bather count <span className="text-muted-foreground text-xs">optional</span></Label><Input type="number" min="0" className="mt-1 rounded-sm" value={form.batherCount} onChange={e => setForm(f => ({ ...f, batherCount: e.target.value }))} /></div>
            <div><Label>Checked by <span className="text-muted-foreground text-xs">optional</span></Label><Input className="mt-1 rounded-sm" value={form.checkedBy} onChange={e => setForm(f => ({ ...f, checkedBy: e.target.value }))} /></div>
          </div>
          <div className="flex items-center gap-2"><input type="checkbox" id="scanDone" checked={form.scanCompleted} onChange={e => setForm(f => ({ ...f, scanCompleted: e.target.checked }))} className="rounded" /><Label htmlFor="scanDone" className="cursor-pointer text-sm">Full pool scan completed</Label></div>
          <div><Label>Observations <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={3} value={form.observations} onChange={e => setForm(f => ({ ...f, observations: e.target.value }))} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : check ? "Save changes" : "Log check"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FirstAidDialog({ open, onClose, check, sites, onSaved }: { open: boolean; onClose: () => void; check?: FirstAidCheck | null; sites: { id: number; name: string }[]; onSaved: () => void; }) {
  const { toast } = useToast();
  const blankItems = Object.fromEntries(FIRST_AID_ITEMS.map(i => [i.key, true]));
  const blank = { siteId: "", checkDate: todayIso(), checkedBy: "", defectsFound: "", notes: "", ...blankItems };
  const [form, setForm] = useState<Record<string, any>>(blank);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm(check ? { siteId: check.siteId ? String(check.siteId) : "", checkDate: check.checkDate, checkedBy: check.checkedBy ?? "", defectsFound: check.defectsFound ?? "", notes: check.notes ?? "", aedOk: check.aedOk, firstAidKitOk: check.firstAidKitOk, rescuePoleOk: check.rescuePoleOk, throwBagOk: check.throwBagOk, spineBoardOk: check.spineBoardOk, ringBuoyOk: check.ringBuoyOk, oxygenKitOk: check.oxygenKitOk } : blank);
  const handleSave = async () => {
    if (!form.checkDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { siteId: form.siteId ? parseInt(form.siteId, 10) : null, checkDate: form.checkDate, checkedBy: form.checkedBy.trim() || null, defectsFound: form.defectsFound.trim() || null, notes: form.notes.trim() || null, ...Object.fromEntries(FIRST_AID_ITEMS.map(i => [i.key, form[i.key]])) };
      if (check) await apiFetch(`/swim-track/first-aid/${check.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await apiFetch("/swim-track/first-aid", { method: "POST", body: JSON.stringify(body) });
      toast({ title: check ? "Check updated" : "First-aid check saved" });
      onSaved(); onClose();
    } catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{check ? "Edit First-Aid Check" : "First-Aid Readiness Check"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Date *</Label><Input type="date" className="mt-1 rounded-sm" value={form.checkDate} onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))} /></div>
            <div><Label>Checked by <span className="text-muted-foreground text-xs">optional</span></Label><Input className="mt-1 rounded-sm" value={form.checkedBy} onChange={e => setForm(f => ({ ...f, checkedBy: e.target.value }))} /></div>
            {sites.length > 0 && (<div className="col-span-2"><Label>Site <span className="text-muted-foreground text-xs">optional</span></Label><Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}><SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger><SelectContent><SelectItem value="_none">— All sites —</SelectItem>{sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent></Select></div>)}
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Equipment checklist</Label>
            {FIRST_AID_ITEMS.map(item => (
              <div key={item.key} className="flex items-center gap-2">
                <input type="checkbox" id={item.key} checked={!!form[item.key]} onChange={e => setForm(f => ({ ...f, [item.key]: e.target.checked }))} className="rounded" />
                <label htmlFor={item.key} className={`text-sm cursor-pointer ${!form[item.key] ? "text-destructive font-medium" : ""}`}>{item.label}</label>
                {!form[item.key] && <XCircle className="w-3.5 h-3.5 text-destructive ml-auto" />}
              </div>
            ))}
          </div>
          <div><Label>Defects / actions required <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.defectsFound} onChange={e => setForm(f => ({ ...f, defectsFound: e.target.value }))} /></div>
          <div><Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : check ? "Save changes" : "Save check"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IncidentDialog({ open, onClose, incident, sites, onSaved }: { open: boolean; onClose: () => void; incident?: Incident | null; sites: { id: number; name: string }[]; onSaved: () => void; }) {
  const { toast } = useToast();
  const blank = { siteId: "", incidentDate: todayIso(), incidentTime: "", incidentType: "near_miss", severity: "low", personsInvolved: "", description: "", actionTaken: "", reportedTo: "", reportedDate: "", outcome: "", notes: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const reset = () => setForm(incident ? { siteId: incident.siteId ? String(incident.siteId) : "", incidentDate: incident.incidentDate, incidentTime: incident.incidentTime ?? "", incidentType: incident.incidentType, severity: incident.severity, personsInvolved: incident.personsInvolved ?? "", description: incident.description, actionTaken: incident.actionTaken ?? "", reportedTo: incident.reportedTo ?? "", reportedDate: incident.reportedDate ?? "", outcome: incident.outcome ?? "", notes: incident.notes ?? "" } : blank);
  const handleSave = async () => {
    if (!form.incidentDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    if (!form.description.trim()) { toast({ title: "Description is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { siteId: form.siteId ? parseInt(form.siteId, 10) : null, incidentDate: form.incidentDate, incidentTime: form.incidentTime || null, incidentType: form.incidentType, severity: form.severity, personsInvolved: form.personsInvolved.trim() || null, description: form.description.trim(), actionTaken: form.actionTaken.trim() || null, reportedTo: form.reportedTo.trim() || null, reportedDate: form.reportedDate || null, outcome: form.outcome.trim() || null, notes: form.notes.trim() || null };
      if (incident) await apiFetch(`/swim-track/incidents/${incident.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await apiFetch("/swim-track/incidents", { method: "POST", body: JSON.stringify(body) });
      toast({ title: incident ? "Incident updated" : "Incident logged" });
      onSaved(); onClose();
    } catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader><DialogTitle>{incident ? "Edit Incident" : "Log Incident / Near Miss"}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Incident date *</Label><Input type="date" className="mt-1 rounded-sm" value={form.incidentDate} onChange={e => setForm(f => ({ ...f, incidentDate: e.target.value }))} /></div>
            <div><Label>Time <span className="text-muted-foreground text-xs">optional</span></Label><Input type="time" className="mt-1 rounded-sm" value={form.incidentTime} onChange={e => setForm(f => ({ ...f, incidentTime: e.target.value }))} /></div>
            <div><Label>Type</Label><Select value={form.incidentType} onValueChange={v => setForm(f => ({ ...f, incidentType: v }))}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(INCIDENT_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Severity</Label><Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v }))}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(SEVERITY_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></div>
            {sites.length > 0 && (<div className="col-span-2"><Label>Site <span className="text-muted-foreground text-xs">optional</span></Label><Select value={form.siteId || "_none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "_none" ? "" : v }))}><SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger><SelectContent><SelectItem value="_none">— All sites —</SelectItem>{sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent></Select></div>)}
          </div>
          <div><Label>Persons involved <span className="text-muted-foreground text-xs">do not record names of members of public</span></Label><Input className="mt-1 rounded-sm" value={form.personsInvolved} onChange={e => setForm(f => ({ ...f, personsInvolved: e.target.value }))} placeholder="e.g. 1 adult male bather, 2 staff members" /></div>
          <div><Label>Description *</Label><Textarea className="mt-1 rounded-sm" rows={3} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Describe what happened…" /></div>
          <div><Label>Action taken <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.actionTaken} onChange={e => setForm(f => ({ ...f, actionTaken: e.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Reported to <span className="text-muted-foreground text-xs">optional</span></Label><Input className="mt-1 rounded-sm" value={form.reportedTo} onChange={e => setForm(f => ({ ...f, reportedTo: e.target.value }))} /></div>
            <div><Label>Date reported <span className="text-muted-foreground text-xs">optional</span></Label><Input type="date" className="mt-1 rounded-sm" value={form.reportedDate} onChange={e => setForm(f => ({ ...f, reportedDate: e.target.value }))} /></div>
          </div>
          <div><Label>Outcome <span className="text-muted-foreground text-xs">leave blank if still open</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.outcome} onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))} /></div>
          <div><Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label><Textarea className="mt-1 rounded-sm" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className={form.severity === "critical" ? "bg-destructive hover:bg-destructive/90" : ""}>{saving ? "Saving…" : incident ? "Save changes" : "Log incident"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

type Tab = "water-quality" | "sessions" | "surveillance" | "first-aid" | "incidents";

export default function AquaTrackPage() {
  const { hasService, activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Gate: aquatrack covers pooltrack + swimtrack legacy keys (merged on backend)
  const hasAqua = hasService("aquatrack") || hasService("pooltrack") || hasService("swimtrack");

  const [activeTab, setActiveTab] = useState<Tab>("water-quality");
  const [search, setSearch] = useState("");

  // ── Pool Quality state ──────────────────────────────────────────────────────
  const [filterType, setFilterType] = useState("");
  const [filterSite, setFilterSite] = useState<number | undefined>();
  const [poolRecordOpen, setPoolRecordOpen] = useState(false);
  const [quickCheckType, setQuickCheckType] = useState<string | undefined>();
  const [poolChecks, setPoolChecks] = useState<PoolCheck[]>([]);
  const [poolStatus, setPoolStatus] = useState<any[]>([]);
  const poolRequestSequence = useRef(0);
  const [poolLoading, setPoolLoading] = useState(true);

  const { data: sites = [] } = useListSites({ query: { enabled: hasAqua, queryKey: getListSitesQueryKey() } }) as any;

  const fetchPoolData = async () => {
    const sequence = ++poolRequestSequence.current;
    setPoolLoading(true);
    setPoolStatus([]);
    try {
      const params = new URLSearchParams();
      if (filterType) params.set("checkType", filterType);
      if (filterSite) params.set("siteId", String(filterSite));
      const [checksData, statusData] = await Promise.all([
        apiFetch<PoolCheck[]>(`/pool-track?${params}`),
        filterSite ? apiFetch<any[]>(`/pool-track/status?siteId=${filterSite}`) : Promise.resolve([]),
      ]);
      if (sequence !== poolRequestSequence.current) return;
      setPoolChecks(checksData);
      setPoolStatus(statusData);
    } catch { /* handled per-check */ }
    finally { if (sequence === poolRequestSequence.current) setPoolLoading(false); }
  };

  useEffect(() => { if (hasAqua && activeTab === "water-quality") void fetchPoolData(); }, [hasAqua, activeTab, filterType, filterSite, activeClientId]);

  const handlePoolDelete = async (id: number) => {
    if (!confirm("Delete this check record?")) return;
    try { await apiFetch(`/pool-track/${id}`, { method: "DELETE" }); toast({ title: "Record deleted" }); fetchPoolData(); }
    catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }); }
  };

  // ── Swim Safety state ───────────────────────────────────────────────────────
  const [sessionDialog, setSessionDialog] = useState(false);
  const [editSession, setEditSession] = useState<SwimSession | null>(null);
  const [surveillanceDialog, setSurveillanceDialog] = useState(false);
  const [editSurveillance, setEditSurveillance] = useState<SurveillanceCheck | null>(null);
  const [firstAidDialog, setFirstAidDialog] = useState(false);
  const [editFirstAid, setEditFirstAid] = useState<FirstAidCheck | null>(null);
  const [incidentDialog, setIncidentDialog] = useState(false);
  const [editIncident, setEditIncident] = useState<Incident | null>(null);
  const [deleteId, setDeleteId] = useState<{ type: string; id: number } | null>(null);

  const { data: swimStatus, refetch: refetchStatus } = useQuery({ queryKey: ["swim-status"], queryFn: () => apiFetch<SwimStatus>("/swim-track/status"), enabled: hasAqua, refetchInterval: 60_000 });
  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({ queryKey: ["swim-sessions"], queryFn: () => apiFetch<SwimSession[]>("/swim-track/sessions"), enabled: hasAqua && activeTab === "sessions" });
  const { data: surveillance = [], isLoading: surveillanceLoading } = useQuery({ queryKey: ["swim-surveillance"], queryFn: () => apiFetch<SurveillanceCheck[]>("/swim-track/surveillance"), enabled: hasAqua && activeTab === "surveillance" });
  const { data: firstAidChecks = [], isLoading: firstAidLoading } = useQuery({ queryKey: ["swim-first-aid"], queryFn: () => apiFetch<FirstAidCheck[]>("/swim-track/first-aid"), enabled: hasAqua && activeTab === "first-aid" });
  const { data: incidents = [], isLoading: incidentsLoading } = useQuery({ queryKey: ["swim-incidents"], queryFn: () => apiFetch<Incident[]>("/swim-track/incidents"), enabled: hasAqua && activeTab === "incidents" });

  const invalidateSwim = () => { ["swim-sessions", "swim-surveillance", "swim-first-aid", "swim-incidents", "swim-status"].forEach(k => queryClient.invalidateQueries({ queryKey: [k] })); };

  const handleSwimDelete = async () => {
    if (!deleteId) return;
    try { await apiFetch(`/swim-track/${deleteId.type}/${deleteId.id}`, { method: "DELETE" }); toast({ title: "Record deleted" }); invalidateSwim(); }
    catch (err: any) { toast({ title: "Failed to delete", description: err.message, variant: "destructive" }); }
    finally { setDeleteId(null); }
  };

  const q = search.toLowerCase();
  const filteredSessions = useMemo(() => sessions.filter(s => (s.lifeguardName ?? "").toLowerCase().includes(q) || (s.siteName ?? "").toLowerCase().includes(q) || SESSION_TYPE_LABELS[s.sessionType]?.toLowerCase().includes(q)), [sessions, q]);
  const filteredSurveillance = useMemo(() => surveillance.filter(s => (s.checkedBy ?? "").toLowerCase().includes(q) || (s.siteName ?? "").toLowerCase().includes(q)), [surveillance, q]);
  const filteredFirstAid = useMemo(() => firstAidChecks.filter(f => (f.checkedBy ?? "").toLowerCase().includes(q) || (f.siteName ?? "").toLowerCase().includes(q)), [firstAidChecks, q]);
  const filteredIncidents = useMemo(() => incidents.filter(i => i.description.toLowerCase().includes(q) || (i.siteName ?? "").toLowerCase().includes(q) || INCIDENT_TYPE_LABELS[i.incidentType]?.toLowerCase().includes(q)), [incidents, q]);

  const firstAidOverdue = swimStatus?.lastFirstAidCheck ? new Date(swimStatus.lastFirstAidCheck) < new Date(Date.now() - 30 * 86400000) : true;

  const overduePool = poolStatus.filter(s => s.status === "overdue");
  const dueSoonPool = poolStatus.filter(s => s.status === "due_soon");

  // ── Locked screen ───────────────────────────────────────────────────────────
  if (!hasAqua) {
    return (
      <AppLayout title="AquaTrack — Pool & Swim Compliance">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium mb-2">AquaTrack</h2>
                <p className="text-muted-foreground mb-1">Pool and swim records — water testing, lifeguard sessions, surveillance, first-aid readiness and incident evidence to support your site operating procedures.</p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin
                  ? <Link href="/settings"><Button size="lg" className="w-full sm:w-auto">Enable AquaTrack</Button></Link>
                  : <p className="text-sm text-muted-foreground">Ask your account admin to enable this service.</p>
                }
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // ── Tab definitions ─────────────────────────────────────────────────────────
  const TABS: { key: Tab; label: string; icon: any; badge?: number }[] = [
    { key: "water-quality",  label: "Water Quality",  icon: Droplets,    badge: overduePool.length || undefined },
    { key: "sessions",       label: "Sessions",       icon: Waves,       badge: swimStatus?.sessionsToday || undefined },
    { key: "surveillance",   label: "Surveillance",   icon: Activity,    badge: swimStatus?.surveillanceToday || undefined },
    { key: "first-aid",      label: "First Aid",      icon: HeartPulse,  badge: swimStatus?.firstAidActionRequired || undefined },
    { key: "incidents",      label: "Incidents",      icon: ShieldAlert, badge: swimStatus?.openIncidents || undefined },
  ];

  return (
    <AppLayout title="AquaTrack — Pool & Swim Compliance">
      <div className="space-y-5">

        {/* ── Page header ──────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <Anchor className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-display font-semibold">AquaTrack</h1>
              <p className="text-sm text-muted-foreground">Pool water quality · Sessions · Surveillance · Safety</p>
            </div>
          </div>
          {/* Per-tab action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            {activeTab === "water-quality" && (
              <>
                {canAdmin && <PoolConfigDialog onChanged={fetchPoolData} />}
                <PoolRecordDialog siteId={filterSite} onSaved={fetchPoolData} open={poolRecordOpen} onOpenChange={setPoolRecordOpen} defaultCheckType={quickCheckType} />
              </>
            )}
            {activeTab === "sessions" && (
              <Button size="sm" className="rounded-sm gap-1.5" onClick={() => { setEditSession(null); setSessionDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log session
              </Button>
            )}
            {activeTab === "surveillance" && (
              <Button size="sm" className="rounded-sm gap-1.5" onClick={() => { setEditSurveillance(null); setSurveillanceDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Log check
              </Button>
            )}
            {activeTab === "first-aid" && (
              <Button size="sm" className="rounded-sm gap-1.5" onClick={() => { setEditFirstAid(null); setFirstAidDialog(true); }}>
                <Plus className="w-3.5 h-3.5" /> Check equipment
              </Button>
            )}
            {activeTab === "incidents" && (
              <Button size="sm" variant="destructive" className="rounded-sm gap-1.5" onClick={() => { setEditIncident(null); setIncidentDialog(true); }}>
                <ShieldAlert className="w-3.5 h-3.5" /> Log incident
              </Button>
            )}
          </div>
        </div>

        {/* ── Summary strip ────────────────────────────────────────────────── */}
        {swimStatus && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Sessions today", value: String(swimStatus.sessionsToday), sub: swimStatus.poolsClosedToday > 0 ? `${swimStatus.poolsClosedToday} closed` : "All open", icon: Waves, cls: "text-primary" },
              { label: "Surveillance checks", value: String(swimStatus.surveillanceToday), sub: "today", icon: Activity, cls: "text-blue-500" },
              { label: "First-aid checks", value: String(swimStatus.firstAidLast30d), sub: firstAidOverdue ? "⚠ overdue (30d)" : "last 30 days", icon: HeartPulse, cls: firstAidOverdue ? "text-destructive" : "text-green-500" },
              { label: "Open incidents", value: String(swimStatus.openIncidents), sub: "no outcome recorded", icon: ShieldAlert, cls: swimStatus.openIncidents > 0 ? "text-destructive" : "text-muted-foreground" },
            ].map(card => (
              <div key={card.label} className="border rounded-sm p-3 space-y-1 bg-card">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><card.icon className={`w-3.5 h-3.5 ${card.cls}`} />{card.label}</div>
                <div className="text-2xl font-semibold tabular-nums">{card.value}</div>
                <div className="text-xs text-muted-foreground">{card.sub}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Tab bar ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex gap-1 border-b flex-1 overflow-x-auto">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 whitespace-nowrap transition-colors ${activeTab === t.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span className="ml-0.5 text-xs bg-primary/10 text-primary rounded-full px-1.5 py-0.5 tabular-nums">{t.badge}</span>
                )}
              </button>
            ))}
          </div>
          {activeTab !== "water-quality" && (
            <div className="relative shrink-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input className="pl-7 h-8 text-sm rounded-sm w-40" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            WATER QUALITY TAB
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "water-quality" && (
          <div className="space-y-5">
            {(sites as any[]).length > 0 && (
              <div className="flex items-center gap-2"><Label>Monitoring site</Label>
                <Select value={filterSite ? String(filterSite) : "all"} onValueChange={value => setFilterSite(value === "all" ? undefined : Number(value))}>
                  <SelectTrigger className="w-56"><SelectValue placeholder="Select a site" /></SelectTrigger>
                  <SelectContent><SelectItem value="all">Select a site</SelectItem>
                    {(sites as any[]).map((site: any) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <WaterMonitoringPlan module="pool-track" siteId={filterSite} checks={CHECK_TYPE_LABELS} unit="hours"
              canManage={canAdmin} onChanged={fetchPoolData} />
            {/* Status cards */}
            {filterSite && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {poolLoading
                ? Array.from({ length: 4 }).map((_, i) => <Card key={i} className="animate-pulse"><CardContent className="p-4 h-20" /></Card>)
                : poolStatus.map(item => (
                    <Card key={item.checkType}
                      className={cn("border-l-4 transition-all hover:shadow-md cursor-pointer group",
                        item.status === "plan_required" ? "border-l-slate-400 bg-slate-50/50" :
                        item.status === "overdue"  ? "border-l-rose-500 bg-rose-50/50" :
                        item.status === "due_soon" ? "border-l-amber-500 bg-amber-50/50" :
                        item.status === "never"    ? "border-l-slate-400 bg-slate-50/50" :
                                                     "border-l-emerald-500 bg-emerald-50/50"
                      )}
                      onClick={() => { setQuickCheckType(item.checkType); setPoolRecordOpen(true); }}>
                      <CardHeader className="pb-1 pt-3 px-4"><CardTitle className="text-xs font-medium leading-snug">{CHECK_TYPE_LABELS[item.checkType] ?? item.checkType}</CardTitle></CardHeader>
                      <CardContent className="pb-3 px-4 space-y-0.5">
                        <div className="text-xs text-muted-foreground">
                          {item.status === "plan_required" ? "Plan required" : `Every ${item.frequencyHours} hours`}
                        </div>
                        {item.dueDate && <div className="text-xs text-muted-foreground">Next: {new Date(item.dueDate).toLocaleString("en-GB")}</div>}
                        {item.lastDate && <div className="text-xs text-muted-foreground">Last: {format(new Date(item.lastDate), "dd/MM/yy")}{item.lastTime && ` ${item.lastTime}`}</div>}
                        {item.status === "never" && <div className="text-xs text-muted-foreground italic">Not recorded yet</div>}
                        {item.result && (
                          <Badge variant="outline" className={cn("text-xs mt-0.5",
                            item.result === "pass" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                            "bg-rose-50 text-rose-700 border-rose-200"
                          )}>
                            {item.result === "pass" ? "Pass" : "Fail"}
                          </Badge>
                        )}
                        <div className="text-[11px] text-primary opacity-0 group-hover:opacity-100 transition-opacity pt-0.5 font-medium">+ Record check →</div>
                      </CardContent>
                    </Card>
                  ))
              }
            </div>}

            {/* Alert banners */}
            {(overduePool.length > 0 || dueSoonPool.length > 0) && (
              <div className="space-y-2">
                {overduePool.length > 0 && (
                  <div className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                    <div className="font-semibold mb-1 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Overdue checks</div>
                    <div className="text-xs">{overduePool.map(s => CHECK_TYPE_LABELS[s.checkType] ?? s.checkType).join(", ")}</div>
                  </div>
                )}
                {dueSoonPool.length > 0 && (
                  <div className="rounded-sm border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    <div className="font-semibold mb-1 flex items-center gap-1.5"><Clock className="w-4 h-4" /> Due soon</div>
                    <div className="text-xs">{dueSoonPool.map(s => CHECK_TYPE_LABELS[s.checkType] ?? s.checkType).join(", ")}</div>
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
                  {(sites as any[]).length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Site</Label>
                      <Select value={filterSite ? String(filterSite) : "all"} onValueChange={v => setFilterSite(v === "all" ? undefined : Number(v))}>
                        <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All sites</SelectItem>
                          {(sites as any[]).map((s: any) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Check log */}
            <Card>
              <CardHeader className="border-b border-border/50 pb-4"><CardTitle className="font-display">Water Quality Log</CardTitle></CardHeader>
              <CardContent className="p-0">
                {poolLoading ? (
                  <div className="p-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
                ) : poolChecks.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground">
                    <Droplets className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">No water quality checks recorded yet.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {poolChecks.map(check => {
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
                                  check.result === "pass" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                  "bg-rose-50 text-rose-700 border-rose-200"
                                )}>
                                  {check.result === "pass" ? "Pass" : "Fail"}
                                </Badge>
                                {!check.pool_open && <Badge variant="outline" className="text-xs bg-slate-50 text-slate-600">Pool closed</Badge>}
                                {check.site_name && <Badge variant="outline" className="text-xs">{check.site_name}</Badge>}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                <span className="font-medium">Date:</span> {format(new Date(check.check_date), "dd/MM/yyyy")}{check.check_time && ` at ${check.check_time}`}
                                {check.performed_by && <> · <span className="font-medium">By:</span> {check.performed_by}</>}
                              </div>
                              {(ph !== null || free !== null || combined !== null || check.turbidity) && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  <ChemBadge label="pH" value={check.ph_level} unit="" level={pHLevel(ph)} />
                                  <ChemBadge label="FCl" value={check.free_chlorine} unit=" mg/L" level={freeCl(free)} />
                                  <ChemBadge label="CCl" value={check.combined_chlorine} unit=" mg/L" level={combCl(combined)} />
                                  {check.water_temp_c && <ChemBadge label="Temp" value={check.water_temp_c} unit="°C" level={waterTemp(parseFloat(check.water_temp_c))} />}
                                  {check.turbidity && check.turbidity !== "clear" && (
                                    <Badge variant="outline" className={cn("text-xs", check.turbidity === "cloudy" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-amber-50 text-amber-700 border-amber-200")}>
                                      {check.turbidity === "slightly_hazy" ? "Slightly hazy" : check.turbidity === "hazy" ? "Hazy" : "Cloudy"}
                                    </Badge>
                                  )}
                                </div>
                              )}
                              {check.actions_taken && <div className="text-xs text-muted-foreground"><span className="font-medium">Actions:</span> {check.actions_taken}</div>}
                              {check.notes && <div className="text-xs text-muted-foreground"><span className="font-medium">Notes:</span> {check.notes}</div>}
                              <CheckPhotoUploader entityType="pool_check" entityId={check.id} compact />
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <PoolRecordDialog existing={check} onSaved={fetchPoolData} />
                              <Button variant="ghost" size="sm" onClick={() => handlePoolDelete(check.id)} className="text-destructive hover:bg-destructive/10"><Trash2 className="w-3.5 h-3.5" /></Button>
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
        )}

        {/* ══════════════════════════════════════════════════════════════════
            SESSIONS TAB
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "sessions" && (
          <>
            {sessionsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading sessions…</div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Waves className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No sessions logged yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5" onClick={() => { setEditSession(null); setSessionDialog(true); }}><Plus className="w-3.5 h-3.5" /> Log first session</Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left font-medium py-2 pr-4">Date</th>
                    <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Type</th>
                    <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                    <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Lifeguard</th>
                    <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Times</th>
                    <th className="text-right font-medium py-2 pr-4 hidden md:table-cell">Peak bathers</th>
                    <th className="text-left font-medium py-2 pr-4">Pre-session</th>
                    <th className="text-left font-medium py-2 pr-4">Status</th>
                    <th className="w-14" /><th className="w-16" />
                  </tr></thead>
                  <tbody>
                    {filteredSessions.map(s => (
                      <tr key={s.id} className={`border-b last:border-0 ${s.poolClosed ? "bg-red-50 dark:bg-red-900/10" : ""}`}>
                        <td className="py-2 pr-4 tabular-nums font-medium">{s.sessionDate}</td>
                        <td className="py-2 pr-4 text-muted-foreground hidden sm:table-cell">{SESSION_TYPE_LABELS[s.sessionType] ?? s.sessionType}</td>
                        <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{s.siteName ?? "—"}</td>
                        <td className="py-2 pr-4 hidden sm:table-cell">{s.lifeguardName ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4 text-muted-foreground tabular-nums hidden lg:table-cell">{s.openTime ?? "—"}{s.closeTime ? ` – ${s.closeTime}` : ""}</td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden md:table-cell">{s.batherCountPeak != null ? <>{s.batherCountPeak}{s.maxBathers ? <span className="text-muted-foreground">/{s.maxBathers}</span> : null}</> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4"><span className={`text-xs px-1.5 py-0.5 rounded-full ${s.preSessionResult === "pass" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{s.preSessionResult === "pass" ? "Pass" : "Fail"}</span></td>
                        <td className="py-2 pr-4">{s.poolClosed ? <span className="text-xs text-destructive font-medium flex items-center gap-1"><XCircle className="w-3 h-3" />Closed</span> : <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Open</span>}</td>
                        <td className="py-2 px-2"><CheckPhotoUploader entityType="swim_session" entityId={s.id} compact /></td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditSession(s); setSessionDialog(true); }}><Pencil className="w-3.5 h-3.5" /></Button>
                          {canAdmin && <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId({ type: "sessions", id: s.id })}><Trash2 className="w-3.5 h-3.5" /></Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            SURVEILLANCE TAB
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "surveillance" && (
          <>
            <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2">
              <Activity className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>RLSS UK recommends lifeguards perform a full pool scan and log a surveillance check every 15–20 minutes.</span>
            </div>
            {surveillanceLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading checks…</div>
            ) : filteredSurveillance.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <Activity className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No surveillance checks recorded yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5" onClick={() => { setEditSurveillance(null); setSurveillanceDialog(true); }}><Plus className="w-3.5 h-3.5" /> Log first check</Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left font-medium py-2 pr-4">Date</th><th className="text-left font-medium py-2 pr-4">Time</th>
                    <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                    <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Checked by</th>
                    <th className="text-right font-medium py-2 pr-4 hidden sm:table-cell">Bathers</th>
                    <th className="text-left font-medium py-2 pr-4">Scan done</th>
                    <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Observations</th>
                    <th className="w-16" />
                  </tr></thead>
                  <tbody>
                    {filteredSurveillance.map(c => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 tabular-nums">{c.checkDate}</td><td className="py-2 pr-4 tabular-nums">{c.checkTime ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{c.siteName ?? "—"}</td>
                        <td className="py-2 pr-4 hidden sm:table-cell">{c.checkedBy ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">{c.batherCount != null ? c.batherCount : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4">{c.scanCompleted ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-destructive" />}</td>
                        <td className="py-2 pr-4 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">{c.observations ?? "—"}</td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditSurveillance(c); setSurveillanceDialog(true); }}><Pencil className="w-3.5 h-3.5" /></Button>
                          {canAdmin && <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId({ type: "surveillance", id: c.id })}><Trash2 className="w-3.5 h-3.5" /></Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            FIRST AID TAB
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "first-aid" && (
          <>
            <div className="text-xs text-muted-foreground bg-muted/40 rounded-sm px-3 py-2 flex items-start gap-2">
              <HeartPulse className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>RLSS UK and HSG179 recommend checking all rescue and first-aid equipment at least monthly and before each pool session.</span>
            </div>
            {firstAidOverdue && (
              <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-sm px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>No first-aid equipment check in the last 30 days — a check is overdue.</span>
                <Button size="sm" variant="outline" className="ml-auto rounded-sm h-7 border-amber-300 text-amber-800 hover:bg-amber-100" onClick={() => { setEditFirstAid(null); setFirstAidDialog(true); }}>Check now</Button>
              </div>
            )}
            {firstAidLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading checks…</div>
            ) : filteredFirstAid.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <HeartPulse className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No first-aid checks recorded yet.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5" onClick={() => { setEditFirstAid(null); setFirstAidDialog(true); }}><Plus className="w-3.5 h-3.5" /> First check</Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left font-medium py-2 pr-4">Date</th>
                    <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                    <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Checked by</th>
                    {FIRST_AID_ITEMS.map(i => <th key={i.key} className="text-center font-medium py-2 px-1 hidden lg:table-cell text-xs max-w-[60px]">{i.label.split(" ")[0]}</th>)}
                    <th className="text-left font-medium py-2 pr-4">Result</th><th className="w-16" />
                  </tr></thead>
                  <tbody>
                    {filteredFirstAid.map(f => {
                      const items = FIRST_AID_ITEMS.map(i => ({ ...i, ok: !!(f as any)[i.key] }));
                      const failCount = items.filter(i => !i.ok).length;
                      return (
                        <tr key={f.id} className={`border-b last:border-0 ${failCount > 0 ? "bg-amber-50" : ""}`}>
                          <td className="py-2 pr-4 tabular-nums">{f.checkDate}</td>
                          <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{f.siteName ?? "—"}</td>
                          <td className="py-2 pr-4 hidden sm:table-cell">{f.checkedBy ?? <span className="text-muted-foreground">—</span>}</td>
                          {items.map(i => <td key={i.key} className="py-2 px-1 text-center hidden lg:table-cell">{i.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mx-auto" /> : <XCircle className="w-3.5 h-3.5 text-destructive mx-auto" />}</td>)}
                          <td className="py-2 pr-4">{f.result === "pass" ? <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full flex items-center gap-1 w-fit"><CheckCircle2 className="w-3 h-3" /> Pass</span> : <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full flex items-center gap-1 w-fit"><XCircle className="w-3 h-3" /> Fail</span>}</td>
                          <td className="py-2 text-right">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditFirstAid(f); setFirstAidDialog(true); }}><Pencil className="w-3.5 h-3.5" /></Button>
                            {canAdmin && <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId({ type: "first-aid", id: f.id })}><Trash2 className="w-3.5 h-3.5" /></Button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            INCIDENTS TAB
        ══════════════════════════════════════════════════════════════════ */}
        {activeTab === "incidents" && (
          <>
            {incidentsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading incidents…</div>
            ) : filteredIncidents.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-sm">
                <ShieldAlert className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No incidents recorded.</p>
                <p className="text-xs text-muted-foreground mt-1">Record near misses and incidents as they occur.</p>
                <Button size="sm" variant="outline" className="mt-3 rounded-sm gap-1.5" onClick={() => { setEditIncident(null); setIncidentDialog(true); }}><Plus className="w-3.5 h-3.5" /> Log incident</Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left font-medium py-2 pr-4">Date</th>
                    <th className="text-left font-medium py-2 pr-4 hidden sm:table-cell">Type</th>
                    <th className="text-left font-medium py-2 pr-4">Severity</th>
                    <th className="text-left font-medium py-2 pr-4 hidden md:table-cell">Site</th>
                    <th className="text-left font-medium py-2 pr-4">Description</th>
                    <th className="text-left font-medium py-2 pr-4 hidden lg:table-cell">Action taken</th>
                    <th className="text-left font-medium py-2 pr-4">Outcome</th>
                    <th className="w-14" /><th className="w-16" />
                  </tr></thead>
                  <tbody>
                    {filteredIncidents.map(i => (
                      <tr key={i.id} className={`border-b last:border-0 ${i.severity === "critical" || i.severity === "high" ? "bg-red-50" : ""}`}>
                        <td className="py-2 pr-4 tabular-nums whitespace-nowrap">{i.incidentDate}{i.incidentTime && <span className="text-muted-foreground text-xs ml-1">{i.incidentTime}</span>}</td>
                        <td className="py-2 pr-4 text-muted-foreground hidden sm:table-cell">{INCIDENT_TYPE_LABELS[i.incidentType] ?? i.incidentType}</td>
                        <td className="py-2 pr-4"><span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${i.severity === "critical" ? "bg-red-100 text-red-700" : i.severity === "high" ? "bg-orange-100 text-orange-700" : i.severity === "medium" ? "bg-yellow-100 text-yellow-700" : "bg-muted text-muted-foreground"}`}>{SEVERITY_LABELS[i.severity] ?? i.severity}</span></td>
                        <td className="py-2 pr-4 text-muted-foreground hidden md:table-cell">{i.siteName ?? "—"}</td>
                        <td className="py-2 pr-4 max-w-xs truncate">{i.description}</td>
                        <td className="py-2 pr-4 text-muted-foreground text-xs max-w-[160px] truncate hidden lg:table-cell">{i.actionTaken ?? "—"}</td>
                        <td className="py-2 pr-4">{i.outcome ? <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">Resolved</span> : <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Open</span>}</td>
                        <td className="py-2 px-2"><CheckPhotoUploader entityType="swim_incident" entityId={i.id} compact /></td>
                        <td className="py-2 text-right">
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditIncident(i); setIncidentDialog(true); }}><Pencil className="w-3.5 h-3.5" /></Button>
                          {canAdmin && <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId({ type: "incidents", id: i.id })}><Trash2 className="w-3.5 h-3.5" /></Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

      </div>

      {/* ── Swim dialogs ─────────────────────────────────────────────────────── */}
      <SessionDialog open={sessionDialog} onClose={() => { setSessionDialog(false); setEditSession(null); }} session={editSession} sites={sites as any[]} onSaved={invalidateSwim} />
      <SurveillanceDialog open={surveillanceDialog} onClose={() => { setSurveillanceDialog(false); setEditSurveillance(null); }} check={editSurveillance} sites={sites as any[]} onSaved={invalidateSwim} />
      <FirstAidDialog open={firstAidDialog} onClose={() => { setFirstAidDialog(false); setEditFirstAid(null); }} check={editFirstAid} sites={sites as any[]} onSaved={invalidateSwim} />
      <IncidentDialog open={incidentDialog} onClose={() => { setIncidentDialog(false); setEditIncident(null); }} incident={editIncident} sites={sites as any[]} onSaved={invalidateSwim} />

      <AlertDialog open={!!deleteId} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader><AlertDialogTitle>Delete this record?</AlertDialogTitle><AlertDialogDescription>This action cannot be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSwimDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
