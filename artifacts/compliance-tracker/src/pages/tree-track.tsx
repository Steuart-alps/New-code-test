import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TreePine, Plus, AlertTriangle, CheckCircle2, Clock, CalendarX,
  Pencil, Trash2, Lock, Search, Building2, Filter, CalendarDays,
  UserCheck, MapPin, Loader2, ExternalLink, ClipboardCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch as sharedApiFetch } from "@/lib/api";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { useSayItFill, withSpokenNote, matchSpokenItem } from "@/lib/say-it-fill";
import { sortByLabel } from "@/lib/sort-options";
import { RecordSignedBy } from "@/components/record-signature";

// ─── Types ────────────────────────────────────────────────────────────────────

const CHECK_TYPES = [
  "visual_assessment",
  "detailed_assessment",
  "post_storm",
  "remedial_works",
  "risk_assessment",
] as const;

type CheckType = (typeof CHECK_TYPES)[number];
type CheckResult = "pass" | "fail";
type ActionSeverity = "monitor" | "action_required" | "urgent_action";
type CheckStatus = "ok" | "due_soon" | "overdue" | "never";

interface TreeInspection {
  id: number;
  clientId: number;
  siteId: number | null;
  checkType: string;
  checkDate: string;
  result: string;
  observationResult?: CheckResult;
  actionSeverity?: ActionSeverity | null;
  treeId?: number | null;
  treeRef: string | null;
  location: string | null;
  what3words?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  inspector: string | null;
  followUpDate: string | null;
  notes: string | null;
  createdAt: string;
}

type RiskZone = "high" | "medium" | "low";

interface Tree {
  id: number;
  siteId: number | null;
  ref: string;
  species: string | null;
  location: string | null;
  what3words: string | null;
  latitude: number | null;
  longitude: number | null;
  riskZone: RiskZone;
  inspectionIntervalMonths: number;
  notes: string | null;
  removedAt: string | null;
  lastInspected: string | null;
  lastCheckDate: string | null;
  openIssue: { checkDate: string; severity: ActionSeverity | null } | null;
  nextDue: string | null;
  status: CheckStatus;
}

interface StatusRow {
  checkType: string;
  frequencyDays: number;
  lastDate: string | null;
  dueDate: string | null;
  status: CheckStatus;
}

interface Site { id: number; name: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  visual_assessment:   "Visual tree assessment (VTA)",
  detailed_assessment: "Detailed / close inspection",
  post_storm:          "Post-storm / adverse weather check",
  remedial_works:      "Remedial works record",
  risk_assessment:     "Tree risk assessment review",
};

const CHECK_TYPE_HINTS: Record<CheckType, string> = {
  visual_assessment:   "Routine ground-level survey. Set the inspection frequency from the tree, location, occupancy and risk assessment; higher-risk trees may need more frequent checks.",
  detailed_assessment: "Close inspection required when anomalies (deadwood, cracks, fungal bodies, lean) are found during a VTA. May require climbing inspection or specialist assessment.",
  post_storm:          "Carry out a walk-over inspection after any storm or severe weather event to identify newly fallen branches, uprooted or leaning trees, or structural failures.",
  remedial_works:      "Record of arboricultural works carried out — crown reduction, deadwood removal, felling, stump grinding, cable bracing, etc.",
  risk_assessment:     "Detailed tree risk assessment by a competent person where indicated. It assesses likelihood of failure and consequences; obtain suitable arboricultural advice before specifying works.",
};

const RESULT_CFG: Record<CheckResult, { label: string; badge: string }> = {
  pass:            { label: "Pass",           badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  fail:            { label: "Fail",           badge: "bg-rose-50 text-rose-700 border-rose-200" },
};

const SEVERITY_CFG: Record<ActionSeverity, { label: string; badge: string }> = {
  monitor:         { label: "Monitor", badge: "bg-blue-50 text-blue-700 border-blue-200" },
  action_required: { label: "Action Required", badge: "bg-amber-50 text-amber-700 border-amber-200" },
  urgent_action:   { label: "Urgent Action", badge: "bg-rose-50 text-rose-700 border-rose-200" },
};

const RISK_ZONE_LABELS: Record<RiskZone, string> = {
  high:   "Busy area",
  medium: "Sometimes used",
  low:    "Rarely visited",
};

const RISK_ZONE_HINTS: Record<RiskZone, string> = {
  high:   "Paths, car parks, play areas, roads, buildings, tees and greens: people are often underneath.",
  medium: "Used now and then, such as rough, wider grounds or quieter paths.",
  low:    "Woodland or boundaries people rarely go near.",
};

const RISK_ZONE_BADGE: Record<RiskZone, string> = {
  high:   "bg-rose-50 text-rose-700 border-rose-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low:    "bg-slate-50 text-slate-600 border-slate-200",
};

const INTERVAL_OPTIONS = [6, 12, 18, 24, 36];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** JSON request through the shared client: adds the /api prefix, the CSRF
 *  token on writes and the session cookie. */
async function apiFetch(path: string, opts?: RequestInit) {
  const res = await sharedApiFetch(path, opts);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error ?? `${res.status}`); }
  if (res.status === 204) return null;
  return res.json();
}

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A what3words address as typed ("///Filled.Count.Soap", "filled count soap") as "filled.count.soap", or null. */
function normaliseWhat3Words(value: string): string | null {
  const words = value.trim().replace(/^\/+/u, "").replace(/\u200b/gu, "").toLowerCase()
    .split(/[.\s。．｡・]+/u).filter(Boolean);
  return words.length === 3 && words.every(w => /^\p{L}+$/u.test(w)) ? words.join(".") : null;
}

function What3WordsLink({ words }: { words: string | null | undefined }) {
  if (!words) return null;
  return (
    <a href={`https://what3words.com/${words}`} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 hover:underline"
      onClick={e => e.stopPropagation()}>
      ///{words} <ExternalLink className="w-3 h-3" />
    </a>
  );
}

function MapLink({ latitude, longitude }: { latitude?: number | null; longitude?: number | null }) {
  if (latitude == null || longitude == null) return null;
  return (
    <a href={`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
      onClick={e => e.stopPropagation()}>
      <MapPin className="w-3 h-3" /> Map
    </a>
  );
}

/**
 * Where something is: the place in words, its what3words address and, when
 * a phone saved one, its GPS spot. Shared by the tree and inspection forms.
 */
function LocationFields({ location, what3words, latitude, longitude, onChange, locationLabel, what3wordsLabel }: {
  location: string; what3words: string; latitude: number | null; longitude: number | null;
  onChange: (patch: Partial<{ location: string; what3words: string; latitude: number | null; longitude: number | null }>) => void;
  locationLabel: string; what3wordsLabel: string;
}) {
  const { toast } = useToast();
  const [locating, setLocating] = useState(false);
  const words = what3words.trim() ? normaliseWhat3Words(what3words) : null;

  function captureMyLocation() {
    if (!navigator.geolocation) {
      toast({ title: "Location unavailable", description: "This browser can't share its location.", variant: "destructive" });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const latitude = Math.round(pos.coords.latitude * 1e6) / 1e6;
        const longitude = Math.round(pos.coords.longitude * 1e6) / 1e6;
        onChange({ latitude, longitude });
        // The three words come from what3words' paid service when it is set
        // up; otherwise the GPS spot is saved and the words are typed in.
        let found: string | null = null;
        try {
          const res = await sharedApiFetch(`/w3w/convert?lat=${latitude}&lng=${longitude}`);
          if (res.ok) found = ((await res.json()) as { words?: string }).words ?? null;
        } catch { /* the GPS spot is saved either way */ }
        if (found) onChange({ what3words: found });
        toast({
          title: "Location saved",
          description: found ? `///${found}` : "GPS spot saved. Add the what3words address from the what3words app if you have it.",
        });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        const msg = err.code === 1 ? "Location permission denied." : err.code === 2 ? "Location unavailable." : "Location timed out.";
        toast({ title: "Couldn't get your location", description: msg, variant: "destructive" });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label htmlFor="location">{locationLabel}</Label>
          <button type="button" onClick={captureMyLocation} disabled={locating}
            className="flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />}
            {locating ? "Getting location…" : "Use my location"}
          </button>
        </div>
        <Input id="location" dictation placeholder="e.g. By the 9th tee, car park perimeter, east boundary"
          value={location} onChange={e => onChange({ location: e.target.value })} className="rounded-sm" />
        {latitude != null && longitude != null && (
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>GPS {latitude.toFixed(5)}, {longitude.toFixed(5)}</span>
            <MapLink latitude={latitude} longitude={longitude} />
            <button type="button" className="hover:underline" onClick={() => onChange({ latitude: null, longitude: null })}>Clear</button>
          </div>
        )}
      </div>
      <div>
        <Label htmlFor="what3words">{what3wordsLabel}</Label>
        <div className="relative mt-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-rose-600">///</span>
          <Input id="what3words" placeholder="filled.count.soap" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            value={what3words.replace(/^\/+/, "")} onChange={e => onChange({ what3words: e.target.value })} className="pl-9 rounded-sm" />
        </div>
        {what3words.trim() && !words ? (
          <p className="text-xs text-rose-600 mt-1">Three words with dots between them, like filled.count.soap</p>
        ) : words ? (
          <div className="mt-1"><What3WordsLink words={words} /></div>
        ) : (
          <p className="text-xs text-muted-foreground mt-1">
            From the free what3words app or <a href="https://what3words.com" target="_blank" rel="noopener noreferrer" className="underline">what3words.com</a>, so anyone can find the exact spot.
          </p>
        )}
      </div>
    </>
  );
}

function daysUntil(d: string | null) {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(d).getTime() - today.getTime()) / 86400000);
}

function ResultBadge({ result }: { result: string }) {
  const cfg = RESULT_CFG[result as CheckResult] ?? SEVERITY_CFG[result as ActionSeverity] ?? { label: result, badge: "bg-slate-50 text-slate-700 border-slate-200" };
  const Icon = result === "pass" ? CheckCircle2
    : result === "monitor" ? Clock
    : AlertTriangle;
  return (
    <Badge variant="outline" className={cfg.badge}>
      <Icon className="w-3 h-3 mr-1" /> {cfg.label}
    </Badge>
  );
}

function StatusBadge({ status }: { status: CheckStatus }) {
  if (status === "ok") return (
    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
      <CheckCircle2 className="w-3 h-3 mr-1" /> OK
    </Badge>
  );
  if (status === "due_soon") return (
    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
      <Clock className="w-3 h-3 mr-1" /> Due Soon
    </Badge>
  );
  if (status === "overdue") return (
    <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
      <AlertTriangle className="w-3 h-3 mr-1" /> Overdue
    </Badge>
  );
  return (
    <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200">
      <CalendarX className="w-3 h-3 mr-1" /> Never Done
    </Badge>
  );
}

const emptyForm = () => ({
  checkType: "visual_assessment" as CheckType,
  checkDate: new Date().toISOString().slice(0, 10),
  result: "pass" as CheckResult,
  actionSeverity: "" as "" | ActionSeverity,
  treeId: "",
  treeRef: "",
  location: "",
  what3words: "",
  latitude: null as number | null,
  longitude: null as number | null,
  inspector: "",
  followUpDate: "",
  siteId: "",
  notes: "",
});

const emptyTreeForm = () => ({
  ref: "",
  species: "",
  siteId: "",
  location: "",
  what3words: "",
  latitude: null as number | null,
  longitude: null as number | null,
  riskZone: "medium" as RiskZone,
  inspectionIntervalMonths: 12,
  notes: "",
  removedAt: "",
});

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TreeTrackPage() {
  const { toast } = useToast();
  const { activeClientId, hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const qc = useQueryClient();
  const hasTrees = hasService("treetrack");

  const [filterType, setFilterType] = useState<CheckType | "all">("all");
  const [filterSite, setFilterSite] = useState("all");
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<TreeInspection | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [resultChanged, setResultChanged] = useState(false);
  const [tab, setTab] = useState<"trees" | "log">("trees");
  const [treeSearch, setTreeSearch] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [showTreeDialog, setShowTreeDialog] = useState(false);
  const [editTree, setEditTree] = useState<Tree | null>(null);
  const [treeForm, setTreeForm] = useState(emptyTreeForm());
  const [savingTree, setSavingTree] = useState(false);
  const [deleteTree, setDeleteTree] = useState<Tree | null>(null);

  // ── Data ───────────────────────────────────────────────────────────────────

  const { data: records = [], isLoading } = useQuery<TreeInspection[]>({
    queryKey: ["tree-track", activeClientId],
    queryFn: () => apiFetch("/tree-track"),
    enabled: !!activeClientId && hasTrees,
  });

  const { data: statuses = [] } = useQuery<StatusRow[]>({
    queryKey: ["tree-track-status", activeClientId],
    queryFn: () => apiFetch("/tree-track/status"),
    enabled: !!activeClientId && hasTrees,
    retry: (count, err: any) => err?.status !== 403 && count < 3,
  });

  const { data: trees = [], isSuccess: treesLoaded } = useQuery<Tree[]>({
    queryKey: ["tree-track-trees", activeClientId, showRemoved],
    queryFn: () => apiFetch(`/tree-track/trees${showRemoved ? "?includeRemoved=true" : ""}`),
    enabled: !!activeClientId && hasTrees,
  });

  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites", activeClientId],
    queryFn: () => apiFetch("/sites"),
    enabled: !!activeClientId,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const urgentCount = useMemo(
    () => records.filter(r => (r.actionSeverity ?? r.result) === "urgent_action").length,
    [records],
  );
  const actionCount = useMemo(
    () => records.filter(r => (r.actionSeverity ?? r.result) === "action_required").length,
    [records],
  );

  const siteName = (id: number | null | undefined) => sites.find(s => s.id === id)?.name ?? null;
  const activeTrees = useMemo(() => trees.filter(t => !t.removedAt), [trees]);
  const treesOverdue = activeTrees.filter(t => t.status === "overdue" || t.status === "never").length;
  const treesWithIssues = activeTrees.filter(t => t.openIssue).length;

  const filteredTrees = useMemo(() => {
    let rows = trees;
    if (filterSite !== "all") rows = rows.filter(t => String(t.siteId) === filterSite);
    if (treeSearch.trim()) {
      const q = treeSearch.toLowerCase();
      rows = rows.filter(t => [t.ref, t.species, t.location, t.what3words, t.notes]
        .some(v => (v ?? "").toLowerCase().includes(q)));
    }
    // Most pressing first: open issues, then overdue or never inspected, then by due date.
    const rank = (t: Tree) => t.removedAt ? 4 : t.openIssue ? 0 : t.status === "overdue" || t.status === "never" ? 1 : t.status === "due_soon" ? 2 : 3;
    return [...rows].sort((a, b) => rank(a) - rank(b)
      || (a.nextDue ?? "").localeCompare(b.nextDue ?? "")
      || a.ref.localeCompare(b.ref, "en-GB", { numeric: true }));
  }, [trees, filterSite, treeSearch]);

  const filtered = useMemo(() => {
    let rows = records;
    if (filterType !== "all") rows = rows.filter(r => r.checkType === filterType);
    if (filterSite !== "all") rows = rows.filter(r => String(r.siteId) === filterSite);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        (r.treeRef ?? "").toLowerCase().includes(q) ||
        (r.location ?? "").toLowerCase().includes(q) ||
        (r.inspector ?? "").toLowerCase().includes(q) ||
        (r.notes ?? "").toLowerCase().includes(q) ||
        CHECK_TYPE_LABELS[r.checkType as CheckType]?.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [records, filterType, filterSite, search]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tree-track"] });
    qc.invalidateQueries({ queryKey: ["tree-track-status"] });
    qc.invalidateQueries({ queryKey: ["tree-track-trees"] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/tree-track/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Record deleted" }); setDeleteId(null); },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ── Dialog ─────────────────────────────────────────────────────────────────

  function openAdd() {
    setEditItem(null);
    setResultChanged(false);
    setForm(emptyForm());
    setShowDialog(true);
  }

  /** The inspection form for one tree, its place filled in from the tree list. */
  function treeFields(tree: Tree) {
    return {
      treeId: String(tree.id),
      treeRef: tree.ref,
      location: tree.location ?? "",
      what3words: tree.what3words ?? "",
      latitude: tree.latitude,
      longitude: tree.longitude,
      siteId: tree.siteId ? String(tree.siteId) : "",
    };
  }

  function openInspectTree(tree: Tree) {
    setEditItem(null);
    setResultChanged(false);
    setForm({ ...emptyForm(), ...treeFields(tree) });
    setShowDialog(true);
  }

  function chooseTree(value: string) {
    const tree = trees.find(t => String(t.id) === value);
    setForm(f => tree ? { ...f, ...treeFields(tree) } : { ...f, treeId: "", treeRef: "" });
  }

  function openAddTree() {
    setEditTree(null);
    setTreeForm({ ...emptyTreeForm(), siteId: filterSite !== "all" ? filterSite : sites.length === 1 ? String(sites[0].id) : "" });
    setShowTreeDialog(true);
  }

  function openEditTree(tree: Tree) {
    setEditTree(tree);
    setTreeForm({
      ref: tree.ref,
      species: tree.species ?? "",
      siteId: tree.siteId ? String(tree.siteId) : "",
      location: tree.location ?? "",
      what3words: tree.what3words ?? "",
      latitude: tree.latitude,
      longitude: tree.longitude,
      riskZone: tree.riskZone,
      inspectionIntervalMonths: tree.inspectionIntervalMonths,
      notes: tree.notes ?? "",
      removedAt: tree.removedAt ?? "",
    });
    setShowTreeDialog(true);
  }

  async function handleSaveTree() {
    if (!treeForm.ref.trim()) { toast({ title: "Give the tree a reference, such as T12", variant: "destructive" }); return; }
    const words = treeForm.what3words.trim() ? normaliseWhat3Words(treeForm.what3words) : null;
    if (treeForm.what3words.trim() && !words) {
      toast({ title: "Check the what3words address", description: "Three words with dots between them, like filled.count.soap", variant: "destructive" });
      return;
    }
    setSavingTree(true);
    try {
      const body = {
        ref: treeForm.ref.trim(),
        species: treeForm.species.trim() || null,
        siteId: treeForm.siteId ? Number(treeForm.siteId) : null,
        location: treeForm.location.trim() || null,
        what3words: words,
        latitude: treeForm.latitude,
        longitude: treeForm.longitude,
        riskZone: treeForm.riskZone,
        inspectionIntervalMonths: treeForm.inspectionIntervalMonths,
        notes: treeForm.notes.trim() || null,
        removedAt: treeForm.removedAt || null,
      };
      if (editTree) {
        await apiFetch(`/tree-track/trees/${editTree.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Tree updated" });
      } else {
        await apiFetch("/tree-track/trees", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Tree added", description: "Record its first inspection with Inspect." });
      }
      invalidate();
      setShowTreeDialog(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSavingTree(false);
    }
  }

  const deleteTreeMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/tree-track/trees/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "Tree removed from the list" }); setDeleteTree(null); setShowTreeDialog(false); },
    onError: (e: any) => { toast({ title: "Couldn't delete the tree", description: e.message, variant: "destructive" }); setDeleteTree(null); },
  });

  // An inspection said to Say it ("tree T12 by the car park, dead branch, urgent").
  useSayItFill(["tree-inspection"], fill => {
    const v = fill.values;
    const text = (key: string) => (typeof v[key] === "string" ? v[key] as string : "");
    const spokenTree = matchSpokenItem(text("treeRef"), activeTrees.map(t => ({ id: t.id, name: t.ref, aliases: [t.species] })));
    const tree = spokenTree ? activeTrees.find(t => t.id === spokenTree.id) : undefined;
    setEditItem(null);
    setResultChanged(false);
    setForm({
      ...emptyForm(),
      checkType: (CHECK_TYPES as readonly string[]).includes(text("checkType")) ? text("checkType") as CheckType : "visual_assessment",
      result: v.result === "fail" ? "fail" : "pass",
      actionSeverity: v.result === "fail" ? (text("actionSeverity") as ActionSeverity) || "action_required" : "",
      treeRef: text("treeRef"), location: text("location"),
      siteId: fill.siteId ? String(fill.siteId) : "",
      ...(tree ? { ...treeFields(tree), location: text("location") || tree.location || "" } : {}),
      notes: withSpokenNote("", fill.text),
    });
    setShowDialog(true);
  }, treesLoaded);

  function openEdit(r: TreeInspection) {
    setEditItem(r);
    setForm({
      checkType: r.checkType as CheckType,
      checkDate: r.checkDate?.slice(0, 10) ?? "",
      result: r.observationResult ?? (r.result === "pass" ? "pass" : "fail"),
      actionSeverity: (r.actionSeverity ?? (["monitor", "action_required", "urgent_action"].includes(r.result) ? r.result : "")) as "" | ActionSeverity,
      treeId: r.treeId ? String(r.treeId) : "",
      treeRef: r.treeRef ?? "",
      location: r.location ?? "",
      what3words: r.what3words ?? "",
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      inspector: r.inspector ?? "",
      followUpDate: r.followUpDate?.slice(0, 10) ?? "",
      siteId: r.siteId ? String(r.siteId) : "",
      notes: r.notes ?? "",
    });
    setResultChanged(false);
    setShowDialog(true);
  }

  async function handleSave() {
    if (!form.checkDate) { toast({ title: "Date is required", variant: "destructive" }); return; }
    const words = form.what3words.trim() ? normaliseWhat3Words(form.what3words) : null;
    if (form.what3words.trim() && !words) {
      toast({ title: "Check the what3words address", description: "Three words with dots between them, like filled.count.soap", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body: any = {
        checkType: form.checkType,
        checkDate: form.checkDate,
        result: form.result,
        actionSeverity: form.actionSeverity || null,
        treeId: form.treeId ? Number(form.treeId) : null,
        treeRef: form.treeRef.trim() || null,
        location: form.location.trim() || null,
        what3words: words,
        latitude: form.latitude,
        longitude: form.longitude,
        inspector: form.inspector.trim() || null,
        followUpDate: form.followUpDate || null,
        siteId: form.siteId ? Number(form.siteId) : null,
        notes: form.notes.trim() || null,
      };
      if (editItem) {
        const { checkType, ...updateBody } = body;
        // Legacy rows encoded remediation severity in result. Unless the user
        // changes the selector, leave that historical value byte-for-byte intact.
        if (!resultChanged && editItem.result !== "pass" && editItem.result !== "fail") {
          delete updateBody.result;
          delete updateBody.actionSeverity;
        }
        await apiFetch(`/tree-track/${editItem.id}`, { method: "PUT", body: JSON.stringify(updateBody) });
        toast({ title: "Record updated" });
      } else {
        await apiFetch("/tree-track", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Inspection recorded" });
      }
      invalidate();
      setShowDialog(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Locked ─────────────────────────────────────────────────────────────────

  if (!hasTrees) {
    return (
      <AppLayout title="TreeTrack">
        <div className="max-w-2xl mx-auto mt-12">
          <Card className="border-2 border-primary/20 bg-primary/5">
            <CardContent className="pt-8 pb-8 px-8 text-center space-y-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-bold text-foreground mb-2">TreeTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital tree inspection logbook — record visual assessments, detailed surveys, post-storm checks and remedial works in line with BS 3998:2010 and NTSG guidance.
                </p>
                <p className="font-medium text-primary">£10 per site per month</p>
              </div>
              <div className="pt-4">
                {canAdmin ? (
                  <Link href="/settings">
                    <Button className="rounded-sm">Activate TreeTrack</Button>
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">Ask your administrator to activate this module.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <AppLayout title="TreeTrack">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
        <p className="text-sm text-muted-foreground mt-1">
          Tree inspection logbook — visual assessments, detailed surveys, post-storm checks and remedial works records
        </p>
        <div className="flex flex-wrap sm:justify-end gap-2 flex-shrink-0">
          {canAdmin && (
            <Button variant="outline" onClick={openAddTree} className="gap-2 rounded-sm">
              <TreePine className="w-4 h-4" /> Add tree
            </Button>
          )}
          <Button onClick={openAdd} className="gap-2 rounded-sm">
            <Plus className="w-4 h-4" /> Record Inspection
          </Button>
        </div>
      </div>

      {/* Status overview */}
      {statuses.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {statuses.map(s => {
            const cfg = {
              ok:        { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", icon: CheckCircle2 },
              due_soon:  { bg: "bg-amber-50 border-amber-200",     text: "text-amber-700",   icon: Clock },
              overdue:   { bg: "bg-rose-50 border-rose-200",       text: "text-rose-700",    icon: AlertTriangle },
              never:     { bg: "bg-slate-50 border-slate-200",     text: "text-slate-500",   icon: CalendarX },
            }[s.status];
            const Icon = cfg.icon;
            const days = daysUntil(s.dueDate);
            return (
              <button
                key={s.checkType}
                onClick={() => setFilterType(filterType === s.checkType ? "all" : s.checkType as CheckType)}
                className={cn(
                  "p-3 rounded-sm border text-left transition-all hover:shadow-sm",
                  cfg.bg,
                  filterType === s.checkType && "ring-2 ring-offset-1 ring-primary"
                )}
              >
                <div className={cn("flex items-center gap-1 mb-1.5", cfg.text)}>
                  <Icon className="w-3.5 h-3.5" />
                  <StatusBadge status={s.status} />
                </div>
                <div className="text-xs font-medium text-foreground leading-snug">
                  {CHECK_TYPE_LABELS[s.checkType as CheckType] ?? s.checkType}
                </div>
                {s.dueDate && days !== null && (
                  <div className={cn("text-xs mt-1", cfg.text)}>
                    {s.status === "overdue"
                      ? `${Math.abs(days)}d overdue`
                      : s.status === "due_soon"
                      ? `Due in ${days}d`
                      : `Next ${fmt(s.dueDate)}`}
                  </div>
                )}
                {s.status === "never" && (
                  <div className="text-xs mt-1 text-slate-400">Not yet recorded</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Action banners */}
      {urgentCount > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-rose-50 border-rose-300 text-rose-800 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{urgentCount} record{urgentCount !== 1 ? "s" : ""}</strong> marked as <strong>Urgent Action</strong> — these trees require immediate attention.
          </span>
        </div>
      )}
      {actionCount > 0 && urgentCount === 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-amber-50 border-amber-300 text-amber-800 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{actionCount} record{actionCount !== 1 ? "s" : ""}</strong> marked as <strong>Action Required</strong> — schedule remedial works.
          </span>
        </div>
      )}

      {treesWithIssues > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-rose-50 border-rose-300 text-rose-800 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{treesWithIssues} tree{treesWithIssues !== 1 ? "s" : ""}</strong> failed {treesWithIssues !== 1 ? "their" : "its"} last inspection. They stay flagged until an inspection passes.
          </span>
        </div>
      )}
      {treesOverdue > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-sm border bg-amber-50 border-amber-300 text-amber-800 text-sm">
          <CalendarX className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>{treesOverdue} tree{treesOverdue !== 1 ? "s are" : " is"}</strong> overdue or not inspected yet.
          </span>
        </div>
      )}

      <Tabs value={tab} onValueChange={v => setTab(v as "trees" | "log")} className="space-y-4">
        <TabsList>
          <TabsTrigger value="trees">Trees ({activeTrees.length})</TabsTrigger>
          <TabsTrigger value="log">Inspection log ({records.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="trees" className="space-y-4 mt-0">
          <div className="flex flex-wrap gap-2 items-center">
            {sites.length > 0 && (
              <Select value={filterSite} onValueChange={setFilterSite}>
                <SelectTrigger className="w-40 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sites</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search tree, species, place, what3words…" value={treeSearch}
                onChange={e => setTreeSearch(e.target.value)} className="pl-9 rounded-sm" />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} />
              Show felled trees
            </label>
          </div>

          {!treesLoaded ? (
            <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
          ) : filteredTrees.length === 0 ? (
            <div className="text-center py-12 px-4 border border-dashed border-border rounded-sm">
              <TreePine className="w-9 h-9 mx-auto text-muted-foreground/30 mb-3" />
              {trees.length === 0 ? (
                <>
                  <p className="text-sm text-foreground font-medium">List the trees you look after</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                    Add each tree, or group of trees, with where it is and its what3words address. TreeTrack then shows when each one is due for inspection and flags any that fail.
                  </p>
                  {canAdmin ? (
                    <Button onClick={openAddTree} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
                      <Plus className="w-4 h-4" /> Add tree
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-3">An Owner adds trees to the list.</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No trees match the current filter.</p>
              )}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredTrees.map(t => {
                const days = daysUntil(t.nextDue);
                return (
                  <Card key={t.id} className={cn("rounded-sm", t.removedAt && "opacity-60")}>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <TreePine className="w-4 h-4 text-green-700 flex-shrink-0" />
                            <span className="font-semibold">{t.ref}</span>
                            {t.species && <span className="text-sm text-muted-foreground truncate">{t.species}</span>}
                          </div>
                          {(siteName(t.siteId) || t.location) && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {[siteName(t.siteId), t.location].filter(Boolean).join(" · ")}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-3 mt-1">
                            <What3WordsLink words={t.what3words} />
                            <MapLink latitude={t.latitude} longitude={t.longitude} />
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                          {t.removedAt ? (
                            <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200">Felled {fmt(t.removedAt)}</Badge>
                          ) : (
                            <StatusBadge status={t.status} />
                          )}
                          {t.openIssue && (
                            <Badge variant="outline" className={SEVERITY_CFG[t.openIssue.severity ?? "action_required"]?.badge ?? RESULT_CFG.fail.badge}>
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              {t.openIssue.severity ? SEVERITY_CFG[t.openIssue.severity].label : "Failed"}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <Badge variant="outline" className={RISK_ZONE_BADGE[t.riskZone]}>{RISK_ZONE_LABELS[t.riskZone]}</Badge>
                        <span className="self-center">Every {t.inspectionIntervalMonths} months</span>
                        <span className="self-center">Last inspected {t.lastInspected ? fmt(t.lastInspected) : "never"}</span>
                        {!t.removedAt && (
                          <span className={cn("self-center", (t.status === "overdue" || t.status === "never") && "text-rose-600 font-medium", t.status === "due_soon" && "text-amber-600 font-medium")}>
                            {t.status === "never" ? "Due now"
                              : days !== null && days < 0 ? `Due ${fmt(t.nextDue)} (${Math.abs(days)}d overdue)`
                              : `Next due ${fmt(t.nextDue)}`}
                          </span>
                        )}
                      </div>
                      {!t.removedAt && (
                        <div className="flex justify-end gap-2 pt-1">
                          {canAdmin && (
                            <Button variant="ghost" size="sm" className="rounded-sm gap-1" onClick={() => openEditTree(t)}>
                              <Pencil className="w-3.5 h-3.5" /> Edit
                            </Button>
                          )}
                          <Button variant="outline" size="sm" className="rounded-sm gap-1" onClick={() => openInspectTree(t)}>
                            <ClipboardCheck className="w-3.5 h-3.5" /> Inspect
                          </Button>
                        </div>
                      )}
                      {t.removedAt && canAdmin && (
                        <div className="flex justify-end">
                          <Button variant="ghost" size="sm" className="rounded-sm gap-1" onClick={() => openEditTree(t)}>
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="log" className="space-y-4 mt-0">
      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {sites.length > 0 && (
          <Select value={filterSite} onValueChange={setFilterSite}>
            <SelectTrigger className="w-40 rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterType} onValueChange={v => setFilterType(v as CheckType | "all")}>
          <SelectTrigger className="w-56 rounded-sm">
            <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All inspection types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All inspection types</SelectItem>
            {sortByLabel(CHECK_TYPES, t => CHECK_TYPE_LABELS[t]).map(t => <SelectItem key={t} value={t}>{CHECK_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search tree ref, location, inspector…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 rounded-sm"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border rounded-sm">
          <TreePine className="w-9 h-9 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {records.length === 0
              ? "No tree inspection records yet. Record your first inspection above."
              : "No records match the current filter."}
          </p>
          {records.length === 0 && (
            <Button onClick={openAdd} variant="outline" size="sm" className="mt-4 rounded-sm gap-2">
              <Plus className="w-4 h-4" /> Record Inspection
            </Button>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                {["Inspection Type", "Date", "Result", "Tree Ref", "Location", "Inspector", "Follow-up", "Photos", ""].map(h => (
                  <th key={h} className={cn(
                    "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                    h === "Tree Ref" && "hidden sm:table-cell",
                    h === "Location" && "hidden md:table-cell",
                    h === "Inspector" && "hidden lg:table-cell",
                    h === "Follow-up" && "hidden lg:table-cell",
                    h === "Photos" && "hidden sm:table-cell",
                    h === "" && "w-20",
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(r => {
                const days = daysUntil(r.followUpDate);
                const followUpUrgent = days !== null && days <= 14;
                return (
                  <tr key={r.id} className="bg-white hover:bg-muted/20 transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-sm bg-green-100 flex items-center justify-center flex-shrink-0">
                          <TreePine className="w-3.5 h-3.5 text-green-700" />
                        </div>
                        <span className="font-medium">{CHECK_TYPE_LABELS[r.checkType as CheckType] ?? r.checkType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmt(r.checkDate)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <ResultBadge result={r.observationResult ?? (r.result === "pass" ? "pass" : "fail")} />
                        {r.actionSeverity && <ResultBadge result={r.actionSeverity} />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                      {r.treeRef ?? <span className="opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {r.location || r.what3words || r.latitude != null ? (
                        <div className="space-y-0.5">
                          {r.location && (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <Building2 className="w-3 h-3 opacity-50" />{r.location}
                            </span>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <What3WordsLink words={r.what3words} />
                            <MapLink latitude={r.latitude} longitude={r.longitude} />
                          </div>
                        </div>
                      ) : <span className="text-muted-foreground opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {r.inspector ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <UserCheck className="w-3 h-3 opacity-50" />{r.inspector}
                        </span>
                      ) : <span className="text-muted-foreground opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {r.followUpDate ? (
                        <span className={cn(
                          "flex items-center gap-1 text-sm",
                          followUpUrgent ? "text-amber-600 font-medium" : "text-muted-foreground"
                        )}>
                          <CalendarDays className="w-3 h-3 opacity-60" />
                          {fmt(r.followUpDate)}
                          {days !== null && days <= 0 && <span className="text-rose-600 text-xs">(overdue)</span>}
                        </span>
                      ) : <span className="text-muted-foreground opacity-40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <RecordSignedBy recordType="tree_inspection" recordId={r.id} compact className="mb-1" />
                      <CheckPhotoUploader entityType="tree_inspection" entityId={r.id} compact />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm" onClick={() => openEdit(r)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(r.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-border px-4 py-2 bg-muted/20 text-xs text-muted-foreground">
            Showing {filtered.length} of {records.length} record{records.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}
        </TabsContent>
      </Tabs>

      {/* Guidance footer */}
      <div className="bg-green-50 border border-green-200 rounded-sm p-4 text-xs text-green-900">
        <p className="font-semibold mb-1">Regulatory guidance: BS 3998:2010 / NTSG / Occupiers' Liability Act</p>
        <p>Occupiers have a duty of care to ensure trees on their land do not pose an unreasonable risk to people or property. As a minimum, all trees should receive an annual visual tree assessment (VTA). Trees showing signs of structural defect, disease, or significant deadwood should be subject to a detailed inspection by a qualified arborist. All inspections and remedial works should be documented.</p>
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={showDialog} onOpenChange={v => { if (!saving) setShowDialog(v); }}>
        <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editItem ? "Edit Inspection Record" : "Record Tree Inspection"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">

            {/* Inspection type */}
            {!editItem ? (
              <div>
                <Label>Inspection Type *</Label>
                <Select value={form.checkType} onValueChange={v => setForm(f => ({ ...f, checkType: v as CheckType }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {sortByLabel(CHECK_TYPES, t => CHECK_TYPE_LABELS[t]).map(t => <SelectItem key={t} value={t}>{CHECK_TYPE_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground italic mt-1">{CHECK_TYPE_HINTS[form.checkType]}</p>
              </div>
            ) : (
              <div className="px-3 py-2 bg-muted/40 rounded-sm text-sm text-muted-foreground">
                {CHECK_TYPE_LABELS[editItem.checkType as CheckType] ?? editItem.checkType}
              </div>
            )}

            {/* Tree */}
            {activeTrees.length > 0 && (
              <div>
                <Label>Tree</Label>
                <Select value={form.treeId || "none"} onValueChange={v => chooseTree(v === "none" ? "" : v)}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not on the tree list (an area or other tree)</SelectItem>
                    {[...activeTrees].sort((a, b) => a.ref.localeCompare(b.ref, "en-GB", { numeric: true })).map(t => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.ref}{t.species ? ` · ${t.species}` : ""}{siteName(t.siteId) ? ` · ${siteName(t.siteId)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Date */}
            <div>
              <Label htmlFor="checkDate">Date *</Label>
              <Input id="checkDate" type="date" value={form.checkDate}
                onChange={e => setForm(f => ({ ...f, checkDate: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Result */}
            <div>
              <Label>Result *</Label>
              <Select value={form.result} onValueChange={v => { setResultChanged(true); setForm(f => ({ ...f, result: v as CheckResult })); }}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass — No significant concerns</SelectItem>
                  <SelectItem value="fail">Fail — concerns found</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.result === "fail" && (
              <div>
                <Label>Remediation severity <span className="text-muted-foreground text-xs">optional</span></Label>
                <Select value={form.actionSeverity || "none"} onValueChange={v => { setResultChanged(true); setForm(f => ({ ...f, actionSeverity: v === "none" ? "" : v as ActionSeverity })); }}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No severity specified</SelectItem>
                    <SelectItem value="monitor">Monitor</SelectItem>
                    <SelectItem value="action_required">Action Required</SelectItem>
                    <SelectItem value="urgent_action">Urgent Action</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Tree reference */}
            {!form.treeId && (
              <div>
                <Label htmlFor="treeRef">Tree Reference / Tag</Label>
                <Input id="treeRef" placeholder="e.g. T1, Oak-North, Group A…"
                  value={form.treeRef}
                  onChange={e => setForm(f => ({ ...f, treeRef: e.target.value }))}
                  className="mt-1 rounded-sm" />
              </div>
            )}

            <LocationFields
              location={form.location} what3words={form.what3words}
              latitude={form.latitude} longitude={form.longitude}
              onChange={patch => setForm(f => ({ ...f, ...patch }))}
              locationLabel="Location on Site"
              what3wordsLabel={form.result === "fail" ? "what3words address of the problem" : "what3words address"} />

            {/* Inspector */}
            <div>
              <Label htmlFor="inspector">Inspector / Arborist</Label>
              <Input id="inspector" placeholder="Name or company"
                value={form.inspector}
                onChange={e => setForm(f => ({ ...f, inspector: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Site */}
            {sites.length > 0 && (
              <div>
                <Label>Site</Label>
                <Select value={form.siteId || "none"} onValueChange={v => setForm(f => ({ ...f, siteId: v === "none" ? "" : v }))}
                  disabled={!!form.treeId && !!activeTrees.find(t => String(t.id) === form.treeId)?.siteId}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select site (optional)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No specific site</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Follow-up date */}
            <div>
              <Label htmlFor="followUpDate">Follow-up / Re-inspection Date</Label>
              <Input id="followUpDate" type="date" value={form.followUpDate}
                onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))}
                className="mt-1 rounded-sm" />
            </div>

            {/* Notes */}
            <div>
              <Label htmlFor="notes">Observations / Recommended Works</Label>
              <Textarea id="notes" placeholder="Describe findings, structural defects, deadwood, fungal bodies, recommended actions…"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="mt-1 rounded-sm" rows={3} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving} className="rounded-sm">Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="rounded-sm">
              {saving ? "Saving…" : editItem ? "Save Changes" : "Record Inspection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit tree */}
      <Dialog open={showTreeDialog} onOpenChange={v => { if (!savingTree) setShowTreeDialog(v); }}>
        <DialogContent className="max-w-lg rounded-sm max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editTree ? `Edit tree ${editTree.ref}` : "Add a tree"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1 max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="treeRefNew">Tree reference *</Label>
                <Input id="treeRefNew" placeholder="e.g. T12 or Beech group" value={treeForm.ref}
                  onChange={e => setTreeForm(f => ({ ...f, ref: e.target.value }))} className="mt-1 rounded-sm" />
              </div>
              <div>
                <Label htmlFor="species">Species</Label>
                <Input id="species" placeholder="e.g. Beech, Scots pine" value={treeForm.species}
                  onChange={e => setTreeForm(f => ({ ...f, species: e.target.value }))} className="mt-1 rounded-sm" />
              </div>
            </div>
            {sites.length > 0 && (
              <div>
                <Label>Site</Label>
                <Select value={treeForm.siteId || "none"} onValueChange={v => setTreeForm(f => ({ ...f, siteId: v === "none" ? "" : v }))}>
                  <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No specific site</SelectItem>
                    {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <LocationFields
              location={treeForm.location} what3words={treeForm.what3words}
              latitude={treeForm.latitude} longitude={treeForm.longitude}
              onChange={patch => setTreeForm(f => ({ ...f, ...patch }))}
              locationLabel="Where it is" what3wordsLabel="what3words address" />
            <div>
              <Label>How busy is the area under it?</Label>
              <Select value={treeForm.riskZone} onValueChange={v => setTreeForm(f => ({ ...f, riskZone: v as RiskZone }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["high", "medium", "low"] as RiskZone[]).map(z => <SelectItem key={z} value={z}>{RISK_ZONE_LABELS[z]}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground italic mt-1">{RISK_ZONE_HINTS[treeForm.riskZone]}</p>
            </div>
            <div>
              <Label>Inspect every</Label>
              <Select value={String(treeForm.inspectionIntervalMonths)} onValueChange={v => setTreeForm(f => ({ ...f, inspectionIntervalMonths: Number(v) }))}>
                <SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from(new Set([...INTERVAL_OPTIONS, treeForm.inspectionIntervalMonths])).sort((a, b) => a - b)
                    .map(m => <SelectItem key={m} value={String(m)}>{m} months</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground italic mt-1">
                At least once a year is usual. Your tree surveyor may advise more often for trees in busy areas or with known defects.
              </p>
            </div>
            <div>
              <Label htmlFor="treeNotes">Notes</Label>
              <Textarea id="treeNotes" placeholder="e.g. Tree preservation order, known defects, access"
                value={treeForm.notes} onChange={e => setTreeForm(f => ({ ...f, notes: e.target.value }))} className="mt-1 rounded-sm" rows={2} />
            </div>
            {editTree && (
              <div>
                <Label htmlFor="removedAt">Felled or removed on</Label>
                <Input id="removedAt" type="date" value={treeForm.removedAt}
                  onChange={e => setTreeForm(f => ({ ...f, removedAt: e.target.value }))} className="mt-1 rounded-sm" />
                <p className="text-xs text-muted-foreground mt-1">Takes it off the list of trees due; its inspections are kept.</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {editTree ? (
              <Button variant="ghost" className="rounded-sm text-destructive hover:text-destructive" disabled={savingTree}
                onClick={() => setDeleteTree(editTree)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowTreeDialog(false)} disabled={savingTree} className="rounded-sm">Cancel</Button>
              <Button onClick={handleSaveTree} disabled={savingTree} className="rounded-sm">
                {savingTree ? "Saving…" : editTree ? "Save Changes" : "Add tree"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTree !== null} onOpenChange={v => { if (!v) setDeleteTree(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tree {deleteTree?.ref}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only for a tree added by mistake. A tree with inspections can't be deleted; set the day it was felled or removed instead, so its records are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction className="rounded-sm bg-destructive hover:bg-destructive/90"
              onClick={() => deleteTree && deleteTreeMutation.mutate(deleteTree.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={v => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete record?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the inspection record. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-sm bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
