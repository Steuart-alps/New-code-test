import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import { apiFetch } from "@/lib/api";
import {
  useListLegionellaChecks,
  getListLegionellaChecksQueryKey,
  useGetLegionellaStatus,
  getGetLegionellaStatusQueryKey,
  useCreateLegionellaCheck,
  useUpdateLegionellaCheck,
  useDeleteLegionellaCheck,
  useListSites,
  getListSitesQueryKey,
  LegionellaCheckType,
  LegionellaCheck,
  LegionellaStatus as LegionellaStatusType,
  CreateLegionellaCheckRequest,
  useGetLegionellaConfig,
  getGetLegionellaConfigQueryKey,
  useUpdateLegionellaConfig,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Droplets, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX, Filter, Pencil, Trash2, Lock, ThermometerSun, Settings, X, XCircle, ShieldAlert } from "lucide-react";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { StaffPerformerSelect } from "@/components/staff-performer-select";

// HSG274 Part 2 Table 2.1
const CHECK_TYPE_LABELS: Record<LegionellaCheckType, string> = {
  calorifier_temp:       "Calorifier flow / return temperature",
  hot_sentinel_temp:     "Hot water — sentinel outlet temperature",
  hot_nonsent_temp:      "Hot water — representative outlet temperature",
  cold_tank_temp:        "Cold water storage temperature",
  cold_sentinel_temp:    "Cold water — sentinel outlet temperature",
  cold_nonsent_temp:     "Cold water — representative outlet temperature",
  cold_tank_inspection:  "Cold water storage tank — visual inspection",
  cold_tank_clean:       "Cold water storage tank — clean & disinfect",
  calorifier_inspection: "Calorifier — internal inspection",
  calorifier_clean:      "Calorifier — clean & disinfect",
  shower_clean:          "Shower head / hose — descale & disinfect",
  tmv_service:           "Thermostatic mixing valve (TMV) — service & verify",
  outlet_flush:          "Little-used outlet — 5-minute flush",
};

// Legacy labels for records created before the HSG274 update
const LEGACY_LABELS: Record<string, string> = {
  cold_water_temp:  "Cold water temperature check (legacy)",
  hot_water_temp:   "Hot water temperature check (legacy)",
  sentinel_flush:   "Sentinel outlet flush (legacy)",
  tank_inspection:  "Cold water storage tank inspection (legacy)",
  risk_assessment:  "Legionella risk assessment review (legacy)",
};

function checkTypeLabel(t: string): string {
  return (CHECK_TYPE_LABELS as Record<string, string>)[t] ?? LEGACY_LABELS[t] ?? t;
}

const CHECK_TYPE_HINTS: Record<LegionellaCheckType, string> = {
  calorifier_temp:       "HSG274 benchmark: calorifier temperature monitoring — use only where it is in the site written scheme.",
  hot_sentinel_temp:     "HSG274 benchmark: sentinel hot-water monitoring — set outlets and frequency in the written scheme.",
  hot_nonsent_temp:      "HSG274 benchmark: representative hot-outlet monitoring — set sampling and frequency from the risk assessment.",
  cold_tank_temp:        "HSG274 benchmark: cold-water storage monitoring — set controls in the written scheme.",
  cold_sentinel_temp:    "HSG274 benchmark: sentinel cold-water monitoring — set outlets and frequency in the written scheme.",
  cold_nonsent_temp:     "HSG274 benchmark: representative cold-outlet monitoring — set sampling and frequency from the risk assessment.",
  cold_tank_inspection:  "HSG274 benchmark: inspect tank condition — use the risk-assessed written scheme.",
  cold_tank_clean:       "HSG274 benchmark: cleaning and disinfection — arrange when justified by the system risk assessment.",
  calorifier_inspection: "HSG274 benchmark: inspect calorifier condition — set the scope and interval with a competent person.",
  calorifier_clean:      "HSG274 benchmark: clean and recommission a calorifier — arrange when justified by the risk assessment.",
  shower_clean:          "HSG274 benchmark: shower-head and hose cleaning — set method and frequency in the written scheme.",
  tmv_service:           "HSG274 benchmark: service and test TMVs — set the interval with competent advice.",
  outlet_flush:          "L8/HSG274 benchmark: manage infrequently used outlets in line with the written scheme.",
};

const TEMPERATURE_TYPES = new Set<LegionellaCheckType>([
  "calorifier_temp", "hot_sentinel_temp", "hot_nonsent_temp",
  "cold_tank_temp", "cold_sentinel_temp", "cold_nonsent_temp",
]);

const TEMP_PLACEHOLDER: Partial<Record<LegionellaCheckType, string>> = {
  calorifier_temp:    "e.g. 62.0  (target ≥60°C)",
  hot_sentinel_temp:  "e.g. 52.0  (target ≥50°C)",
  hot_nonsent_temp:   "e.g. 51.5  (target ≥50°C)",
  cold_tank_temp:     "e.g. 16.0  (target ≤20°C)",
  cold_sentinel_temp: "e.g. 17.5  (target ≤20°C)",
  cold_nonsent_temp:  "e.g. 18.0  (target ≤20°C)",
};

function ResultBadge({ result }: { result: string }) {
  if (result === "pass") {
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
        <CheckCircle2 className="w-3 h-3 mr-1" /> Pass
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
      <AlertTriangle className="w-3 h-3 mr-1" /> Fail
    </Badge>
  );
}

function StatusBadge({ status, lastResult }: { status: "ok" | "due_soon" | "overdue" | "never"; lastResult?: string | null }) {
  if (lastResult === "fail")
    return (
      <Badge variant="outline" className="bg-red-100 text-red-800 border-red-300">
        <XCircle className="w-3 h-3 mr-1" /> Failed
      </Badge>
    );
  if (lastResult === "action_required")
    return (
      <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-300">
        <ShieldAlert className="w-3 h-3 mr-1" /> Action needed
      </Badge>
    );
  if (status === "ok")
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
        <CheckCircle2 className="w-3 h-3 mr-1" /> OK
      </Badge>
    );
  if (status === "due_soon")
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
        <Clock className="w-3 h-3 mr-1" /> Due Soon
      </Badge>
    );
  if (status === "overdue")
    return (
      <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
        <AlertTriangle className="w-3 h-3 mr-1" /> Overdue
      </Badge>
    );
  return (
    <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">
      <CalendarX className="w-3 h-3 mr-1" /> Never
    </Badge>
  );
}

// ── Config Dialog ─────────────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T[]; } catch { return fallback; }
}

function parseJsonRecord(raw: string | undefined | null, fallback: Record<string, number>): Record<string, number> {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : fallback;
  } catch { return fallback; }
}

const DEFAULT_LEGIONELLA_FREQUENCIES: Record<string, number> = {
  calorifier_temp: 7, hot_sentinel_temp: 30, hot_nonsent_temp: 90,
  cold_tank_temp: 30, cold_sentinel_temp: 30, cold_nonsent_temp: 90,
  cold_tank_inspection: 183, cold_tank_clean: 365, calorifier_inspection: 365,
  calorifier_clean: 365, shower_clean: 90, tmv_service: 365, outlet_flush: 7,
};

type LegionellaProfileState = {
  systemInventoryReference: string;
  writtenControlSchemeReference: string;
  riskAssessmentReference: string;
  riskAssessmentReviewDate: string;
  competentPerson: string;
  samplingLabRecordReference: string;
  controlLimitsRationale: string;
  remedialVerificationReference: string;
  schemeReviewDate: string;
  ukNation: string;
  temperatureLimits: Record<string, { min?: number; max?: number }>;
};

function LegionellaConfigDialog({ siteId }: { siteId?: number }) {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetLegionellaConfig(siteId ? { siteId } : undefined);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateLegionellaConfig();

  const [defaultPerformer, setDefaultPerformer] = useState("");
  const [nonSentinelOutlets, setNonSentinelOutlets] = useState<string[]>([]);
  const [frequencyDays, setFrequencyDays] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(DEFAULT_LEGIONELLA_FREQUENCIES).map(([key, value]) => [key, String(value)])),
  );
  const [profile, setProfile] = useState<LegionellaProfileState>({
    systemInventoryReference: "", writtenControlSchemeReference: "", riskAssessmentReference: "",
    riskAssessmentReviewDate: "", competentPerson: "", samplingLabRecordReference: "",
    controlLimitsRationale: "", remedialVerificationReference: "", schemeReviewDate: "", ukNation: "",
    temperatureLimits: {},
  });

  useEffect(() => {
    if (!config || !open) return;
    setDefaultPerformer(config.water_default_performer ?? "");
    setNonSentinelOutlets(parseJsonArray<string>(config.water_non_sentinel_outlets));
    const saved = parseJsonRecord(config.water_frequency_days, DEFAULT_LEGIONELLA_FREQUENCIES);
     const savedProfile: any = config.controlProfile ?? {};
    setFrequencyDays(Object.fromEntries(Object.keys(DEFAULT_LEGIONELLA_FREQUENCIES).map(key => [key, String(savedProfile.frequencyDays?.[key] ?? saved[key] ?? DEFAULT_LEGIONELLA_FREQUENCIES[key])])));
    setProfile({
      systemInventoryReference: savedProfile.systemInventoryReference ?? "",
      writtenControlSchemeReference: savedProfile.writtenControlSchemeReference ?? "",
      riskAssessmentReference: savedProfile.riskAssessmentReference ?? "",
      riskAssessmentReviewDate: savedProfile.riskAssessmentReviewDate ?? "",
      competentPerson: savedProfile.competentPerson ?? "",
      samplingLabRecordReference: savedProfile.samplingLabRecordReference ?? "",
      controlLimitsRationale: savedProfile.controlLimitsRationale ?? "",
      remedialVerificationReference: savedProfile.remedialVerificationReference ?? "",
      schemeReviewDate: savedProfile.schemeReviewDate ?? "",
      ukNation: savedProfile.ukNation ?? "",
       temperatureLimits: savedProfile.temperatureLimits ?? (config as any).effectiveTemperatureLimits ?? {},
    });
  }, [config, open]);

  const handleSave = () => {
    const numericFrequencies = Object.fromEntries(Object.entries(frequencyDays).map(([key, value]) => [key, Math.max(1, Number(value) || DEFAULT_LEGIONELLA_FREQUENCIES[key])]));
    if (!window.confirm("Save these site control limits? They are local controls for the written scheme and do not override the benchmark guidance.")) return;
    updateConfig.mutate(
      {
        data: {
          water_default_performer: defaultPerformer,
          water_non_sentinel_outlets: JSON.stringify(nonSentinelOutlets.filter(Boolean)),
          ...(siteId ? { controlProfile: { ...profile, frequencyDays: numericFrequencies, temperatureLimits: profile.temperatureLimits } } : { water_frequency_days: JSON.stringify(numericFrequencies) }),
        } as any,
        params: siteId ? { siteId } : undefined,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLegionellaConfigQueryKey() });
          toast({ title: "Template saved", description: "New checks will use these defaults." });
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
          <DialogTitle>LegionellaTrack Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure defaults for new water safety checks.</p>
        </DialogHeader>

        <Tabs defaultValue="defaults" className="flex-1 min-h-0 flex flex-col">
           <TabsList className="shrink-0 w-full grid grid-cols-4">
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
            <TabsTrigger value="nonsent">Non-sentinel</TabsTrigger>
             <TabsTrigger value="controls">Controls</TabsTrigger>
          </TabsList>

          <TabsContent value="defaults" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <div className="space-y-1.5">
              <Label>Default performed by</Label>
              <Input value={defaultPerformer} onChange={e => setDefaultPerformer(e.target.value)}
                placeholder="e.g. Responsible person" className="rounded-sm" />
              <p className="text-xs text-muted-foreground">Pre-fills the "Performed by" field on every new check.</p>
            </div>
             <div className="space-y-2">
               <Label>Risk-assessed check frequencies (days)</Label>
               <p className="text-xs text-muted-foreground">HSG274/L8 values are benchmarks; the written scheme and risk assessment control the local interval.</p>
               <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                 {Object.entries(DEFAULT_LEGIONELLA_FREQUENCIES).map(([key, fallback]) => (
                   <div key={key} className="space-y-1">
                     <Label className="text-xs">{CHECK_TYPE_LABELS[key as LegionellaCheckType]}</Label>
                     <Input type="number" min={1} max={3650} value={frequencyDays[key] ?? fallback}
                       onChange={e => setFrequencyDays(current => ({ ...current, [key]: e.target.value }))} className="h-8 rounded-sm" />
                   </div>
                 ))}
               </div>
             </div>
          </TabsContent>

          <TabsContent value="nonsent" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              Non-sentinel (representative) outlets checked periodically. These appear as location suggestions on checks.
            </p>
            <div className="space-y-2">
              {nonSentinelOutlets.map((o, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input value={o} placeholder='e.g. "Ground floor toilet — cold tap"'
                    className="h-8 text-sm rounded-sm"
                    onChange={e => { const n = [...nonSentinelOutlets]; n[i] = e.target.value; setNonSentinelOutlets(n); }} />
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
                    onClick={() => setNonSentinelOutlets(nonSentinelOutlets.filter((_, x) => x !== i))}>
                    <X className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setNonSentinelOutlets([...nonSentinelOutlets, ""])}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add outlet
              </Button>
            </div>
          </TabsContent>
           <TabsContent value="controls" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
             {!siteId && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-sm p-2">Choose a site in the history filter to save a site-specific control profile.</p>}
             <p className="text-xs text-muted-foreground">Record the site water-system controls and evidence references used during inspection.</p>
              <div className="space-y-2 rounded-sm border border-amber-200 bg-amber-50 p-3">
                <Label>Site temperature limits (°C)</Label>
                <p className="text-xs text-amber-800">These are effective local controls only; they never rewrite or override the written scheme or benchmark guidance.</p>
                {Array.from(TEMPERATURE_TYPES).map(key => (
                  <div key={key} className="grid grid-cols-[1fr_80px_80px] gap-2 items-center">
                    <span className="text-xs">{CHECK_TYPE_LABELS[key]}</span>
                    <Input type="number" step="0.1" placeholder="Min" disabled={!siteId}
                      value={profile.temperatureLimits[key]?.min ?? ""}
                      onChange={e => setProfile(p => ({ ...p, temperatureLimits: { ...p.temperatureLimits, [key]: { ...p.temperatureLimits[key], min: e.target.value === "" ? undefined : Number(e.target.value) } } }))} />
                    <Input type="number" step="0.1" placeholder="Max" disabled={!siteId}
                      value={profile.temperatureLimits[key]?.max ?? ""}
                      onChange={e => setProfile(p => ({ ...p, temperatureLimits: { ...p.temperatureLimits, [key]: { ...p.temperatureLimits[key], max: e.target.value === "" ? undefined : Number(e.target.value) } } }))} />
                  </div>
                ))}
              </div>
             {([
               ["systemInventoryReference", "Water-system inventory reference"],
               ["writtenControlSchemeReference", "Written control scheme reference"],
               ["riskAssessmentReference", "Legionella risk assessment reference"],
               ["riskAssessmentReviewDate", "Risk assessment review date"],
               ["competentPerson", "Responsible / competent person"],
               ["samplingLabRecordReference", "Sampling and laboratory record reference"],
               ["controlLimitsRationale", "Control limits and rationale"],
               ["remedialVerificationReference", "Remedial verification reference"],
               ["schemeReviewDate", "Scheme applicability review date"],
             ] as const).map(([key, label]) => (
               <div key={key} className="space-y-1">
                 <Label>{label}</Label>
                 {key.toLowerCase().includes("date") ? (
                   <Input type="date" value={profile[key]} disabled={!siteId} onChange={e => setProfile(current => ({ ...current, [key]: e.target.value }))} />
                 ) : (
                   <Textarea rows={key === "controlLimitsRationale" ? 3 : 1} value={profile[key]} disabled={!siteId}
                     onChange={e => setProfile(current => ({ ...current, [key]: e.target.value }))} />
                 )}
               </div>
             ))}
             <div className="space-y-1">
               <Label>UK nation</Label>
               <Select value={profile.ukNation || "none"} disabled={!siteId} onValueChange={value => setProfile(current => ({ ...current, ukNation: value === "none" ? "" : value }))}>
                 <SelectTrigger><SelectValue placeholder="Select nation" /></SelectTrigger>
                 <SelectContent><SelectItem value="none">Not set</SelectItem><SelectItem value="england">England</SelectItem><SelectItem value="scotland">Scotland</SelectItem><SelectItem value="wales">Wales</SelectItem><SelectItem value="northern_ireland">Northern Ireland</SelectItem></SelectContent>
               </Select>
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

// ── Sentinel Outlet types & helpers ──────────────────────────────────────────

type OutletStatus = {
  id: number;
  name: string;
  type: "hot" | "cold" | "calorifier";
  location: string | null;
  siteId: number | null;
  sortOrder: number;
  testedThisMonth: boolean;
  checkTypeForOutlet: LegionellaCheckType;
  lastCheck: {
    id: number;
    checkDate: string;
    result: string;
    temperature: string | null;
    performedBy: string | null;
    notes: string | null;
  } | null;
};

const OUTLET_TYPE_LABEL: Record<string, string> = { hot: "Hot", cold: "Cold", calorifier: "Calorifier" };
const OUTLET_TYPE_CLS: Record<string, string> = {
  hot:        "bg-orange-100 text-orange-700 border-orange-200",
  cold:       "bg-sky-100 text-sky-700 border-sky-200",
  calorifier: "bg-amber-100 text-amber-700 border-amber-200",
};

// ── Add Outlet Dialog ─────────────────────────────────────────────────────────

function AddOutletDialog({ open, onClose, onSuccess }: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"hot" | "cold" | "calorifier">("hot");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const r = await apiFetch("/legionella/outlets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), type, location: location.trim() || null }),
    });
    setBusy(false);
    if (r.ok) {
      toast({ title: "Outlet added" });
      setName(""); setType("hot"); setLocation("");
      onSuccess();
    } else {
      toast({ title: "Failed to add outlet", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Add Sentinel Outlet</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Outlet name</Label>
            <Input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. HWS sentinel — 2nd floor bathroom" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={v => setType(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hot">Hot water</SelectItem>
                <SelectItem value="cold">Cold water</SelectItem>
                <SelectItem value="calorifier">Calorifier</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Location (optional)</Label>
            <Input value={location} onChange={e => setLocation(e.target.value)}
              placeholder="e.g. Male toilets, ground floor" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || busy}>
            {busy ? "Adding…" : "Add Outlet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Outlet test dialog ─────────────────────────────────────────────────────────

function OutletTestDialog({ outlet, onClose, onSuccess }: {
  outlet: OutletStatus;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const checkType = outlet.checkTypeForOutlet;
  const [checkDate, setCheckDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [temperature, setTemperature] = useState("");
  const [performedBy, setPerformedBy] = useState("");
  const [staffRosterId, setStaffRosterId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();
  const { data: config } = useGetLegionellaConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const fallback = config?.water_default_performer || user?.name || "";
    if (!performedBy && fallback) setPerformedBy(fallback);
  }, [config, user]);

  const isTemperature = TEMPERATURE_TYPES.has(checkType);
  const locationStr = outlet.name + (outlet.location ? ` — ${outlet.location}` : "");

  const handleSubmit = async () => {
    setBusy(true);
    const r = await apiFetch("/legionella", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkType,
        checkDate,
        result,
        temperature: isTemperature && temperature ? parseFloat(temperature) : undefined,
        location: locationStr,
        performedBy: performedBy || null, staffRosterId: staffRosterId,
        notes: notes || undefined,
        siteId: outlet.siteId ?? undefined,
        outletId: outlet.id,
      }),
    });
    setBusy(false);
    if (r.ok) {
      queryClient.invalidateQueries({ queryKey: getListLegionellaChecksQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLegionellaStatusQueryKey() });
      const label = result === "pass" ? "Pass" : "Fail";
      toast({ title: "Test recorded", description: `${outlet.name} — ${label}` });
      onSuccess();
    } else {
      toast({ title: "Failed to record test", variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">Log Sentinel Test</DialogTitle>
          <p className="text-sm text-muted-foreground">{locationStr}</p>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="rounded-md bg-muted/50 px-3 py-2 space-y-0.5">
            <p className="text-sm font-medium">{CHECK_TYPE_LABELS[checkType]}</p>
            <p className="text-xs text-muted-foreground italic">{CHECK_TYPE_HINTS[checkType]}</p>
          </div>
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={checkDate} onChange={e => setCheckDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Check result</Label>
            <Select value={result} onValueChange={v => setResult(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">A Fail automatically opens an Action Required item to track remediation.</p>
          </div>
          {isTemperature && (
            <div className="space-y-1.5">
              <Label>Temperature (°C)</Label>
              <div className="relative">
                <ThermometerSun className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input type="number" step="0.1" value={temperature}
                  onChange={e => setTemperature(e.target.value)}
                  placeholder={TEMP_PLACEHOLDER[checkType] ?? "°C"}
                  className="pl-9" />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <StaffPerformerSelect value={performedBy} onChange={setPerformedBy} onRosterIdChange={setStaffRosterId} />
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy ? "Saving…" : "Record Test"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sentinel Outlets Panel ─────────────────────────────────────────────────────

function SentinelOutletsPanel({ canAdmin }: { canAdmin: boolean }) {
  const [outlets, setOutlets] = useState<OutletStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [logOutlet, setLogOutlet] = useState<OutletStatus | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { toast } = useToast();

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await apiFetch("/legionella/outlet-status");
      setOutlets(r.ok ? await r.json() : []);
    } catch {
      setOutlets([]);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const handleDelete = async (id: number) => {
    if (!confirm("Remove this outlet? This won't delete historical test records.")) return;
    const r = await apiFetch(`/legionella/outlets/${id}`, { method: "DELETE" });
    if (r.ok || r.status === 204) {
      toast({ title: "Outlet removed" });
      refresh();
    } else {
      toast({ title: "Failed to remove outlet", variant: "destructive" });
    }
  };

  const now = new Date();
  const monthName = now.toLocaleString("en-GB", { month: "long", year: "numeric" });
  const total = outlets.length;
  const done = outlets.filter(o => o.testedThisMonth).length;

  // Hide panel entirely if there are no outlets and user can't add any
  if (!loading && total === 0 && !canAdmin) return null;

  return (
    <Card>
      <CardHeader className="border-b border-border/50 pb-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              Sentinel Outlets
              {total > 0 && (
                <span className={cn(
                  "text-xs px-2 py-0.5 rounded-full font-semibold border",
                  done === total
                    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                    : "bg-amber-100 text-amber-700 border-amber-200"
                )}>
                  {done}/{total} tested — {monthName}
                </span>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Monitoring points and frequency should match this site's risk assessment and written scheme.</p>
          </div>
          {canAdmin && (
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Outlet
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4">
        {loading ? (
          <div className="flex justify-center py-6">
            <div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : total === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Droplets className="w-10 h-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm">No sentinel outlets defined yet.</p>
            {canAdmin && (
              <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-primary"
                onClick={() => setAddOpen(true)}>
                Add your first outlet →
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {outlets.map(outlet => (
              <div key={outlet.id} className={cn(
                "rounded-lg border p-4 space-y-3 transition-all",
                outlet.testedThisMonth
                  ? outlet.lastCheck?.result !== "pass"
                    ? "border-red-200 bg-red-50/40"
                    : "border-emerald-200 bg-emerald-50/40"
                  : "border-amber-200 bg-amber-50/40"
              )}>
                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm leading-snug">{outlet.name}</div>
                    {outlet.location && (
                      <div className="text-xs text-muted-foreground mt-0.5">{outlet.location}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded border font-medium",
                      OUTLET_TYPE_CLS[outlet.type] ?? "bg-muted text-muted-foreground border-border"
                    )}>
                      {OUTLET_TYPE_LABEL[outlet.type] ?? outlet.type}
                    </span>
                    {canAdmin && (
                      <Button variant="ghost" size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(outlet.id)}>
                        <X className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Status row */}
                <div className="flex items-center gap-1.5 text-xs">
                  {outlet.testedThisMonth ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span className={cn(
                        "font-medium",
                        outlet.lastCheck?.result === "pass" ? "text-emerald-700" : "text-red-700"
                      )}>
                          {outlet.lastCheck?.result === "pass" ? "Passed" : "Failed"}
                        {outlet.lastCheck?.temperature && ` (${outlet.lastCheck.temperature}°C)`}
                        {outlet.lastCheck?.checkDate && ` — ${format(new Date(outlet.lastCheck.checkDate), "dd MMM")}`}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      <span className="text-amber-700 font-medium">Not tested this month</span>
                    </>
                  )}
                </div>

                {/* Action */}
                <Button size="sm"
                  variant={outlet.testedThisMonth ? "outline" : "default"}
                  className="w-full"
                  onClick={() => setLogOutlet(outlet)}>
                  <Plus className="w-3 h-3 mr-1.5" />
                  {outlet.testedThisMonth ? "Log another" : "Log Test"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {logOutlet && (
        <OutletTestDialog
          outlet={logOutlet}
          onClose={() => setLogOutlet(null)}
          onSuccess={() => { setLogOutlet(null); refresh(); }}
        />
      )}

      {canAdmin && addOpen && (
        <AddOutletDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); refresh(); }}
        />
      )}
    </Card>
  );
}

// ── Record Check Dialog ────────────────────────────────────────────────────────

function RecordCheckDialog({
  siteId,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultCheckType,
}: {
  siteId?: number;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  defaultCheckType?: LegionellaCheckType;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (controlledOpen !== undefined) controlledOnOpenChange?.(v);
    else setInternalOpen(v);
  };
  const [checkType, setCheckType] = useState<LegionellaCheckType>("calorifier_temp");

  // When opened via a status card click, pre-select that check type
  useEffect(() => {
    if (open && defaultCheckType) setCheckType(defaultCheckType);
  }, [open, defaultCheckType]);
  const [checkDate, setCheckDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [temperature, setTemperature] = useState("");
  const [location, setLocation] = useState("");
  const { user } = useAuth();
  const [performedBy, setPerformedBy] = useState(user?.name ?? "");
  const [staffRosterId, setStaffRosterId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [selectedSite, setSelectedSite] = useState<number | undefined>(siteId);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createCheck = useCreateLegionellaCheck();
  const { data: sites } = useListSites();
  const { data: config } = useGetLegionellaConfig();

  // Pre-fill from template
  useEffect(() => {
    if (!open || !config) return;
    if (!performedBy && config.water_default_performer) setPerformedBy(config.water_default_performer);
  }, [open]);

  const isTemperatureCheck = TEMPERATURE_TYPES.has(checkType);
  const effectiveLimit = (config as any)?.effectiveTemperatureLimits?.[checkType] ??
    (config as any)?.controlProfile?.temperatureLimits?.[checkType];
  const enteredTemperature = temperature === "" ? null : Number(temperature);
  const localLimitWarning = isTemperatureCheck && enteredTemperature !== null && effectiveLimit &&
    ((effectiveLimit.min !== undefined && enteredTemperature < effectiveLimit.min) ||
      (effectiveLimit.max !== undefined && enteredTemperature > effectiveLimit.max));

  const handleSubmit = async () => {
    if (isTemperatureCheck && !temperature) {
      toast({ title: "Temperature reading is required", variant: "destructive" });
      return;
    }
    const data: CreateLegionellaCheckRequest & { staffRosterId?: number | null } = {
      checkType,
      checkDate,
      result,
      temperature: isTemperatureCheck && temperature ? parseFloat(temperature) : undefined,
      siteId: selectedSite,
      location: location || undefined,
      performedBy: performedBy || null, staffRosterId: staffRosterId,
      notes: notes || undefined,
    };

    createCheck.mutate(
      { data },
      {
        onSuccess: (response: any) => {
          queryClient.invalidateQueries({ queryKey: getListLegionellaChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLegionellaStatusQueryKey() });
          toast({ title: "Check recorded", description: `Server outcome: ${response?.result ?? result}.` });
          setOpen(false);
          setTemperature("");
          setLocation("");
          setPerformedBy(user?.name ?? "");
          setNotes("");
          setCheckDate(format(new Date(), "yyyy-MM-dd"));
        },
        onError: (error: any) => {
          toast({ title: "Failed to record check", description: error.message || "An error occurred.", variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="shadow-lg shadow-primary/20">
          <Plus className="w-4 h-4 mr-2" />
          Record Check
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">Record Legionella Check</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label>Check Type</Label>
            <Select value={checkType} onValueChange={(v) => setCheckType(v as LegionellaCheckType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CHECK_TYPE_LABELS) as LegionellaCheckType[]).map((key) => (
                  <SelectItem key={key} value={key}>{CHECK_TYPE_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground italic">{CHECK_TYPE_HINTS[checkType]}</p>
          </div>

          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Check result</Label>
            <Select value={result} onValueChange={(v) => setResult(v as typeof result)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">A Fail automatically opens an Action Required item to track remediation.</p>
          </div>

          {isTemperatureCheck && (
            <div className="space-y-1.5">
              <Label>Temperature (°C)</Label>
              <div className="relative">
                <ThermometerSun className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="number"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder={TEMP_PLACEHOLDER[checkType] ?? "°C"}
                  className="pl-9"
                />
              </div>
            </div>
          )}
          {localLimitWarning && (
            <div className="flex items-start gap-2 rounded-sm border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              This reading is outside the effective site limit. The server will evaluate the result on save.
            </div>
          )}

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site (optional)</Label>
              <Select
                value={selectedSite ? String(selectedSite) : "none"}
                onValueChange={(v) => setSelectedSite(v === "none" ? undefined : Number(v))}
              >
                <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Location / Outlet</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Ground floor male toilets, tap 3" />
          </div>

          <div className="space-y-1.5">
            <StaffPerformerSelect value={performedBy} onChange={setPerformedBy} onRosterIdChange={setStaffRosterId} />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={createCheck.isPending}>
            {createCheck.isPending ? "Saving..." : "Record Check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditCheckDialog({ check }: { check: LegionellaCheck }) {
  const [open, setOpen] = useState(false);
  const [checkDate, setCheckDate] = useState(check.checkDate);
  const [result, setResult] = useState<"pass" | "fail">(check.result === "pass" ? "pass" : "fail");
  const [resultChanged, setResultChanged] = useState(false);
  const [temperature, setTemperature] = useState(check.temperature || "");
  const [location, setLocation] = useState(check.location || "");
  const [performedBy, setPerformedBy] = useState(check.performedBy || "");
  const [staffRosterId, setStaffRosterId] = useState<number | null>((check as any).staffRosterId ?? null);
  const [notes, setNotes] = useState(check.notes || "");
  const [selectedSite, setSelectedSite] = useState<number | undefined>(check.siteId || undefined);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateCheck = useUpdateLegionellaCheck();
  const { data: sites } = useListSites();

  const isTemperatureCheck = TEMPERATURE_TYPES.has(check.checkType as LegionellaCheckType);

  const handleSubmit = async () => {
    updateCheck.mutate(
      {
        id: check.id,
        data: {
          checkDate,
          ...(resultChanged ? { result } : {}),
          temperature: isTemperatureCheck && temperature ? parseFloat(String(temperature)) : undefined,
          siteId: selectedSite,
          location: location || undefined,
          performedBy: performedBy || null, staffRosterId: staffRosterId,
          notes: notes || undefined,
        } as any,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListLegionellaChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLegionellaStatusQueryKey() });
          toast({ title: "Check updated" });
          setOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to update", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm"><Pencil className="w-3.5 h-3.5" /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">Edit Check</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Check result</Label>
            {check.result !== "pass" && check.result !== "fail" && (
              <p className="text-xs text-muted-foreground">Legacy result: Action Required (treated as Fail). Choose a result to replace it.</p>
            )}
            <Select value={result} onValueChange={(v) => { setResult(v as typeof result); setResultChanged(true); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">A Fail automatically opens an Action Required item to track remediation.</p>
          </div>

          {isTemperatureCheck && (
            <div className="space-y-1.5">
              <Label>Temperature (°C)</Label>
              <Input
                type="number"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
          )}

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site (optional)</Label>
              <Select
                value={selectedSite ? String(selectedSite) : "none"}
                onValueChange={(v) => setSelectedSite(v === "none" ? undefined : Number(v))}
              >
                <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Location / Outlet</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <StaffPerformerSelect value={performedBy} onChange={setPerformedBy} onRosterIdChange={setStaffRosterId} />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={updateCheck.isPending}>
            {updateCheck.isPending ? "Saving..." : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LegionellaPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasLegionellatrack = hasService("legionellatrack");

  const [filterType, setFilterType] = useState<LegionellaCheckType | "">("");
  const [filterSite, setFilterSite] = useState<number | undefined>(undefined);
  const [recordOpen, setRecordOpen] = useState(false);
  const [quickCheckType, setQuickCheckType] = useState<LegionellaCheckType | undefined>(undefined);

  const { data: status, isLoading: statusLoading, error: statusError } = useGetLegionellaStatus(
    { siteId: filterSite },
    { query: { enabled: hasLegionellatrack, retry: (count, err: any) => err?.status !== 403 && count < 3, queryKey: getGetLegionellaStatusQueryKey({ siteId: filterSite }) } }
  );
  const serverLocked = (statusError as any)?.status === 403;

  const { data: checks, isLoading: checksLoading } = useListLegionellaChecks(
    { checkType: filterType || undefined, siteId: filterSite },
    { query: { enabled: hasLegionellatrack, queryKey: getListLegionellaChecksQueryKey({ checkType: filterType || undefined, siteId: filterSite }) } }
  );
  const { data: sites } = useListSites({ query: { enabled: hasLegionellatrack, queryKey: getListSitesQueryKey() } });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteCheck = useDeleteLegionellaCheck();

  const handleDelete = (id: number) => {
    if (!confirm("Delete this check record?")) return;
    deleteCheck.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListLegionellaChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLegionellaStatusQueryKey() });
          toast({ title: "Check deleted" });
        },
        onError: (error: any) => {
          toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  if (!hasLegionellatrack || serverLocked) {
    return (
      <AppLayout title="LegionellaTrack — Water Safety Logbook">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">LegionellaTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital Legionella water safety logbook — record a site-specific written scheme, monitoring and actions.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button size="lg" className="w-full sm:w-auto font-medium">
                      Enable LegionellaTrack
                    </Button>
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground bg-white/50 inline-block px-4 py-2 rounded-md border border-border/50">
                    Ask your account admin to enable this service.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const overdueStatuses = status?.filter((s) => s.status === "overdue") || [];
  const dueSoonStatuses = status?.filter((s) => s.status === "due_soon") || [];

  return (
    <AppLayout title="LegionellaTrack — Water Safety Logbook">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <Droplets className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                Legionella water safety logbook — supporting L8/HSG274-informed, risk-assessed controls
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && <LegionellaConfigDialog siteId={filterSite} />}
            <RecordCheckDialog siteId={filterSite} open={recordOpen} onOpenChange={setRecordOpen} defaultCheckType={quickCheckType} />
          </div>
        </div>

        {/* Status Overview */}
        {statusLoading ? (
          <Card>
            <CardContent className="p-12 flex justify-center">
              <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {status?.map((item) => (
              <Card
                key={item.checkType}
                className={cn(
                  "border-l-4 transition-all hover:shadow-md cursor-pointer group",
                  item.lastResult === "fail"
                    ? "border-l-red-600 bg-red-100/60"
                    : item.lastResult === "action_required"
                    ? "border-l-orange-600 bg-orange-100/60"
                    : item.status === "overdue"
                    ? "border-l-rose-500 bg-rose-50/50"
                    : item.status === "due_soon"
                    ? "border-l-amber-500 bg-amber-50/50"
                    : item.status === "never"
                    ? "border-l-slate-400 bg-slate-50/50"
                    : "border-l-emerald-500 bg-emerald-50/50"
                )}
                onClick={() => { setQuickCheckType(item.checkType as LegionellaCheckType); setRecordOpen(true); }}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm font-medium leading-tight">
                      {checkTypeLabel(item.checkType)}
                    </CardTitle>
                    <StatusBadge status={item.status} lastResult={item.lastResult} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Frequency:</span> Every {item.frequencyDays} days
                  </div>
                  {item.lastDate && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Last check:</span>{" "}
                      {format(new Date(item.lastDate), "dd/MM/yyyy")}
                    </div>
                  )}
                  {item.dueDate && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Next due:</span>{" "}
                      {format(new Date(item.dueDate), "dd/MM/yyyy")}
                    </div>
                  )}
                  {item.status === "never" && (
                    <div className="text-xs text-muted-foreground italic">No checks recorded yet</div>
                  )}
                  <div className="text-[11px] text-primary opacity-0 group-hover:opacity-100 transition-opacity pt-0.5 font-medium">
                    + Record check →
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Sentinel Outlets — per-outlet monthly tracking */}
        <SentinelOutletsPanel canAdmin={canAdmin} />

        {(overdueStatuses.length > 0 || dueSoonStatuses.length > 0) && (
          <div className="space-y-3">
            {overdueStatuses.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> Overdue checks
                </div>
                <div className="text-xs">
                  {overdueStatuses.map((s) => checkTypeLabel(s.checkType)).join(", ")} — action required.
                </div>
              </div>
            )}
            {dueSoonStatuses.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" /> Due soon
                </div>
                <div className="text-xs">
                  {dueSoonStatuses.map((s) => checkTypeLabel(s.checkType)).join(", ")} — schedule soon.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-display">Filter History</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Check Type</Label>
                <Select
                  value={filterType || "all"}
                  onValueChange={(v) => setFilterType(v === "all" ? "" : (v as LegionellaCheckType | ""))}
                >
                  <SelectTrigger><SelectValue placeholder="All types" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {(Object.keys(CHECK_TYPE_LABELS) as LegionellaCheckType[]).map((key) => (
                      <SelectItem key={key} value={key}>{CHECK_TYPE_LABELS[key]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {sites && sites.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Site</Label>
                  <Select
                    value={filterSite ? String(filterSite) : "all"}
                    onValueChange={(v) => setFilterSite(v === "all" ? undefined : Number(v))}
                  >
                    <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sites</SelectItem>
                      {sites.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Check History */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="font-display">Check History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {checksLoading ? (
              <div className="p-12 flex justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
              </div>
            ) : !checks || checks.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Droplets className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No checks recorded yet. Record your first check above.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {checks.map((check) => {
                  const site = sites?.find((s) => s.id === check.siteId);
                  return (
                    <div key={check.id} className="p-4 hover:bg-muted/20 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{checkTypeLabel(check.checkType)}</span>
                            <ResultBadge result={check.result} />
                            {check.temperature && (
                              <Badge variant="outline" className="text-xs bg-sky-50 text-sky-700 border-sky-200">
                                <ThermometerSun className="w-3 h-3 mr-1" />
                                {check.temperature}°C
                              </Badge>
                            )}
                            {site && (
                              <Badge variant="outline" className="text-xs">{site.name}</Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground space-y-0.5">
                            <div>
                              <span className="font-medium">Date:</span>{" "}
                              {format(new Date(check.checkDate), "dd/MM/yyyy")}
                            </div>
                            {check.location && (
                              <div><span className="font-medium">Location:</span> {check.location}</div>
                            )}
                            {check.performedBy && (
                              <div><span className="font-medium">Performed by:</span> {check.performedBy}</div>
                            )}
                            {check.notes && (
                              <div><span className="font-medium">Notes:</span> {check.notes}</div>
                            )}
                          </div>
                          <CheckPhotoUploader entityType="legionella_check" entityId={check.id} compact />
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <EditCheckDialog check={check} />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(check.id)}
                            className="text-destructive hover:bg-destructive/10"
                          >
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
