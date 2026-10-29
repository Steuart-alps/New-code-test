import { KitchenTemperatureControls } from "@/components/kitchen-temperature-controls";
import { SayItButton } from "@/components/say-it-button";
import { FoodJurisdictionOptions, KitchenGuidanceNote } from "@/components/kitchen-temperature-guidance";
import { assessKitchenTemperatures, isFoodJurisdiction, kitchenFailureValue, kitchenHoldRequirement, kitchenTemperatureGuidance, parseKitchenTemperatureRules, type FoodJurisdiction, type KitchenTemperatureFailure } from "@workspace/api-client-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { takeLinkParams } from "@/lib/deep-link";
import { ChecklistItemRow } from "@/components/checklist-item-row";
import { checklistProgress, submitHint, withResult, itemResult, type ChecklistResult } from "@/lib/checklist-results";
import { scrollPageToTop } from "@/lib/page-scroll";
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
  useGetFoodSafetySummary,
  getGetFoodSafetySummaryQueryKey,
  useCreateFoodSafetyRecord,
  useUpdateFoodSafetyRecord,
  useListSites,
  FoodSafetyRecord,
  type KitchenClosedDay,
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
import { AuditLog } from "@/components/audit-log";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { UtensilsCrossed, Settings, Plus, Trash2, CheckCircle2, Calendar, Save, Lock, ClipboardList, Thermometer, GripVertical, Sparkles, AlertTriangle, CheckCircle, CheckSquare, Square, Sunrise, Sunset, Building2, RotateCcw, Settings2, Loader2, FileText } from "lucide-react";
import { DocTrackLibrary } from "./doc-track";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { StaffPerformerSelect } from "@/components/staff-performer-select";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import WeeklyReviewTab from "./kitchen-weekly";
import ProbeCheckTab from "./kitchen-probe";
import CleaningScheduleTab from "./kitchen-cleaning";
import { ChecklistTemplateEditor, type TemplateItem } from "./checklist-template-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  isKitchenDiaryDirty,
  isKitchenTemplateReady,
  kitchenDiaryHydrationAction,
  kitchenDiaryRecordKey,
  kitchenDiaryScopeKey,
  kitchenDayStatus,
  kitchenDiarySnapshot,
  parseColdUnits,
  parseJsonArray,
  parseStringArray,
  requestKitchenDiaryScopeChange,
  stampedLimit,
  shouldDisplayKitchenSection,
  type ColdUnit,
  type KitchenDayStatus,
  type KitchenDiaryLoaded,
} from "@/lib/kitchen-state";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StringListEditor } from "@/components/string-list-editor";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";

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
  holdSeconds?: string;       // Seconds held at the core temperature
};
type CoolingRow = {
  item: string;
  timeStart: string;          // Time cooling started
  startTemp?: string;         // Core temp when cooling started (°C), a record only
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
  holdMinutes?: string;       // Minutes held at the core temperature
  result: string;             // "pass"|"fail"|""
  notes: string;
};

type ActiveTab = "diary" | "weekly" | "probe" | "cleaning" | "checks" | "documents";

// ── helpers ────────────────────────────────────────────────────────────────────
function buildDiaryBaseline(record: FoodSafetyRecord) {
  const raw = record as any;
  return {
    deliveries: raw.deliveries ?? [],
    coldFood: raw.coldFood ?? [],
    hotTemperature: raw.hotTemperature ?? [],
    cooling: raw.cooling ?? [],
    reheating: raw.reheating ?? [],
    hotHolding: raw.hotHolding ?? [],
    sousVide: raw.sousVide ?? [],
    cookingLimit: raw.cookingLimit ?? null,
    coolingLimit: raw.coolingLimit ?? null,
    reheatingLimit: raw.reheatingLimit ?? null,
    hotHoldingLimit: raw.hotHoldingLimit ?? null,
    correctives: raw.correctives ?? null,
    managerSignature: raw.managerSignature ?? null,
    performedBy: raw.performedBy ?? null,
    staffRosterId: raw.staffRosterId ?? null,
    submittedAt: raw.submittedAt ?? null,
  };
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

// ── ConfigDialog ───────────────────────────────────────────────────────────────
function ConfigDialog() {
  const [open, setOpen] = useState(false);
  const newColdUnit = useFocusNewRow();
  // Which site's template we're editing. null = "All sites (default)" (the
  // client-level template). A number = a specific site's overrides.
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const { data: sites } = useListSites();
  const configParams = selectedSiteId != null ? { siteId: selectedSiteId } : undefined;
  const { data: config, isLoading: configLoading } = useGetFoodSafetyConfig(configParams, {
    query: { queryKey: getGetFoodSafetyConfigQueryKey(configParams) },
  });
  // The pure client-level effective config (defaults ← client) — used as the
  // baseline to diff a site's edits against so we only persist genuine
  // overrides and clear reverted ones.
  const { data: clientConfig, isLoading: clientConfigLoading } = useGetFoodSafetyConfig(undefined, {
    query: { queryKey: getGetFoodSafetyConfigQueryKey() },
  });
  const templateReady = isKitchenTemplateReady(config, clientConfig, configLoading, clientConfigLoading);
  const siteOverrides: string[] = ((config as any)?._siteOverrides as string[] | undefined) ?? [];
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateFoodSafetyConfig();
  const resetConfig = useResetFoodSafetyConfig();

  // Limits tab
  const [cookingLimit, setCookingLimit] = useState("75°C or above (core)");
  const [coolingLimit, setCoolingLimit] = useState("8°C within 90 minutes");
  const [foodJurisdiction, setFoodJurisdiction] = useState<FoodJurisdiction>("england_wales");
  const [reheatingLimit, setReheatingLimit] = useState<string>("Above 75°C");
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
  const [probeNames, setProbeNames] = useState<string[]>([]);

  useEffect(() => {
    if (!config) return;
    setCookingLimit(config.food_cooking_limit || "75°C or above (core)");
    setCoolingLimit(config.food_cooling_limit || "8°C within 90 minutes");
    setFoodJurisdiction(isFoodJurisdiction(config.food_jurisdiction) ? config.food_jurisdiction : "england_wales");
    setReheatingLimit(config.food_reheating_limit || "Above 75°C");
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
    setProbeNames(parseStringArray(config.food_probe_names));
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
      food_jurisdiction: foodJurisdiction,
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
      ...(selectedSiteId == null
        ? { food_probe_names: JSON.stringify(probeNames.filter(Boolean)) }
        : {}),
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
          <DialogTitle className="font-display font-bold">Diary Template</DialogTitle>
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
          <TabsList className="shrink-0 w-full grid grid-cols-3 sm:grid-cols-5 h-auto">
            <TabsTrigger value="sections">Sections</TabsTrigger>
            <TabsTrigger value="cold">Cold Storage</TabsTrigger>
            <TabsTrigger value="items">Default Items</TabsTrigger>
            <TabsTrigger value="limits">Limits</TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-kitchen-audit">Audit log</TabsTrigger>
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
            <div ref={newColdUnit.ref} className="space-y-2">
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
                <Button variant="outline" size="sm" onClick={() => { newColdUnit.expect(); setColdUnits([...coldUnits, { name: "", type: "fridge" }]); }}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Fridge
                </Button>
                <Button variant="outline" size="sm" onClick={() => { newColdUnit.expect(); setColdUnits([...coldUnits, { name: "", type: "freezer" }]); }}>
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
              <StringListEditor kitchen addLabel="Add item" items={defaultHotItems} onChange={setDefaultHotItems} placeholder="e.g. Roast Chicken" />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-semibold">Hot Holding items</Label>
              <p className="text-xs text-muted-foreground">Items kept hot for service (e.g. Chips, Gravy, Soup)</p>
              <StringListEditor kitchen addLabel="Add item" items={defaultHoldingItems} onChange={setDefaultHoldingItems} placeholder="e.g. Chips" />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-semibold">Sous Vide items</Label>
              <p className="text-xs text-muted-foreground">Items you regularly cook sous vide</p>
              <StringListEditor kitchen addLabel="Add item" items={defaultSvItems} onChange={setDefaultSvItems} placeholder="e.g. Duck Breast" />
            </div>

            {selectedSiteId == null && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold">Calibration probes</Label>
                <p className="text-xs text-muted-foreground">
                  Name the thermometer probes that should appear on each new monthly calibration check. Probe names are shared across all sites.
                </p>
                <StringListEditor kitchen addLabel="Add item" items={probeNames} onChange={setProbeNames} placeholder="e.g. Blue probe" />
              </div>
            )}
          </TabsContent>

          {/* ── Limits tab ── */}
          <TabsContent value="limits" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <p className="text-xs text-muted-foreground mb-3">
              These limits are starting guidance only. Set and review critical limits in your food-business-specific HACCP system, with competent advice where needed.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="kitchen-food-country">Country guidance</Label>
              <select
                id="kitchen-food-country"
                value={foodJurisdiction}
                onChange={e => {
                  const next = e.target.value as FoodJurisdiction;
                  const labels = kitchenTemperatureGuidance(next).labels;
                  setFoodJurisdiction(next);
                  setCookingLimit(labels.cooking);
                  setCoolingLimit(labels.cooling);
                  setReheatingLimit(labels.reheating);
                  setHotHoldingLimit(labels.hotHolding);
                }}
                className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
              >
                <FoodJurisdictionOptions />
              </select>
              <p className="text-xs text-muted-foreground">
                Choosing a country fills in its recommended limits below for new diary records; you can change any of them. To use its numbers for pass/fail checks, choose the same country in Numeric temperature controls at the top of KitchenTrack.
              </p>
              <KitchenGuidanceNote jurisdiction={foodJurisdiction} />
            </div>
            <div className="space-y-1.5">
              <Label>Cooking temperature limit</Label>
              <Input value={cookingLimit} placeholder="75°C or above (core)"
                onChange={e => setCookingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">Example guidance varies by process and nation; use the critical limit in your documented HACCP system.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Cooling limit</Label>
              <Input value={coolingLimit} placeholder="8°C within 90 minutes"
                onChange={e => setCoolingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">Set a safe cooling limit and corrective action for your process in the HACCP system.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Reheating limit</Label>
              <Input value={reheatingLimit} placeholder="Above 82°C"
                onChange={e => setReheatingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">Reheating controls depend on the food process and jurisdiction; confirm your own documented limit.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Hot holding minimum</Label>
              <Input value={hotHoldingLimit} placeholder="Above 63°C"
                onChange={e => setHotHoldingLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">Confirm your hot-holding controls, permitted tolerances and corrective action in the HACCP system.</p>
            </div>
          </TabsContent>
          <TabsContent value="audit" className="flex-1 overflow-y-auto pt-4 px-1"><AuditLog module="kitchen" /></TabsContent>
        </Tabs>

        <DialogFooter className="shrink-0 pt-2 border-t border-border mt-2 sm:justify-between">
          <Button variant="ghost" className="text-destructive hover:text-destructive"
            onClick={handleReset} disabled={!templateReady || resetConfig.isPending || updateConfig.isPending}>
            {resetConfig.isPending
              ? (selectedSiteId != null ? "Clearing…" : "Resetting…")
              : (selectedSiteId != null ? "Clear site overrides" : "Reset to defaults")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!templateReady || updateConfig.isPending}>
              {!templateReady ? "Loading…" : updateConfig.isPending ? "Saving…" : "Save template"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Food Safety Completeness Calendar ────────────────────────────────────────

function shiftFSMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fsMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function fsDayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

interface FSCompletenessCalendarProps {
  siteId?: number | null;
  onPickDay: (date: string) => void;
}

/** Admin control: mark a run of days as closed (not operating) for the diary
 *  scope shown. Days with a diary record are refused by the API. */
function MarkClosedDaysDialog({ siteId, defaultDate, onSaved }: { siteId: number | null; defaultDate: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(defaultDate);
  const [to, setTo] = useState(defaultDate);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const siteQuery = siteId == null ? "" : `?siteId=${siteId}`;
      const res = await apiFetch(`/food-safety/closed-days${siteQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, reason }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        const dates: string[] = Array.isArray(body?.dates) ? body.dates : [];
        toast({
          title: "Not marked closed",
          description: `${dates.map(fsDayLabel).join(", ")} already ${dates.length === 1 ? "has" : "have"} a diary record, so ${dates.length === 1 ? "it was" : "they were"} open.`,
          variant: "destructive",
        });
        return;
      }
      if (!res.ok) {
        toast({ title: "Not marked closed", description: await getApiErrorMessage(res, "Closed days could not be saved."), variant: "destructive" });
        return;
      }
      toast({ title: "Closed days saved", description: "They no longer count as missing records." });
      setOpen(false);
      setReason("");
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setFrom(defaultDate); setTo(defaultDate); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">Mark closed days</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark days the kitchen is closed</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Closed days are not counted as missing diary records. Who marked them and when is kept in the audit history.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="closed-from">From</Label>
            <Input id="closed-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="closed-to">To</Label>
            <Input id="closed-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="closed-reason">Reason</Label>
          <Input id="closed-reason" dictation value={reason} maxLength={200} placeholder="e.g. Closed for refurbishment" onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={saving || !from || !to || from > to || !reason.trim()} onClick={save}>
            {saving ? "Saving…" : "Mark closed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FoodSafetyCompletenessCalendar({ siteId, onPickDay }: FSCompletenessCalendarProps) {
  const today = format(new Date(), "yyyy-MM-dd");
  const currentMonth = today.slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const canAdmin = useCanAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<KitchenClosedDay | null>(null);

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const summaryParams = { year: y, month: m, ...(siteId != null ? { siteId } : {}) };
  const { data: summary, isLoading: loading, isError } = useGetFoodSafetySummary(summaryParams, {
    query: {
      queryKey: getGetFoodSafetySummaryQueryKey(summaryParams),
      staleTime: 30_000,
    },
  });
  const summaryByDate = new Map((summary?.days ?? []).map((day) => [day.date, day]));

  const dayStatuses: { date: string; status: KitchenDayStatus; closure: KitchenClosedDay | null }[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const day = summaryByDate.get(date);
    dayStatuses.push({ date, status: kitchenDayStatus(date, today, day), closure: day?.closure ?? null });
  }

  const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Mon = 0
  // Closed days are never missing: they are counted on their own.
  const missingCount = dayStatuses.filter(({ status }) => status === "missing").length;
  const closedDays = dayStatuses.filter(({ status }) => status === "nonOperating");
  const actionableDates = dayStatuses.filter(({ status }) => status === "missing" || status === "draft");

  const refreshCompleteness = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === "string" && (key.startsWith("/api/food-safety") || key.startsWith("/api/dashboard"));
      },
    });
  };

  const removeClosure = async (closure: KitchenClosedDay) => {
    const res = await apiFetch(`/food-safety/closed-days/${closure.id}`, { method: "DELETE" });
    setRemoving(null);
    if (!res.ok) {
      toast({ title: "Closed day not removed", description: await getApiErrorMessage(res, "Try again shortly."), variant: "destructive" });
      return;
    }
    toast({ title: "Closed day removed", description: `${fsDayLabel(closure.date)} counts as an operating day again.` });
    refreshCompleteness();
  };

  return (
    <Card className="mt-6">
      <CardContent className="pt-4 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="font-bold text-sm">Monthly Completeness</h3>
            <p className="text-xs text-muted-foreground">Days where the food safety diary was not completed. Closed days are not counted as missing.</p>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && <MarkClosedDaysDialog siteId={siteId ?? null} defaultDate={month === currentMonth ? today : `${month}-01`} onSaved={refreshCompleteness} />}
            <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setMonth(shiftFSMonth(month, -1))}>←</Button>
            <span className="text-sm font-medium min-w-[130px] text-center">{fsMonthLabel(month)}</span>
            <Button
              variant="outline" size="sm" className="h-7 px-2"
              disabled={month >= currentMonth}
              onClick={() => setMonth(shiftFSMonth(month, 1))}
            >→</Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : isError ? (
          <div className="rounded-sm border border-destructive/20 bg-destructive/5 px-4 py-5 text-sm text-destructive">
            Monthly completeness could not be loaded. Try again shortly.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1 max-w-sm">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
                <div key={d} className="text-[10px] text-muted-foreground text-center font-medium py-1">{d}</div>
              ))}
              {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
              {dayStatuses.map(({ date, status, closure }) => (
                <button
                  key={date}
                  data-day-status={status}
                  disabled={status === "future"}
                  onClick={() => { if (status !== "future") onPickDay(date); }}
                  title={
                    status === "future" ? `${date} — future` :
                    status === "nonOperating" ? `${date} — closed (not operating)${closure ? `: ${closure.reason}${closure.createdByName ? ` · marked by ${closure.createdByName}` : ""}${closure.addedAfterDay ? " · added afterwards" : ""}` : ""}` :
                    status === "complete" ? `${date} — submitted` :
                    status === "draft" ? `${date} — draft saved` :
                    `${date} — no record`
                  }
                  className={cn(
                    "aspect-square rounded text-[11px] font-medium flex items-center justify-center transition-transform",
                    status === "complete" && "bg-emerald-100 text-emerald-700 hover:scale-110",
                    status === "draft"    && "bg-amber-100 text-amber-700 hover:scale-110",
                    status === "missing"  && "bg-amber-200 text-amber-800 hover:scale-110",
                    status === "nonOperating" && "bg-slate-100 text-slate-500 border border-dashed border-slate-300 hover:scale-110",
                    status === "future"   && "bg-muted/30 text-muted-foreground/40",
                  )}
                >
                  {parseInt(date.slice(8), 10)}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" /> Filled / submitted</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-100 border border-amber-300" /> Draft only</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-200 border border-amber-300" /> Missing</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-100 border border-dashed border-slate-300" /> Closed (not operating)</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-muted/30 border border-border" /> Future</span>
              {(missingCount > 0 || closedDays.length > 0) && (
                <span className="ml-auto font-medium text-amber-700">
                  {missingCount} missing day{missingCount !== 1 ? "s" : ""} in {fsMonthLabel(month)}
                  {closedDays.length > 0 && <span className="text-muted-foreground font-normal"> · {closedDays.length} closed</span>}
                </span>
              )}
            </div>
            {actionableDates.length > 0 && (
              <div className="mt-4 border-t border-border/50 pt-3">
                <p className="text-xs font-medium text-foreground">Dates needing attention</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {actionableDates.map(({ date, status }) => (
                    <Button key={date} variant="outline" size="sm" className={cn(
                      "h-7",
                      status === "missing"
                        ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                        : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100",
                    )} onClick={() => onPickDay(date)}>
                      {fsDayLabel(date)} — {status === "missing" ? "missing" : "draft"}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {closedDays.length > 0 && (
              <div className="mt-4 border-t border-border/50 pt-3">
                <p className="text-xs font-medium text-foreground">Closed days</p>
                <ul className="mt-2 space-y-1">
                  {closedDays.map(({ date, closure }) => (
                    <li key={date} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{fsDayLabel(date)}</span>
                      {closure && (
                        <>
                          <span>{closure.reason}</span>
                          <span>
                            · marked by {closure.createdByName ?? "a former user"} on {fsDayLabel(closure.createdAt.slice(0, 10))}
                            {closure.addedAfterDay && " (added afterwards)"}
                          </span>
                          {canAdmin && (
                            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setRemoving(closure)}>
                              Remove
                            </Button>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
      <AlertDialog open={removing !== null} onOpenChange={(next) => { if (!next) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this closed day?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing ? `${fsDayLabel(removing.date)} will count as an operating day again, so it shows as missing until a diary is filled in. The removal is kept in the audit history.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (removing) void removeClosure(removing); }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── Daily Diary tab ───────────────────────────────────────────────────────────

export function DailyDiaryTab() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), "yyyy-MM-dd"));
  // Which site's diary we're viewing/filling. null = the legacy client-wide
  // whole-organisation diary (records with no site), matching the original
  // single-diary behaviour.
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const { data: sites } = useListSites();

  // The diary is scoped to the selected site: it loads that site's effective
  // config (defaults ← client ← site) AND that site's records. When no site is
  // chosen, both fall back to the whole-organisation diary.
  const configParams = selectedSiteId != null ? { siteId: selectedSiteId } : undefined;
  const recordParams = selectedSiteId != null ? { siteId: selectedSiteId } : undefined;
  const { data: config, isLoading: configLoading } = useGetFoodSafetyConfig(configParams, {
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
  const newRow = useFocusNewRow();
  const createRecord = useCreateFoodSafetyRecord();
  const updateRecord = useUpdateFoodSafetyRecord();

  // ── Derived template values from config ─────────────────────────────────────
  const cookingLimit = config?.food_cooking_limit || "75°C or above (core)";
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
  // What the form last loaded from, or saved to, the server for this
  // date/site scope. Unsaved edits are measured against it, never against
  // whatever the latest server response happens to be.
  const [loaded, setLoaded] = useState<(KitchenDiaryLoaded & { record: FoodSafetyRecord | null }) | null>(null);
  const [pendingScope, setPendingScope] = useState<{ date: string; siteId: number | null } | null>(null);
  const scopeKey = kitchenDiaryScopeKey(selectedSiteId, selectedDate);
  const currentSnapshot = kitchenDiarySnapshot({
    deliveries, coldFood, cooking, cooling, reheating, hotHolding, sousVide, correctives, managerSignature,
  });
  const isDirty = isKitchenDiaryDirty(loaded, scopeKey, currentSnapshot);
  const formReady = loaded?.scope === scopeKey;
  // The server version the edits are based on. Saves are checked against it,
  // so a newer version that arrived meanwhile is merged or reported as a
  // conflict instead of being overwritten.
  const baseRecord = formReady ? loaded.record : null;

  useEffect(() => {
    if (recordLoading || configLoading) return;
    const recordKey = kitchenDiaryRecordKey(record);
    // A refetch or late response must not replace unsaved edits, except a
    // day filed elsewhere: it is locked, so the filed version is shown.
    const keepEdits = isDirty && !record?.submittedAt;
    if (kitchenDiaryHydrationAction(loaded, scopeKey, recordKey, keepEdits) !== "hydrate") return;

    let next: {
      deliveries: DeliveryRow[]; coldFood: ColdFoodRow[]; cooking: CookingRow[]; cooling: CoolingRow[];
      reheating: ReheatingRow[]; hotHolding: HotHoldingRow[]; sousVide: SousVideRow[];
      correctives: string; managerSignature: string;
    };
    if (record) {
      // Support old combined-row format (cookTimeStart field) — migrate to split arrays
      const rawHot: any[] = (record.hotTemperature || []) as any[];
      const isOldFormat = rawHot.some(r => "cookTimeStart" in r || "coolTimeStart" in r);
      next = {
        deliveries: (record.deliveries || []) as DeliveryRow[],
        coldFood: (record.coldFood || []) as ColdFoodRow[],
        cooking: isOldFormat
          ? rawHot.map(r => ({ item: r.item || "", timeStart: r.cookTimeStart || "", timeFinish: r.cookTimeFinish || "", coreTemp: r.cookCoreTemp || "" }))
          : rawHot as CookingRow[],
        cooling: isOldFormat
          ? rawHot.filter(r => r.coolTimeStart || r.coolTimeFinish).map(r => ({ item: r.item || "", timeStart: r.coolTimeStart || "", timeFinish: r.coolTimeFinish || "", coreTemp: "" }))
          : ((record as any).cooling || []) as CoolingRow[],
        reheating: isOldFormat
          ? rawHot.filter(r => r.reheatCoreTemp).map(r => ({ item: r.item || "", timeStart: "", timeFinish: "", coreTemp: r.reheatCoreTemp || "" }))
          : ((record as any).reheating || []) as ReheatingRow[],
        hotHolding: (record.hotHolding || []) as HotHoldingRow[],
        sousVide: ((record as any).sousVide || []) as SousVideRow[],
        correctives: record.correctives || "",
        managerSignature: record.managerSignature || user?.name || "",
      };
    } else {
      // New record — initialise from template
      next = {
        deliveries: [],
        coldFood: templateColdUnits.map(u => ({
          unit: u.name, tempAm: "", tempPm: "", correctiveAction: "",
        })),
        cooking: templateHotItems.map(item => ({
          item, timeStart: "", timeFinish: "", coreTemp: "",
        })),
        cooling: [],
        reheating: [],
        hotHolding: templateHoldingItems.map(item => ({
          item, coreTemp: "", timeOfCheck: "",
        })),
        sousVide: templateSvItems.map(item => ({
          item, targetTemp: "", waterTemp: "", timeStarted: "", timeFinished: "", coreTemp: "", result: "", notes: "",
        })),
        correctives: "",
        managerSignature: "",
      };
    }
    setDeliveries(next.deliveries);
    setColdFood(next.coldFood);
    setCooking(next.cooking);
    setCooling(next.cooling);
    setReheating(next.reheating);
    setHotHolding(next.hotHolding);
    setSousVide(next.sousVide);
    setCorrectives(next.correctives);
    setManagerSignature(next.managerSignature);
    setLoaded({ scope: scopeKey, recordKey, snapshot: kitchenDiarySnapshot(next), record: record ?? null });
  }, [
    config,
    configLoading,
    isDirty,
    loaded,
    record,
    recordLoading,
    scopeKey,
    templateColdUnits,
    templateHoldingItems,
    templateHotItems,
    templateSvItems,
    user?.name,
  ]);

  // A fridge or freezer's scanned QR label opens today's diary for its site
  // and puts the cursor in that unit's reading (AM before noon, PM after).
  const [scanColdUnit, setScanColdUnit] = useState<string | null>(null);
  useEffect(() => {
    const link = takeLinkParams(["siteId", "coldUnit"] as const);
    if (!link?.coldUnit) return;
    const site = Number(link.siteId);
    applyScope({ date: format(new Date(), "yyyy-MM-dd"), siteId: Number.isSafeInteger(site) && site > 0 ? site : null });
    setScanColdUnit(link.coldUnit.slice(0, 100));
  }, []);
  useEffect(() => {
    if (!scanColdUnit || !formReady) return;
    const name = scanColdUnit.trim().toLowerCase();
    setScanColdUnit(null);
    let index = coldFood.findIndex(row => row.unit.trim().toLowerCase() === name);
    if (index < 0 && !isSubmitted) {
      index = coldFood.length;
      setColdFood([...coldFood, { unit: scanColdUnit.trim(), tempAm: "", tempPm: "", correctiveAction: "" }]);
    }
    if (index < 0) return;
    const field = new Date().getHours() < 12 ? "am" : "pm";
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-cold-unit-row="${index}"][data-cold-unit-field="${field}"]`);
      input?.scrollIntoView({ behavior: "smooth", block: "center" });
      input?.focus({ preventScroll: true });
    }, 200);
  }, [scanColdUnit, formReady]);

  // Date and site changes replace the form, so unsaved edits need a
  // deliberate discard; "Keep editing" stays on the current day and site.
  const applyScope = (next: { date: string; siteId: number | null }) => {
    setPendingScope(null);
    setSelectedDate(next.date);
    setSelectedSiteId(next.siteId);
  };
  const changeScope = (next: { date: string; siteId: number | null }) => {
    if (!next.date) return;
    const decision = requestKitchenDiaryScopeChange(
      scopeKey,
      kitchenDiaryScopeKey(next.siteId, next.date),
      isDirty,
      createRecord.isPending || updateRecord.isPending,
    );
    if (decision === "confirm") setPendingScope(next);
    else if (decision === "switch") applyScope(next);
  };
  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  // Historical records retain the limits that were filed with them. The
  // current template applies only when starting a new diary day.
  const entryCookingLimit = stampedLimit(baseRecord?.cookingLimit, cookingLimit);
  const entryCoolingLimit = stampedLimit(baseRecord?.coolingLimit, coolingLimit);
  const entryReheatingLimit = stampedLimit(baseRecord?.reheatingLimit, reheatingLimit);
  const entryHotHoldingLimit = stampedLimit(baseRecord?.hotHoldingLimit, hotHoldingLimit);

  // A later template change must not hide evidence already stored on an older
  // record. Empty sections still follow the current template.
  const displayDeliveries = shouldDisplayKitchenSection(showDeliveries, !!baseRecord && deliveries.length > 0);
  const displayColdFood = shouldDisplayKitchenSection(showColdFood, !!baseRecord && coldFood.length > 0);
  const displayHotTemp = shouldDisplayKitchenSection(showHotTemp, !!baseRecord && cooking.length > 0);
  const displayCooling = shouldDisplayKitchenSection(showCooling, !!baseRecord && cooling.length > 0);
  const displayReheating = shouldDisplayKitchenSection(showReheating, !!baseRecord && reheating.length > 0);
  const displayHotHolding = shouldDisplayKitchenSection(showHotHolding, !!baseRecord && hotHolding.length > 0);
  const displaySousVide = shouldDisplayKitchenSection(showSousVide, !!baseRecord && sousVide.length > 0);

  // Invalidate the record queries for the current diary scope.
  const invalidateRecords = () => {
    window.dispatchEvent(new Event("kitchen-actions-changed"));
    queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate, recordParams) });
    queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey(recordParams) });
    queryClient.invalidateQueries({ queryKey: getGetFoodSafetySummaryQueryKey().slice(0, 1) });
  };
  const handleDiaryConflict = (error: any) => {
    // Deliberate reload: the save was refused, so the latest diary replaces
    // the form (the toast tells staff to review and re-enter).
    setLoaded(null);
    const latest = error?.data?.record;
    if (latest) {
      queryClient.setQueryData(
        getGetFoodSafetyRecordByDateQueryKey(selectedDate, recordParams),
        latest,
      );
    } else {
      invalidateRecords();
    }
    toast({
      title: "Diary changed elsewhere",
      description: "New entries or edits were made while you were editing. The latest diary has been reloaded; review your changes and try again.",
      variant: "destructive",
    });
  };

  const buildData = (submittedAt?: string) => ({
    recordDate: selectedDate,
    deliveries: baseRecord || showDeliveries ? deliveries : [],
    coldFood: baseRecord || showColdFood ? coldFood : [],
    hotTemperature: baseRecord || showHotTemp ? cooking : [],
    cooling: baseRecord || showCooling ? cooling : [],
    reheating: baseRecord || showReheating ? reheating : [],
    hotHolding: baseRecord || showHotHolding ? hotHolding : [],
    sousVide: baseRecord || showSousVide ? sousVide : [],
    cookingLimit: entryCookingLimit,
    coolingLimit: entryCoolingLimit,
    reheatingLimit: entryReheatingLimit,
    hotHoldingLimit: entryHotHoldingLimit,
    // "" clears a saved value; leave unset fields out so a stale save can still merge.
    correctives: correctives || (record?.correctives ? "" : undefined),
    managerSignature: managerSignature || (record?.managerSignature ? "" : undefined),
    submittedAt,
  });
  const temperatureAssessment = (() => {
    try {
      const rules = parseKitchenTemperatureRules(config?.food_temperature_rules);
      const units = JSON.parse(config?.food_cold_units || "[]");
      const failures = assessKitchenTemperatures(baseRecord as unknown as Record<string, unknown> | null, buildData(), rules, units);
      return { failures, error: "", rules };
    } catch (problem) {
      return { failures: [] as KitchenTemperatureFailure[], error: problem instanceof Error ? problem.message : "Numeric rules could not be evaluated", rules: null };
    }
  })();
  const missingCorrective = temperatureAssessment.failures.some(failure => !failure.actionTaken);
  const holdRules = temperatureAssessment.rules;
  const holdPlaceholder = (section: "hotTemperature" | "sousVide", item: string) => {
    const hold = holdRules ? kitchenHoldRequirement(holdRules, section, item) : null;
    return hold ? `≥ ${hold.limit}` : "Optional";
  };
  const validateTemperatures = () => {
    if (temperatureAssessment.error || missingCorrective) {
      toast({ title: "Temperature follow-up required", description: temperatureAssessment.error || "Record the corrective action taken for every failed reading, using the row's action field or new corrective-action notes.", variant: "destructive" });
      return false;
    }
    return true;
  };

  // After a save the form is clean against what was sent. The saved record
  // becomes the base for further edits; if nothing was typed meanwhile, the
  // form reloads it (picking up rows merged in from other devices).
  const markSaved = (saved: unknown, savedScope: string, savedSnapshot: string) => {
    const savedRecord = saved && typeof saved === "object" && "recordDate" in saved
      ? saved as FoodSafetyRecord : null;
    if (savedRecord) {
      queryClient.setQueryData(getGetFoodSafetyRecordByDateQueryKey(selectedDate, recordParams), savedRecord);
    }
    setLoaded(current => current && current.scope === savedScope
      ? { scope: savedScope, recordKey: "saved", snapshot: savedSnapshot, record: savedRecord ?? current.record }
      : current);
  };

  const handleSaveDraft = async () => {
    if (!formReady || !validateTemperatures()) return;
    const data = buildData(undefined);
    const savedScope = scopeKey;
    const savedSnapshot = currentSnapshot;

    if (baseRecord) {
      updateRecord.mutate(
        {
          id: baseRecord.id,
          data: {
            ...data,
            expectedUpdatedAt: baseRecord.updatedAt,
            expectedRecord: buildDiaryBaseline(baseRecord),
          },
        },
        {
          onSuccess: (saved) => {
            markSaved(saved, savedScope, savedSnapshot);
            invalidateRecords();
            toast({ title: "Draft saved" });
          },
          onError: (error: any) => {
            if (error?.status === 409) {
              handleDiaryConflict(error);
              return;
            }
            toast({ title: "Failed to save", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createRecord.mutate(
        { data, params: recordParams },
        {
          onSuccess: (saved) => {
            markSaved(saved, savedScope, savedSnapshot);
            invalidateRecords();
            toast({ title: "Draft created" });
          },
          onError: (error: any) => {
            // Someone else started this day after the form loaded.
            if (error?.status === 409) {
              handleDiaryConflict(error);
              return;
            }
            toast({ title: "Failed to create", description: error.message, variant: "destructive" });
          },
        }
      );
    }
  };

  const handleSubmit = async () => {
    if (!formReady || !validateTemperatures()) return;
    if (!managerSignature.trim()) {
      toast({ title: "Manager signature required", variant: "destructive" });
      return;
    }
    const data = buildData(new Date().toISOString());
    const savedScope = scopeKey;
    const savedSnapshot = currentSnapshot;
    const onSuccess = (saved: unknown) => {
      markSaved(saved, savedScope, savedSnapshot);
      invalidateRecords();
      toast({ title: "Diary filed", description: "Kitchen diary signed off and stored." });
    };
    const onError = (error: any) => {
      if (error?.status === 409) {
        handleDiaryConflict(error);
        return;
      }
      toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
    };
    if (baseRecord) {
      updateRecord.mutate({
        id: baseRecord.id,
        data: {
          ...data,
          expectedUpdatedAt: baseRecord.updatedAt,
          expectedRecord: buildDiaryBaseline(baseRecord),
        },
      }, { onSuccess, onError });
    } else {
      createRecord.mutate({ data, params: recordParams }, { onSuccess, onError });
    }
  };

  const isFiled = !!record?.submittedAt;
  // Viewers are read-only: they see the diary locked like a filed one, with no
  // Add/Save/File actions (the server would refuse them).
  const isSubmitted = isFiled || user?.role === "client_viewer";

  return (
    <div ref={newRow.ref} className="space-y-6">
      {temperatureAssessment.error && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{temperatureAssessment.error}</p>}
      {temperatureAssessment.failures.length > 0 && <div role="alert" className="rounded border border-destructive p-3 text-sm">
        <p className="font-medium">Outside configured limits — record the action taken. Each new failed observation opens a manager-verified follow-up.</p>
        {temperatureAssessment.failures.map((failure, index) => <p key={index}>{failure.label} · {failure.field}: {kitchenFailureValue(failure)}{!failure.actionTaken ? " — corrective action required" : " — action recorded"}</p>)}
      </div>}
      <AlertDialog open={pendingScope !== null} onOpenChange={(open) => { if (!open) setPendingScope(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Save your draft before changing date or site, or discard these changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingScope) applyScope(pendingScope); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Date Picker */}
      <Card>
        <CardHeader className="border-b border-border/50 pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-display font-bold">Select Date</CardTitle>
            {isFiled && (
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
              onChange={(e) => changeScope({ date: e.target.value, siteId: selectedSiteId })}
              className="max-w-xs"
            />
            {sites && sites.length > 0 && (
              <>
                <Label className="text-sm">Site:</Label>
                <select
                  value={selectedSiteId ?? ""}
                  onChange={(e) => changeScope({ date: selectedDate, siteId: e.target.value === "" ? null : Number(e.target.value) })}
                  className="h-9 rounded-sm border border-input bg-background px-2 text-sm"
                >
                  <option value="">Organisation diary</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {recordLoading || configLoading || !formReady ? (
        <Card>
          <CardContent className="p-12 flex justify-center">
            <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Filed banner */}
          {isFiled && record?.submittedAt && (
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
          {displayDeliveries && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Deliveries</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    Chilled limit: ≤8°C · Frozen limit: ≤-15°C
                  </CardDescription>
                </div>
                {!isSubmitted && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => { newRow.expect(); setDeliveries([...deliveries, {
                      supplier: "", items: "", vanClean: "", rawCookedSep: "",
                      tempChilled: "", tempFrozen: "", tempOk: "", conditionOk: "",
                      dateCodesOk: "", allergyAware: "", correctiveActions: "",
                    }]); }}
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
          {displayColdFood && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Cold Food Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Fridge limit: ≤5°C · Freezer limit: ≤-18°C · Recommended twice daily (AM &amp; PM)</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm"
                    onClick={() => { newRow.expect(); setColdFood([...coldFood, { unit: "", tempAm: "", tempPm: "", correctiveAction: "" }]); }}>
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
                            data-cold-unit-row={i} data-cold-unit-field="am" inputMode="decimal"
                            className="h-7 text-xs rounded-sm w-24" placeholder="e.g. 3" />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input value={row.tempPm} disabled={isSubmitted} onChange={e => upd("tempPm", e.target.value)}
                            data-cold-unit-row={i} data-cold-unit-field="pm" inputMode="decimal"
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
          {displayHotTemp && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Cooking Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Target: {entryCookingLimit}</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setCooking([...cooking, { item: "", timeStart: "", timeFinish: "", coreTemp: "" }]); }}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Food item</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Time started</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Time finished</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Core temp (°C)</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Held (seconds)</th>
                    {!isSubmitted && <th className="w-8" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cooking.length === 0
                    ? <tr><td colSpan={6} className="px-4 py-5 text-center text-muted-foreground italic text-sm">No cooking records yet.</td></tr>
                    : cooking.map((row, i) => {
                      const upd = (f: keyof CookingRow, v: string) => { const n = [...cooking]; n[i] = { ...n[i], [f]: v }; setCooking(n); };
                      return (
                        <tr key={i} className="hover:bg-muted/10">
                          <td className="px-3 py-1.5"><Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)} className="h-7 text-xs rounded-sm min-w-[110px]" placeholder="e.g. Chicken" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeStart} disabled={isSubmitted} onChange={e => upd("timeStart", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeFinish} disabled={isSubmitted} onChange={e => upd("timeFinish", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder="°C" /></td>
                          <td className="px-2 py-1.5"><Input inputMode="numeric" aria-label={`${row.item || `Cooking row ${i + 1}`} seconds held at core temperature`} value={row.holdSeconds ?? ""} disabled={isSubmitted} onChange={e => upd("holdSeconds", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder={holdPlaceholder("hotTemperature", row.item)} /></td>
                          {!isSubmitted && <td className="px-2 py-1.5"><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setCooking(cooking.filter((_, x) => x !== i))}><Trash2 className="w-3 h-3 text-destructive" /></Button></td>}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* ── Cooling ──────────────────────────────────────────────────── */}
          {displayCooling && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Cooling Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Target: {entryCoolingLimit} · Rows exceeding 90 minutes are flagged red</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setCooling([...cooling, { item: "", timeStart: "", startTemp: "", timeFinish: "", coreTemp: "" }]); }}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Food item</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Cooling started</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Start temp (°C)</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Cooling finished</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">End temp (°C)</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Duration</th>
                    {!isSubmitted && <th className="w-8" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cooling.length === 0
                    ? <tr><td colSpan={7} className="px-4 py-5 text-center text-muted-foreground italic text-sm">No cooling records yet.</td></tr>
                    : cooling.map((row, i) => {
                      const upd = (f: keyof CoolingRow, v: string) => { const n = [...cooling]; n[i] = { ...n[i], [f]: v }; setCooling(n); };
                      const mins = coolingMins(row.timeStart, row.timeFinish);
                      const overTime = mins !== null && mins > (temperatureAssessment.rules?.coolingMinutes ?? 90);
                      const durationLabel = mins === null ? "" : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                      return (
                        <tr key={i} className={cn("hover:bg-muted/10", overTime && "bg-rose-50")}>
                          <td className="px-3 py-1.5"><Input value={row.item} disabled={isSubmitted} onChange={e => upd("item", e.target.value)} className="h-7 text-xs rounded-sm min-w-[110px]" placeholder="e.g. Soup" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeStart} disabled={isSubmitted} onChange={e => upd("timeStart", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input inputMode="decimal" aria-label={`${row.item || `Cooling row ${i + 1}`} temperature when cooling started`} value={row.startTemp ?? ""} disabled={isSubmitted} onChange={e => upd("startTemp", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder="°C" /></td>
                          <td className="px-2 py-1.5"><Input type="time" value={row.timeFinish} disabled={isSubmitted} onChange={e => upd("timeFinish", e.target.value)} className="h-7 text-xs rounded-sm w-24" /></td>
                          <td className="px-2 py-1.5"><Input value={row.coreTemp} disabled={isSubmitted} onChange={e => upd("coreTemp", e.target.value)} className="h-7 text-xs rounded-sm w-20" placeholder="°C" /></td>
                          <td className="px-2 py-1.5">
                            <span className={cn("text-xs font-medium", overTime ? "text-rose-600" : "text-muted-foreground")}>
                              {overTime && <AlertTriangle className="w-3 h-3 inline mr-0.5" />}{durationLabel}
                            </span>
                          </td>
                          {!isSubmitted && <td className="px-2 py-1.5"><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setCooling(cooling.filter((_, x) => x !== i))}><Trash2 className="w-3 h-3 text-destructive" /></Button></td>}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </CardContent>
          </Card>}

          {/* ── Reheating ────────────────────────────────────────────────── */}
          {displayReheating && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Reheating Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Target: {entryReheatingLimit}</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setReheating([...reheating, { item: "", timeStart: "", timeFinish: "", coreTemp: "" }]); }}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
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
          {displayHotHolding && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Hot Holding / Off-Site Temperature Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Minimum: {entryHotHoldingLimit}</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm"
                    onClick={() => { newRow.expect(); setHotHolding([...hotHolding, { item: "", coreTemp: "", timeOfCheck: "" }]); }}>
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
          {displaySousVide && <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display font-bold">Sous Vide Record</CardTitle>
                  <CardDescription className="text-xs mt-1">Log bath temperature, cooking duration and core probe temperature</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setSousVide([...sousVide, {
                    item: "", targetTemp: "", waterTemp: "", timeStarted: "", timeFinished: "", coreTemp: "", result: "", notes: "",
                  }]); }}>
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
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Held (minutes)</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Result</th>
                      <th className="text-left px-2 py-2 font-medium text-muted-foreground">Notes</th>
                      {!isSubmitted && <th className="w-8" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sousVide.length === 0 ? (
                      <tr><td colSpan={10} className="px-4 py-6 text-center text-muted-foreground italic text-sm">No sous vide records yet.</td></tr>
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
                            <Input inputMode="numeric" aria-label={`${row.item || `Sous vide row ${i + 1}`} minutes held at core temperature`} value={row.holdMinutes ?? ""} disabled={isSubmitted} onChange={e => upd("holdMinutes", e.target.value)}
                              className="h-7 text-xs rounded-sm w-16" placeholder={holdPlaceholder("sousVide", row.item)} />
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
              <CardTitle className="text-base font-display font-bold">Corrective Actions Taken</CardTitle>
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
              <CardTitle className="text-base font-display font-bold">Sign off &amp; File</CardTitle>
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
            <CheckPhotoUploader entityType="food_safety_check" entityId={record.id} compact />
          )}
        </>
      )}

      {/* History */}
      <Card>
        <CardHeader className="border-b border-border/50 pb-4">
          <CardTitle className="font-display font-bold">Recent Records</CardTitle>
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
                  onClick={() => changeScope({ date: r.recordDate, siteId: selectedSiteId })}
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

      {/* Monthly completeness calendar */}
      <FoodSafetyCompletenessCalendar
        siteId={selectedSiteId}
        onPickDay={(d) => { changeScope({ date: d, siteId: selectedSiteId }); scrollPageToTop(); }}
      />
    </div>
  );
}

// ── Kitchen Daily Checks tab ──────────────────────────────────────────────────

interface KCLItem { label: string; checked: boolean; notes?: string; section?: string; result?: ChecklistResult; }
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
  const [staffRosterId, setStaffRosterId] = useState<number | null>((existing as any)?.staffRosterId ?? null);
  const [managerNote, setManagerNote] = useState(existing?.managerNote ?? "");
  const [saving, setSaving] = useState(false);
  const submitted = !!existing?.submittedAt;

  useEffect(() => {
    setItems(existing?.items ?? effectiveDefault);
    setCompletedBy(existing?.completedBy ?? user?.name ?? "");
    setStaffRosterId((existing as any)?.staffRosterId ?? null);
    setManagerNote(existing?.managerNote ?? "");
  }, [existing, type, templateItems]);

  const setResult = (i: number, result: ChecklistResult) => { if (submitted) return; setItems(prev => prev.map((item, idx) => idx === i ? withResult(item, result) : item)); };
  const passRemaining = () => { if (submitted) return; setItems(prev => prev.map(item => itemResult(item) ? item : withResult(item, "pass"))); };
  const setNote = (i: number, note: string) => { if (submitted) return; setItems(prev => prev.map((item, idx) => idx === i ? { ...item, notes: note } : item)); };

  async function save(submit: boolean) {
    setSaving(true);
    const endpoint = KCL_ENDPOINT[type];
    const payload: any = { checklistType: type, checkDate: date, siteId: siteId ?? null, items, completedBy: completedBy || null, staffRosterId: staffRosterId, managerNote: managerNote || null };
    if (submit) payload.submittedAt = new Date().toISOString();
    const failedTitle = submit ? "Checklist not submitted" : "Draft not saved";
    try {
      const res = existing
        ? await apiFetch(`${endpoint}/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiFetch(endpoint, { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        // Keep the user's ticks; only a 409 (already submitted elsewhere)
        // reloads, to show the stored submitted copy.
        toast({ title: failedTitle, description: await getApiErrorMessage(res, "Please try again."), variant: "destructive" });
        if (res.status === 409) onSaved();
        return;
      }
      toast({ title: submit ? "Checklist submitted" : "Draft saved" });
      onSaved();
    } catch {
      toast({ title: failedTitle, description: "Check your connection and try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  const progress = checklistProgress(items);
  const hint = submitHint(progress);
  const Icon = type === "kitchen_opening" ? Sunrise : Sunset;

  return (
    <>
      <Card className="p-5 bg-card shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-primary opacity-80" />
            <h3 className="font-bold font-display">{KCL_LABELS[type]}</h3>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && !submitted && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setShowEditor(true)} title="Customise checklist">
                <Settings2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{progress.answered}/{items.length}{progress.failed > 0 && <span className="text-red-600 font-medium"> · {progress.failed} failed</span>}</span>
            {submitted
              ? <Badge className="bg-emerald-100 text-emerald-800 text-xs"><Lock className="w-3 h-3 mr-1" />Submitted</Badge>
              : progress.ready
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
                <ChecklistItemRow item={item} submitted={submitted} onResult={result => setResult(i, result)} onNote={note => setNote(i, note)} />
              </div>
            ))}
          </div>
        )}

        {!submitted && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-3">
              <StaffPerformerSelect label="Completed by" value={completedBy} onChange={setCompletedBy} onRosterIdChange={setStaffRosterId} />
              {canAdmin && <div className="space-y-1"><Label className="text-xs">Manager note</Label><Input value={managerNote} onChange={e => setManagerNote(e.target.value)} placeholder="Optional" className="h-8 text-sm" /></div>}
            </div>
            {progress.remaining > 0 && progress.answered > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={passRemaining}>Mark the {progress.remaining} remaining as Pass</Button>
            )}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={saving} className="flex-1">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save draft"}</Button>
              <Button size="sm" onClick={() => save(true)} disabled={saving || !progress.ready} className="flex-1">Submit checklist</Button>
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

  // Without a site filter the lists hold every site's rows; match the card's
  // own slot so it never edits another site's checklist.
  const getAm = (type: string) => amRows.find(c => c.checklistType === type && (c.siteId ?? null) === selectedSiteId);
  const getPm = (type: string) => pmRows.find(c => c.checklistType === type && (c.siteId ?? null) === selectedSiteId);

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
  { id: "documents", label: "HACCP & Recipes",      icon: FileText,      description: "HACCP plans and recipe spec sheets" },
];

export default function KitchenPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasKitchentrack = hasService("kitchentrack");

  const { data: foodSafetyConfig, error: configError } = useGetFoodSafetyConfig(undefined, {
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
                <h2 className="text-2xl font-display font-bold text-foreground mb-2">KitchenTrack</h2>
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
        <KitchenTemperatureControls />
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <UtensilsCrossed className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">{activeTabMeta.description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SayItButton />
            <Link href="/food-safety" className="text-sm font-medium text-primary underline underline-offset-2">Inspection register &amp; diary calendar</Link>
            <Link href="/allergens">
              <Button variant="outline" size="sm" className="gap-1.5">Allergen records</Button>
            </Link>
            {activeTab === "diary" && canAdmin && <ConfigDialog />}
          </div>
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
        <div className="flex flex-wrap gap-1 p-1 bg-muted/50 rounded-xl w-full sm:w-auto sm:inline-flex border border-border/50">
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
        {activeTab === "probe"    && <ProbeCheckTab defaultProbeNamesJson={foodSafetyConfig?.food_probe_names} />}
        {activeTab === "cleaning" && <CleaningScheduleTab />}
        {activeTab === "documents" && <DocTrackLibrary kitchen />}
      </div>
    </AppLayout>
  );
}
