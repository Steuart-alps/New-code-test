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
  useListSites,
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
import { UtensilsCrossed, Settings, Plus, Trash2, CheckCircle2, Calendar, Save, Lock, ClipboardList, Thermometer, GripVertical, Sparkles, AlertTriangle, CheckCircle, CheckSquare, Square, Sunrise, Sunset, Building2, RotateCcw, Settings2, Loader2 } from "lucide-react";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import WeeklyReviewTab from "./kitchen-weekly";
import ProbeCheckTab from "./kitchen-probe";
import CleaningScheduleTab from "./kitchen-cleaning";
import { ChecklistTemplateEditor, type TemplateItem } from "./checklist-template-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

type ActiveTab = "diary" | "weekly" | "probe" | "cleaning" | "checks";

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
  // Which site's template we're editing. null = "All sites (default)" (the
  // client-level template). A number = a specific site's overrides.
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const { data: sites } = useListSites();
  const configParams = selectedSiteId != null ? { siteId: selectedSiteId } : undefined;
  const { data: config } = useGetFoodSafetyConfig(configParams, {
    query: { queryKey: getGetFoodSafetyConfigQueryKey(configParams) },
  });
  // The pure client-level effective config (defaults ← client) — used as the
  // baseline to diff a site's edits against so we only persist genuine
  // overrides and clear reverted ones.
  const { data: clientConfig } = useGetFoodSafetyConfig(undefined, {
    query: { queryKey: getGetFoodSafetyConfigQueryKey() },
  });
  const siteOverrides: string[] = ((config as any)?._siteOverrides as string[] | undefined) ?? [];
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

  // Invalidate every food-safety config query (client-level + all sites) so both
  // the editor and the diary pick up the new values.
  const invalidateAllConfigs = () =>
    queryClient.invalidateQueries({ queryKey: getGetFoodSafetyConfigQueryKey().slice(0, 1) });

  const handleSave = () => {
    // The full config the admin has composed in the dialog.
    const desired: Record<string, string> = {
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
    };

    // For the client-level template we save every key as-is (unchanged
    // behaviour). For a site we diff against the client-level effective config
    // and only persist keys that differ; keys reverted to the client value are
    // cleared (null) so they resume inheriting.
    let payload: Record<string, string | null> = desired;
    if (selectedSiteId != null) {
      const base = (clientConfig as Record<string, string> | undefined) ?? {};
      payload = {};
      for (const [k, v] of Object.entries(desired)) {
        if (base[k] !== v) payload[k] = v;   // genuine override
        else payload[k] = null;              // reverted → clear the override
      }
    }

    updateConfig.mutate(
      {
        data: payload,
        params: configParams,
      },
      {
        onSuccess: () => {
          invalidateAllConfigs();
          toast({
            title: "Template saved",
            description: selectedSiteId != null
              ? "This site now uses these settings for new diary days."
              : "New diary days will use these defaults automatically.",
          });
          setOpen(false);
        },
        onError: (err: any) => {
          toast({ title: "Failed to save", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleReset = () => {
    const msg = selectedSiteId != null
      ? "Clear this site's overrides? It will fall back to the default (all-sites) template. This cannot be undone."
      : "Reset the diary template to the default sections and rows? This cannot be undone.";
    if (!window.confirm(msg)) return;
    resetConfig.mutate({ params: configParams }, {
      onSuccess: () => {
        invalidateAllConfigs();
        toast({
          title: selectedSiteId != null ? "Site overrides cleared" : "Template reset",
          description: selectedSiteId != null
            ? "This site now follows the default template."
            : "The diary template is back to its defaults.",
        });
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

        {sites && sites.length > 0 && (
          <div className="shrink-0 space-y-1.5 rounded-sm border border-border p-3">
            <Label className="text-sm font-medium">Editing template for</Label>
            <select
              value={selectedSiteId ?? ""}
              onChange={e => setSelectedSiteId(e.target.value === "" ? null : Number(e.target.value))}
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
            >
              <option value="">All sites (default)</option>
              {sites.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {selectedSiteId != null
                ? `Changes here override the default template for this site only. Unchanged settings inherit the default.${siteOverrides.length > 0 ? ` (${siteOverrides.length} setting${siteOverrides.length === 1 ? "" : "s"} currently overridden)` : ""}`
                : "This is the default template used by every site that has no overrides of its own."}
            </p>
          </div>
        )}

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
            {resetConfig.isPending
              ? (selectedSiteId != null ? "Clearing…" : "Resetting…")
              : (selectedSiteId != null ? "Clear site overrides" : "Reset to defaults")}
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
  // Which site's diary we're viewing/filling. null = "All sites" = the
  // whole-organisation diary (records with no site), matching the original
  // single-diary behaviour.
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const { data: sites } = useListSites();

  // The diary is scoped to the selected site: it loads that site's effective
  // config (defaults ← client ← site) AND that site's records. When no site is
  // chosen, both fall back to the whole-organisation diary.
  const configParams = selectedSiteId != null ? { siteId: selectedSiteId } : undefined;
  const recordParams = selectedSiteId != null ? { siteId: selectedSiteId } : undefined;
  const { data: config } = useGetFoodSafetyConfig(configParams, {
    query: { queryKey: getGetFoodSafetyConfigQueryKey(configParams) },
  });
  const { data: records } = useListFoodSafetyRecords(recordParams, {
    query: { queryKey: getListFoodSafetyRecordsQueryKey(recordParams) },
  });
  const { data: record, isLoading: recordLoading } = useGetFoodSafetyRecordByDate(selectedDate, recordParams, {
    query: {
      enabled: !!selectedDate,
      queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate, recordParams),
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
  }, [record, selectedDate, selectedSiteId]);

  // Invalidate the record queries for the current diary scope.
  const invalidateRecords = () => {
    queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate, recordParams) });
    queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey(recordParams) });
  };

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
            invalidateRecords();
            toast({ title: "Draft saved" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to save", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createRecord.mutate(
        { data, params: recordParams },
        {
          onSuccess: () => {
            invalidateRecords();
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
      invalidateRecords();
      toast({ title: "Diary filed", description: "Kitchen diary signed off and stored." });
    };
    const onError = (error: any) => toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
    if (record) {
      updateRecord.mutate({ id: record.id, data }, { onSuccess, onError });
    } else {
      createRecord.mutate({ data, params: recordParams }, { onSuccess, onError });
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
          <div className="flex flex-wrap items-center gap-4">
            <Label className="text-sm">Date:</Label>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="max-w-xs"
            />
            {sites && sites.length > 0 && (
              <>
                <Label className="text-sm">Site:</Label>
                <select
                  value={selectedSiteId ?? ""}
                  onChange={(e) => setSelectedSiteId(e.target.value === "" ? null : Number(e.target.value))}
                  className="h-9 rounded-sm border border-input bg-background px-2 text-sm"
                >
                  <option value="">All sites</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </>
            )}
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

// ── Kitchen Daily Checks tab ──────────────────────────────────────────────────

interface KCLItem { label: string; checked: boolean; notes?: string; section?: string; }
interface KCLRecord {
  id: number; checklistType: string; checkDate: string;
  siteId?: number | null; items: KCLItem[];
  completedBy?: string | null; managerNote?: string | null; submittedAt?: string | null;
}

const KCL_OPENING: KCLItem[] = [
  { section: "Security & Safety", label: "Unlock premises and disarm alarm", checked: false },
  { label: "Check for signs of break-in or damage", checked: false },
  { label: "Ensure emergency exits are clear and unlocked", checked: false },
  { label: "Check fire exits, extinguishers and fire blanket are accessible", checked: false },
  { label: "Switch on lights and ventilation/extraction", checked: false },
  { section: "Food Safety", label: "Wash hands before starting work", checked: false },
  { label: "Put on clean uniform and PPE (if required)", checked: false },
  { label: "Check soap, sanitiser and paper towels are stocked", checked: false },
  { label: "Ensure cleaning chemicals are labelled and stored correctly", checked: false },
  { section: "Temperature Checks", label: "Walk-in fridge temperature checked (target 0–5°C)", checked: false },
  { label: "Under-counter fridge temperature checked (target 0–5°C)", checked: false },
  { label: "Freezer temperature checked (target -18°C or below)", checked: false },
  { label: "Display fridge temperature checked (target 0–5°C, if applicable)", checked: false },
  { label: "Any temperature outside safe limits reported", checked: false },
  { section: "Equipment Checks", label: "Ovens turned on", checked: false },
  { label: "Grills turned on", checked: false },
  { label: "Fryers turned on", checked: false },
  { label: "Extraction system operating correctly", checked: false },
  { label: "Hot holding equipment turned on", checked: false },
  { label: "Dishwasher reaches correct wash/rinse temperatures", checked: false },
  { label: "Probe thermometer tested and sanitised before use", checked: false },
  { section: "Food Preparation", label: "Overnight deliveries checked", checked: false },
  { label: "Stock rotated (FIFO)", checked: false },
  { label: "Use-by dates checked", checked: false },
  { label: "Expired food discarded", checked: false },
  { label: "All prepared food labelled with date/time", checked: false },
  { label: "Prep list completed", checked: false },
  { section: "Cleaning", label: "All food contact surfaces sanitised", checked: false },
  { label: "Chopping boards cleaned", checked: false },
  { label: "Knives and utensils cleaned", checked: false },
  { label: "Bins emptied if required and fitted with clean liners", checked: false },
  { label: "Sinks clean and ready for use", checked: false },
  { section: "Service Readiness", label: "Cooking stations set up", checked: false },
  { label: "Ingredients stocked", checked: false },
  { label: "Team briefing held (menu changes, allergens, bookings)", checked: false },
  { section: "Documentation", label: "Fridge/freezer temperatures recorded", checked: false },
  { label: "Any maintenance issues recorded", checked: false },
  { label: "Checklist signed and dated", checked: false },
];

const KCL_CLOSING: KCLItem[] = [
  { section: "Food Safety & Storage", label: "All prepared food labelled and dated", checked: false },
  { label: "Food stored in suitable, covered containers", checked: false },
  { label: "Raw food stored below ready-to-eat food", checked: false },
  { label: "FIFO rotation completed", checked: false },
  { label: "Expired or out-of-date food discarded", checked: false },
  { label: "Walk-in fridge temperature recorded", checked: false },
  { label: "Under-counter fridge temperature recorded", checked: false },
  { label: "Freezer temperature recorded", checked: false },
  { section: "Equipment", label: "Ovens switched off (unless required overnight)", checked: false },
  { label: "Hobs and grills cleaned and turned off", checked: false },
  { label: "Fryers filtered, cleaned and switched off", checked: false },
  { label: "Extraction canopy switched off (after cooling period)", checked: false },
  { label: "Dishwashers drained and cleaned", checked: false },
  { section: "Cleaning & Sanitising", label: "Food preparation surfaces cleaned and sanitised", checked: false },
  { label: "Chopping boards cleaned and sanitised", checked: false },
  { label: "Knives and utensils washed and stored safely", checked: false },
  { label: "Sinks cleaned and sanitised", checked: false },
  { label: "Floor swept and mopped", checked: false },
  { label: "Sanitiser bottles refilled", checked: false },
  { section: "Waste Management", label: "Kitchen bins emptied", checked: false },
  { label: "External bins secured with lids closed", checked: false },
  { label: "Recycling separated correctly", checked: false },
  { section: "Health & Safety", label: "Gas isolation checked", checked: false },
  { label: "Electrical appliances switched off where appropriate", checked: false },
  { label: "Fire exits clear", checked: false },
  { label: "Fire doors closed", checked: false },
  { label: "Chemicals stored safely away from food", checked: false },
  { section: "Pest Prevention", label: "No signs of pest activity", checked: false },
  { label: "Food removed from floors", checked: false },
  { label: "Doors and windows secured", checked: false },
  { section: "Documentation", label: "Temperature logs completed", checked: false },
  { label: "Cleaning schedule signed", checked: false },
  { label: "Corrective actions recorded", checked: false },
  { label: "Equipment faults reported", checked: false },
  { section: "Security", label: "Lights switched off", checked: false },
  { label: "Alarm set", checked: false },
  { label: "External doors locked", checked: false },
  { label: "Keys returned to secure location", checked: false },
];

const KCL_DEFAULTS: Record<string, KCLItem[]> = { kitchen_opening: KCL_OPENING, kitchen_closing: KCL_CLOSING };
const KCL_LABELS: Record<string, string> = { kitchen_opening: "Kitchen Opening", kitchen_closing: "Kitchen Closing" };
const KCL_ENDPOINT: Record<string, string> = { kitchen_opening: "/daily-track-am", kitchen_closing: "/daily-track-pm" };

function KitchenChecklistCard({
  type, siteId, siteName, date, existing, onSaved, canAdmin,
}: { type: string; siteId: number | null; siteName?: string; date: string; existing?: KCLRecord; onSaved: () => void; canAdmin: boolean }) {
  const [templateItems, setTemplateItems] = useState<KCLItem[] | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    if (existing) { setTemplateLoading(false); return; }
    (async () => {
      setTemplateLoading(true);
      const params = new URLSearchParams({ type });
      if (siteId) params.set("siteId", String(siteId));
      const r = await apiFetch(`/checklist-templates?${params}`);
      if (r.ok) { const data = await r.json(); setTemplateItems(data.items ?? null); }
      setTemplateLoading(false);
    })();
  }, [type, siteId, existing]);

  const effectiveDefault = templateItems ? templateItems.map(i => ({ ...i, checked: false })) : (KCL_DEFAULTS[type] ?? []);
  const [items, setItems] = useState<KCLItem[]>(existing?.items ?? effectiveDefault);
  const [completedBy, setCompletedBy] = useState(existing?.completedBy ?? user?.name ?? "");
  const [managerNote, setManagerNote] = useState(existing?.managerNote ?? "");
  const [saving, setSaving] = useState(false);
  const submitted = !!existing?.submittedAt;

  useEffect(() => {
    setItems(existing?.items ?? effectiveDefault);
    setCompletedBy(existing?.completedBy ?? user?.name ?? "");
    setManagerNote(existing?.managerNote ?? "");
  }, [existing, type, templateItems]);

  const toggle = (i: number) => { if (submitted) return; setItems(prev => prev.map((item, idx) => idx === i ? { ...item, checked: !item.checked } : item)); };
  const setNote = (i: number, note: string) => { if (submitted) return; setItems(prev => prev.map((item, idx) => idx === i ? { ...item, notes: note } : item)); };

  async function save(submit: boolean) {
    setSaving(true);
    const endpoint = KCL_ENDPOINT[type];
    const payload: any = { checklistType: type, checkDate: date, siteId: siteId ?? null, items, completedBy: completedBy || null, managerNote: managerNote || null };
    if (submit) payload.submittedAt = new Date().toISOString();
    try {
      if (existing) { await apiFetch(`${endpoint}/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) }); }
      else { await apiFetch(endpoint, { method: "POST", body: JSON.stringify(payload) }); }
      onSaved();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  const checkedCount = items.filter(i => i.checked).length;
  const Icon = type === "kitchen_opening" ? Sunrise : Sunset;

  return (
    <>
      <Card className="p-5 bg-card shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-primary opacity-80" />
            <h3 className="font-semibold font-display">{KCL_LABELS[type]}</h3>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && !submitted && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setShowEditor(true)} title="Customise checklist">
                <Settings2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{checkedCount}/{items.length}</span>
            {submitted
              ? <Badge className="bg-emerald-100 text-emerald-800 text-xs"><Lock className="w-3 h-3 mr-1" />Submitted</Badge>
              : checkedCount === items.length && items.length > 0
              ? <Badge className="bg-blue-100 text-blue-800 text-xs">Ready to submit</Badge>
              : <Badge variant="secondary" className="text-xs">In progress</Badge>}
          </div>
        </div>

        {templateLoading && !existing ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-1 mb-4">
            {items.map((item, i) => (
              <div key={i}>
                {item.section && item.section !== items[i - 1]?.section && (
                  <p className={`text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 px-1 ${i > 0 ? "mt-3" : ""} mb-1`}>{item.section}</p>
                )}
                <div className={`rounded-lg border p-3 transition-colors ${submitted ? "bg-muted/20 opacity-80" : "hover:bg-muted/20 cursor-pointer"} ${item.checked ? "border-emerald-200 bg-emerald-50/50" : "border-border"}`}>
                  <div className="flex items-start gap-3" onClick={() => toggle(i)}>
                    {item.checked ? <CheckSquare className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" /> : <Square className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />}
                    <span className={`text-sm ${item.checked ? "text-emerald-800 line-through decoration-emerald-400" : ""}`}>{item.label}</span>
                  </div>
                  {!submitted && item.checked && (
                    <div className="mt-2 ml-7">
                      <Input value={item.notes ?? ""} onChange={e => setNote(i, e.target.value)} placeholder="Optional note…" className="h-7 text-xs bg-white" onClick={e => e.stopPropagation()} />
                    </div>
                  )}
                  {submitted && item.notes && <p className="ml-7 mt-1 text-xs text-muted-foreground italic">{item.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        {!submitted && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label className="text-xs">Completed by</Label><Input value={completedBy} onChange={e => setCompletedBy(e.target.value)} placeholder="Name" className="h-8 text-sm" /></div>
              {canAdmin && <div className="space-y-1"><Label className="text-xs">Manager note</Label><Input value={managerNote} onChange={e => setManagerNote(e.target.value)} placeholder="Optional" className="h-8 text-sm" /></div>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={saving} className="flex-1">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save draft"}</Button>
              <Button size="sm" onClick={() => save(true)} disabled={saving || checkedCount === 0} className="flex-1">Submit checklist</Button>
            </div>
          </div>
        )}
        {submitted && existing?.completedBy && <div className="border-t pt-3"><p className="text-xs text-muted-foreground">Completed by: <span className="font-medium">{existing.completedBy}</span></p></div>}
        {existing?.id && <div className="border-t mt-3 pt-3"><CheckPhotoUploader entityType="daily_checklist" entityId={existing.id} compact /></div>}
      </Card>

      {canAdmin && (
        <ChecklistTemplateEditor
          open={showEditor}
          onOpenChange={setShowEditor}
          type={type}
          typeLabel={KCL_LABELS[type] ?? type}
          siteId={siteId}
          siteName={siteName}
          defaultItems={KCL_DEFAULTS[type] ?? []}
          onSaved={(newItems: TemplateItem[]) => {
            const ci = newItems.map(i => ({ ...i, checked: false })) as KCLItem[];
            setTemplateItems(ci);
            if (!existing) setItems(ci);
          }}
        />
      )}
    </>
  );
}

function DailyChecksTab() {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { data: sites = [] } = useListSites();
  const today = new Date().toISOString().slice(0, 10);
  const _qs = new URLSearchParams(window.location.search);
  const [date, setDate] = useState(_qs.get("date") ?? today);
  const [siteId, setSiteId] = useState<string>(_qs.get("siteId") ?? "__none__");
  const [amRows, setAmRows] = useState<KCLRecord[]>([]);
  const [pmRows, setPmRows] = useState<KCLRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedSiteId = siteId === "__none__" ? null : Number(siteId);
  const selectedSiteName = sites.find(s => s.id === selectedSiteId)?.name;

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ date });
    if (selectedSiteId) params.set("siteId", String(selectedSiteId));
    const [amRes, pmRes] = await Promise.all([
      apiFetch(`/daily-track-am?${params}`),
      apiFetch(`/daily-track-pm?${params}`),
    ]);
    if (amRes.ok) setAmRows(await amRes.json());
    if (pmRes.ok) setPmRows(await pmRes.json());
    setLoading(false);
  }, [date, selectedSiteId, activeClientId]);

  useEffect(() => { load(); }, [load]);

  const getAm = (type: string) => amRows.find(c => c.checklistType === type);
  const getPm = (type: string) => pmRows.find(c => c.checklistType === type);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 p-4 bg-card border border-border rounded-xl">
        <div className="space-y-1 flex-1 min-w-[140px]">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1 flex-1 min-w-[180px]">
          <Label className="text-xs">Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select site…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No site filter</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button variant="outline" size="sm" onClick={load} className="h-9 gap-1.5">
            <RotateCcw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <KitchenChecklistCard type="kitchen_opening" siteId={selectedSiteId} siteName={selectedSiteName} date={date} existing={getAm("kitchen_opening")} onSaved={load} canAdmin={canAdmin} />
          <KitchenChecklistCard type="kitchen_closing" siteId={selectedSiteId} siteName={selectedSiteName} date={date} existing={getPm("kitchen_closing")} onSaved={load} canAdmin={canAdmin} />
        </div>
      )}
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
  { id: "checks",   label: "Daily Checks",         icon: CheckSquare,   description: "Kitchen opening and closing checklists" },
  { id: "diary",    label: "Daily Diary",           icon: Calendar,      description: "Daily temperature records, deliveries and corrective actions" },
  { id: "weekly",   label: "Weekly Review",         icon: ClipboardList, description: "Combined CookSafe house rules + management review" },
  { id: "probe",    label: "Probe Check",           icon: Thermometer,   description: "Monthly probe thermometer calibration record" },
  { id: "cleaning", label: "Cleaning Schedule",     icon: Sparkles,      description: "Daily, weekly and monthly cleaning task schedule and sign-off" },
];

export default function KitchenPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasKitchentrack = hasService("kitchentrack");

  const { error: configError } = useGetFoodSafetyConfig(undefined, {
    query: { enabled: hasKitchentrack, retry: (count: number, err: any) => err?.status !== 403 && count < 3, queryKey: getGetFoodSafetyConfigQueryKey() },
  });
  const serverLocked = (configError as any)?.status === 403;

  const _initTab = (new URLSearchParams(window.location.search).get("tab") as ActiveTab | null) ?? "diary";
  const [activeTab, setActiveTab] = useState<ActiveTab>(TABS.some(t => t.id === _initTab) ? _initTab : "diary");
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
        {activeTab === "checks"   && <DailyChecksTab />}
        {activeTab === "diary"    && <DailyDiaryTab />}
        {activeTab === "weekly"   && <WeeklyReviewTab />}
        {activeTab === "probe"    && <ProbeCheckTab />}
        {activeTab === "cleaning" && <CleaningScheduleTab />}
      </div>
    </AppLayout>
  );
}
