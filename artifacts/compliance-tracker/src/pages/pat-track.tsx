import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
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
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin, type AuthClient } from "@/context/auth-context";
import {
  useGetPATTrackConfig,
  getGetPATTrackConfigQueryKey,
  useUpdatePATTrackConfig,
} from "@workspace/api-client-react";
import {
  Zap, Plus, AlertTriangle, CheckCircle2, Clock, Pencil, Trash2,
  Lock, Search, Settings, X, ClipboardList, PackageCheck, Library,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, addMonths, parseISO, isValid } from "date-fns";

// ─── Constants ─────────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const APPLIANCE_TYPES = [
  "Class I", "Class II", "Class III",
  "Extension Lead", "IT Equipment", "Portable Tool",
  "Cleaning Equipment", "AV Equipment", "Kitchen Appliance", "Other",
] as const;

const ITEM_RESULTS = ["pass", "fail", "na"] as const;

// ─── Room presets ──────────────────────────────────────────────────────────────

const ROOM_PRESETS = {
  "hotel-suite": {
    label: "Hotel Suite",
    emoji: "🛏️",
    items: [
      { name: "Television",               type: "AV Equipment"      },
      { name: "Bedside Lamp (Left)",      type: "Class I"           },
      { name: "Bedside Lamp (Right)",     type: "Class I"           },
      { name: "Standing Lamp",            type: "Class I"           },
      { name: "Mini Fridge",              type: "Kitchen Appliance" },
      { name: "Kettle",                   type: "Kitchen Appliance" },
      { name: "Hair Dryer",               type: "Class II"          },
      { name: "Iron",                     type: "Class I"           },
      { name: "Trouser Press",            type: "Class I"           },
      { name: "Telephone",                type: "IT Equipment"      },
      { name: "Air Conditioning Unit",    type: "Class I"           },
      { name: "Shower Radio",             type: "AV Equipment"      },
      { name: "Safe (Electric)",          type: "Class I"           },
    ],
  },
  "hotel-classic": {
    label: "Classic Hotel Room",
    emoji: "🏨",
    items: [
      { name: "Television",   type: "AV Equipment"      },
      { name: "Bedside Lamp", type: "Class I"           },
      { name: "Desk Lamp",    type: "Class I"           },
      { name: "Kettle",       type: "Kitchen Appliance" },
      { name: "Hair Dryer",   type: "Class II"          },
      { name: "Iron",         type: "Class I"           },
      { name: "Telephone",    type: "IT Equipment"      },
    ],
  },
  "office": {
    label: "Office",
    emoji: "💼",
    items: [
      { name: "Desktop PC",          type: "IT Equipment"  },
      { name: "Monitor",             type: "IT Equipment"  },
      { name: "Desk Lamp",           type: "Class I"       },
      { name: "Extension Lead",      type: "Extension Lead"},
      { name: "Printer",             type: "IT Equipment"  },
      { name: "Shredder",            type: "IT Equipment"  },
      { name: "Desk Fan",            type: "Class I"       },
      { name: "Telephone / Handset", type: "IT Equipment"  },
      { name: "Laptop Charger",      type: "IT Equipment"  },
      { name: "Cordless Phone Base", type: "IT Equipment"  },
    ],
  },
  "bar-restaurant": {
    label: "Bar / Restaurant",
    emoji: "🍽️",
    items: [
      { name: "Commercial Coffee Machine", type: "Kitchen Appliance" },
      { name: "Blender",                   type: "Kitchen Appliance" },
      { name: "Toaster",                   type: "Kitchen Appliance" },
      { name: "Kettle",                    type: "Kitchen Appliance" },
      { name: "Bar Fridge",                type: "Kitchen Appliance" },
      { name: "Ice Machine",               type: "Kitchen Appliance" },
      { name: "Glasswasher",               type: "Class I"           },
      { name: "POS Terminal",              type: "IT Equipment"      },
      { name: "Card Payment Terminal",     type: "IT Equipment"      },
      { name: "Television",               type: "AV Equipment"      },
      { name: "Radio / Music System",      type: "AV Equipment"      },
      { name: "Electric Bottle Opener",    type: "Kitchen Appliance" },
    ],
  },
  "reception": {
    label: "Reception",
    emoji: "🛎️",
    items: [
      { name: "Desktop PC",            type: "IT Equipment"  },
      { name: "Monitor",               type: "IT Equipment"  },
      { name: "Printer",               type: "IT Equipment"  },
      { name: "Telephone / Switchboard",type: "IT Equipment"  },
      { name: "Desk Lamp",             type: "Class I"       },
      { name: "Extension Lead",        type: "Extension Lead"},
      { name: "Card Payment Terminal", type: "IT Equipment"  },
      { name: "Cordless Phone",        type: "IT Equipment"  },
      { name: "TV / Information Screen",type: "AV Equipment"  },
    ],
  },
  "kitchen": {
    label: "Kitchen",
    emoji: "🍳",
    items: [
      { name: "Commercial Microwave",       type: "Kitchen Appliance" },
      { name: "Kettle",                     type: "Kitchen Appliance" },
      { name: "Toaster",                    type: "Kitchen Appliance" },
      { name: "Food Blender",               type: "Kitchen Appliance" },
      { name: "Stand Mixer / Food Mixer",   type: "Kitchen Appliance" },
      { name: "Commercial Coffee Machine",  type: "Kitchen Appliance" },
      { name: "Hot Water Urn",              type: "Kitchen Appliance" },
      { name: "Soup Kettle",                type: "Kitchen Appliance" },
      { name: "Contact Grill / Sandwich Press", type: "Kitchen Appliance" },
      { name: "Electric Deep Fryer",        type: "Kitchen Appliance" },
      { name: "Bain Marie",                 type: "Kitchen Appliance" },
      { name: "Hand Blender",               type: "Kitchen Appliance" },
      { name: "Refrigerator",               type: "Kitchen Appliance" },
      { name: "Chest Freezer",              type: "Kitchen Appliance" },
      { name: "Dishwasher",                 type: "Class I"           },
      { name: "Waffle Maker",               type: "Kitchen Appliance" },
      { name: "Juicer",                     type: "Kitchen Appliance" },
    ],
  },
  "pro-shop": {
    label: "Pro-Shop",
    emoji: "⛳",
    items: [
      { name: "Desktop PC",                  type: "IT Equipment"      },
      { name: "Printer",                     type: "IT Equipment"      },
      { name: "POS Terminal / Cash Register",type: "IT Equipment"      },
      { name: "Card Payment Terminal",       type: "IT Equipment"      },
      { name: "Telephone",                   type: "IT Equipment"      },
      { name: "Desk Lamp",                   type: "Class I"           },
      { name: "Extension Lead",              type: "Extension Lead"    },
      { name: "Golf Trolley Battery Charger",type: "Class I"           },
      { name: "Refrigerated Display Cabinet",type: "Kitchen Appliance" },
      { name: "TV / Display Screen",         type: "AV Equipment"      },
      { name: "Label Printer",               type: "IT Equipment"      },
    ],
  },
  "greenkeeping": {
    label: "Greenkeeping Facility",
    emoji: "🌿",
    items: [
      { name: "Battery Charger — Ride-On Mower",    type: "Class I"       },
      { name: "Battery Charger — Electric Buggy",   type: "Class I"       },
      { name: "Battery Charger — Electric Sprayer", type: "Class I"       },
      { name: "Battery Charger — GPS Unit",         type: "Class I"       },
      { name: "Cordless Tool Charger — Drill",      type: "Portable Tool" },
      { name: "Cordless Tool Charger — Hedge Trimmer", type: "Portable Tool" },
      { name: "Extension Lead",                     type: "Extension Lead"},
      { name: "Electric Pressure Washer",           type: "Portable Tool" },
      { name: "Angle Grinder",                      type: "Portable Tool" },
      { name: "Electric Bench Grinder",             type: "Portable Tool" },
      { name: "Workshop Lamp / Inspection Light",   type: "Class I"       },
      { name: "Kettle",                             type: "Kitchen Appliance" },
      { name: "Microwave",                          type: "Kitchen Appliance" },
      { name: "Refrigerator",                       type: "Kitchen Appliance" },
      { name: "Radio",                              type: "AV Equipment"  },
    ],
  },
  "retail-shop": {
    label: "Retail Shop",
    emoji: "🏪",
    items: [
      { name: "POS Terminal / Till",          type: "IT Equipment"      },
      { name: "Barcode Scanner",              type: "IT Equipment"      },
      { name: "Receipt Printer",              type: "IT Equipment"      },
      { name: "Card Payment Terminal",        type: "IT Equipment"      },
      { name: "Electric Till Drawer",         type: "Class I"           },
      { name: "Label Printer",                type: "IT Equipment"      },
      { name: "Security Tag Deactivator",     type: "Class I"           },
      { name: "Desktop PC",                   type: "IT Equipment"      },
      { name: "Monitor",                      type: "IT Equipment"      },
      { name: "Extension Lead",               type: "Extension Lead"    },
      { name: "CCTV Monitor",                 type: "AV Equipment"      },
      { name: "Display / Info Screen",        type: "AV Equipment"      },
      { name: "Electric Fan / Heater",        type: "Class I"           },
      { name: "Kettle (Staff Room)",          type: "Kitchen Appliance" },
      { name: "Microwave (Staff Room)",       type: "Kitchen Appliance" },
      { name: "Refrigerator (Staff Room)",    type: "Kitchen Appliance" },
    ],
  },
} as const;

type PresetKey = keyof typeof ROOM_PRESETS;

// Business type → suggested preset keys (ordered by relevance)
const BUSINESS_TYPE_PRESETS: Record<string, PresetKey[]> = {
  hotel_accommodation:    ["hotel-suite", "hotel-classic", "reception", "kitchen", "bar-restaurant"],
  holiday_park_campsite:  ["reception", "kitchen", "bar-restaurant", "greenkeeping", "office"],
  leisure_sports_centre:  ["reception", "pro-shop", "kitchen", "office"],
  restaurant_cafe_pub:    ["bar-restaurant", "kitchen", "reception"],
  care_home_healthcare:   ["office", "kitchen", "reception"],
  nursery_school:         ["office", "kitchen", "reception"],
  offices_commercial:     ["office", "reception"],
  retail:                 ["retail-shop", "office", "reception"],
  other:                  Object.keys(ROOM_PRESETS) as PresetKey[],
};

const BUSINESS_TYPE_LABELS: Record<string, string> = {
  hotel_accommodation:   "Hotel / Accommodation",
  holiday_park_campsite: "Holiday Park / Campsite",
  leisure_sports_centre: "Leisure / Sports Centre",
  restaurant_cafe_pub:   "Restaurant / Café / Pub",
  care_home_healthcare:  "Care Home / Healthcare",
  nursery_school:        "Nursery / School",
  offices_commercial:    "Offices / Commercial",
  retail:                "Retail",
  other:                 "Other",
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Appliance {
  id: number;
  client_id: number;
  site_id: number | null;
  name: string;
  appliance_type: string;
  location: string | null;
  asset_tag: string | null;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  last_test_date: string | null;
  last_result: string | null;
  next_test_date: string | null;
  last_tested_by: string | null;
}

interface PATTest {
  id: number;
  client_id: number;
  appliance_id: number;
  test_date: string;
  result: string;
  next_test_date: string | null;
  tested_by: string | null;
  visual_inspection: string | null;
  earth_continuity_ohms: string | null;
  insulation_mohms: string | null;
  operating_current: string | null;
  notes: string | null;
  created_at: string;
  appliance_name: string;
  appliance_type: string;
  asset_tag: string | null;
}

interface PATStatus {
  totalAppliances: number;
  untested: number;
  overdue: number;
  dueSoon: number;
  ok: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

function addDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

function parseJsonArray<T>(v: string | undefined): T[] {
  if (!v) return [];
  try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
}

function applianceStatus(a: Appliance): "overdue" | "due-soon" | "ok" | "untested" {
  if (!a.next_test_date) return "untested";
  const today = todayIso();
  const in30 = addDays(30);
  if (a.next_test_date < today) return "overdue";
  if (a.next_test_date <= in30) return "due-soon";
  return "ok";
}

function StatusBadge({ status }: { status: ReturnType<typeof applianceStatus> }) {
  if (status === "overdue")   return <Badge className="bg-rose-100 text-rose-800 border-rose-200 rounded-sm text-xs">Overdue</Badge>;
  if (status === "due-soon")  return <Badge className="bg-amber-100 text-amber-800 border-amber-200 rounded-sm text-xs">Due soon</Badge>;
  if (status === "ok")        return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 rounded-sm text-xs">Up to date</Badge>;
  return <Badge className="bg-slate-100 text-slate-600 border-slate-200 rounded-sm text-xs">Not tested</Badge>;
}

function ResultBadge({ result }: { result: string }) {
  if (result === "pass") return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 rounded-sm text-xs">Pass</Badge>;
  if (result === "fail") return <Badge className="bg-rose-100 text-rose-800 border-rose-200 rounded-sm text-xs">Fail</Badge>;
  return <Badge className="bg-slate-100 text-slate-600 border-slate-200 rounded-sm text-xs">{result}</Badge>;
}

// ─── apiFetch ─────────────────────────────────────────────────────────────────

async function apiFetch<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}/api/pat-track${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ─── PATConfigDialog ──────────────────────────────────────────────────────────

function PATConfigDialog() {
  const [open, setOpen] = useState(false);
  const [defaultTester, setDefaultTester] = useState("");
  const [retestMonths, setRetestMonths] = useState("12");
  const [locations, setLocations] = useState<string[]>([]);
  const [newLocation, setNewLocation] = useState("");
  const [showEarthBond, setShowEarthBond] = useState(true);
  const [showInsulation, setShowInsulation] = useState(true);
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: config } = useGetPATTrackConfig();
  const updateConfig = useUpdatePATTrackConfig();

  useEffect(() => {
    if (!config || !open) return;
    setDefaultTester(config.pat_default_tester ?? "");
    setRetestMonths(config.pat_retest_months ?? "12");
    setLocations(parseJsonArray<string>(config.pat_locations));
    setShowEarthBond(config.pat_show_earth_bond !== "false");
    setShowInsulation(config.pat_show_insulation !== "false");
  }, [config, open]);

  const handleSave = () => {
    setSaving(true);
    updateConfig.mutate(
      {
        data: {
          pat_default_tester:  defaultTester,
          pat_retest_months:   retestMonths,
          pat_locations:       JSON.stringify(locations.filter(Boolean)),
          pat_show_earth_bond: showEarthBond ? "true" : "false",
          pat_show_insulation: showInsulation ? "true" : "false",
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPATTrackConfigQueryKey() });
          toast({ title: "Template saved" });
          setOpen(false);
        },
        onError: (e: any) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
        onSettled: () => setSaving(false),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 rounded-sm h-8">
          <Settings className="w-3.5 h-3.5" /> Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" /> PATtrack Template Settings
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5 py-1 max-h-[65vh] overflow-y-auto pr-1">

          {/* Defaults */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Defaults</p>
            <div>
              <Label>Default tester name</Label>
              <Input className="mt-1 rounded-sm" value={defaultTester}
                onChange={e => setDefaultTester(e.target.value)} placeholder="e.g. John Smith" />
            </div>
            <div>
              <Label>Default retest interval (months)</Label>
              <Select value={retestMonths} onValueChange={setRetestMonths}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 months (quarterly)</SelectItem>
                  <SelectItem value="6">6 months (twice yearly)</SelectItem>
                  <SelectItem value="12">12 months (annual)</SelectItem>
                  <SelectItem value="24">24 months (every 2 years)</SelectItem>
                  <SelectItem value="48">48 months (every 4 years)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Sets the default "next test date" when logging a new test</p>
            </div>
          </div>

          {/* Test fields */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Optional test fields</p>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Earth bond continuity (Ω)</p>
                <p className="text-xs text-muted-foreground">Show earth continuity reading field (for Class I appliances)</p>
              </div>
              <Switch checked={showEarthBond} onCheckedChange={setShowEarthBond} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Insulation resistance (MΩ)</p>
                <p className="text-xs text-muted-foreground">Show insulation resistance reading field</p>
              </div>
              <Switch checked={showInsulation} onCheckedChange={setShowInsulation} />
            </div>
          </div>

          {/* Locations */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Locations / areas</p>
            <p className="text-xs text-muted-foreground">Suggested locations that appear as quick-pick options when adding appliances</p>
            <div className="flex gap-2">
              <Input className="rounded-sm flex-1" value={newLocation}
                onChange={e => setNewLocation(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && newLocation.trim()) {
                    e.preventDefault();
                    if (!locations.includes(newLocation.trim())) setLocations(l => [...l, newLocation.trim()]);
                    setNewLocation("");
                  }
                }}
                placeholder="e.g. Office, Staff Kitchen, Workshop" />
              <Button size="sm" variant="outline" className="rounded-sm" onClick={() => {
                if (newLocation.trim() && !locations.includes(newLocation.trim())) {
                  setLocations(l => [...l, newLocation.trim()]); setNewLocation("");
                }
              }}>Add</Button>
            </div>
            {locations.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {locations.map(loc => (
                  <span key={loc} className="inline-flex items-center gap-1 bg-muted rounded-sm px-2 py-0.5 text-xs">
                    {loc}
                    <button onClick={() => setLocations(l => l.filter(x => x !== loc))} className="hover:text-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">
            {saving ? "Saving…" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ApplianceDialog ──────────────────────────────────────────────────────────

interface ApplianceDialogProps {
  appliance?: Appliance | null;
  onSaved: () => void;
  onClose: () => void;
  open: boolean;
  sites: { id: number; name: string }[];
  config: any;
}

function ApplianceDialog({ appliance, onSaved, onClose, open, sites, config }: ApplianceDialogProps) {
  const isEdit = !!appliance;
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const locations = parseJsonArray<string>(config?.pat_locations);

  const blank = {
    name: "", applianceType: "Other", location: "", assetTag: "",
    description: "", siteId: "", active: true,
  };
  const [form, setForm] = useState(blank);

  const reset = () => setForm(appliance ? {
    name: appliance.name, applianceType: appliance.appliance_type,
    location: appliance.location ?? "", assetTag: appliance.asset_tag ?? "",
    description: appliance.description ?? "",
    siteId: appliance.site_id ? String(appliance.site_id) : "",
    active: appliance.active,
  } : blank);

  useEffect(() => { if (open) reset(); }, [open]);

  const handleSave = async () => {
    if (!form.name.trim()) { toast({ title: "Appliance name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), applianceType: form.applianceType,
        location: form.location.trim() || null, assetTag: form.assetTag.trim() || null,
        description: form.description.trim() || null,
        siteId: form.siteId ? parseInt(form.siteId, 10) : null,
        active: form.active,
      };
      if (isEdit) {
        await apiFetch(`/appliances/${appliance!.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/appliances", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: isEdit ? "Appliance updated" : "Appliance added" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-md rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Appliance" : "Add Appliance"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[65vh] overflow-y-auto pr-1">
          <div>
            <Label>Appliance name *</Label>
            <Input className="mt-1 rounded-sm" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Staff Room Kettle, Office Toaster" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Appliance type</Label>
              <Select value={form.applianceType} onValueChange={v => setForm(f => ({ ...f, applianceType: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {APPLIANCE_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Asset tag <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.assetTag}
                onChange={e => setForm(f => ({ ...f, assetTag: e.target.value }))}
                placeholder="e.g. PAT-001" />
            </div>
          </div>
          <div>
            <Label>Location / area <span className="text-muted-foreground text-xs">optional</span></Label>
            {locations.length > 0 && <datalist id="pat-locations-list">{locations.map(l => <option key={l} value={l} />)}</datalist>}
            <Input className="mt-1 rounded-sm" value={form.location}
              list={locations.length > 0 ? "pat-locations-list" : undefined}
              onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
              placeholder="e.g. Staff Kitchen, Office A" />
          </div>
          <div>
            <Label>Description <span className="text-muted-foreground text-xs">optional</span></Label>
            <Input className="mt-1 rounded-sm" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Model, make, serial number…" />
          </div>
          {sites.length > 0 && (
            <div>
              <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
              <Select value={form.siteId} onValueChange={v => setForm(f => ({ ...f, siteId: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All sites</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {isEdit && (
            <div className="flex items-center justify-between border border-border rounded-sm px-3 py-2">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">Inactive appliances are hidden from the register</p>
              </div>
              <Switch checked={form.active} onCheckedChange={v => setForm(f => ({ ...f, active: v }))} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add appliance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── TestDialog ───────────────────────────────────────────────────────────────

// ─── PresetGrid helper ────────────────────────────────────────────────────────

function PresetGrid({
  presetKeys,
  savedTemplates,
  onSelect,
}: {
  presetKeys: PresetKey[];
  savedTemplates: Record<string, { name: string; type: string }[]>;
  onSelect: (key: PresetKey) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {presetKeys.map(key => {
        const preset = ROOM_PRESETS[key];
        const isCustomised = !!savedTemplates[key]?.length;
        const itemCount = isCustomised ? savedTemplates[key].length : preset.items.length;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className="border border-border rounded-sm p-4 text-left hover:border-primary hover:bg-primary/5 transition-colors relative"
          >
            {isCustomised && (
              <span className="absolute top-2 right-2 text-[10px] font-semibold text-primary bg-primary/10 rounded-sm px-1 py-0.5 leading-none">
                ✦ saved
              </span>
            )}
            <p className="text-2xl mb-1.5">{preset.emoji}</p>
            <p className="text-sm font-medium leading-tight">{preset.label}</p>
            <p className="text-xs text-muted-foreground mt-1">{itemCount} items</p>
          </button>
        );
      })}
    </div>
  );
}

// ─── PresetDialog ─────────────────────────────────────────────────────────────

interface PresetItem {
  name: string;
  type: string;
  checked: boolean;
}

function PresetDialog({ open, onClose, onSaved, sites, config, businessType }: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  sites: { id: number; name: string }[];
  config: any;
  businessType?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedPreset, setSelectedPreset] = useState<PresetKey | "">("");
  const [location, setLocation] = useState("");
  const [siteId, setSiteId] = useState("");
  const [items, setItems] = useState<PresetItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [resettingTemplate, setResettingTemplate] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemType, setNewItemType] = useState("Other");
  const [showOther, setShowOther] = useState(false);

  const locations = parseJsonArray<string>(config?.pat_locations);

  // Fetch saved per-preset templates
  const { data: savedTemplates = {} } = useQuery<Record<string, PresetItem[]>>({
    queryKey: ["/api/pat-track/preset-templates"],
    queryFn: () => apiFetch("/preset-templates"),
    enabled: open,
  });

  // Derive suggested / other preset keys from business type
  const allPresetKeys = Object.keys(ROOM_PRESETS) as PresetKey[];
  const suggestedKeys: PresetKey[] = businessType
    ? (BUSINESS_TYPE_PRESETS[businessType] ?? allPresetKeys)
    : allPresetKeys;
  const otherKeys: PresetKey[] = allPresetKeys.filter(k => !suggestedKeys.includes(k));
  const hasSections = otherKeys.length > 0; // only show sections when business type narrows things down

  // Reset when closed
  useEffect(() => {
    if (!open) {
      setStep(1); setSelectedPreset(""); setLocation(""); setSiteId(""); setItems([]);
      setNewItemName(""); setNewItemType("Other"); setShowOther(false);
    }
  }, [open]);

  const handleSelectPreset = (key: PresetKey) => {
    setSelectedPreset(key);
    // Use saved template if one exists; otherwise fall back to hardcoded defaults
    const saved = savedTemplates[key];
    if (saved && saved.length > 0) {
      setItems(saved.map(item => ({ ...item, checked: true })));
    } else {
      setItems(ROOM_PRESETS[key].items.map(item => ({ ...item, checked: true })));
    }
    setStep(2);
  };

  const hasCustomTemplate = selectedPreset ? !!savedTemplates[selectedPreset]?.length : false;
  const selectedCount = items.filter(i => i.checked && i.name.trim()).length;

  // Save the current item list (all items, checked or not) as the template for this preset
  const handleSaveTemplate = async () => {
    if (!selectedPreset) return;
    setSavingTemplate(true);
    try {
      await apiFetch(`/preset-templates/${selectedPreset}`, {
        method: "PUT",
        body: JSON.stringify({ items: items.map(({ name, type }) => ({ name, type })) }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/pat-track/preset-templates"] });
      toast({ title: "Template saved", description: `Your ${ROOM_PRESETS[selectedPreset].label} template has been saved` });
    } catch (err: any) {
      toast({ title: "Failed to save template", description: err.message, variant: "destructive" });
    } finally { setSavingTemplate(false); }
  };

  // Reset this preset back to the built-in defaults
  const handleResetTemplate = async () => {
    if (!selectedPreset) return;
    setResettingTemplate(true);
    try {
      await apiFetch(`/preset-templates/${selectedPreset}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["/api/pat-track/preset-templates"] });
      setItems(ROOM_PRESETS[selectedPreset].items.map(item => ({ ...item, checked: true })));
      toast({ title: "Reset to defaults" });
    } catch (err: any) {
      toast({ title: "Failed to reset", description: err.message, variant: "destructive" });
    } finally { setResettingTemplate(false); }
  };

  // Add a new custom item to the list
  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    setItems(prev => [...prev, { name: newItemName.trim(), type: newItemType, checked: true }]);
    setNewItemName("");
  };

  const handleAdd = async () => {
    const toAdd = items.filter(i => i.checked && i.name.trim());
    if (toAdd.length === 0) { toast({ title: "No appliances selected", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await Promise.all(
        toAdd.map(item =>
          apiFetch("/appliances", {
            method: "POST",
            body: JSON.stringify({
              name:          item.name.trim(),
              applianceType: item.type,
              location:      location.trim() || null,
              assetTag:      null,
              description:   null,
              siteId:        siteId ? parseInt(siteId, 10) : null,
              active:        true,
            }),
          })
        )
      );
      toast({ title: `${toAdd.length} appliance${toAdd.length !== 1 ? "s" : ""} added to register` });
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ title: "Failed to add appliances", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving && !v) onClose(); }}>
      <DialogContent className="max-w-2xl rounded-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="w-4 h-4" />
            {step === 1 ? "Load appliance preset" : "Review appliances to add"}
          </DialogTitle>
        </DialogHeader>

        {/* ── Step 1: Choose room type ────────────────────────── */}
        {step === 1 && (
          <div className="py-2 space-y-5">
            {/* Suggested section (or full grid when no business type) */}
            <div>
              {hasSections && (
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Suggested for{" "}
                    {businessType ? BUSINESS_TYPE_LABELS[businessType] ?? "your business" : "your business"}
                  </p>
                </div>
              )}
              {!hasSections && (
                <p className="text-sm text-muted-foreground mb-3">
                  Select a room or area type to load its appliance list. Saved templates are shown with a ✦ badge.
                </p>
              )}
              <PresetGrid
                presetKeys={suggestedKeys}
                savedTemplates={savedTemplates}
                onSelect={handleSelectPreset}
              />
            </div>

            {/* Other room types (only shown when business type narrows things down) */}
            {hasSections && (
              <div>
                <button
                  onClick={() => setShowOther(v => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline flex items-center gap-1"
                >
                  {showOther ? "▾" : "▸"} Other room types ({otherKeys.length})
                </button>
                {showOther && (
                  <div className="mt-3">
                    <PresetGrid
                      presetKeys={otherKeys}
                      savedTemplates={savedTemplates}
                      onSelect={handleSelectPreset}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Review & customise ──────────────────────── */}
        {step === 2 && selectedPreset && (
          <div className="space-y-4 py-1">
            {/* Back + breadcrumb + template actions */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStep(1)}
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                >
                  ← Change room type
                </button>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-sm font-medium">
                  {ROOM_PRESETS[selectedPreset].emoji} {ROOM_PRESETS[selectedPreset].label}
                </span>
                {hasCustomTemplate && (
                  <span className="text-[10px] font-semibold text-primary bg-primary/10 rounded-sm px-1.5 py-0.5">✦ saved template</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  size="sm" variant="outline"
                  className="rounded-sm h-7 text-xs gap-1"
                  disabled={savingTemplate || saving}
                  onClick={handleSaveTemplate}
                >
                  {savingTemplate ? "Saving…" : "Save as template"}
                </Button>
                {hasCustomTemplate && (
                  <Button
                    size="sm" variant="ghost"
                    className="rounded-sm h-7 text-xs text-muted-foreground hover:text-destructive"
                    disabled={resettingTemplate || saving}
                    onClick={handleResetTemplate}
                  >
                    {resettingTemplate ? "Resetting…" : "Reset to defaults"}
                  </Button>
                )}
              </div>
            </div>

            {/* Location + site */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>
                  Location / area
                  <span className="text-muted-foreground text-xs ml-1">optional — applied to all</span>
                </Label>
                {locations.length > 0 && (
                  <datalist id="preset-locations-list">
                    {locations.map(l => <option key={l} value={l} />)}
                  </datalist>
                )}
                <Input
                  className="mt-1 rounded-sm"
                  value={location}
                  list={locations.length > 0 ? "preset-locations-list" : undefined}
                  onChange={e => setLocation(e.target.value)}
                  placeholder="e.g. Room 101, Ground Floor Bar"
                />
              </div>
              {sites.length > 0 && (
                <div>
                  <Label>Site <span className="text-muted-foreground text-xs ml-1">optional</span></Label>
                  <Select value={siteId} onValueChange={setSiteId}>
                    <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All sites</SelectItem>
                      {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Checklist */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Appliances to add <span className="text-muted-foreground text-xs">({selectedCount} selected)</span></Label>
                <div className="flex gap-3">
                  <button
                    className="text-xs text-primary hover:underline underline-offset-2"
                    onClick={() => setItems(prev => prev.map(x => ({ ...x, checked: true })))}
                  >Select all</button>
                  <button
                    className="text-xs text-muted-foreground hover:underline underline-offset-2"
                    onClick={() => setItems(prev => prev.map(x => ({ ...x, checked: false })))}
                  >None</button>
                </div>
              </div>
              <div className="border border-border rounded-sm divide-y divide-border max-h-56 overflow-y-auto">
                {items.map((item, i) => (
                  <div key={i} className={cn("flex items-center gap-3 px-3 py-2 group", !item.checked && "opacity-40")}>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={e => setItems(prev => prev.map((it, idx) => idx === i ? { ...it, checked: e.target.checked } : it))}
                      className="flex-shrink-0 accent-primary"
                    />
                    <input
                      type="text"
                      value={item.name}
                      onChange={e => setItems(prev => prev.map((it, idx) => idx === i ? { ...it, name: e.target.value } : it))}
                      className="flex-1 bg-transparent text-sm border-0 border-b border-transparent focus:border-border focus:outline-none py-0.5 min-w-0"
                    />
                    <select
                      value={item.type}
                      onChange={e => setItems(prev => prev.map((it, idx) => idx === i ? { ...it, type: e.target.value } : it))}
                      className="text-xs text-muted-foreground bg-transparent border-0 focus:outline-none flex-shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      {APPLIANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <span className="text-xs text-muted-foreground flex-shrink-0 group-hover:hidden">{item.type}</span>
                    <button
                      onClick={() => setItems(prev => prev.filter((_, idx) => idx !== i))}
                      className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-muted-foreground hover:text-destructive transition-opacity"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add custom item */}
              <div className="flex items-center gap-2 mt-2 border border-dashed border-border rounded-sm px-3 py-2">
                <input
                  type="text"
                  value={newItemName}
                  onChange={e => setNewItemName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddItem(); } }}
                  className="flex-1 bg-transparent text-sm border-0 focus:outline-none py-0.5 min-w-0 placeholder:text-muted-foreground/50"
                  placeholder="Add item… (e.g. Smart TV)"
                />
                <select
                  value={newItemType}
                  onChange={e => setNewItemType(e.target.value)}
                  className="text-xs text-muted-foreground bg-transparent border-0 focus:outline-none flex-shrink-0 cursor-pointer"
                >
                  {APPLIANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <button
                  onClick={handleAddItem}
                  disabled={!newItemName.trim()}
                  className="flex-shrink-0 text-primary disabled:text-muted-foreground hover:opacity-80"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Click a name to rename · hover a row to change type or remove</p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          {step === 2 && (
            <Button onClick={handleAdd} disabled={saving || selectedCount === 0} className="rounded-sm">
              {saving ? "Adding…" : `Add ${selectedCount} appliance${selectedCount !== 1 ? "s" : ""}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── TestDialog ───────────────────────────────────────────────────────────────

interface TestDialogProps {
  test?: PATTest | null;
  appliances: Appliance[];
  onSaved: () => void;
  onClose: () => void;
  open: boolean;
  config: any;
  presetApplianceId?: number;
}

function TestDialog({ test, appliances, onSaved, onClose, open, config, presetApplianceId }: TestDialogProps) {
  const isEdit = !!test;
  const { toast } = useToast();
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);

  const retestMonths = parseInt(config?.pat_retest_months ?? "12", 10) || 12;
  const showEarthBond = config?.pat_show_earth_bond !== "false";
  const showInsulation = config?.pat_show_insulation !== "false";

  const computeNextDate = (testDate: string) => {
    if (!testDate) return "";
    try {
      const d = addMonths(parseISO(testDate), retestMonths);
      return isValid(d) ? d.toISOString().split("T")[0] : "";
    } catch { return ""; }
  };

  const blank = {
    applianceId: presetApplianceId ? String(presetApplianceId) : "",
    testDate: todayIso(), result: "pass", nextTestDate: computeNextDate(todayIso()),
    testedBy: config?.pat_default_tester || user?.name || "",
    visualInspection: "pass", earthContinuityOhms: "", insulationMohms: "",
    operatingCurrent: "", notes: "",
  };
  const [form, setForm] = useState(blank);

  const reset = () => setForm(test ? {
    applianceId: String(test.appliance_id), testDate: test.test_date,
    result: test.result, nextTestDate: test.next_test_date ?? "",
    testedBy: test.tested_by ?? "", visualInspection: test.visual_inspection ?? "pass",
    earthContinuityOhms: test.earth_continuity_ohms ?? "",
    insulationMohms: test.insulation_mohms ?? "",
    operatingCurrent: test.operating_current ?? "",
    notes: test.notes ?? "",
  } : { ...blank, applianceId: presetApplianceId ? String(presetApplianceId) : "", testedBy: config?.pat_default_tester || user?.name || "" });

  useEffect(() => { if (open) reset(); }, [open, config]);

  // Auto-compute next test date when test date changes (new tests only)
  useEffect(() => {
    if (isEdit || !form.testDate) return;
    setForm(f => ({ ...f, nextTestDate: computeNextDate(f.testDate) }));
  }, [form.testDate, retestMonths]);

  const handleSave = async () => {
    if (!form.applianceId) { toast({ title: "Select an appliance", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = {
        applianceId:         parseInt(form.applianceId, 10),
        testDate:            form.testDate,
        result:              form.result,
        nextTestDate:        form.nextTestDate || null,
        testedBy:            form.testedBy.trim() || null,
        visualInspection:    form.visualInspection || null,
        earthContinuityOhms: form.earthContinuityOhms.trim() || null,
        insulationMohms:     form.insulationMohms.trim() || null,
        operatingCurrent:    form.operatingCurrent.trim() || null,
        notes:               form.notes.trim() || null,
      };
      if (isEdit) {
        await apiFetch(`/tests/${test!.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/tests", { method: "POST", body: JSON.stringify(body) });
      }
      toast({ title: isEdit ? "Test record updated" : "Test recorded" });
      onSaved(); onClose();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const activeAppliances = appliances.filter(a => a.active);

  return (
    <Dialog open={open} onOpenChange={v => { if (!saving) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto" onOpenAutoFocus={reset}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-600" />
            {isEdit ? "Edit PAT Test Record" : "Log PAT Test"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1 max-h-[65vh] overflow-y-auto pr-1">

          {/* Appliance */}
          <div>
            <Label>Appliance *</Label>
            <Select value={form.applianceId} onValueChange={v => setForm(f => ({ ...f, applianceId: v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select appliance…" /></SelectTrigger>
              <SelectContent>
                {activeAppliances.map(a => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}{a.asset_tag ? ` (${a.asset_tag})` : ""}{a.location ? ` — ${a.location}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date & Result */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Test date *</Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.testDate}
                onChange={e => setForm(f => ({ ...f, testDate: e.target.value }))} />
            </div>
            <div>
              <Label>Overall result *</Label>
              <Select value={form.result} onValueChange={v => setForm(f => ({ ...f, result: v }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass ✓</SelectItem>
                  <SelectItem value="fail">Fail ✗</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tester & Next date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tested by <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input className="mt-1 rounded-sm" value={form.testedBy}
                onChange={e => setForm(f => ({ ...f, testedBy: e.target.value }))}
                placeholder="Tester name" />
            </div>
            <div>
              <Label>Next test due <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input type="date" className="mt-1 rounded-sm" value={form.nextTestDate}
                onChange={e => setForm(f => ({ ...f, nextTestDate: e.target.value }))} />
            </div>
          </div>

          {/* Visual inspection */}
          <div>
            <Label>Visual inspection</Label>
            <Select value={form.visualInspection} onValueChange={v => setForm(f => ({ ...f, visualInspection: v }))}>
              <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pass">Pass</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
                <SelectItem value="na">N/A</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Electrical measurements */}
          {(showEarthBond || showInsulation) && (
            <div className="border border-border rounded-sm p-3 space-y-3 bg-muted/20">
              <p className="text-xs font-medium text-muted-foreground">Electrical measurements</p>
              <div className="grid grid-cols-2 gap-3">
                {showEarthBond && (
                  <div>
                    <Label>Earth continuity (Ω) <span className="text-muted-foreground text-xs">optional</span></Label>
                    <Input className="mt-1 rounded-sm" value={form.earthContinuityOhms}
                      onChange={e => setForm(f => ({ ...f, earthContinuityOhms: e.target.value }))}
                      placeholder="e.g. 0.05" />
                  </div>
                )}
                {showInsulation && (
                  <div>
                    <Label>Insulation resistance (MΩ) <span className="text-muted-foreground text-xs">optional</span></Label>
                    <Input className="mt-1 rounded-sm" value={form.insulationMohms}
                      onChange={e => setForm(f => ({ ...f, insulationMohms: e.target.value }))}
                      placeholder="e.g. 2.0" />
                  </div>
                )}
              </div>
              <div>
                <Label>Operating current (A) <span className="text-muted-foreground text-xs">optional</span></Label>
                <Input className="mt-1 rounded-sm" value={form.operatingCurrent}
                  onChange={e => setForm(f => ({ ...f, operatingCurrent: e.target.value }))}
                  placeholder="e.g. 3.5" />
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <Label>Notes <span className="text-muted-foreground text-xs">optional</span></Label>
            <Textarea className="mt-1 rounded-sm" value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2} placeholder="Defects noted, actions taken…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="rounded-sm">Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="rounded-sm">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Log test"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function PATTrackPage() {
  const { user, client } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [activeTab, setActiveTab] = useState<"appliances" | "tests">("appliances");

  // Dialog state
  const [applianceDialog, setApplianceDialog] = useState(false);
  const [editAppliance, setEditAppliance] = useState<Appliance | null>(null);
  const [presetDialog, setPresetDialog] = useState(false);
  const [testDialog, setTestDialog] = useState(false);
  const [editTest, setEditTest] = useState<PATTest | null>(null);
  const [presetApplianceId, setPresetApplianceId] = useState<number | undefined>();
  const [deleteApplianceId, setDeleteApplianceId] = useState<number | null>(null);
  const [deleteTestId, setDeleteTestId] = useState<number | null>(null);

  // Data
  const { data: appliances = [], refetch: refetchAppliances } = useQuery<Appliance[]>({
    queryKey: ["/api/pat-track/appliances"],
    queryFn: () => apiFetch("/appliances"),
  });
  const { data: tests = [], refetch: refetchTests } = useQuery<PATTest[]>({
    queryKey: ["/api/pat-track/tests"],
    queryFn: () => apiFetch("/tests"),
  });
  const { data: status } = useQuery<PATStatus>({
    queryKey: ["/api/pat-track/status"],
    queryFn: () => apiFetch("/status"),
  });
  const { data: sites = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/sites"],
    queryFn: () => fetch(`${baseUrl}/api/sites`, { credentials: "include" }).then(r => r.json()),
  });
  const { data: config } = useGetPATTrackConfig();

  const refetchAll = () => {
    refetchAppliances();
    refetchTests();
    queryClient.invalidateQueries({ queryKey: ["/api/pat-track/status"] });
  };

  // Filtered lists
  const filteredAppliances = useMemo(() => {
    const lq = q.toLowerCase();
    return appliances.filter(a =>
      a.name.toLowerCase().includes(lq) ||
      (a.appliance_type ?? "").toLowerCase().includes(lq) ||
      (a.location ?? "").toLowerCase().includes(lq) ||
      (a.asset_tag ?? "").toLowerCase().includes(lq)
    );
  }, [appliances, q]);

  const filteredTests = useMemo(() => {
    const lq = q.toLowerCase();
    return tests.filter(t =>
      t.appliance_name.toLowerCase().includes(lq) ||
      (t.tested_by ?? "").toLowerCase().includes(lq) ||
      (t.asset_tag ?? "").toLowerCase().includes(lq)
    );
  }, [tests, q]);

  // Delete handlers
  const deleteAppliance = async () => {
    if (!deleteApplianceId) return;
    try {
      await apiFetch(`/appliances/${deleteApplianceId}`, { method: "DELETE" });
      toast({ title: "Appliance deleted" });
      refetchAll();
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally { setDeleteApplianceId(null); }
  };

  const deleteTest = async () => {
    if (!deleteTestId) return;
    try {
      await apiFetch(`/tests/${deleteTestId}`, { method: "DELETE" });
      toast({ title: "Test record deleted" });
      refetchAll();
    } catch (err: any) {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    } finally { setDeleteTestId(null); }
  };

  const lockUI = user?.role === "client_viewer";

  return (
    <AppLayout title="PATtrack">
      <div className="space-y-6">

        {/* ── Status strip ─────────────────────────────────────────────── */}
        {status && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total appliances", value: status.totalAppliances, sub: "in register", icon: PackageCheck, cls: "text-primary" },
              { label: "Overdue", value: status.overdue, sub: "need testing now", icon: AlertTriangle, cls: status.overdue > 0 ? "text-rose-600" : "text-emerald-600" },
              { label: "Due within 30 days", value: status.dueSoon, sub: "upcoming", icon: Clock, cls: status.dueSoon > 0 ? "text-amber-600" : "text-emerald-600" },
              { label: "Up to date", value: status.ok, sub: "within test window", icon: CheckCircle2, cls: "text-emerald-600" },
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

        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground mt-1">
            In-house PAT testing register — maintain your appliance inventory and keep test records up to date
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            {canAdmin && <PATConfigDialog />}
            {!lockUI && (
              <Button className="gap-2 rounded-sm h-8 text-sm" size="sm" onClick={() => {
                setEditTest(null); setPresetApplianceId(undefined); setTestDialog(true);
              }}>
                <Plus className="w-4 h-4" /> Log Test
              </Button>
            )}
          </div>
        </div>

        {/* ── Search ───────────────────────────────────────────────────── */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input className="pl-9 rounded-sm" placeholder="Search appliances, locations, asset tags…"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────── */}
        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as any)}>
          <div className="flex items-center justify-between gap-3">
            <TabsList className="rounded-sm">
              <TabsTrigger value="appliances" className="rounded-sm gap-1.5">
                <PackageCheck className="w-3.5 h-3.5" /> Appliances
                <span className="ml-1 text-xs text-muted-foreground">({appliances.length})</span>
              </TabsTrigger>
              <TabsTrigger value="tests" className="rounded-sm gap-1.5">
                <ClipboardList className="w-3.5 h-3.5" /> Test history
                <span className="ml-1 text-xs text-muted-foreground">({tests.length})</span>
              </TabsTrigger>
            </TabsList>
            {activeTab === "appliances" && !lockUI && canAdmin && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8"
                  onClick={() => setPresetDialog(true)}>
                  <Library className="w-3.5 h-3.5" /> Load preset
                </Button>
                <Button size="sm" variant="outline" className="rounded-sm gap-1.5 h-8"
                  onClick={() => { setEditAppliance(null); setApplianceDialog(true); }}>
                  <Plus className="w-3.5 h-3.5" /> Add appliance
                </Button>
              </div>
            )}
          </div>

          {/* ── Appliances tab ──────────────────────────────────────── */}
          <TabsContent value="appliances" className="mt-4">
            {filteredAppliances.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <Zap className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm">{appliances.length === 0 ? "No appliances in register yet — load a preset or add appliances one at a time to get started" : "No appliances match your search"}</p>
                {appliances.length === 0 && canAdmin && !lockUI && (
                  <div className="flex items-center justify-center gap-3 mt-4">
                    <Button variant="default" className="rounded-sm gap-2"
                      onClick={() => setPresetDialog(true)}>
                      <Library className="w-4 h-4" /> Load preset
                    </Button>
                    <Button variant="outline" className="rounded-sm gap-2"
                      onClick={() => { setEditAppliance(null); setApplianceDialog(true); }}>
                      <Plus className="w-4 h-4" /> Add manually
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Appliance</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Type</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Location</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Last tested</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Next due</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                      <th className="px-4 py-2.5 w-28"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredAppliances.map(a => {
                      const st = applianceStatus(a);
                      return (
                        <tr key={a.id} className="group hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3">
                            <p className="font-medium text-sm">{a.name}</p>
                            {a.asset_tag && <p className="text-xs text-muted-foreground">{a.asset_tag}</p>}
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{a.appliance_type}</td>
                          <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">{a.location ?? "—"}</td>
                          <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                            {a.last_test_date ? (
                              <span>
                                {format(parseISO(a.last_test_date), "dd MMM yyyy")}
                                {a.last_result && <> — <ResultBadge result={a.last_result} /></>}
                              </span>
                            ) : <span className="text-muted-foreground/50">Never</span>}
                          </td>
                          <td className="px-4 py-3 text-xs">
                            {a.next_test_date ? format(parseISO(a.next_test_date), "dd MMM yyyy") : <span className="text-muted-foreground/50">—</span>}
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={st} /></td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {!lockUI && (
                                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" title="Log test"
                                  onClick={() => { setEditTest(null); setPresetApplianceId(a.id); setTestDialog(true); }}>
                                  <Zap className="w-3.5 h-3.5 text-yellow-600" />
                                </Button>
                              )}
                              {canAdmin && (
                                <>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                    onClick={() => { setEditAppliance(a); setApplianceDialog(true); }}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => setDeleteApplianceId(a.id)}>
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
                  Showing {filteredAppliances.length} of {appliances.length} appliance{appliances.length !== 1 ? "s" : ""}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Tests tab ───────────────────────────────────────────── */}
          <TabsContent value="tests" className="mt-4">
            {filteredTests.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm">{tests.length === 0 ? "No test records yet — log your first PAT test to get started" : "No tests match your search"}</p>
              </div>
            ) : (
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Appliance</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Test date</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Result</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Tested by</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Next due</th>
                      <th className="px-2 py-2.5 w-14"></th>
                      <th className="px-4 py-2.5 w-20"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredTests.map(t => (
                      <tr key={t.id} className="group hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-medium text-sm">{t.appliance_name}</p>
                          {t.asset_tag && <p className="text-xs text-muted-foreground">{t.asset_tag}</p>}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell text-sm">
                          {format(parseISO(t.test_date), "dd MMM yyyy")}
                        </td>
                        <td className="px-4 py-3"><ResultBadge result={t.result} /></td>
                        <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                          {t.tested_by ?? <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                          {t.next_test_date ? format(parseISO(t.next_test_date), "dd MMM yyyy") : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-2 py-3">
                          <CheckPhotoUploader entityType="pat_test" entityId={t.id} compact />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {!lockUI && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm"
                                onClick={() => { setEditTest(t); setTestDialog(true); }}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {canAdmin && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTestId(t.id)}>
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
                  Showing {filteredTests.length} of {tests.length} test record{tests.length !== 1 ? "s" : ""}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* ── Legal footer ─────────────────────────────────────────────── */}
        <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-4 text-xs text-yellow-900">
          <p className="font-semibold mb-1">PAT Testing — legal framework</p>
          <p>
            The Electricity at Work Regulations 1989 require that all electrical systems (including appliances) are maintained in a safe condition.
            The IET Code of Practice for In-Service Inspection and Testing of Electrical Equipment provides recommended inspection intervals based on appliance class and environment.
            PAT testing records are not a legal requirement in themselves, but they demonstrate due diligence if an incident occurs.
          </p>
        </div>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
      <PresetDialog
        open={presetDialog}
        sites={sites}
        config={config}
        businessType={client?.businessType}
        onSaved={refetchAll}
        onClose={() => setPresetDialog(false)}
      />

      <ApplianceDialog
        open={applianceDialog}
        appliance={editAppliance}
        sites={sites}
        config={config}
        onSaved={refetchAll}
        onClose={() => { setApplianceDialog(false); setEditAppliance(null); }}
      />

      <TestDialog
        open={testDialog}
        test={editTest}
        appliances={appliances}
        config={config}
        presetApplianceId={presetApplianceId}
        onSaved={refetchAll}
        onClose={() => { setTestDialog(false); setEditTest(null); setPresetApplianceId(undefined); }}
      />

      {/* Delete appliance confirm */}
      <AlertDialog open={!!deleteApplianceId} onOpenChange={() => setDeleteApplianceId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete appliance?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the appliance and all its test records. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteAppliance} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete test confirm */}
      <AlertDialog open={!!deleteTestId} onOpenChange={() => setDeleteTestId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete test record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this PAT test record. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteTest} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
