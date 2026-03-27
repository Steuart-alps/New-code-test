import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import {
  UtensilsCrossed, Plus, Trash2, Settings2, Save, CheckCircle2, AlertTriangle, ChevronRight,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type DeliveryEntry = {
  id: string;
  supplierName: string;
  foodItems: string;
  vanCleanliness: string;
  vanSeparation: string;
  temperature: string;
  foodCondition: string;
  withinDateCodes: string;
  allergyAwareness: string;
  correctiveActions: string;
};

type ColdFoodUnit = {
  name: string;
  type: "fridge" | "freezer";
  amTemp: string;
  pmTemp: string;
  corrective: string;
};

type HotTempRow = {
  id: string;
  foodItem: string;
  cookingStarted: string;
  cookingFinished: string;
  coreTemp: string;
  coolingStarted: string;
  coolingFinished: string;
  reheatingCoreTemp: string;
};

type HotHoldingRow = {
  id: string;
  foodItem: string;
  coreTemp: string;
  timeOfCheck: string;
};

type FoodConfig = {
  food_num_fridges: string;
  food_num_freezers: string;
  food_cooking_limit: string;
  food_cooling_limit: string;
  food_reheating_limit: string;
  food_hot_holding_limit: string;
};

const DEFAULT_CONFIG: FoodConfig = {
  food_num_fridges: "2",
  food_num_freezers: "2",
  food_cooking_limit: "Above 75°C (10 seconds)",
  food_cooling_limit: "8°C within 90 minutes",
  food_reheating_limit: "Above 82°C",
  food_hot_holding_limit: "Above 63°C",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

function buildColdFood(config: FoodConfig): ColdFoodUnit[] {
  const units: ColdFoodUnit[] = [];
  const nF = Math.max(1, Math.min(8, parseInt(config.food_num_fridges) || 2));
  const nZ = Math.max(1, Math.min(6, parseInt(config.food_num_freezers) || 2));
  for (let i = 1; i <= nF; i++) units.push({ name: `Fridge ${i}`, type: "fridge", amTemp: "", pmTemp: "", corrective: "" });
  for (let i = 1; i <= nZ; i++) units.push({ name: `Freezer ${i}`, type: "freezer", amTemp: "", pmTemp: "", corrective: "" });
  return units;
}

function emptyDelivery(): DeliveryEntry {
  return { id: uid(), supplierName: "", foodItems: "", vanCleanliness: "", vanSeparation: "", temperature: "", foodCondition: "", withinDateCodes: "", allergyAwareness: "", correctiveActions: "" };
}

function emptyHotTempRow(): HotTempRow {
  return { id: uid(), foodItem: "", cookingStarted: "", cookingFinished: "", coreTemp: "", coolingStarted: "", coolingFinished: "", reheatingCoreTemp: "" };
}

function emptyHotHoldingRow(): HotHoldingRow {
  return { id: uid(), foodItem: "", coreTemp: "", timeOfCheck: "" };
}

// ── Pass/Fail/Yes/No selector ─────────────────────────────────────────────────

function ToggleCell({
  value, onChange, options = ["pass", "fail"], disabled,
}: { value: string; onChange: (v: string) => void; options?: string[]; disabled?: boolean }) {
  const colours: Record<string, string> = {
    pass: "bg-green-100 text-green-700 border-green-300",
    yes: "bg-green-100 text-green-700 border-green-300",
    fail: "bg-red-100 text-red-700 border-red-300",
    no: "bg-red-100 text-red-700 border-red-300",
    n_a: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map(o => (
        <button
          key={o}
          type="button"
          disabled={disabled}
          onClick={() => onChange(value === o ? "" : o)}
          className={cn(
            "px-2 py-0.5 rounded border text-xs font-medium capitalize transition-colors",
            value === o ? colours[o] ?? "bg-primary text-white border-primary" : "bg-card border-border text-muted-foreground hover:bg-muted",
            disabled && "opacity-50 cursor-not-allowed"
          )}
        >
          {o.replace("_", "/")}
        </button>
      ))}
    </div>
  );
}

// ── Config Dialog ─────────────────────────────────────────────────────────────

function ConfigDialog({ open, onClose, config, onSave }: {
  open: boolean; onClose: () => void; config: FoodConfig; onSave: (c: FoodConfig) => void;
}) {
  const [local, setLocal] = useState(config);
  useEffect(() => { if (open) setLocal(config); }, [open, config]);

  function field(key: keyof FoodConfig, label: string, type: "number" | "text" = "text") {
    return (
      <div className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <Input
          type={type}
          min={type === "number" ? 1 : undefined}
          max={type === "number" ? 8 : undefined}
          value={local[key]}
          onChange={e => setLocal(p => ({ ...p, [key]: e.target.value }))}
          className="h-8 text-sm"
        />
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Configure Record</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-3">
            {field("food_num_fridges", "Number of Fridges", "number")}
            {field("food_num_freezers", "Number of Freezers", "number")}
          </div>
          <div className="border-t pt-3 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Critical Limits</p>
            {field("food_cooking_limit", "Cooking Limit")}
            {field("food_cooling_limit", "Cooling Limit")}
            {field("food_reheating_limit", "Reheating Limit")}
            {field("food_hot_holding_limit", "Hot Holding Limit")}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => { onSave(local); onClose(); }}>Save Config</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FoodModulePage() {
  const { activeClientId } = useAuth();
  const [date, setDate] = useState(todayStr());
  const [recordId, setRecordId] = useState<number | null>(null);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);

  const [deliveries, setDeliveries] = useState<DeliveryEntry[]>([emptyDelivery()]);
  const [coldFood, setColdFood] = useState<ColdFoodUnit[]>([]);
  const [hotTemperature, setHotTemperature] = useState<HotTempRow[]>([emptyHotTempRow()]);
  const [hotHolding, setHotHolding] = useState<HotHoldingRow[]>([emptyHotHoldingRow()]);
  const [cookingLimit, setCookingLimit] = useState(DEFAULT_CONFIG.food_cooking_limit);
  const [coolingLimit, setCoolingLimit] = useState(DEFAULT_CONFIG.food_cooling_limit);
  const [reheatingLimit, setReheatingLimit] = useState(DEFAULT_CONFIG.food_reheating_limit);
  const [hotHoldingLimit, setHotHoldingLimit] = useState(DEFAULT_CONFIG.food_hot_holding_limit);
  const [correctives, setCorrectives] = useState("");
  const [managerSignature, setManagerSignature] = useState("");

  const [config, setConfig] = useState<FoodConfig>(DEFAULT_CONFIG);
  const [configOpen, setConfigOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const isSubmitted = !!submittedAt;

  function clientParam() {
    return activeClientId ? `&clientId=${activeClientId}` : "";
  }

  const loadConfig = useCallback(async () => {
    if (!activeClientId) return;
    const res = await apiFetch(`/food-safety/config?clientId=${activeClientId}`);
    if (res.ok) {
      const cfg = await res.json();
      setConfig({ ...DEFAULT_CONFIG, ...cfg });
    }
  }, [activeClientId]);

  const loadRecord = useCallback(async (d: string) => {
    if (!activeClientId) return;
    setLoading(true);
    setRecordId(null);
    setSubmittedAt(null);
    const res = await apiFetch(`/food-safety?date=${d}${clientParam()}`);
    if (res.ok) {
      const rec = await res.json();
      if (rec) {
        setRecordId(rec.id);
        setSubmittedAt(rec.submittedAt ?? null);
        setDeliveries(rec.deliveries?.length ? rec.deliveries : [emptyDelivery()]);
        setColdFood(rec.coldFood?.length ? rec.coldFood : buildColdFood(config));
        setHotTemperature(rec.hotTemperature?.length ? rec.hotTemperature : [emptyHotTempRow()]);
        setHotHolding(rec.hotHolding?.length ? rec.hotHolding : [emptyHotHoldingRow()]);
        setCookingLimit(rec.cookingLimit);
        setCoolingLimit(rec.coolingLimit);
        setReheatingLimit(rec.reheatingLimit);
        setHotHoldingLimit(rec.hotHoldingLimit);
        setCorrectives(rec.correctives ?? "");
        setManagerSignature(rec.managerSignature ?? "");
      } else {
        // No record yet — blank slate based on config
        setDeliveries([emptyDelivery()]);
        setColdFood(buildColdFood(config));
        setHotTemperature([emptyHotTempRow()]);
        setHotHolding([emptyHotHoldingRow()]);
        setCookingLimit(config.food_cooking_limit);
        setCoolingLimit(config.food_cooling_limit);
        setReheatingLimit(config.food_reheating_limit);
        setHotHoldingLimit(config.food_hot_holding_limit);
        setCorrectives("");
        setManagerSignature("");
      }
    }
    setLoading(false);
  }, [activeClientId, config]); // eslint-disable-line

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadRecord(date); }, [date]); // eslint-disable-line

  async function handleSaveConfig(newConfig: FoodConfig) {
    setConfig(newConfig);
    if (activeClientId) {
      await apiFetch(`/food-safety/config`, {
        method: "PUT",
        body: JSON.stringify({ ...newConfig, clientId: activeClientId }),
      });
    }
    // Update cold food units if no record yet
    if (!recordId) {
      setColdFood(buildColdFood(newConfig));
      setCookingLimit(newConfig.food_cooking_limit);
      setCoolingLimit(newConfig.food_cooling_limit);
      setReheatingLimit(newConfig.food_reheating_limit);
      setHotHoldingLimit(newConfig.food_hot_holding_limit);
    }
  }

  async function handleSave(submit = false) {
    if (!activeClientId) return;
    setSaving(true);
    const body = {
      recordDate: date,
      deliveries,
      coldFood,
      hotTemperature,
      hotHolding,
      cookingLimit,
      coolingLimit,
      reheatingLimit,
      hotHoldingLimit,
      correctives,
      managerSignature,
      clientId: activeClientId,
      ...(submit ? { submittedAt: new Date().toISOString() } : {}),
    };
    try {
      if (recordId) {
        const res = await apiFetch(`/food-safety/${recordId}?clientId=${activeClientId}`, { method: "PUT", body: JSON.stringify(body) });
        if (res.ok) {
          const rec = await res.json();
          if (submit) setSubmittedAt(rec.submittedAt);
        }
      } else {
        const res = await apiFetch(`/food-safety?clientId=${activeClientId}`, { method: "POST", body: JSON.stringify(body) });
        if (res.ok) {
          const rec = await res.json();
          setRecordId(rec.id);
          if (submit) setSubmittedAt(rec.submittedAt);
        } else if (res.status === 409) {
          const { id } = await res.json();
          setRecordId(id);
          // Retry update
          const res2 = await apiFetch(`/food-safety/${id}?clientId=${activeClientId}`, { method: "PUT", body: JSON.stringify(body) });
          if (res2.ok && submit) { const rec = await res2.json(); setSubmittedAt(rec.submittedAt); }
        }
      }
    } finally {
      setSaving(false);
    }
  }

  if (!activeClientId) {
    return (
      <AppLayout title="Food Safety">
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
          <UtensilsCrossed className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">Select a client first to access this module.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Food Safety — Daily Record">
      <div className="space-y-5 max-w-5xl">

        {/* Top bar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-sm text-muted-foreground whitespace-nowrap">Date</Label>
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-40 h-8 text-sm"
            />
          </div>
          {isSubmitted && (
            <Badge className="bg-green-100 text-green-700 border-green-300 gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Submitted {format(new Date(submittedAt!), "dd MMM yyyy HH:mm")}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setConfigOpen(true)}>
              <Settings2 className="w-3.5 h-3.5" />
              Configure
            </Button>
            {!isSubmitted && (
              <>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleSave(false)} disabled={saving || loading}>
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving…" : "Save Draft"}
                </Button>
                <Button size="sm" className="gap-1.5" onClick={() => handleSave(true)} disabled={saving || loading || !managerSignature}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Submit &amp; Sign
                </Button>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />
          </div>
        ) : (
          <Accordion type="multiple" defaultValue={["deliveries", "cold", "hot", "holding"]} className="space-y-3">

            {/* ── DELIVERIES ─────────────────────────────────────────── */}
            <AccordionItem value="deliveries" className="bg-card border border-border rounded-xl px-5">
              <AccordionTrigger className="hover:no-underline py-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ChevronRight className="w-4 h-4 text-muted-foreground accordion-chevron" />
                  Deliveries
                  <Badge variant="outline" className="text-xs ml-1">{deliveries.length}</Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="space-y-4">
                  {deliveries.map((d, i) => (
                    <div key={d.id} className="border border-border rounded-lg p-4 space-y-3 relative">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Delivery {i + 1}</span>
                        {!isSubmitted && deliveries.length > 1 && (
                          <button type="button" onClick={() => setDeliveries(p => p.filter(x => x.id !== d.id))} className="text-muted-foreground hover:text-destructive transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Supplier's Name</Label>
                          <Input disabled={isSubmitted} value={d.supplierName} onChange={e => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, supplierName: e.target.value } : x))} className="h-8 text-sm" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Food Items Delivered</Label>
                          <Input disabled={isSubmitted} value={d.foodItems} onChange={e => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, foodItems: e.target.value } : x))} className="h-8 text-sm" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Van Cleanliness</Label>
                          <ToggleCell disabled={isSubmitted} value={d.vanCleanliness} onChange={v => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, vanCleanliness: v } : x))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Raw/Cooked Separation</Label>
                          <ToggleCell disabled={isSubmitted} value={d.vanSeparation} onChange={v => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, vanSeparation: v } : x))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Food Condition</Label>
                          <ToggleCell disabled={isSubmitted} value={d.foodCondition} onChange={v => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, foodCondition: v } : x))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Food Temp (°C)</Label>
                          <Input disabled={isSubmitted} value={d.temperature} onChange={e => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, temperature: e.target.value } : x))} className="h-8 text-sm" placeholder="e.g. 4" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Within Date Codes</Label>
                          <ToggleCell disabled={isSubmitted} value={d.withinDateCodes} options={["yes", "no"]} onChange={v => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, withinDateCodes: v } : x))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Allergy Awareness</Label>
                          <ToggleCell disabled={isSubmitted} value={d.allergyAwareness} options={["yes", "no"]} onChange={v => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, allergyAwareness: v } : x))} />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Corrective Actions</Label>
                        <Input disabled={isSubmitted} value={d.correctiveActions} onChange={e => setDeliveries(p => p.map(x => x.id === d.id ? { ...x, correctiveActions: e.target.value } : x))} className="h-8 text-sm" placeholder="e.g. Rejected food, contacted supplier" />
                      </div>
                    </div>
                  ))}
                  {!isSubmitted && (
                    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setDeliveries(p => [...p, emptyDelivery()])}>
                      <Plus className="w-3.5 h-3.5" /> Add Delivery
                    </Button>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ── COLD FOOD RECORD ───────────────────────────────────── */}
            <AccordionItem value="cold" className="bg-card border border-border rounded-xl px-5">
              <AccordionTrigger className="hover:no-underline py-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ChevronRight className="w-4 h-4 text-muted-foreground accordion-chevron" />
                  Cold Food Record
                  <span className="text-xs font-normal text-muted-foreground ml-1">Critical Limit: Fridge ≤5°C · Freezer ≤−18°C</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 pr-4 text-xs font-semibold text-muted-foreground w-32">Unit</th>
                        <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">AM Temp (°C)</th>
                        <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">PM Temp (°C)</th>
                        <th className="text-left py-2 pl-3 text-xs font-semibold text-muted-foreground">Corrective Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coldFood.map((unit, i) => {
                        const isFridge = unit.type === "fridge";
                        const limit = isFridge ? 5 : -18;
                        const amWarn = unit.amTemp && parseFloat(unit.amTemp) > limit;
                        const pmWarn = unit.pmTemp && parseFloat(unit.pmTemp) > limit;
                        return (
                          <tr key={i} className="border-b border-border/50 last:border-0">
                            <td className="py-2 pr-4">
                              <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", isFridge ? "bg-blue-50 text-blue-700" : "bg-indigo-50 text-indigo-700")}>
                                {unit.name}
                              </span>
                            </td>
                            <td className="py-2 px-3">
                              <div className="relative">
                                <Input
                                  disabled={isSubmitted}
                                  type="number"
                                  step="0.1"
                                  value={unit.amTemp}
                                  onChange={e => setColdFood(p => p.map((u, j) => j === i ? { ...u, amTemp: e.target.value } : u))}
                                  className={cn("h-7 text-sm text-center w-24", amWarn && "border-red-400 bg-red-50")}
                                />
                                {amWarn && <AlertTriangle className="absolute right-1 top-1 w-3 h-3 text-red-500" />}
                              </div>
                            </td>
                            <td className="py-2 px-3">
                              <div className="relative">
                                <Input
                                  disabled={isSubmitted}
                                  type="number"
                                  step="0.1"
                                  value={unit.pmTemp}
                                  onChange={e => setColdFood(p => p.map((u, j) => j === i ? { ...u, pmTemp: e.target.value } : u))}
                                  className={cn("h-7 text-sm text-center w-24", pmWarn && "border-red-400 bg-red-50")}
                                />
                                {pmWarn && <AlertTriangle className="absolute right-1 top-1 w-3 h-3 text-red-500" />}
                              </div>
                            </td>
                            <td className="py-2 pl-3">
                              <Input
                                disabled={isSubmitted}
                                value={unit.corrective}
                                onChange={e => setColdFood(p => p.map((u, j) => j === i ? { ...u, corrective: e.target.value } : u))}
                                className="h-7 text-sm"
                                placeholder={amWarn || pmWarn ? "Action taken…" : ""}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ── HOT TEMPERATURE RECORD ─────────────────────────────── */}
            <AccordionItem value="hot" className="bg-card border border-border rounded-xl px-5">
              <AccordionTrigger className="hover:no-underline py-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ChevronRight className="w-4 h-4 text-muted-foreground accordion-chevron" />
                  Hot Temperature Record
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
                    <div><span className="font-medium text-foreground">Cooking: </span>{cookingLimit}</div>
                    <div><span className="font-medium text-foreground">Cooling: </span>{coolingLimit}</div>
                    <div><span className="font-medium text-foreground">Reheating: </span>{reheatingLimit}</div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse min-w-[640px]">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 pr-3 text-xs font-semibold text-muted-foreground">Food Item</th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-muted-foreground">Cook Started</th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-muted-foreground">Cook Finished</th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-amber-700">Core Temp (°C)</th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-muted-foreground">Cool Started</th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-muted-foreground">Cool Finished</th>
                          <th className="text-center py-2 px-2 text-xs font-semibold text-blue-700">Reheat Temp (°C)</th>
                          {!isSubmitted && <th className="w-6" />}
                        </tr>
                      </thead>
                      <tbody>
                        {hotTemperature.map((row) => (
                          <tr key={row.id} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-3">
                              <Input disabled={isSubmitted} value={row.foodItem} onChange={e => setHotTemperature(p => p.map(r => r.id === row.id ? { ...r, foodItem: e.target.value } : r))} className="h-7 text-sm" />
                            </td>
                            {(["cookingStarted", "cookingFinished"] as const).map(k => (
                              <td key={k} className="py-1.5 px-2">
                                <Input disabled={isSubmitted} type="time" value={row[k]} onChange={e => setHotTemperature(p => p.map(r => r.id === row.id ? { ...r, [k]: e.target.value } : r))} className="h-7 text-sm w-24" />
                              </td>
                            ))}
                            <td className="py-1.5 px-2">
                              <Input disabled={isSubmitted} type="number" step="0.1" value={row.coreTemp} onChange={e => setHotTemperature(p => p.map(r => r.id === row.id ? { ...r, coreTemp: e.target.value } : r))} className={cn("h-7 text-sm text-center w-20", row.coreTemp && parseFloat(row.coreTemp) < 75 && "border-red-400 bg-red-50")} />
                            </td>
                            {(["coolingStarted", "coolingFinished"] as const).map(k => (
                              <td key={k} className="py-1.5 px-2">
                                <Input disabled={isSubmitted} type="time" value={row[k]} onChange={e => setHotTemperature(p => p.map(r => r.id === row.id ? { ...r, [k]: e.target.value } : r))} className="h-7 text-sm w-24" />
                              </td>
                            ))}
                            <td className="py-1.5 px-2">
                              <Input disabled={isSubmitted} type="number" step="0.1" value={row.reheatingCoreTemp} onChange={e => setHotTemperature(p => p.map(r => r.id === row.id ? { ...r, reheatingCoreTemp: e.target.value } : r))} className={cn("h-7 text-sm text-center w-20", row.reheatingCoreTemp && parseFloat(row.reheatingCoreTemp) < 82 && "border-red-400 bg-red-50")} />
                            </td>
                            {!isSubmitted && (
                              <td className="py-1.5">
                                <button type="button" onClick={() => setHotTemperature(p => p.filter(r => r.id !== row.id))} disabled={hotTemperature.length === 1} className="text-muted-foreground hover:text-destructive disabled:opacity-30 transition-colors">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!isSubmitted && (
                    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setHotTemperature(p => [...p, emptyHotTempRow()])}>
                      <Plus className="w-3.5 h-3.5" /> Add Row
                    </Button>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ── HOT HOLDING ─────────────────────────────────────────── */}
            <AccordionItem value="holding" className="bg-card border border-border rounded-xl px-5">
              <AccordionTrigger className="hover:no-underline py-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ChevronRight className="w-4 h-4 text-muted-foreground accordion-chevron" />
                  Hot Holding / Off-Site Temperature Record
                  <span className="text-xs font-normal text-muted-foreground ml-1">Critical Limit: {hotHoldingLimit}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 pr-3 text-xs font-semibold text-muted-foreground">Food Item</th>
                          <th className="text-center py-2 px-3 text-xs font-semibold text-amber-700">Core Temp (°C)</th>
                          <th className="text-left py-2 pl-3 text-xs font-semibold text-muted-foreground">Time of Check</th>
                          {!isSubmitted && <th className="w-6" />}
                        </tr>
                      </thead>
                      <tbody>
                        {hotHolding.map((row) => (
                          <tr key={row.id} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-3">
                              <Input disabled={isSubmitted} value={row.foodItem} onChange={e => setHotHolding(p => p.map(r => r.id === row.id ? { ...r, foodItem: e.target.value } : r))} className="h-7 text-sm" />
                            </td>
                            <td className="py-1.5 px-3">
                              <Input disabled={isSubmitted} type="number" step="0.1" value={row.coreTemp} onChange={e => setHotHolding(p => p.map(r => r.id === row.id ? { ...r, coreTemp: e.target.value } : r))} className={cn("h-7 text-sm text-center w-24", row.coreTemp && parseFloat(row.coreTemp) < 63 && "border-red-400 bg-red-50")} />
                            </td>
                            <td className="py-1.5 pl-3">
                              <Input disabled={isSubmitted} type="time" value={row.timeOfCheck} onChange={e => setHotHolding(p => p.map(r => r.id === row.id ? { ...r, timeOfCheck: e.target.value } : r))} className="h-7 text-sm w-28" />
                            </td>
                            {!isSubmitted && (
                              <td className="py-1.5">
                                <button type="button" onClick={() => setHotHolding(p => p.filter(r => r.id !== row.id))} disabled={hotHolding.length === 1} className="text-muted-foreground hover:text-destructive disabled:opacity-30 transition-colors">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!isSubmitted && (
                    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setHotHolding(p => [...p, emptyHotHoldingRow()])}>
                      <Plus className="w-3.5 h-3.5" /> Add Row
                    </Button>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

          </Accordion>
        )}

        {/* ── FOOTER: Correctives + Signature ───────────────────────────── */}
        {!loading && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">General Corrective Actions / Notes</Label>
              <Textarea
                disabled={isSubmitted}
                value={correctives}
                onChange={e => setCorrectives(e.target.value)}
                rows={3}
                className="text-sm resize-none"
                placeholder="Record any corrective actions taken today…"
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Manager / Proprietor Signature
                  {!isSubmitted && <span className="text-destructive ml-1">*</span>}
                </Label>
                <Input
                  disabled={isSubmitted}
                  value={managerSignature}
                  onChange={e => setManagerSignature(e.target.value)}
                  className="h-9 text-sm"
                  placeholder="Type full name as signature"
                />
              </div>
              {!isSubmitted && (
                <div className="flex gap-2 shrink-0">
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleSave(false)} disabled={saving}>
                    <Save className="w-3.5 h-3.5" />
                    {saving ? "Saving…" : "Save Draft"}
                  </Button>
                  <Button size="sm" className="gap-1.5" onClick={() => handleSave(true)} disabled={saving || !managerSignature}>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Submit &amp; Sign
                  </Button>
                </div>
              )}
            </div>
            {!isSubmitted && !managerSignature && (
              <p className="text-xs text-muted-foreground">A signature is required before you can submit.</p>
            )}
          </div>
        )}

        <ConfigDialog open={configOpen} onClose={() => setConfigOpen(false)} config={config} onSave={handleSaveConfig} />
      </div>
    </AppLayout>
  );
}
