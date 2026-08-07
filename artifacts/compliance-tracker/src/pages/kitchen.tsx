import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import {
  useGetFoodSafetyConfig,
  getGetFoodSafetyConfigQueryKey,
  useUpdateFoodSafetyConfig,
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
import { UtensilsCrossed, Settings, Plus, Trash2, CheckCircle2, Calendar, Save, Lock, ClipboardList, Thermometer, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import WeeklyReviewTab from "./kitchen-weekly";
import ProbeCheckTab from "./kitchen-probe";

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
type HotTemperatureRow = {
  item: string;
  cookTimeStart: string;      // Time started cooking
  cookTimeFinish: string;     // Time finished cooking
  cookCoreTemp: string;       // Core temp at end of cooking (°C)
  coolTimeStart: string;      // Time cooling started
  coolTimeFinish: string;     // Time cooling finished
  reheatCoreTemp: string;     // Core temp when reheated (°C)
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

type ActiveTab = "diary" | "weekly" | "probe";

// ── helpers ────────────────────────────────────────────────────────────────────
function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T[]; } catch { return fallback; }
}
function parseStringArray(raw: string | undefined | null): string[] {
  return parseJsonArray<string>(raw);
}
type ColdUnit = { name: string; type: "fridge" | "freezer" };
function parseColdUnits(config: ReturnType<typeof useGetFoodSafetyConfig>["data"]): ColdUnit[] {
  if (config?.food_cold_units) return parseJsonArray<ColdUnit>(config.food_cold_units);
  const nf = Number(config?.food_num_fridges || "2");
  const nz = Number(config?.food_num_freezers || "1");
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

  // Limits tab
  const [cookingLimit, setCookingLimit] = useState("Above 75°C (10 seconds)");
  const [coolingLimit, setCoolingLimit] = useState("8°C within 90 minutes");
  const [reheatingLimit, setReheatingLimit] = useState("Above 82°C");
  const [hotHoldingLimit, setHotHoldingLimit] = useState("Above 63°C");

  // Sections tab
  const [showDeliveries, setShowDeliveries] = useState(true);
  const [showHotTemp, setShowHotTemp] = useState(true);
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
    setShowHotTemp(config.food_show_hot_temperature !== "false");
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
          food_show_hot_temperature: showHotTemp ? "true" : "false",
          food_show_hot_holding: showHotHolding ? "true" : "false",
          food_show_sous_vide: showSousVide ? "true" : "false",
          food_cold_units: JSON.stringify(coldUnits),
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
              { label: "Hot Temperature Record", desc: "Cooking / cooling / reheating", state: showHotTemp, set: setShowHotTemp },
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
              Cold Food Record is always shown — it's required for daily food safety compliance.
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
  const showHotTemp = config?.food_show_hot_temperature !== "false";
  const showHotHolding = config?.food_show_hot_holding !== "false";
  const showSousVide = config?.food_show_sous_vide !== "false";

  // Default items for new records
  const templateColdUnits = parseColdUnits(config);
  const templateHotItems = parseStringArray(config?.food_default_hot_items);
  const templateHoldingItems = parseStringArray(config?.food_default_holding_items);
  const templateSvItems = parseStringArray(config?.food_default_sv_items);

  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [coldFood, setColdFood] = useState<ColdFoodRow[]>([]);
  const [hotTemperature, setHotTemperature] = useState<HotTemperatureRow[]>([]);
  const [hotHolding, setHotHolding] = useState<HotHoldingRow[]>([]);
  const [sousVide, setSousVide] = useState<SousVideRow[]>([]);
  const [correctives, setCorrectives] = useState("");
  const [managerSignature, setManagerSignature] = useState(user?.name ?? "");

  useEffect(() => {
    if (record) {
      // Load saved record — always use saved data, never overwrite with template
      setDeliveries((record.deliveries || []) as DeliveryRow[]);
      setColdFood((record.coldFood || []) as ColdFoodRow[]);
      setHotTemperature((record.hotTemperature || []) as HotTemperatureRow[]);
      setHotHolding((record.hotHolding || []) as HotHoldingRow[]);
      setSousVide(((record as any).sousVide || []) as SousVideRow[]);
      setCorrectives(record.correctives || "");
      setManagerSignature(record.managerSignature || user?.name || "");
    } else {
      // New record — initialise from template
      const coldRows: ColdFoodRow[] = templateColdUnits.map(u => ({
        unit: u.name, tempAm: "", tempPm: "", correctiveAction: "",
      }));
      const hotRows: HotTemperatureRow[] = templateHotItems.map(item => ({
        item, cookTimeStart: "", cookTimeFinish: "", cookCoreTemp: "",
        coolTimeStart: "", coolTimeFinish: "", reheatCoreTemp: "",
      }));
      const holdingRows: HotHoldingRow[] = templateHoldingItems.map(item => ({
        item, coreTemp: "", timeOfCheck: "",
      }));
      const svRows: SousVideRow[] = templateSvItems.map(item => ({
        item, targetTemp: "", waterTemp: "", timeStarted: "", timeFinished: "", coreTemp: "", result: "", notes: "",
      }));
      setDeliveries([]);
      setColdFood(coldRows);
      setHotTemperature(hotRows);
      setHotHolding(holdingRows);
      setSousVide(svRows);
      setCorrectives("");
      setManagerSignature("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, selectedDate]);

  const handleSaveDraft = async () => {
    const data = {
      recordDate: selectedDate,
      deliveries,
      coldFood,
      hotTemperature,
      hotHolding,
      sousVide,
      cookingLimit,
      coolingLimit,
      reheatingLimit,
      hotHoldingLimit,
      correctives: correctives || undefined,
      managerSignature: managerSignature || undefined,
      submittedAt: undefined,
    };

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

    const data = {
      recordDate: selectedDate,
      deliveries,
      coldFood,
      hotTemperature,
      hotHolding,
      sousVide,
      cookingLimit,
      coolingLimit,
      reheatingLimit,
      hotHoldingLimit,
      correctives: correctives || undefined,
      managerSignature,
      submittedAt: new Date().toISOString(),
    };

    if (record) {
      updateRecord.mutate(
        { id: record.id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Record submitted", description: "Kitchen diary signed off." });
          },
          onError: (error: any) => {
            toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
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
            toast({ title: "Record submitted" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
          },
        }
      );
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
          <Card>
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
          </Card>

          {/* Hot Temperature Record */}
          {showHotTemp && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Hot Temperature Record</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    Cooking: {cookingLimit} · Cooling: {coolingLimit} · Reheating: {reheatingLimit}
                  </CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setHotTemperature([...hotTemperature, {
                    item: "", cookTimeStart: "", cookTimeFinish: "", cookCoreTemp: "",
                    coolTimeStart: "", coolTimeFinish: "", reheatCoreTemp: "",
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
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground" rowSpan={2}>Food Item</th>
                      <th className="text-center px-2 py-1 font-medium text-muted-foreground border-l border-border" colSpan={3}>COOKING</th>
                      <th className="text-center px-2 py-1 font-medium text-muted-foreground border-l border-border" colSpan={2}>COOLING</th>
                      <th className="text-center px-2 py-1 font-medium text-muted-foreground border-l border-border" colSpan={1}>REHEATING</th>
                      {!isSubmitted && <th className="w-8" />}
                    </tr>
                    <tr className="border-t border-border/50">
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground border-l border-border whitespace-nowrap">Time started</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap">Time finished</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap">Core temp</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground border-l border-border whitespace-nowrap">Time started</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap">Time finished</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground border-l border-border whitespace-nowrap">Core temp</th>
                      {!isSubmitted && <th />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {hotTemperature.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-6 text-center text-muted-foreground italic text-sm">No hot food records yet.</td></tr>
                    ) : hotTemperature.map((row, i) => {
                      const upd = (f: keyof HotTemperatureRow, v: string) => { const n = [...hotTemperature]; n[i] = { ...n[i], [f]: v }; setHotTemperature(n); };
                      const inp = (f: keyof HotTemperatureRow, ph: string, cls = "") => (
                        <Input value={row[f]} disabled={isSubmitted} onChange={e => upd(f, e.target.value)}
                          className={cn("h-7 text-xs rounded-sm", cls)} placeholder={ph} />
                      );
                      return (
                        <tr key={i} className="hover:bg-muted/10">
                          <td className="px-3 py-1.5">{inp("item", "Food item", "min-w-[120px]")}</td>
                          <td className="px-2 py-1.5 border-l border-border/40">{inp("cookTimeStart", "HH:mm", "w-20")}</td>
                          <td className="px-2 py-1.5">{inp("cookTimeFinish", "HH:mm", "w-20")}</td>
                          <td className="px-2 py-1.5">{inp("cookCoreTemp", "°C", "w-16")}</td>
                          <td className="px-2 py-1.5 border-l border-border/40">{inp("coolTimeStart", "HH:mm", "w-20")}</td>
                          <td className="px-2 py-1.5">{inp("coolTimeFinish", "HH:mm", "w-20")}</td>
                          <td className="px-2 py-1.5 border-l border-border/40">{inp("reheatCoreTemp", "°C", "w-16")}</td>
                          {!isSubmitted && (
                            <td className="px-2 py-1.5">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                                onClick={() => setHotTemperature(hotTemperature.filter((_, x) => x !== i))}>
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
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Manager Sign-off</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Manager Name (Signature)</Label>
                  <Input
                    value={managerSignature}
                    onChange={(e) => setManagerSignature(e.target.value)}
                    placeholder="Type your name to sign"
                    disabled={isSubmitted}
                  />
                </div>
                <div className="flex items-center gap-3">
                  {!isSubmitted && (
                    <>
                      <Button
                        variant="outline"
                        onClick={handleSaveDraft}
                        disabled={createRecord.isPending || updateRecord.isPending}
                      >
                        <Save className="w-4 h-4 mr-2" />
                        Save Draft
                      </Button>
                      <Button
                        onClick={handleSubmit}
                        disabled={createRecord.isPending || updateRecord.isPending}
                        className="shadow-lg shadow-primary/20"
                      >
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                        {createRecord.isPending || updateRecord.isPending ? "Submitting..." : "Submit & Sign"}
                      </Button>
                    </>
                  )}
                  {isSubmitted && (
                    <div className="flex items-center gap-2 text-sm text-emerald-700">
                      <CheckCircle2 className="w-4 h-4" />
                      Submitted on {format(new Date(record.submittedAt!), "dd/MM/yyyy 'at' HH:mm")}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

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

const TABS: { id: ActiveTab; label: string; icon: any; description: string }[] = [
  { id: "diary",  label: "Daily Diary",    icon: Calendar,       description: "Daily temperature records, deliveries and corrective actions" },
  { id: "weekly", label: "Weekly Review",  icon: ClipboardList,  description: "Combined CookSafe house rules + management review" },
  { id: "probe",  label: "Probe Check",    icon: Thermometer,    description: "Monthly probe thermometer calibration record" },
];

export default function KitchenPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasKitchentrack = hasService("kitchentrack");

  const { error: configError } = useGetFoodSafetyConfig({
    query: { enabled: hasKitchentrack, retry: (count, err: any) => err?.status !== 403 && count < 3 },
  });
  const serverLocked = (configError as any)?.status === 403;

  const [activeTab, setActiveTab] = useState<ActiveTab>("diary");

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
          {activeTab === "diary" && <ConfigDialog />}
        </div>

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
        {activeTab === "diary"  && <DailyDiaryTab />}
        {activeTab === "weekly" && <WeeklyReviewTab />}
        {activeTab === "probe"  && <ProbeCheckTab />}
      </div>
    </AppLayout>
  );
}
