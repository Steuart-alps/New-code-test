import { useState, useMemo, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import {
  useListFireSafetyChecks,
  getListFireSafetyChecksQueryKey,
  useGetFireSafetyStatus,
  getGetFireSafetyStatusQueryKey,
  useCreateFireSafetyCheck,
  useUpdateFireSafetyCheck,
  useDeleteFireSafetyCheck,
  useListSites,
  FireCheckType,
  FireSafetyCheck,
  FireSafetyStatus as FireSafetyStatusType,
  CreateFireSafetyCheckRequest,
  useGetFireSafetyConfig,
  getGetFireSafetyConfigQueryKey,
  useUpdateFireSafetyConfig,
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
import {
  Flame, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX,
  Filter, Pencil, Trash2, Lock, Route, Cpu, Check, X, Minus, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";

// ── Check type config ─────────────────────────────────────────────────────────

const ALL_CHECK_TYPES = [
  "alarm", "emergency_lights", "extinguishers",
  "fire_doors", "fire_drill", "fire_walk", "alarm_panel",
] as const;
type AnyCheckType = typeof ALL_CHECK_TYPES[number];

const CHECK_TYPE_LABELS: Record<AnyCheckType, string> = {
  alarm:            "Weekly fire alarm test",
  emergency_lights: "Monthly emergency lighting test",
  extinguishers:    "Weekly extinguisher visual check",
  fire_doors:       "Fire door check",
  fire_drill:       "Fire drill / evacuation",
  fire_walk:        "Fire walk — escape route sign-off",
  alarm_panel:      "Alarm panel check",
};

const CHECK_TYPE_GROUPS: { label: string; types: AnyCheckType[] }[] = [
  {
    label: "Regular checks",
    types: ["alarm", "alarm_panel", "emergency_lights", "extinguishers", "fire_doors"],
  },
  {
    label: "Walkthroughs & drills",
    types: ["fire_walk", "fire_drill"],
  },
];

// ── Structured note types ─────────────────────────────────────────────────────

interface EscapeRoute {
  name: string;
  status: "clear" | "obstructed" | "blocked";
  note: string;
}

interface FireWalkNotes {
  _type: "fire_walk";
  routes: EscapeRoute[];
  freeNotes: string;
}

interface AlarmPanelNotes {
  _type: "alarm_panel";
  panelStatus: "normal" | "fault" | "zones_active";
  faultsFound: string;
  zonesTested: string;
  actionsTaken: string;
  freeNotes: string;
}

function parseStructuredNotes(notes: string | null | undefined): FireWalkNotes | AlarmPanelNotes | null {
  if (!notes) return null;
  try {
    const obj = JSON.parse(notes);
    if (obj._type === "fire_walk" || obj._type === "alarm_panel") return obj;
  } catch {}
  return null;
}

function autoFireWalkResult(routes: EscapeRoute[]): "pass" | "fail" {
  if (routes.length === 0) return "pass";
  return routes.some(r => r.status !== "clear") ? "fail" : "pass";
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: "ok" | "due_soon" | "overdue" | "never" }) {
  if (status === "ok") return (
    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
      <CheckCircle2 className="w-3 h-3 mr-1" />OK
    </Badge>
  );
  if (status === "due_soon") return (
    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
      <Clock className="w-3 h-3 mr-1" />Due Soon
    </Badge>
  );
  if (status === "overdue") return (
    <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
      <AlertTriangle className="w-3 h-3 mr-1" />Overdue
    </Badge>
  );
  return (
    <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">
      <CalendarX className="w-3 h-3 mr-1" />Never
    </Badge>
  );
}

// ── Escape route editor ───────────────────────────────────────────────────────

function EscapeRouteEditor({
  routes,
  onChange,
}: {
  routes: EscapeRoute[];
  onChange: (routes: EscapeRoute[]) => void;
}) {
  function add() {
    onChange([...routes, { name: "", status: "clear", note: "" }]);
  }
  function remove(i: number) {
    onChange(routes.filter((_, idx) => idx !== i));
  }
  function update(i: number, patch: Partial<EscapeRoute>) {
    onChange(routes.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }

  return (
    <div className="space-y-2">
      {routes.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No routes added yet. Add each escape route below.</p>
      )}
      {routes.map((r, i) => (
        <div key={i} className="flex gap-2 items-start">
          <Input
            value={r.name}
            onChange={e => update(i, { name: e.target.value })}
            placeholder={`Route ${i + 1} (e.g. "Main entrance → car park")`}
            className="rounded-sm text-sm flex-1"
          />
          <div className="flex gap-0.5 flex-shrink-0">
            {(["clear", "obstructed", "blocked"] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => update(i, { status: s })}
                className={cn(
                  "px-2 py-1.5 text-xs rounded-sm border font-medium transition-colors",
                  r.status === s
                    ? s === "clear"      ? "bg-emerald-600 text-white border-emerald-600"
                    : s === "obstructed" ? "bg-amber-500 text-white border-amber-500"
                    :                     "bg-rose-600 text-white border-rose-600"
                    : "bg-background text-muted-foreground border-border hover:border-primary/50"
                )}
              >
                {s === "clear" ? "✓" : s === "obstructed" ? "!" : "✗"}
              </button>
            ))}
          </div>
          <Input
            value={r.note}
            onChange={e => update(i, { note: e.target.value })}
            placeholder="Notes (optional)"
            className="rounded-sm text-sm w-36 flex-shrink-0"
          />
          <button type="button" onClick={() => remove(i)} className="text-muted-foreground hover:text-destructive mt-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} className="rounded-sm gap-1.5 text-xs">
        <Plus className="w-3 h-3" /> Add Route
      </Button>
    </div>
  );
}

// ── Structured notes display ──────────────────────────────────────────────────

function FireWalkDisplay({ data }: { data: FireWalkNotes }) {
  return (
    <div className="space-y-1.5 mt-1">
      {data.routes.length > 0 && (
        <div className="space-y-1">
          {data.routes.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={cn("font-medium flex-shrink-0",
                r.status === "clear" ? "text-emerald-700" : r.status === "obstructed" ? "text-amber-700" : "text-rose-700"
              )}>
                {r.status === "clear" ? "✓" : r.status === "obstructed" ? "⚠" : "✗"}
              </span>
              <span className="text-muted-foreground">{r.name || `Route ${i + 1}`}</span>
              {r.note && <span className="text-muted-foreground italic">— {r.note}</span>}
            </div>
          ))}
        </div>
      )}
      {data.freeNotes && <p className="text-xs text-muted-foreground"><span className="font-medium">Notes:</span> {data.freeNotes}</p>}
    </div>
  );
}

function AlarmPanelDisplay({ data }: { data: AlarmPanelNotes }) {
  const statusLabel = { normal: "Normal", fault: "Fault", zones_active: "Zones active" }[data.panelStatus] ?? data.panelStatus;
  const statusCls = data.panelStatus === "normal" ? "text-emerald-700" : data.panelStatus === "fault" ? "text-rose-700" : "text-amber-700";
  return (
    <div className="space-y-0.5 mt-1 text-xs text-muted-foreground">
      <p><span className="font-medium">Panel status:</span> <span className={statusCls}>{statusLabel}</span></p>
      {data.faultsFound && <p><span className="font-medium">Faults:</span> {data.faultsFound}</p>}
      {data.zonesTested && <p><span className="font-medium">Zones tested:</span> {data.zonesTested}</p>}
      {data.actionsTaken && <p><span className="font-medium">Actions taken:</span> {data.actionsTaken}</p>}
      {data.freeNotes && <p><span className="font-medium">Notes:</span> {data.freeNotes}</p>}
    </div>
  );
}

// ── Config Dialog ─────────────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T[]; } catch { return fallback; }
}

function FireConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetFireSafetyConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateFireSafetyConfig();

  const [defaultPerformer, setDefaultPerformer] = useState("");
  const [escapeRoutes, setEscapeRoutes] = useState<Array<{ name: string; location: string }>>([]);
  const [alarmZones, setAlarmZones] = useState<string[]>([]);
  const [extinguisherPoints, setExtinguisherPoints] = useState<string[]>([]);

  useEffect(() => {
    if (!config || !open) return;
    setDefaultPerformer(config.fire_default_performer ?? "");
    setEscapeRoutes(parseJsonArray<{ name: string; location: string }>(config.fire_escape_routes));
    setAlarmZones(parseJsonArray<string>(config.fire_alarm_zones));
    setExtinguisherPoints(parseJsonArray<string>(config.fire_extinguisher_points));
  }, [config, open]);

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          fire_default_performer: defaultPerformer,
          fire_escape_routes: JSON.stringify(escapeRoutes.filter(r => r.name || r.location)),
          fire_alarm_zones: JSON.stringify(alarmZones.filter(Boolean)),
          fire_extinguisher_points: JSON.stringify(extinguisherPoints.filter(Boolean)),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyConfigQueryKey() });
          toast({ title: "Template saved", description: "New checks will use these defaults." });
          setOpen(false);
        },
        onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
      }
    );
  };

  const StringListEditor = ({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) => (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 items-center">
          <Input value={item} placeholder={placeholder} className="h-8 text-sm rounded-sm"
            onChange={e => { const n = [...items]; n[i] = e.target.value; onChange(n); }} />
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0"
            onClick={() => onChange(items.filter((_, x) => x !== i))}>
            <X className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...items, ""])}>
        <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
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
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>FireTrack Template</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">Configure defaults for new fire safety checks.</p>
        </DialogHeader>

        <Tabs defaultValue="defaults" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0 w-full grid grid-cols-4">
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
            <TabsTrigger value="routes">Escape Routes</TabsTrigger>
            <TabsTrigger value="zones">Alarm Zones</TabsTrigger>
            <TabsTrigger value="ext">Extinguishers</TabsTrigger>
          </TabsList>

          <TabsContent value="defaults" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <div className="space-y-1.5">
              <Label>Default performed by</Label>
              <Input value={defaultPerformer} onChange={e => setDefaultPerformer(e.target.value)}
                placeholder="e.g. Fire Marshal on duty" className="rounded-sm" />
              <p className="text-xs text-muted-foreground">Pre-fills the "Performed by" field on every new check.</p>
            </div>
          </TabsContent>

          <TabsContent value="routes" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List your named escape routes. They'll be pre-loaded when recording a fire walk so staff just mark each one clear or obstructed.
            </p>
            <div className="space-y-2">
              {escapeRoutes.map((r, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1">
                    <Input value={r.name} placeholder='Route name (e.g. "Main entrance → car park")'
                      className="h-8 text-sm rounded-sm"
                      onChange={e => { const n = [...escapeRoutes]; n[i] = { ...n[i], name: e.target.value }; setEscapeRoutes(n); }} />
                    <Input value={r.location} placeholder="Location / assembly point (optional)"
                      className="h-7 text-xs rounded-sm"
                      onChange={e => { const n = [...escapeRoutes]; n[i] = { ...n[i], location: e.target.value }; setEscapeRoutes(n); }} />
                  </div>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0 mt-0.5"
                    onClick={() => setEscapeRoutes(escapeRoutes.filter((_, x) => x !== i))}>
                    <X className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setEscapeRoutes([...escapeRoutes, { name: "", location: "" }])}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add route
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="zones" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List your alarm panel zones. They'll be pre-filled in the "Zones tested" field on alarm panel checks.
            </p>
            <StringListEditor items={alarmZones} onChange={setAlarmZones} placeholder='e.g. "Zone 1 — Ground floor"' />
          </TabsContent>

          <TabsContent value="ext" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List your extinguisher locations. Used as reference during extinguisher visual checks.
            </p>
            <StringListEditor items={extinguisherPoints} onChange={setExtinguisherPoints} placeholder='e.g. "Reception — CO₂"' />
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

// ── Record Check Dialog ───────────────────────────────────────────────────────

function RecordCheckDialog({
  siteId,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultCheckType,
}: {
  siteId?: number;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  defaultCheckType?: AnyCheckType;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (controlledOpen !== undefined) controlledOnOpenChange?.(v);
    else setInternalOpen(v);
  };
  const [checkType, setCheckType] = useState<AnyCheckType>("alarm");

  // When opened via a status card click, pre-select that check type
  useEffect(() => {
    if (open && defaultCheckType) setCheckType(defaultCheckType);
  }, [open, defaultCheckType]);
  const [checkDate, setCheckDate] = useState(todayIso());
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [location, setLocation] = useState("");
  const { user } = useAuth();
  const [performedBy, setPerformedBy] = useState(user?.name ?? "");
  const [notes, setNotes] = useState("");
  const [selectedSite, setSelectedSite] = useState<number | undefined>(siteId);

  // Fire walk state
  const [routes, setRoutes] = useState<EscapeRoute[]>([]);

  // Alarm panel state
  const [panelStatus, setPanelStatus] = useState<"normal" | "fault" | "zones_active">("normal");
  const [faultsFound, setFaultsFound] = useState("");
  const [zonesTested, setZonesTested] = useState("");
  const [actionsTaken, setActionsTaken] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createCheck = useCreateFireSafetyCheck();
  const { data: sites } = useListSites();
  const { data: config } = useGetFireSafetyConfig();

  // Pre-fill from template
  useEffect(() => {
    if (!open || !config) return;
    if (!performedBy && config.fire_default_performer) setPerformedBy(config.fire_default_performer);
  }, [open]);

  // Pre-fill check-type-specific fields when checkType changes (only if still empty)
  useEffect(() => {
    if (!open || !config) return;
    if (checkType === "fire_walk" && routes.length === 0 && config.fire_escape_routes) {
      try {
        const saved = JSON.parse(config.fire_escape_routes) as Array<{ name: string; location: string }>;
        if (Array.isArray(saved) && saved.length > 0) {
          setRoutes(saved.map(r => ({ name: r.name || "", status: "clear" as const, note: r.location || "" })));
        }
      } catch {}
    }
    if (checkType === "alarm_panel" && !zonesTested && config.fire_alarm_zones) {
      try {
        const zones = JSON.parse(config.fire_alarm_zones) as string[];
        if (Array.isArray(zones) && zones.length > 0) setZonesTested(zones.filter(Boolean).join(", "));
      } catch {}
    }
  }, [open, checkType, config]);

  // Auto-compute result for fire walk
  const effectiveResult: "pass" | "fail" = checkType === "fire_walk"
    ? autoFireWalkResult(routes)
    : checkType === "alarm_panel"
    ? (panelStatus === "fault" ? "fail" : "pass")
    : result;

  function buildNotes(): string | undefined {
    if (checkType === "fire_walk") {
      const data: FireWalkNotes = { _type: "fire_walk", routes, freeNotes: notes };
      return JSON.stringify(data);
    }
    if (checkType === "alarm_panel") {
      const data: AlarmPanelNotes = {
        _type: "alarm_panel", panelStatus, faultsFound, zonesTested, actionsTaken, freeNotes: notes,
      };
      return JSON.stringify(data);
    }
    return notes || undefined;
  }

  function reset() {
    setCheckDate(todayIso()); setResult("pass"); setLocation(""); setPerformedBy(user?.name ?? ""); setNotes("");
    setRoutes([]); setPanelStatus("normal"); setFaultsFound(""); setZonesTested(""); setActionsTaken("");
  }

  const handleSubmit = async () => {
    const data: CreateFireSafetyCheckRequest = {
      checkType: checkType as FireCheckType,
      checkDate,
      result: effectiveResult,
      siteId: selectedSite,
      location: location || undefined,
      performedBy: performedBy || undefined,
      notes: buildNotes(),
    };
    createCheck.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          toast({ title: "Check recorded", description: "Fire safety check saved." });
          reset(); setOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to record check", description: error.message || "An error occurred.", variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button className="shadow-lg shadow-primary/20">
          <Plus className="w-4 h-4 mr-2" />Record Check
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">Record Fire Safety Check</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Check type — grouped */}
          <div className="space-y-1.5">
            <Label>Check Type</Label>
            <Select value={checkType} onValueChange={v => setCheckType(v as AnyCheckType)}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHECK_TYPE_GROUPS.map(g => (
                  <div key={g.label}>
                    <p className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{g.label}</p>
                    {g.types.map(k => (
                      <SelectItem key={k} value={k}>{CHECK_TYPE_LABELS[k]}</SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={checkDate} onChange={e => setCheckDate(e.target.value)} className="rounded-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Performed By <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input value={performedBy} onChange={e => setPerformedBy(e.target.value)} placeholder="Name" className="rounded-sm" />
            </div>
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

          {/* ── Fire walk ─────────────────────────────────────────────────── */}
          {checkType === "fire_walk" && (
            <div className="space-y-3 border border-border rounded-sm p-3 bg-muted/20">
              <div className="flex items-center gap-2">
                <Route className="w-4 h-4 text-primary flex-shrink-0" />
                <p className="text-sm font-medium">Escape Route Sign-Off</p>
              </div>
              <EscapeRouteEditor routes={routes} onChange={setRoutes} />
              {routes.length > 0 && (
                <div className={cn("text-xs px-3 py-2 rounded-sm border font-medium",
                  autoFireWalkResult(routes) === "pass"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-rose-50 text-rose-700 border-rose-200"
                )}>
                  {autoFireWalkResult(routes) === "pass"
                    ? "✓ All routes clear — sign-off will be recorded as Pass"
                    : "✗ One or more routes obstructed or blocked — recorded as Fail"}
                </div>
              )}
            </div>
          )}

          {/* ── Alarm panel ───────────────────────────────────────────────── */}
          {checkType === "alarm_panel" && (
            <div className="space-y-3 border border-border rounded-sm p-3 bg-muted/20">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary flex-shrink-0" />
                <p className="text-sm font-medium">Alarm Panel Details</p>
              </div>
              <div className="space-y-1.5">
                <Label>Panel status</Label>
                <div className="flex gap-2">
                  {([
                    { v: "normal",      label: "Normal",       cls: "bg-emerald-600 border-emerald-600 text-white" },
                    { v: "fault",       label: "Fault",        cls: "bg-rose-600 border-rose-600 text-white" },
                    { v: "zones_active",label: "Zones active", cls: "bg-amber-500 border-amber-500 text-white" },
                  ] as const).map(o => (
                    <button key={o.v} type="button" onClick={() => setPanelStatus(o.v)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-medium rounded-sm border transition-colors",
                        panelStatus === o.v ? o.cls : "bg-background text-muted-foreground border-border hover:border-primary/50"
                      )}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Zones tested <span className="text-muted-foreground text-xs">optional</span></Label>
                <Input value={zonesTested} onChange={e => setZonesTested(e.target.value)} placeholder="e.g. Zone 1 – Ground floor, Zone 2 – First floor" className="rounded-sm" />
              </div>
              {panelStatus !== "normal" && (
                <div className="space-y-1.5">
                  <Label>Faults / issues found</Label>
                  <Textarea value={faultsFound} onChange={e => setFaultsFound(e.target.value)} placeholder="Describe the fault or active zone…" rows={2} className="rounded-sm" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Actions taken <span className="text-muted-foreground text-xs">optional</span></Label>
                <Input value={actionsTaken} onChange={e => setActionsTaken(e.target.value)} placeholder="e.g. Reported to engineer, none required" className="rounded-sm" />
              </div>
            </div>
          )}

          {/* ── Standard result (not fire_walk / alarm_panel) ─────────────── */}
          {checkType !== "fire_walk" && checkType !== "alarm_panel" && (
            <div className="space-y-1.5">
              <Label>Result</Label>
              <Select value={result} onValueChange={v => setResult(v as "pass" | "fail")}>
                <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass</SelectItem>
                  <SelectItem value="fail">Fail</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {checkType !== "fire_walk" && checkType !== "alarm_panel" && (
            <div className="space-y-1.5">
              <Label>Location / Call Point <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Ground floor near kitchen" className="rounded-sm" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{checkType === "fire_walk" || checkType === "alarm_panel" ? "Additional notes" : "Notes"} <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); setOpen(false); }}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={createCheck.isPending}>
            {createCheck.isPending ? "Saving…" : "Record Check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Check Dialog ─────────────────────────────────────────────────────────

function EditCheckDialog({ check, siteId }: { check: FireSafetyCheck; siteId?: number }) {
  const [open, setOpen] = useState(false);
  const structured = useMemo(() => parseStructuredNotes(check.notes), [check.notes, open]);

  const [checkDate, setCheckDate] = useState(check.checkDate);
  const [result, setResult] = useState<"pass" | "fail">(check.result as "pass" | "fail");
  const [location, setLocation] = useState(check.location || "");
  const [performedBy, setPerformedBy] = useState(check.performedBy || "");
  const [notes, setNotes] = useState(
    structured ? (structured as any).freeNotes ?? "" : check.notes || ""
  );
  const [selectedSite, setSelectedSite] = useState<number | undefined>(check.siteId || undefined);

  // Fire walk
  const [routes, setRoutes] = useState<EscapeRoute[]>(
    structured?._type === "fire_walk" ? (structured as FireWalkNotes).routes : []
  );

  // Alarm panel
  const initPanel = structured?._type === "alarm_panel" ? (structured as AlarmPanelNotes) : null;
  const [panelStatus, setPanelStatus] = useState<"normal" | "fault" | "zones_active">(initPanel?.panelStatus ?? "normal");
  const [faultsFound, setFaultsFound] = useState(initPanel?.faultsFound ?? "");
  const [zonesTested, setZonesTested] = useState(initPanel?.zonesTested ?? "");
  const [actionsTaken, setActionsTaken] = useState(initPanel?.actionsTaken ?? "");

  const checkType = check.checkType as AnyCheckType;
  const isFireWalk = checkType === "fire_walk";
  const isPanel = checkType === "alarm_panel";

  const effectiveResult: "pass" | "fail" = isFireWalk
    ? autoFireWalkResult(routes)
    : isPanel
    ? (panelStatus === "fault" ? "fail" : "pass")
    : result;

  function buildNotes(): string | undefined {
    if (isFireWalk) return JSON.stringify({ _type: "fire_walk", routes, freeNotes: notes } satisfies FireWalkNotes);
    if (isPanel) return JSON.stringify({ _type: "alarm_panel", panelStatus, faultsFound, zonesTested, actionsTaken, freeNotes: notes } satisfies AlarmPanelNotes);
    return notes || undefined;
  }

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateCheck = useUpdateFireSafetyCheck();
  const { data: sites } = useListSites();

  const handleSubmit = () => {
    updateCheck.mutate(
      {
        id: check.id,
        data: {
          checkDate, result: effectiveResult,
          siteId: selectedSite, location: location || undefined,
          performedBy: performedBy || undefined, notes: buildNotes(),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          toast({ title: "Check updated" }); setOpen(false);
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
      <DialogContent className="max-w-xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            Edit — {CHECK_TYPE_LABELS[checkType] ?? check.checkType}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={checkDate} onChange={e => setCheckDate(e.target.value)} className="rounded-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Performed By</Label>
              <Input value={performedBy} onChange={e => setPerformedBy(e.target.value)} className="rounded-sm" />
            </div>
          </div>

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site</Label>
              <Select value={selectedSite ? String(selectedSite) : "none"} onValueChange={v => setSelectedSite(v === "none" ? undefined : Number(v))}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {isFireWalk && (
            <div className="space-y-3 border border-border rounded-sm p-3 bg-muted/20">
              <div className="flex items-center gap-2">
                <Route className="w-4 h-4 text-primary flex-shrink-0" />
                <p className="text-sm font-medium">Escape Route Sign-Off</p>
              </div>
              <EscapeRouteEditor routes={routes} onChange={setRoutes} />
              {routes.length > 0 && (
                <div className={cn("text-xs px-3 py-2 rounded-sm border font-medium",
                  autoFireWalkResult(routes) === "pass"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-rose-50 text-rose-700 border-rose-200"
                )}>
                  {autoFireWalkResult(routes) === "pass" ? "✓ All routes clear" : "✗ Route(s) obstructed/blocked — Fail"}
                </div>
              )}
            </div>
          )}

          {isPanel && (
            <div className="space-y-3 border border-border rounded-sm p-3 bg-muted/20">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary flex-shrink-0" />
                <p className="text-sm font-medium">Alarm Panel Details</p>
              </div>
              <div className="space-y-1.5">
                <Label>Panel status</Label>
                <div className="flex gap-2">
                  {([
                    { v: "normal",      label: "Normal",       cls: "bg-emerald-600 border-emerald-600 text-white" },
                    { v: "fault",       label: "Fault",        cls: "bg-rose-600 border-rose-600 text-white" },
                    { v: "zones_active",label: "Zones active", cls: "bg-amber-500 border-amber-500 text-white" },
                  ] as const).map(o => (
                    <button key={o.v} type="button" onClick={() => setPanelStatus(o.v)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-medium rounded-sm border transition-colors",
                        panelStatus === o.v ? o.cls : "bg-background text-muted-foreground border-border hover:border-primary/50"
                      )}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Zones tested</Label>
                <Input value={zonesTested} onChange={e => setZonesTested(e.target.value)} className="rounded-sm" />
              </div>
              {panelStatus !== "normal" && (
                <div className="space-y-1.5">
                  <Label>Faults found</Label>
                  <Textarea value={faultsFound} onChange={e => setFaultsFound(e.target.value)} rows={2} className="rounded-sm" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Actions taken</Label>
                <Input value={actionsTaken} onChange={e => setActionsTaken(e.target.value)} className="rounded-sm" />
              </div>
            </div>
          )}

          {!isFireWalk && !isPanel && (
            <>
              <div className="space-y-1.5">
                <Label>Result</Label>
                <Select value={result} onValueChange={v => setResult(v as "pass" | "fail")}>
                  <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pass">Pass</SelectItem>
                    <SelectItem value="fail">Fail</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Location / Call Point</Label>
                <Input value={location} onChange={e => setLocation(e.target.value)} className="rounded-sm" />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label>{isFireWalk || isPanel ? "Additional notes" : "Notes"}</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="rounded-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={updateCheck.isPending}>
            {updateCheck.isPending ? "Saving…" : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FireSafetyPage() {
  const { hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const hasFiretrack = hasService("firetrack");

  const [filterType, setFilterType] = useState<AnyCheckType | "">("");
  const [filterSite, setFilterSite] = useState<number | undefined>(undefined);
  const [recordOpen, setRecordOpen] = useState(false);
  const [quickCheckType, setQuickCheckType] = useState<AnyCheckType | undefined>(undefined);

  const { data: status, isLoading: statusLoading, error: statusError } = useGetFireSafetyStatus(
    { siteId: filterSite },
    { query: { enabled: hasFiretrack, retry: (count, err: any) => err?.status !== 403 && count < 3 } }
  );
  const serverLocked = (statusError as any)?.status === 403;
  const { data: checks, isLoading: checksLoading } = useListFireSafetyChecks(
    { checkType: filterType as FireCheckType || undefined, siteId: filterSite },
    { query: { enabled: hasFiretrack } }
  );
  const { data: sites } = useListSites({ query: { enabled: hasFiretrack } });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const deleteCheck = useDeleteFireSafetyCheck();

  const handleDelete = (id: number) => {
    if (!confirm("Delete this check record?")) return;
    deleteCheck.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          toast({ title: "Check deleted" });
        },
        onError: (error: any) => {
          toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  if (!hasFiretrack || serverLocked) {
    return (
      <AppLayout title="FireTrack — Fire Safety Logbook">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-foreground mb-2">FireTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital fire safety logbook — record checks, fire walks, and alarm panel inspections.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button size="lg" className="w-full sm:w-auto font-medium">Enable FireTrack</Button>
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

  const overdueStatuses = status?.filter(s => s.status === "overdue") || [];
  const dueSoonStatuses = status?.filter(s => s.status === "due_soon") || [];

  return (
    <AppLayout title="FireTrack — Fire Safety Logbook">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <Flame className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">
              Fire safety logbook — alarm tests, fire walks, escape route sign-offs, panel checks
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && <FireConfigDialog />}
            <RecordCheckDialog siteId={filterSite} open={recordOpen} onOpenChange={setRecordOpen} defaultCheckType={quickCheckType} />
          </div>
        </div>

        {/* Status overview — two rows */}
        {statusLoading ? (
          <Card>
            <CardContent className="p-12 flex justify-center">
              <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {status?.map(item => (
              <Card
                key={item.checkType}
                className={cn(
                  "border-l-4 transition-all hover:shadow-md cursor-pointer group",
                  item.status === "overdue"  ? "border-l-rose-500 bg-rose-50/50" :
                  item.status === "due_soon" ? "border-l-amber-500 bg-amber-50/50" :
                  item.status === "never"    ? "border-l-slate-400 bg-slate-50/50" :
                                               "border-l-emerald-500 bg-emerald-50/50"
                )}
                onClick={() => { setQuickCheckType(item.checkType as AnyCheckType); setRecordOpen(true); }}
              >
                <CardHeader className="pb-2 pt-3 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-xs font-medium leading-snug text-foreground">
                      {CHECK_TYPE_LABELS[item.checkType as AnyCheckType] ?? item.checkType}
                    </CardTitle>
                    <StatusBadge status={item.status as any} />
                  </div>
                </CardHeader>
                <CardContent className="pb-3 px-4 space-y-0.5">
                  <div className="text-xs text-muted-foreground">Every {item.frequencyDays} days</div>
                  {item.lastDate && (
                    <div className="text-xs text-muted-foreground">
                      Last: {format(new Date(item.lastDate), "dd/MM/yyyy")}
                    </div>
                  )}
                  {item.dueDate && (
                    <div className="text-xs text-muted-foreground">
                      Due: {format(new Date(item.dueDate), "dd/MM/yyyy")}
                    </div>
                  )}
                  {item.status === "never" && (
                    <div className="text-xs text-muted-foreground italic">Not yet recorded</div>
                  )}
                  <div className="text-[11px] text-primary opacity-0 group-hover:opacity-100 transition-opacity pt-0.5 font-medium">
                    + Record check →
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Alert banners */}
        {(overdueStatuses.length > 0 || dueSoonStatuses.length > 0) && (
          <div className="space-y-3">
            {overdueStatuses.length > 0 && (
              <div className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> Overdue checks
                </div>
                <div className="text-xs">
                  {overdueStatuses.map(s => CHECK_TYPE_LABELS[s.checkType as AnyCheckType] ?? s.checkType).join(", ")} — action required.
                </div>
              </div>
            )}
            {dueSoonStatuses.length > 0 && (
              <div className="rounded-sm border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" /> Due soon
                </div>
                <div className="text-xs">
                  {dueSoonStatuses.map(s => CHECK_TYPE_LABELS[s.checkType as AnyCheckType] ?? s.checkType).join(", ")} — schedule soon.
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
                <Select value={filterType || "all"} onValueChange={v => setFilterType(v === "all" ? "" : v as AnyCheckType)}>
                  <SelectTrigger className="rounded-sm"><SelectValue placeholder="All types" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {CHECK_TYPE_GROUPS.map(g => (
                      <div key={g.label}>
                        <p className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{g.label}</p>
                        {g.types.map(k => <SelectItem key={k} value={k}>{CHECK_TYPE_LABELS[k]}</SelectItem>)}
                      </div>
                    ))}
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

        {/* Check history */}
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
                <Flame className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No checks recorded yet. Record your first check above.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {checks.map(check => {
                  const site = sites?.find(s => s.id === check.siteId);
                  const structured = parseStructuredNotes(check.notes);
                  return (
                    <div key={check.id} className="p-4 hover:bg-muted/20 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">
                              {CHECK_TYPE_LABELS[check.checkType as AnyCheckType] ?? check.checkType}
                            </span>
                            <Badge variant="outline" className={cn(
                              check.result === "pass"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : "bg-rose-50 text-rose-700 border-rose-200"
                            )}>
                              {check.result === "pass" ? "Pass" : "Fail"}
                            </Badge>
                            {site && <Badge variant="outline" className="text-xs">{site.name}</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground space-y-0.5">
                            <div><span className="font-medium">Date:</span> {format(new Date(check.checkDate), "dd/MM/yyyy")}</div>
                            {check.performedBy && <div><span className="font-medium">Performed by:</span> {check.performedBy}</div>}
                            {check.location && <div><span className="font-medium">Location:</span> {check.location}</div>}
                          </div>
                          {/* Structured display */}
                          {structured?._type === "fire_walk" && <FireWalkDisplay data={structured as FireWalkNotes} />}
                          {structured?._type === "alarm_panel" && <AlarmPanelDisplay data={structured as AlarmPanelNotes} />}
                          {/* Plain notes fallback */}
                          {!structured && check.notes && (
                            <div className="text-xs text-muted-foreground"><span className="font-medium">Notes:</span> {check.notes}</div>
                          )}
                          <CheckPhotoUploader entityType="fire_safety_check" entityId={check.id} compact />
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <EditCheckDialog check={check} siteId={filterSite} />
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
