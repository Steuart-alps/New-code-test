import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import {
  useGetFoodSafetyConfig,
  getGetFoodSafetyConfigQueryKey,
  useUpdateFoodSafetyConfig,
  useResetFoodSafetyConfig,
  useListFoodSafetyRecords,
  getListFoodSafetyRecordsQueryKey,
  useGetFoodSafetyRecordByDate,
  getGetFoodSafetyRecordByDateQueryKey,
  useCreateFoodSafetyRecord,
  useUpdateFoodSafetyRecord,
  FoodSafetyRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { UtensilsCrossed, Settings, Plus, Trash2, CheckCircle2, Calendar, Save, Lock, ClipboardList, Thermometer, GripVertical, Sparkles, AlertTriangle, CheckCircle } from "lucide-react";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import WeeklyReviewTab from "./kitchen-weekly";
import ProbeCheckTab from "./kitchen-probe";
import CleaningScheduleTab from "./kitchen-cleaning";

// CookSafe All-in-One Record field shapes
type DeliveryRow = {
  supplier: string;           // Supplier name
  items: string;              // Details of food items
  vanClean: string;           // Van cleanliness "yes"|"no"|""
  rawCookedSep: string;       // Raw/cooked separated "yes"|"no"|""
  tempChilled: string;        // Chilled delivery temp (°C) — limit 8°C
  tempFrozen: string;         // Frozen delivery temp (°C) — limit -15°C
  tempOk: string;             // Food temp within limits "yes"|"no"|""
  conditionOk: string;        // Packaging/condition ok "yes"|"no"|""
  dateCodesOk: string;        // Within use-by/best-before "yes"|"no"|""
  allergyAware: string;       // Allergy awareness "yes"|"no"|""
  correctiveActions: string;  // Actions taken if any failures
};
type ColdFoodRow = {
  unit: string;               // "Fridge 1", "Freezer 1" etc
  tempAm: string;             // AM temperature reading (°C)
  tempPm: string;             // PM temperature reading (°C)
  correctiveAction: string;   // Action if out of range
};
type CookingRow = {
  item: string;
  timeStart: string;          // Time started cooking
  timeFinish: string;         // Time finished cooking
  coreTemp: string;           // Core temp at end (°C)
};
type CoolingRow = {
  item: string;
  timeStart: string;          // Time cooling started
  timeFinish: string;         // Time cooling finished
  coreTemp: string;           // Core temp after cooling (°C) — target ≤8°C within 90 min
};
type ReheatingRow = {
  item: string;
  timeStart: string;          // Time reheating started
  timeFinish: string;         // Time finished reheating
  coreTemp: string;           // Core temp (°C)
};
type HotHoldingRow = {
  item: string;
  coreTemp: string;           // Core temperature (°C)
  timeOfCheck: string;        // Time of check (HH:mm)
};
type SousVideRow = {
  item: string;               // Food item
  targetTemp: string;         // Target bath temperature (°C)
  waterTemp: string;          // Actual bath temperature (°C)
  timeStarted: string;        // Cooking start time
  timeFinished: string;       // Cooking finish time
  coreTemp: string;           // Core probe temp at end (°C)
  result: string;             // "pass"|"fail"|""
  notes: string;
};

type ActiveTab = "diary" | "weekly" | "probe" | "cleaning";

// ── helpers ────────────────────────────────────────────────────────────────────
function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T[]; } catch { return fallback; }
}
function parseStringArray(raw: string | undefined | null): string[] {
  return parseJsonArray<string>(raw);
}

/** Returns elapsed minutes between two HH:mm strings, null if either is blank. */
function coolingMins(start: string, finish: string): number | null {
  if (!start || !finish) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [fh, fm] = finish.split(":").map(Number);
  if ([sh, sm, fh, fm].some(isNaN)) return null;
  let m = (fh * 60 + fm) - (sh * 60 + sm);
  if (m < 0) m += 24 * 60; // overnight wrap
  return m;
}
type ColdUnit = { name: string; type: "fridge" | "freezer" };
function parseColdUnits(config: ReturnType<typeof useGetFoodSafetyConfig>["data"]): ColdUnit[] {
  const c = config as any;
  if (c?.food_cold_units) return parseJsonArray<ColdUnit>(c.food_cold_units);
  const nf = Number(c?.food_num_fridges || "2");
  const nz = Number(c?.food_num_freezers || "1");
  return [
    ...Array.from({ length: nf }, (_, i) => ({ name: `Fridge ${i + 1}`, type: "fridge" as const })),
    ...Array.from({ length: nz }, (_, i) => ({ name: `Freezer ${i + 1}`, type: "freezer" as const })),
  ];
}

// ── ConfigDialog ───────────────────────────────────────────────────────────────
function ConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetFoodSafetyConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateFoodSafetyConfig();
  const resetConfig = useResetFoodSafetyConfig();

  // Limits tab
  const [cookingLimit, setCookingLimit] = useState("Above 75°C (10 seconds)");
  const [coolingLimit, setCoolingLimit] = useState("8°C within 90 minutes");
  const [reheatingLimit, setReheatingLimit] = useState("Above 82°C");
  const [hotHoldingLimit, setHotHoldingLimit] = useState("Above 63°C");

  // Sections tab
  const [showDeliveries, setShowDeliveries] = useState(true);
  const [showColdFood, setShowColdFood] = useState(true);
  const [showHotTemp, setShowHotTemp] = useState(true);
  const [showCooling, setShowCooling] = useState(true);
  const [showReheating, setShowReheating] = useState(true);
  const [showHotHolding, setShowHotHolding] = useState(true);
  const [showSousVide, setShowSousVide] = useState(true);

  // Cold storage tab
  const [coldUnits, setColdUnits] = useState<ColdUnit[]>([]);

  // Default items tab
  const [defaultHotItems, setDefaultHotItems] = useState<string[]>([]);
  const [defaultHoldingItems, setDefaultHoldingItems] = useState<string[]>([]);
  const [defaultSvItems, setDefaultSvItems] = useState<string[]>([]);

  useEffect(() => {
    if (!config) return;
    setCookingLimit(config.food_cooking_limit || "Above 75°C (10 seconds)");
    setCoolingLimit(config.food_cooling_limit || "8°C within 90 minutes");
    setReheatingLimit(config.food_reheating_limit || "Above 82°C");
    setHotHoldingLimit(config.food_hot_holding_limit || "Above 63°C");
    setShowDeliveries(config.food_show_deliveries !== "false");
    setShowColdFood(config.food_show_cold_food !== "false");
    setShowHotTemp(config.food_show_hot_temperature !== "false");
    setShowCooling((config.food_show_cooling ?? config.food_show_hot_temperature) !== "false");
    setShowReheating((config.food_show_reheating ?? config.food_show_hot_temperature) !== "false");
    setShowHotHolding(config.food_show_hot_holding !== "false");
    setShowSousVide(config.food_show_sous_vide !== "false");
    setColdUnits(parseColdUnits(config));
    setDefaultHotItems(parseStringArray(config.food_default_hot_items));
    setDefaultHoldingItems(parseStringArray(config.food_default_holding_items));
    setDefaultSvItems(parseStringArray(config.food_default_sv_items));
  }, [config, open]);

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          food_cooking_limit: cookingLimit,
          food_cooling_limit: coolingLimit,
          food_reheating_limit: reheatingLimit,
          food_hot_holding_limit: hotHoldingLimit,
          food_show_deliveries: showDeliveries ? "true" : "false",
          food_show_cold_food: showColdFood ? "true" : "false",
          food_show_hot_temperature: showHotTemp ? "true" : "false",
          food_show_cooling: showCooling ? "true" : "false",
          food_show_reheating: showReheating ? "true" : "false",
          food_show_hot_holding: showHotHolding ? "true" : "false",
          food_show_sous_vide: showSousVide ? "true" : "false",
          food_cold_units: JSON.stringify(coldUnits.map(u => ({ ...u, name: u.name.trim() })).filter(u => u.name)),
          food_default_hot_items: JSON.stringify(defaultHotItems.filter(Boolean)),
          food_default_holding_items: JSON.stringify(defaultHoldingItems.filter(Boolean)),
          food_default_sv_items: JSON.stringify(defaultSvItems.filter(Boolean)),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetFoodSafetyConfigQueryKey() });
          toast({ title: "Template saved", description: "New diary days will use these defaults automatically." });
          setOpen(false);
        },
        onError: (err: any) => {
          toast({ title: "Failed to save", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleReset = () => {
    if (!window.confirm("Reset the diary template to the default sections and rows? This cannot be undone.")) return;
    resetConfig.mutate(undefined as void, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetFoodSafetyConfigQueryKey() });
        toast({ title: "Template reset", description: "The diary template is back to its defaults." });
        setOpen(false);
      },
      onError: (err: any) => {
        toast({ title: "Failed to reset", description: err.message, variant: "destructive" });
      },
    });
  };

  // Reusable string-list editor
  const StringListEditor = ({
    items, onChange, placeholder,
  }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) => (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 items-center">
          <GripVertical className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <Input value={item} placeholder={placeholder} className="h-8 text-sm rounded-sm"
            onChange={e => { const n = [...items]; n[i] = e.target.value; onChange(n); }} />
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
            onClick={() => onChange(items.filter((_, x) => x !== i))}>
            <Trash2 className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...items, ""])}>
        <Plus className="w-3.5 h-3.5 mr-1.5" /> Add item
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="w-4 h-4 mr-2" />
          Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="font-display">Diary Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Configure once — every new diary day will use these settings automatically.
          </p>
        </DialogHeader>

        <Tabs defaultValue="sections" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0 w-full grid grid-cols-4">
            <TabsTrigger value="sections">Sections</TabsTrigger>
            <TabsTrigger value="cold">Cold Storage</TabsTrigger>
            <TabsTrigger value="items">Default Items</TabsTrigger>
            <TabsTrigger value="limits">Limits</TabsTrigger>
          </TabsList>

          {/* ── Sections tab ── */}
          <TabsContent value="sections" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground mb-3">
              Hide sections your kitchen doesn't use — they'll disappear from every diary day.
            </p>
            {([
              { label: "Deliveries", desc: "Supplier delivery checks", state: showDeliveries, set: setShowDeliveries },
              { label: "Cold Food Record", desc: "Fridge / freezer temperature checks", state: showColdFood, set: setShowColdFood },
              { label: "Cooking Record", desc: "Core temperatures when cooking", state: showHotTemp, set: setShowHotTemp },
              { label: "Cooling Record", desc: "Cool-down times and temperatures", state: showCooling, set: setShowCooling },
              { label: "Reheating Record", desc: "Core temperatures when reheating", state: showReheating, set: setShowReheating },
              { label: "Hot Holding / Off-Site", desc: "Food kept hot after cooking", state: showHotHolding, set: setShowHotHolding },
              { label: "Sous Vide", desc: "Low-temperature precision cooking", state: showSousVide, set: setShowSousVide },
            ] as const).map(({ label, desc, state, set }) => (
              <div key={label} className="flex items-center justify-between rounded-sm border border-border p-3">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
                <Switch checked={state} onCheckedChange={set} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-1">
              Cold Food temperature monitoring is required for daily food safety compliance — keep it enabled unless your kitchen has no cold storage.
            </p>
          </TabsContent>

          {/* ── Cold storage tab ── */}
          <TabsContent value="cold" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground mb-3">
              Name each fridge and freezer. These rows will appear pre-filled on every new diary day.
            </p>
            <div className="space-y-2">
              {coldUnits.map((unit, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <GripVertical className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <select
                    value={unit.type}
                    onChange={e => { const n = [...coldUnits]; n[i] = { ...n[i], type: e.target.value as "fridge" | "freezer" }; setColdUnits(n); }}
                    className="h-8 rounded-sm border border-input bg-background px-2 text-sm"
                  >
                    <option value="fridge">Fridge</option>
                    <option value="freezer">Freezer</option>
                  </select>
                  <Input value={unit.name} placeholder="e.g. Walk-in Fridge"
                    className="h-8 text-sm rounded-sm flex-1"
                    onChange={e => { const n = [...coldUnits]; n[i] = { ...n[i], name: e.target.value }; setColdUnits(n); }} />
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
                    onClick={() => setColdUnits(coldUnits.filter((_, x) => x !== i))}>
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => setColdUnits([...coldUnits, { name: "", type: "fridge" }])}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Fridge
                </Button>
                <Button variant="outline" size="sm" onClick={() => setColdUnits([...coldUnits, { name: "", type: "freezer" }])}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Freezer
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground pt-2">
              Fridge limit: ≤5°C · Freezer limit: ≤-18°C
            </p>
          </TabsContent>

          {/* ── Default items tab ── */}
          <TabsContent value="items" className="flex-1 overflow-y-auto space-y-6 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              Pre-populate rows with your standard menu items so staff don't have to type them every day.
            </p>

            <div className="space-y-2">
              <Label className="text-sm font-semibold">Hot Temperature items</Label>
              <p className="text-xs text-muted-foreground">Dishes you cook fresh each day (e.g. Roast Chicken, Beef Stew)</p>
              <StringListEditor items={defaultHotItems} onChange={setDefaultHotItems} placeholder="e.g. Roast Chicken" />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-semibold">Hot Holding items</Label>
              <p className="text-xs text-muted-foreground">Items kept hot for service (e.g. Chips, Gravy, Soup)</p>
              <StringListEditor items={defaultHoldingItems} onChange={setDefaultHoldingItems} placeholder="e.g. Chips" />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-semibold">Sous Vide items</Label>
              <p className="text-xs text-muted-foreground">Items you regularly cook sous vide</p>
              <StringListEditor items={defaultSvItems} onChange={setDefaultSvItems} placeholder="e.g. Duck Breast" />
            </div>
          </TabsContent>

          {/* ── Limits tab ── */}
          <TabsContent value="limits" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <p className="text-xs text-muted-foreground mb-3">
              These limits appear as guidance text on every diary day. The defaults match UK food safety legislation.
            </p>
            <div className="space-y-1.5">
              <Label>Cooking temperature limit</Label>
              <Input value={cookingLimit} placeholder="Above 75°C (10 seconds)"
                onChange={e => setCookingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">UK default: Above 75°C for 10 seconds (Scotland: 82°C)</p>
            </div>
            <div className="space-y-1.5">
              <Label>Cooling limit</Label>
              <Input value={coolingLimit} placeholder="8°C within 90 minutes"
                onChange={e => setCoolingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">Cool to 8°C or below within 90 minutes</p>
            </div>
            <div className="space-y-1.5">
              <Label>Reheating limit</Label>
              <Input value={reheatingLimit} placeholder="Above 82°C"
                onChange={e => setReheatingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">Scotland: 82°C · England/Wales/NI: 75°C</p>
            </div>
            <div className="space-y-1.5">
              <Label>Hot holding minimum</Label>
              <Input value={hotHoldingLimit} placeholder="Above 63°C"
                onChange={e => setHotHoldingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">UK default: Above 63°C at all times</p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="shrink-0 pt-2 border-t border-border mt-2 sm:justify-between">
          <Button variant="ghost" className="text-destructive hover:text-destructive"
            onClick={handleReset} disabled={resetConfig.isPending || updateConfig.isPending}>
            {resetConfig.isPending ? "Resetting…" : "Reset to defaults"}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={updateConfig.isPending}>
              {updateConfig.isPending ? "Saving…" : "Save template"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Daily Diary tab ───────────────────────────────────────────────────────────

function DailyDiaryTab() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const { data: config } = useGetFoodSafetyConfig();
  const { data: records } = useListFoodSafetyRecords();
  const { data: record, isLoading: recordLoading } = useGetFoodSafetyRecordByDate(selectedDate, {
    query: {
      enabled: !!selectedDate,
      queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate),
      retry: false,
    },
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createRecord = useCreateFoodSafetyRecord();
  const updateRecord = useUpdateFoodSafetyRecord();

  // ── Derived template values from config ─────────────────────────────────────
  const cookingLimit = config?.food_cooking_limit || "Above 75°C (10 seconds)";
  const coolingLimit = config?.food_cooling_limit || "8°C within 90 minutes";
  const reheatingLimit = config?.food_reheating_limit || "Above 82°C";
  const hotHoldingLimit = config?.food_hot_holding_limit || "Above 63°C";

  // Section visibility — default true unless explicitly disabled
  const showDeliveries = config?.food_show_deliveries !== "false";
  const showColdFood = config?.food_show_cold_food !== "false";
  const showHotTemp = config?.food_show_hot_temperature !== "false";
  // Cooling/reheating fall back to the grouped hot-temperature toggle for
  // templates saved before they became independent sections.
  const showCooling = (config?.food_show_cooling ?? config?.food_show_hot_temperature) !== "false";
  const showReheating = (config?.food_show_reheating ?? config?.food_show_hot_temperature) !== "false";
  const showHotHolding = config?.food_show_hot_holding !== "false";
  const showSousVide = config?.food_show_sous_vide !== "false";

  // Default items for new records
  const templateColdUnits = parseColdUnits(config);
  const templateHotItems = parseStringArray(config?.food_default_hot_items);
  const templateHoldingItems = parseStringArray(config?.food_default_holding_items);
  const templateSvItems = parseStringArray(config?.food_default_sv_items);

  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [coldFood, setColdFood] = useState<ColdFoodRow[]>([]);
  const [cooking, setCooking] = useState<CookingRow[]>([]);
  const [cooling, setCooling] = useState<CoolingRow[]>([]);
  const [reheating, setReheating] = useState<ReheatingRow[]>([]);
  const [hotHolding, setHotHolding] = useState<HotHoldingRow[]>([]);
  const [sousVide, setSousVide] = useState<SousVideRow[]>([]);
  const [correctives, setCorrectives] = useState("");
  const [managerSignature, setManagerSignature] = useState(user?.name ?? "");

  useEffect(() => {
    if (record) {
      setDeliveries((record.deliveries || []) as DeliveryRow[]);
      setColdFood((record.coldFood || []) as ColdFoodRow[]);

      // Support old combined-row format (cookTimeStart field) — migrate to split arrays
      const rawHot: any[] = (record.hotTemperature || []) as any[];
      const isOldFormat = rawHot.some(r => "cookTimeStart" in r || "coolTimeStart" in r);
      if (isOldFormat) {
        setCooking(rawHot.map(r => ({ item: r.item || "", timeStart: r.cookTimeStart || "", timeFinish: r.cookTimeFinish || "", coreTemp: r.cookCoreTemp || "" })));
        setCooling(rawHot.filter(r => r.coolTimeStart || r.coolTimeFinish).map(r => ({ item: r.item || "", timeStart: r.coolTimeStart || "", timeFinish: r.coolTimeFinish || "", coreTemp: "" })));
        setReheating(rawHot.filter(r => r.reheatCoreTemp).map(r => ({ item: r.item || "", timeStart: "", timeFinish: "", coreTemp: r.reheatCoreTemp || "" })));
      } else {
        setCooking(rawHot as CookingRow[]);
        setCooling(((record as any).cooling || []) as CoolingRow[]);
        setReheating(((record as any).reheating || []) as ReheatingRow[]);
      }

      setHotHolding((record.hotHolding || []) as HotHoldingRow[]);
      setSousVide(((record as any).sousVide || []) as SousVideRow[]);
      setCorrectives(record.correctives || "");
      setManagerSignature(record.managerSignature || user?.name || "");
    } else {
      // New record — initialise from template
      const coldRows: ColdFoodRow[] = templateColdUnits.map(u => ({
        unit: u.name, tempAm: "", tempPm: "", correctiveAction: "",
      }));
      const cookingRows: CookingRow[] = templateHotItems.map(item => ({
        item, timeStart: "", timeFinish: "", coreTemp: "",
      }));
      const holdingRows: HotHoldingRow[] = templateHoldingItems.map(item => ({
        item, coreTemp: "", timeOfCheck: "",
      }));
      const svRows: SousVideRow[] = templateSvItems.map(item => ({
        item, targetTemp: "", waterTemp: "", timeStarted: "", timeFinished: "", coreTemp: "", result: "", notes: "",
      }));
      setDeliveries([]);
      setColdFood(coldRows);
      setCooking(cookingRows);
      setCooling([]);
      setReheating([]);
      setHotHolding(holdingRows);
      setSousVide(svRows);
      setCorrectives("");
      setManagerSignature("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, selectedDate]);

  const buildData = (submittedAt?: string) => ({
    recordDate: selectedDate,
    deliveries,
    coldFood,
    hotTemperature: cooking,
    cooling,
    reheating,
    hotHolding,
    sousVide,
    cookingLimit,
    coolingLimit,
    reheatingLimit,
    hotHoldingLimit,
    correctives: correctives || undefined,
    managerSignature: managerSignature || undefined,
    submittedAt,
  });

  const handleSaveDraft = async () => {
    const data = buildData(undefined);

    if (record) {
      updateRecord.mutate(
        { id: record.id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Draft saved" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to save", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createRecord.mutate(
        { data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Draft created" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to create", description: error.message, variant: "destructive" });
          },
        }
      );
    }
  };

  const handleSubmit = async () => {
    if (!managerSignature.trim()) {
      toast({ title: "Manager signature required", variant: "destructive" });
      return;
    }
    const data = buildData(new Date().toISOString());
    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
      queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
      toast({ title: "Diary filed", description: "Kitchen diary signed off and stored." });
    };
    const onError = (error: any) => toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
    if (record) {
      updateRecord.mutate({ id: record.id, data }, { onSuccess, onError });
    } else {
      createRecord.mutate({ data }, { onSuccess, onError });
    }
  };

  const isSubmitted = !!record?.submittedAt;

  return (
    <div className="space-y-6">
      {/* Date Picker */}
      <Card>
        <CardHeader className="border-b border-border/50 pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-display">Select Date</CardTitle>
            {isSubmitted && (
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Submitted
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <Label className="text-sm">Date:</Label>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="max-w-xs"
            />
          </div>
        </CardContent>
      </Card>

      {recordLoading ? (
        <Card>
          <CardContent className="p-12 flex justify-center">
            <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Filed banner */}
          {isSubmitted && record?.submittedAt && (
            <Card className="border-emerald-200 bg-emerald-50">
              <CardContent className="py-4 px-6 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <p className="font-medium text-emerald-800">Diary filed</p>
                  <p className="text-sm text-emerald-700">
                    Signed off by <span className="font-medium">{record.managerSignature || "—"}</span> on {format(new Date(record.submittedAt), "EEEE d MMMM yyyy 'at' HH:mm")}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Deliveries */}
          {showDeliveries && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Deliveries</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    Chilled limit: ≤8°C · Frozen limit: ≤-15°C
                  </CardDescription>
                </div>
                {!isSubmitted && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setDeliveries([...deliveries, {
                      supplier: "", items: "", vanClean: "", rawCookedSep: "",
                      tempChilled: "", tempFrozen: "", tempOk: "", conditionOk: "",
                      dateCodesOk: "", allergyAware: "", correctiveActions: "",
                    }])}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Delivery
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {deliveries.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No deliveries recorded today.</p>
              ) : deliveries.map((row, i) => {
                const upd = (field: keyof DeliveryRow, val: string) => {
                  const next = [...deliveries]; next[i] = { ...next[i], [field]: val }; setDeliveries(next);
                };
                const YNBtn = ({ field, label }: { field: keyof DeliveryRow; label: string }) => (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <div className="flex gap-1">
                      {["yes", "no"].map(v => (
                        <button key={v} disabled={isSubmitted}
                          onClick={() => upd(field, row[field] === v ? "" : v)}
                          className={cn(
                            "px-2 py-0.5 text-xs rounded-sm border transition-colors",
                            row[field] === v
                              ? v === "yes" ? "bg-emerald-500 text-white border-emerald-500" : "bg-rose-500 text-white border-rose-500"
                              : "border-border text-muted-foreground hover:border-primary"
                          )}>{v === "yes" ? "Yes" : "No"}</button>
                      ))}
                    </div>
                  </div>
                );
                return (
                  <div key={i} className="border border-border rounded-sm p-3 space-y-3 bg-muted/10">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Delivery {i + 1}</span>
                      {!isSubmitted && (
                        <Button variant="ghost" size="sm" onClick={() => setDeliveries(deliveries.filter((_, x) => x !== i))}>
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Supplier's name</p>
                        <Input placeholder="Supplier" value={row.supplier} disabled={isSubmitted}
                          onChange={e => upd("supplier", e.target.value)} className="h-8 text-sm rounded-sm" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Details of food items</p>
                        <Input placeholder="Food items delivered" value={row.items} disabled={isSubmitted}
                          onChange={e => upd("items", e.target.value)} className="h-8 text-sm rounded-sm" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <YNBtn field="vanClean" label="Van clean?" />
                      <YNBtn field="rawCookedSep" label="Raw/cooked separated?" />
                      <YNBtn field="conditionOk" label="Food condition / packaging?" />
                      <YNBtn field="dateCodesOk" label="Within date codes?" />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Chilled temp (°C)</p>
                        <Input placeholder="e.g. 4" value={row.tempChilled} disabled={isSubmitted}
                          onChange={e => upd("tempChilled", e.target.value)} className="h-8 text-sm rounded-sm" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Frozen temp (°C)</p>
                        <Input placeholder="e.g. -18" value={row.tempFrozen} disabled={isSubmitted}
                          onChange={e => upd("tempFrozen", e.target.value)} className="h-8 text-sm rounded-sm" />
                      </div>
                      <YNBtn field="tempOk" label="Temp within limits?" />
                      <YNBtn field="allergyAware" label="Allergy awareness?" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Corrective actions (if applicable)</p>
                      <Input placeholder="e.g. Rejected — temp too high. Supplier notified." value={row.correctiveActions} disabled={isSubmitted}
                        onChange={e => upd("correctiveActions", e.target.value)} className="h-8 text-sm rounded-sm" />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>}

          {/* Cold Food */}
          {showColdFood && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Cold Food Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Fridge limit: ≤5°C · Freezer limit: ≤-18°C · Recommended twice daily (AM &amp; PM)</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm"
                    onClick={() => setColdFood([...coldFood, { unit: "", tempAm: "", tempPm: "", correctiveAction: "" }])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Unit</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">AM temp (°C)</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">PM temp (°C)</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Corrective action</th>
                    {!isSubmitted && <th className="w-8 px-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {coldFood.map((row, i) => {
                    const upd = (f: keyof ColdFoodRow, v: string) => { const n = [...coldFood]; n[i] = { ...n[i], [f]: v }; setColdFood(n); };
                    return (
                      <tr key={i} className="hover:bg-muted/10">
                        <td className="px-3 py-1.5">
                          <Input value={row.unit} disabled={isSubmitted} onChange={e => upd("unit", e.target.value)}
                            className="h-7 text-xs rounded-sm" placeholder="Fridge 1" />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input value={row.tempAm} disabled={isSubmitted} onChange={e => upd("tempAm", e.target.value)}
                            className="h-7 text-xs rounded-sm w-24" placeholder="e.g. 3" />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input value={row.tempPm} disabled={isSubmitted} onChange={e => upd("tempPm", e.target.value)}
                            className="h-7 text-xs rounded-sm w-24" placeholder="e.g. 4" />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input value={row.correctiveAction} disabled={isSubmitted} onChange={e => upd("correctiveAction", e.target.value)}
                            className="h-7 text-xs rounded-sm" placeholder="Action taken if out of range" />
                        </td>
                        {!isSubmitted && (
                          <td className="px-2 py-1.5">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                              onClick={() => setColdFood(coldFood.filter((_, x) => x !== i))}>
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* ── Cooking ──────────────────────────────────────────────────── */}
          {showHotTemp && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Cooking Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Target: {cookingLimit}</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setCooking([...cooking, { item: "", timeStart: "", timeFinish: "", coreTemp: "" }])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Food item</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Time started</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Time finished</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Core temp (°C)</th>
                    {!isSubmitted && <th className="w-8" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cooking.length === 0
                    ? <tr><td colSpan={5} className="px-4 py-5 text-center text-muted-foreground italic text-sm">No cooking records yet.</td></tr>
                    : cooking.map((row, i) => {
                      const upd = (f: keyof CookingRow, v: string) => { const n = [...cooking]; n[i] = { ...n[i], [f]: v }; setCooking(n); };
                      return (
                        <tr key={i} className="hover:bg-muted/10">
                          <td className="px-3 py-1.5"><Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)} className="h-7 text-xs rounded-sm min-w-[110px]" placeholder="e.g. Chicken" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeStart} disabled={isSubmitted} onChange={e => upd("timeStart", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeFinish} disabled={isSubmitted} onChange={e => upd("timeFinish", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder="°C" /></td>
                          {!isSubmitted && <td className="px-2 py-1.5"><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setCooking(cooking.filter((_, x) => x !== i))}><Trash2 className="w-3 h-3 text-destructive" /></Button></td>}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* ── Cooling ──────────────────────────────────────────────────── */}
          {showCooling && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Cooling Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Target: {coolingLimit} · Rows exceeding 90 minutes are flagged red</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setCooling([...cooling, { item: "", timeStart: "", timeFinish: "", coreTemp: "" }])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Food item</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Cooling started</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Cooling finished</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Duration</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">End temp (°C)</th>
                    {!isSubmitted && <th className="w-8" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cooling.length === 0
                    ? <tr><td colSpan={6} className="px-4 py-5 text-center text-muted-foreground italic text-sm">No cooling records yet.</td></tr>
                    : cooling.map((row, i) => {
                      const upd = (f: keyof CoolingRow, v: string) => { const n = [...cooling]; n[i] = { ...n[i], [f]: v }; setCooling(n); };
                      const mins = coolingMins(row.timeStart, row.timeFinish);
                      const overTime = mins !== null && mins > 90;
                      const durationLabel = mins === null ? "" : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                      return (
                        <tr key={i} className={cn("hover:bg-muted/10", overTime && "bg-rose-50")}>
                          <td className="px-3 py-1.5"><Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)} className="h-7 text-xs rounded-sm min-w-[110px]" placeholder="e.g. Soup" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeStart} disabled={isSubmitted} onChange={e => upd("timeStart", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeFinish} disabled={isSubmitted} onChange={e => upd("timeFinish", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5">
                            <span className={cn("text-xs font-medium", overTime ? "text-rose-600" : "text-muted-foreground")}>
                              {overTime && <AlertTriangle className="w-3 h-3 inline mr-0.5" />}{durationLabel}
                            </span>
                          </td>
                          <td className="px-2 py-1.5"><Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder="°C" /></td>
                          {!isSubmitted && <td className="px-2 py-1.5"><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setCooling(cooling.filter((_, x) => x !== i))}><Trash2 className="w-3 h-3 text-destructive" /></Button></td>}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* ── Reheating ────────────────────────────────────────────────── */}
          {showReheating && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Reheating Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Target: {reheatingLimit}</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setReheating([...reheating, { item: "", timeStart: "", timeFinish: "", coreTemp: "" }])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Food item</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Time started</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Time finished</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Core temp (°C)</th>
                    {!isSubmitted && <th className="w-8" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {reheating.length === 0
                    ? <tr><td colSpan={5} className="px-4 py-5 text-center text-muted-foreground italic text-sm">No reheating records yet.</td></tr>
                    : reheating.map((row, i) => {
                      const upd = (f: keyof ReheatingRow, v: string) => { const n = [...reheating]; n[i] = { ...n[i], [f]: v }; setReheating(n); };
                      return (
                        <tr key={i} className="hover:bg-muted/10">
                          <td className="px-3 py-1.5"><Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)} className="h-7 text-xs rounded-sm min-w-[110px]" placeholder="e.g. Curry" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeStart} disabled={isSubmitted} onChange={e => upd("timeStart", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeFinish} disabled={isSubmitted} onChange={e => upd("timeFinish", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder="°C" /></td>
                          {!isSubmitted && <td className="px-2 py-1.5"><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setReheating(reheating.filter((_, x) => x !== i))}><Trash2 className="w-3 h-3 text-destructive" /></Button></td>}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* Hot Holding */}
          {showHotHolding && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Hot Holding / Off-Site Temperature Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Minimum: {hotHoldingLimit}</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm"
                    onClick={() => setHotHolding([...hotHolding, { item: "", coreTemp: "", timeOfCheck: "" }])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Food Item</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Core Temp (°C)</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Time of Check</th>
                    {!isSubmitted && <th className="w-8 px-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {hotHolding.length === 0 ? (
                    <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground italic text-sm">No hot holding checks recorded.</td></tr>
                  ) : hotHolding.map((row, i) => {
                    const upd = (f: keyof HotHoldingRow, v: string) => { const n = [...hotHolding]; n[i] = { ...n[i], [f]: v }; setHotHolding(n); };
                    return (
                      <tr key={i} className="hover:bg-muted/10">
                        <td className="px-3 py-1.5">
                          <Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)}
                            className="h-7 text-xs rounded-sm" placeholder="Food item" />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)}
                            className="h-7 text-xs rounded-sm w-24" placeholder="e.g. 65" />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input type="time" value={row.timeOfCheck} disabled={isSubmitted} onChange={e => upd("timeOfCheck", e.target.value)}
                            className="h-7 text-xs rounded-sm w-28" />
                        </td>
                        {!isSubmitted && (
                          <td className="px-2 py-1.5">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                              onClick={() => setHotHolding(hotHolding.filter((_, x) => x !== i))}>
                              <Trash2 className="w-3.5 h-3.5 text-destructive" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* Sous Vide */}
          {showSousVide && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Sous Vide Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Log bath temperature, cooking duration and core probe temperature</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setSousVide([...sousVide, {
                    item: "", targetTemp: "", waterTemp: "", timeStarted: "", timeFinished: "", coreTemp: "", result: "", notes: "",
                  }])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead className="bg-muted/40 border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Food item</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Target bath (°C)</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Actual bath (°C)</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Time in</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Time out</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Core temp (°C)</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Result</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Notes</th>
                      {!isSubmitted && <th className="w-8" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sousVide.length === 0 ? (
                      <tr><td colSpan={9} className="px-4 py-6 text-center text-muted-foreground italic text-sm">No sous vide records yet.</td></tr>
                    ) : sousVide.map((row, i) => {
                      const upd = (f: keyof SousVideRow, v: string) => { const n = [...sousVide]; n[i] = { ...n[i], [f]: v }; setSousVide(n); };
                      return (
                        <tr key={i} className="hover:bg-muted/10">
                          <td className="px-3 py-1.5">
                            <Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)}
                              className="h-7 text-xs rounded-sm min-w-[110px]" placeholder="e.g. Chicken breast" />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input value={row.targetTemp} disabled={isSubmitted} onChange={e => upd("targetTemp", e.target.value)}
                              className="h-7 text-xs rounded-sm w-16" placeholder="63" />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input value={row.waterTemp} disabled={isSubmitted} onChange={e => upd("waterTemp", e.target.value)}
                              className="h-7 text-xs rounded-sm w-16" placeholder="63.2" />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input type="time" value={row.timeStarted} disabled={isSubmitted} onChange={e => upd("timeStarted", e.target.value)}
                              className="h-7 text-xs rounded-sm w-24" />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input type="time" value={row.timeFinished} disabled={isSubmitted} onChange={e => upd("timeFinished", e.target.value)}
                              className="h-7 text-xs rounded-sm w-24" />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)}
                              className="h-7 text-xs rounded-sm w-16" placeholder="°C" />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              {["pass", "fail"].map(v => (
                                <button key={v} disabled={isSubmitted}
                                  onClick={() => upd("result", row.result === v ? "" : v)}
                                  className={cn(
                                    "px-2 py-0.5 text-xs rounded-sm border transition-colors",
                                    row.result === v
                                      ? v === "pass" ? "bg-emerald-500 text-white border-emerald-500" : "bg-rose-500 text-white border-rose-500"
                                      : "border-border text-muted-foreground"
                                  )}>{v === "pass" ? "Pass" : "Fail"}</button>
                              ))}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <Input value={row.notes} disabled={isSubmitted} onChange={e => upd("notes", e.target.value)}
                              className="h-7 text-xs rounded-sm min-w-[100px]" placeholder="Notes" />
                          </td>
                          {!isSubmitted && (
                            <td className="px-2 py-1.5">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                                onClick={() => setSousVide(sousVide.filter((_, x) => x !== i))}>
                                <Trash2 className="w-3 h-3 text-destructive" />
                              </Button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>}

          {/* Correctives */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Corrective Actions Taken</CardTitle>
              <CardDescription className="text-xs mt-1">
                Note any issues found and what was done to fix them
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              <Textarea
                value={correctives}
                onChange={(e) => setCorrectives(e.target.value)}
                rows={3}
                placeholder="e.g. Fridge 2 running warm — engineer called, stock moved to Fridge 1"
                disabled={isSubmitted}
              />
            </CardContent>
          </Card>

          {/* Sign-off */}
          {!isSubmitted && (
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Sign off &amp; File</CardTitle>
              <CardDescription className="text-xs mt-1">Once filed, all entries are locked. Use "Save Draft" to save progress without locking.</CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Manager Name (Signature)</Label>
                  <Input
                    value={managerSignature}
                    onChange={(e) => setManagerSignature(e.target.value)}
                    placeholder="Type your name to sign"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="outline" onClick={handleSaveDraft} disabled={createRecord.isPending || updateRecord.isPending}>
                    <Save className="w-4 h-4 mr-2" />Save Draft
                  </Button>
                  <Button onClick={handleSubmit} disabled={createRecord.isPending || updateRecord.isPending} className="shadow-lg shadow-primary/20">
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    {createRecord.isPending || updateRecord.isPending ? "Filing..." : "File Diary"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          )}

          {/* Photos */}
          {record?.id && (
            <CheckPhotoUploader entityType="food_safety_record" entityId={record.id} />
          )}
        </>
      )}

      {/* Missing Days Alert */}
      {records !== undefined && (() => {
        const hasRecord = new Set(records.map((r) => r.recordDate));
        const submitted = new Set(records.filter((r) => r.submittedAt).map((r) => r.recordDate));
        const missing: string[] = [];
        const draftsOnly: string[] = [];
        for (let i = 1; i <= 30; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const ds = format(d, "yyyy-MM-dd");
          if (!hasRecord.has(ds)) {
            missing.push(ds);
          } else if (!submitted.has(ds)) {
            draftsOnly.push(ds);
          }
        }
        if (missing.length === 0 && draftsOnly.length === 0) return null;
        const DateButton = ({ ds, variant }: { ds: string; variant: "missing" | "draft" }) => (
          <button
            key={ds}
            onClick={() => setSelectedDate(ds)}
            className={
              variant === "missing"
                ? "text-xs px-2 py-1 rounded-md bg-red-100 hover:bg-red-200 text-red-800 border border-red-200 transition-colors font-medium dark:bg-red-900/40 dark:text-red-300 dark:border-red-700 dark:hover:bg-red-900/60"
                : "text-xs px-2 py-1 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-200 transition-colors font-medium dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700 dark:hover:bg-amber-900/60"
            }
            title={`Open diary for ${ds}`}
          >
            {format(new Date(ds + "T12:00:00"), "d MMM")}
          </button>
        );
        return (
          <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20">
            <CardHeader className="pb-3 border-b border-amber-200/60">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <CardTitle className="text-sm font-medium text-amber-800 dark:text-amber-400">
                  {missing.length > 0 && draftsOnly.length > 0
                    ? `${missing.length} missing + ${draftsOnly.length} draft-only ${missing.length + draftsOnly.length === 1 ? "day" : "days"} in the last 30 days`
                    : missing.length > 0
                      ? `${missing.length} ${missing.length === 1 ? "day" : "days"} with no food safety record in the last 30 days`
                      : `${draftsOnly.length} ${draftsOnly.length === 1 ? "day" : "days"} with an unsubmitted draft in the last 30 days`}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-3 pb-4 space-y-3">
              {missing.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1.5">No record filed:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {missing.slice(0, 20).map((ds) => <DateButton key={ds} ds={ds} variant="missing" />)}
                    {missing.length > 20 && (
                      <span className="text-xs text-red-700 self-center pl-1">+{missing.length - 20} more</span>
                    )}
                  </div>
                </div>
              )}
              {draftsOnly.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1.5">Draft not submitted:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {draftsOnly.slice(0, 20).map((ds) => <DateButton key={ds} ds={ds} variant="draft" />)}
                    {draftsOnly.length > 20 && (
                      <span className="text-xs text-amber-700 self-center pl-1">+{draftsOnly.length - 20} more</span>
                    )}
                  </div>
                </div>
              )}
              <p className="text-xs text-amber-700 dark:text-amber-400">Click a date to open the diary entry for that day.</p>
            </CardContent>
          </Card>
        );
      })()}

      {/* History */}
      <Card>
        <CardHeader className="border-b border-border/50 pb-4">
          <CardTitle className="font-display">Recent Records</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!records || records.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <Calendar className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">No kitchen diary records yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {records.slice(0, 10).map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedDate(r.recordDate)}
                  className="w-full p-4 hover:bg-muted/20 transition-colors text-left flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span className="font-medium text-sm">{format(new Date(r.recordDate), "dd/MM/yyyy")}</span>
                  </div>
                  {r.submittedAt ? (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Submitted
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                      Draft
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

// ── Kitchen check status helpers ──────────────────────────────────────────────

type KitchenCheckStatus = { checkType: string; frequencyDays: number; lastDate: string | null; dueDate: string | null; status: "ok" | "due_soon" | "overdue" | "never" };

const KITCHEN_CHECK_LABELS: Record<string, string> = {
  daily_diary:     "Daily Diary",
  weekly_review:   "Weekly Review",
  probe_check:     "Probe Check",
  cleaning_daily:  "Daily Cleaning",
  cleaning_weekly: "Weekly Cleaning",
  cleaning_monthly:"Monthly Cleaning",
};

const KITCHEN_CHECK_TAB: Record<string, ActiveTab> = {
  daily_diary:     "diary",
  weekly_review:   "weekly",
  probe_check:     "probe",
  cleaning_daily:  "cleaning",
  cleaning_weekly: "cleaning",
  cleaning_monthly:"cleaning",
};

function KitchenStatusBadge({ status }: { status: KitchenCheckStatus["status"] }) {
  if (status === "overdue")  return <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 shrink-0"><AlertTriangle className="w-3 h-3 mr-1" />Overdue</Badge>;
  if (status === "due_soon") return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 shrink-0">Due</Badge>;
  if (status === "ok")       return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0"><CheckCircle className="w-3 h-3 mr-1" />OK</Badge>;
  return <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 shrink-0">Never</Badge>;
}

const TABS: { id: ActiveTab; label: string; icon: any; description: string }[] = [
  { id: "diary",    label: "Daily Diary",         icon: Calendar,      description: "Daily temperature records, deliveries and corrective actions" },
  { id: "weekly",   label: "Weekly Review",        icon: ClipboardList, description: "Combined CookSafe house rules + management review" },
  { id: "probe",    label: "Probe Check",          icon: Thermometer,   description: "Monthly probe thermometer calibration record" },
  { id: "cleaning", label: "Cleaning Schedule",    icon: Sparkles,      description: "Daily, weekly and monthly cleaning task schedule and sign-off" },
];

export default function KitchenPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasKitchentrack = hasService("kitchentrack");

  const { error: configError } = useGetFoodSafetyConfig({
    query: { enabled: hasKitchentrack, retry: (count, err: any) => err?.status !== 403 && count < 3, queryKey: getGetFoodSafetyConfigQueryKey() },
  });
  const serverLocked = (configError as any)?.status === 403;

  const [activeTab, setActiveTab] = useState<ActiveTab>("diary");
  const [checkStatus, setCheckStatus] = useState<KitchenCheckStatus[]>([]);

  const loadStatus = useCallback(async () => {
    try {
      const r = await apiFetch("/food-safety/status");
      if (r.ok) setCheckStatus(await r.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => { if (hasKitchentrack) loadStatus(); }, [hasKitchentrack, loadStatus]);

  if (!hasKitchentrack || serverLocked) {
    return (
      <AppLayout title="KitchenTrack — Kitchen Diary">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">KitchenTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital food safety diary — record deliveries, temperatures, and actions.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button size="lg" className="w-full sm:w-auto font-medium">
                      Enable KitchenTrack
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

  const activeTabMeta = TABS.find(t => t.id === activeTab)!;

  return (
    <AppLayout title="KitchenTrack">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <UtensilsCrossed className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">{activeTabMeta.description}</p>
          </div>
          {activeTab === "diary" && canAdmin && <ConfigDialog />}
        </div>

        {/* Check status cards */}
        {checkStatus.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {checkStatus.map(item => (
              <Card
                key={item.checkType}
                className={cn(
                  "border-l-4 transition-all hover:shadow-md cursor-pointer group",
                  item.status === "overdue"  ? "border-l-rose-500 bg-rose-50/50" :
                  item.status === "due_soon" ? "border-l-amber-500 bg-amber-50/50" :
                  item.status === "never"    ? "border-l-slate-400 bg-slate-50/50" :
                                               "border-l-emerald-500 bg-emerald-50/50"
                )}
                onClick={() => setActiveTab(KITCHEN_CHECK_TAB[item.checkType] ?? "diary")}
              >
                <CardContent className="px-3 pt-3 pb-2 space-y-1">
                  <div className="flex items-start justify-between gap-1">
                    <p className="text-xs font-medium leading-snug">{KITCHEN_CHECK_LABELS[item.checkType] ?? item.checkType}</p>
                    <KitchenStatusBadge status={item.status} />
                  </div>
                  {item.lastDate && <p className="text-[11px] text-muted-foreground">Last: {format(new Date(item.lastDate), "dd/MM/yy")}</p>}
                  {item.dueDate  && <p className="text-[11px] text-muted-foreground">Due: {format(new Date(item.dueDate),  "dd/MM/yy")}</p>}
                  {item.status === "never" && <p className="text-[11px] text-muted-foreground italic">Not recorded</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 p-1 bg-muted/50 rounded-xl w-full sm:w-auto sm:inline-flex border border-border/50">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none justify-center",
                  activeTab === tab.id
                    ? "bg-background shadow text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/60"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        {activeTab === "diary"    && <DailyDiaryTab />}
        {activeTab === "weekly"   && <WeeklyReviewTab />}
        {activeTab === "probe"    && <ProbeCheckTab />}
        {activeTab === "cleaning" && <CleaningScheduleTab />}
      </div>
    </AppLayout>
  );
}
