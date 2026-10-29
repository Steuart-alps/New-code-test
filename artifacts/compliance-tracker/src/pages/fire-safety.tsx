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
  getListSitesQueryKey,
  FireCheckType,
  FireSafetyCheck,
  FireSafetyStatus as FireSafetyStatusType,
  CreateFireSafetyCheckRequest,
  useGetFireSafetyConfig,
  getGetFireSafetyConfigQueryKey,
  useUpdateFireSafetyConfig,
  useListFireCallPoints,
  getListFireCallPointsQueryKey,
  useCreateFireCallPoint,
  useUpdateFireCallPoint,
  useOrderFireCallPoints,
  FireCallPoint,
  getGetFireDrillAttendanceQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSayItSite } from "@/components/say-it-button";
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
  Filter, Pencil, Trash2, Lock, Route, Cpu, Check, X, Minus, Settings, XCircle, ShieldAlert,
  BellRing, Lightbulb, Moon, Archive, RotateCcw, ChevronUp, ChevronDown, Footprints,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth, useCanAdmin, useCanEdit } from "@/context/auth-context";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { StaffPerformerSelect } from "@/components/staff-performer-select";
import { AuditLog } from "@/components/audit-log";
import { LoadError } from "@/components/load-error";
import { takeLinkParams } from "@/lib/deep-link";
import { ImportCsvButton } from "@/components/import-csv-dialog";
import { WalkRoundDialog, type WalkRoundPoint } from "@/components/walk-round-dialog";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { Checkbox } from "@/components/ui/checkbox";
import {
  EMPTY_SOUND_LEVEL, parseSoundLevel, SoundLevelField, soundLevelRequest, SoundLevelVerdictText, type SoundLevelValue,
} from "@/components/sound-level-field";
import { SOUND_LEVEL_MIN_DB } from "@/lib/fire-sound-level";
import { StringListEditor } from "@/components/string-list-editor";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { sortByLabel } from "@/lib/sort-options";
import { TrackContractorChecks } from "@/components/track-contractor-checks";
import {
  DrillAttendanceCard, DrillStaffPicker, DrillTimingFields, EMPTY_EVACUATION, evacuationFromSeconds, evacuationIsBlank,
  formatEvacuation, parseEvacuation, type EvacuationValue,
} from "@/components/fire-drill";
import { RecordSignedBy } from "@/components/record-signature";

// ── Check type config ─────────────────────────────────────────────────────────

const ALL_CHECK_TYPES = [
  "alarm", "emergency_lights", "extinguishers",
  "fire_doors", "fire_drill", "fire_walk", "alarm_panel",
  "emergency_lights_annual", "alarm_service", "extinguisher_service",
] as const;
type AnyCheckType = typeof ALL_CHECK_TYPES[number];

const CHECK_TYPE_LABELS: Record<AnyCheckType, string> = {
  alarm:            "Weekly fire alarm test",
  emergency_lights: "Monthly emergency lighting flick test",
  extinguishers:    "Weekly extinguisher visual check",
  fire_doors:       "Fire door check",
  fire_drill:       "Fire drill (6-monthly, with night staff)",
  fire_walk:        "Fire walk — escape route sign-off",
  alarm_panel:      "Alarm panel check",
  emergency_lights_annual: "Annual 3-hour emergency lighting discharge test",
  alarm_service:    "6-monthly fire alarm service",
  extinguisher_service: "Annual fire extinguisher service",
};

const CHECK_TYPE_GROUPS: { label: string; types: AnyCheckType[] }[] = [
  {
    label: "Regular checks",
    types: ["alarm", "emergency_lights", "extinguishers", "fire_doors"],
  },
  {
    label: "Walkthroughs & drills",
    types: ["fire_walk", "fire_drill"],
  },
];

/**
 * Checks no longer recorded here (the server's RETIRED_FIRE_CHECK_TYPES): the
 * alarm panel is on the premises opening and closing checks, and the
 * contractor services are their compliance checks, shown on this page by
 * TrackContractorChecks. Older records still show in the history and can be
 * filtered.
 */
const RETIRED_CHECK_GROUP: { label: string; types: AnyCheckType[] } = {
  label: "No longer recorded here",
  types: ["alarm_panel", "alarm_service", "extinguisher_service", "emergency_lights_annual"],
};

/** How often, in words, for the status cards. */
function frequencyLabel(days: number): string {
  if (days === 1) return "Daily";
  if (days === 7) return "Weekly";
  if (days === 14) return "Fortnightly";
  if (days === 30) return "Monthly";
  if (days === 90) return "Quarterly";
  if (days === 180) return "At least every 6 months";
  if (days === 365) return "Annual";
  return `Every ${days} days`;
}

// ── Night staff (fire drills) ─────────────────────────────────────────────────

type NightStaff = "included" | "not_included" | "no_night_staff";

// Button labels: the question is "Night staff included?".
const NIGHT_STAFF_OPTIONS: Record<NightStaff, string> = {
  included: "Yes",
  not_included: "No",
  no_night_staff: "N/A",
};

// History wording, after "Night staff included:".
const NIGHT_STAFF_LABELS: Record<NightStaff, string> = {
  included: "Yes",
  not_included: "No",
  no_night_staff: "N/A (no night staff at this site)",
};

function NightStaffPicker({ value, onChange, optional }: { value: NightStaff | null; onChange: (v: NightStaff) => void; optional?: boolean }) {
  return (
    <div className="space-y-2 border border-border rounded-sm p-3 bg-muted/20">
      <div className="flex items-center gap-2">
        <Moon className="w-4 h-4 text-primary flex-shrink-0" />
        <p className="text-sm font-medium">Night staff included? {optional && <span className="text-muted-foreground text-xs font-normal">optional</span>}</p>
      </div>
      <p className="text-xs text-muted-foreground">Drills are due at least every 6 months and should include night staff.</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Night staff included">
        {(Object.keys(NIGHT_STAFF_OPTIONS) as NightStaff[]).map(option => (
          <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}
            data-testid={`night-staff-${option}`}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-sm border transition-colors",
              value === option
                ? option === "not_included" ? "bg-amber-500 border-amber-500 text-white" : "bg-primary border-primary text-primary-foreground"
                : "bg-background text-muted-foreground border-border hover:border-primary/50",
            )}>
            {NIGHT_STAFF_OPTIONS[option]}
          </button>
        ))}
      </div>
      {value === "not_included" && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-sm px-2 py-1.5">
          Plan the next drill so night staff take part.
        </p>
      )}
      {value === "no_night_staff" && (
        <p className="text-xs text-muted-foreground">N/A: this site has no night staff.</p>
      )}
    </div>
  );
}

// Drill notes are required: what needs to improve, or that nothing does.
const DRILL_NOTES_LABEL = "Improvements required / notes";
const DRILL_NOTES_PLACEHOLDER = "e.g. Fire door on the first floor was slow to close; everyone used the nearest exit";

// ── Emergency lighting ────────────────────────────────────────────────────────

function FlickTestGuide() {
  return (
    <div className="flex gap-2 border border-border rounded-sm p-3 bg-muted/20 text-xs text-muted-foreground">
      <Lightbulb className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
      <p>
        <span className="font-medium text-foreground">Monthly 5 minute flick test.</span> Switch the emergency lighting
        to test for 5 minutes and check every fitting lights. Record Fail and note which fittings if any do not.
      </p>
    </div>
  );
}

// ── Call points (weekly alarm tests) ──────────────────────────────────────────

/** A call point's name, plus its location when the name does not already say it. */
function callPointLabel(point: Pick<FireCallPoint, "name" | "location">): string {
  const location = point.location?.trim();
  if (!location || point.name.toLowerCase().includes(location.toLowerCase())) return point.name;
  return `${point.name} – ${location}`;
}

function lastTestedText(point: FireCallPoint) {
  return point.lastTestedDate ? `last tested ${format(new Date(point.lastTestedDate), "dd/MM/yyyy")}` : "not tested yet";
}

function callPointSiteParam(siteId: number | undefined | null) {
  return { siteId: siteId ? String(siteId) : "none" };
}

/**
 * Pick the call point used for this week's alarm test. With a list set up for
 * the site, the next one in the site's rotation order (after the one tested
 * last) is picked for you, and any other can still be chosen; without a list,
 * the call point is typed in. With no site chosen at a
 * business that has sites, every site's call points are listed and picking
 * one sets the test's site.
 */
function CallPointPicker({
  siteId, sites, open, callPointId, callPoint, onChange, onSiteChange, optional, keepId,
}: {
  siteId: number | undefined;
  sites: { id: number; name: string }[] | undefined;
  open: boolean;
  callPointId: number | null;
  callPoint: string;
  /** `sleepingArea` is set when a call point is picked from the list. */
  onChange: (value: { callPointId: number | null; callPoint: string; sleepingArea?: boolean }) => void;
  onSiteChange: (siteId: number | undefined) => void;
  optional?: boolean;
  /** An archived call point already on this record stays selectable. */
  keepId?: number | null;
}) {
  const anySite = siteId === undefined && (sites?.length ?? 0) > 0;
  const params = anySite ? { includeArchived: "true" as const } : { ...callPointSiteParam(siteId), includeArchived: "true" as const };
  const { data: allPoints, isLoading } = useListFireCallPoints(params, {
    query: { enabled: open, queryKey: getListFireCallPointsQueryKey(params) },
  });
  const points = (allPoints ?? []).filter(p => !p.archivedAt || p.id === keepId);
  const active = points.filter(p => !p.archivedAt);
  const suggested = anySite ? undefined : active.find(p => p.nextInTurn) ?? active[0];
  const behind = active.filter(p => p.notTestedThisRound && p.id !== callPointId);
  const siteName = (id: number | null) => sites?.find(site => site.id === id)?.name ?? "No specific site";

  // Suggest the next call point in the rotation when nothing is chosen yet.
  useEffect(() => {
    if (!open || optional || callPointId != null || callPoint || !suggested) return;
    onChange({ callPointId: suggested.id, callPoint: callPointLabel(suggested), sleepingArea: suggested.sleepingArea ?? false });
  }, [open, suggested?.id, callPointId, callPoint]);

  return (
    <div className="space-y-2 border border-border rounded-sm p-3 bg-muted/20">
      <div className="flex items-center gap-2">
        <BellRing className="w-4 h-4 text-primary flex-shrink-0" />
        <p className="text-sm font-medium">Call point tested {optional && <span className="text-muted-foreground text-xs font-normal">optional</span>}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Test the alarm weekly from a different call point each time.{suggested ? " The next one in your order is picked for you; choose another if you used a different one." : ""}
      </p>
      {isLoading ? null : points.length > 0 ? (
        <Select value={callPointId ? String(callPointId) : ""}
          onValueChange={v => {
            const p = points.find(x => String(x.id) === v);
            if (!p) return;
            onChange({ callPointId: p.id, callPoint: callPointLabel(p), sleepingArea: p.sleepingArea ?? false });
            if (anySite) onSiteChange(p.siteId ?? undefined);
          }}>
          <SelectTrigger className="rounded-sm" data-testid="select-call-point"><SelectValue placeholder="Choose the call point" /></SelectTrigger>
          <SelectContent>
            {points.map(p => (
              <SelectItem key={p.id} value={String(p.id)}>
                {callPointLabel(p)}{anySite ? ` (${siteName(p.siteId)})` : ""} · {lastTestedText(p)}
                {p.nextInTurn && !p.archivedAt ? " · next in turn" : ""}{p.archivedAt ? " · archived" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Input value={callPoint} onChange={e => onChange({ callPointId: null, callPoint: e.target.value })}
            placeholder='e.g. "CP3 – First floor fire exit"' className="rounded-sm" data-testid="input-call-point" />
          <p className="text-xs text-muted-foreground">Managers can list this site's call points under Template, Call points.</p>
        </>
      )}
      {!anySite && behind.length > 0 && (
        <p className="text-xs text-amber-800" data-testid="call-points-behind">
          Not tested in the last full round: {behind.map(callPointLabel).join(", ")}.
        </p>
      )}
    </div>
  );
}

/** "Next in turn" and "not tested this round" tags for a call point in use. */
function RotationTags({ point }: { point: FireCallPoint }) {
  return (
    <>
      {point.nextInTurn && <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/40 text-primary shrink-0">Next in turn</Badge>}
      {point.notTestedThisRound && point.lastTestedDate && !point.nextInTurn && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-300 bg-amber-50 text-amber-800 shrink-0">
          Not tested this round
        </Badge>
      )}
    </>
  );
}

/**
 * A site's call points in test order. Managers add, rename, set the location,
 * move them up or down the rotation, archive or restore them, or upload a list.
 */
function CallPointsEditor({ siteId, enabled }: { siteId: number | null; enabled: boolean }) {
  const params = { ...callPointSiteParam(siteId), includeArchived: "true" as const };
  const { data: points } = useListFireCallPoints(params, { query: { enabled, queryKey: getListFireCallPointsQueryKey(params) } });
  const createPoint = useCreateFireCallPoint();
  const updatePoint = useUpdateFireCallPoint();
  const orderPoints = useOrderFireCallPoints();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newName, setNewName] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [editing, setEditing] = useState<Record<number, { name: string; location: string }>>({});
  const [walkRoundOpen, setWalkRoundOpen] = useState(false);
  const clientApiFetch = useActiveClientApi();
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListFireCallPointsQueryKey().slice(0, 1) });
  const fail = (err: any) => toast({ title: "Call point not saved", description: err.message, variant: "destructive" });

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    createPoint.mutate({ data: { siteId, name, location: newLocation.trim() || null } }, {
      onSuccess: () => { setNewName(""); setNewLocation(""); refresh(); },
      onError: fail,
    });
  };
  const save = (point: FireCallPoint, data: { name?: string; location?: string | null; sleepingArea?: boolean; archived?: boolean }) =>
    updatePoint.mutate({ id: point.id, data }, {
      onSuccess: () => { setEditing(({ [point.id]: _, ...rest }) => rest); refresh(); },
      onError: fail,
    });

  const active = (points ?? []).filter(p => !p.archivedAt);
  const archived = (points ?? []).filter(p => p.archivedAt);
  const move = (index: number, by: -1 | 1) => {
    const ids = active.map(p => p.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    // Show the new order straight away; the saved list replaces it.
    queryClient.setQueryData<FireCallPoint[]>(getListFireCallPointsQueryKey(params), current =>
      current ? [...ids.map(id => current.find(p => p.id === id)!), ...current.filter(p => p.archivedAt)] : current);
    orderPoints.mutate({ data: { siteId, ids } }, { onSettled: refresh, onError: fail });
  };
  // A walk round is saved like an uploaded list: new call points join the
  // end of the order as spoken, and ones already listed get the new location.
  const saveWalkRound = async (walked: WalkRoundPoint[]) => {
    const response = await clientApiFetch("/imports/fire-call-points", {
      method: "POST",
      body: JSON.stringify({ headers: ["Call point", "Location"], rows: walked.map(p => [p.name, p.location]), siteId, preview: false }),
    });
    const body = await response.json().catch(() => null) as { error?: string; rows?: Array<{ label: string; action: string; reasons: string[] }> } | null;
    if (!response.ok) {
      const bad = body?.rows?.find(row => row.action === "error");
      return bad ? `${bad.label}: ${bad.reasons.join("; ")}` : body?.error ?? "The call points could not be saved";
    }
    await refresh();
    toast({ title: "Call points saved", description: `${walked.length} from your walk round.` });
    return null;
  };
  const draft = (point: FireCallPoint) => editing[point.id] ?? { name: point.name, location: point.location ?? "" };
  const changed = (point: FireCallPoint) => {
    const value = editing[point.id];
    return !!value && !!value.name.trim() && (value.name.trim() !== point.name || value.location.trim() !== (point.location ?? ""));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setWalkRoundOpen(true)} data-testid="button-walk-round-call-points">
          <Footprints className="mr-1 h-4 w-4" /> Walk round and speak
        </Button>
        <ImportCsvButton type="fire-call-points" siteId={siteId} label="Upload a list" onImported={refresh} />
      </div>
      <WalkRoundDialog open={walkRoundOpen} onClose={() => setWalkRoundOpen(false)} kind="call_point"
        title="Walk round and speak: call points" prefix="CP"
        examples={["This is call point 1, by the front door", "Call point 2, kitchen fire exit"]}
        existingNames={(points ?? []).map(p => p.name)} onSave={saveWalkRound} />
      {active.length === 0 && <p className="text-xs text-muted-foreground italic">No call points listed yet. Add them below in the order you want them tested, or upload a list.</p>}
      {active.length > 0 && <p className="text-[11px] text-muted-foreground">Tested in this order, from the top. Use the arrows to change it.</p>}
      {active.map((point, index) => (
        <div key={point.id} className="rounded-sm border border-border p-2 space-y-1.5" data-testid={`call-point-row-${point.id}`}>
          <div className="flex gap-2 items-center">
            <span className="text-xs font-medium text-muted-foreground w-5 text-right shrink-0">{index + 1}.</span>
            <Input value={draft(point).name} className="h-8 text-sm rounded-sm flex-1 min-w-0" aria-label="Call point name"
              onChange={e => setEditing(current => ({ ...current, [point.id]: { ...draft(point), name: e.target.value } }))} />
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" title="Move up" aria-label="Move up"
              disabled={index === 0 || orderPoints.isPending} onClick={() => move(index, -1)}>
              <ChevronUp className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" title="Move down" aria-label="Move down"
              disabled={index === active.length - 1 || orderPoints.isPending} onClick={() => move(index, 1)}>
              <ChevronDown className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" title="Archive (kept on past tests)" aria-label="Archive"
              onClick={() => save(point, { archived: true })}>
              <Archive className="w-3.5 h-3.5 text-muted-foreground" />
            </Button>
          </div>
          <div className="flex gap-2 items-center pl-7">
            <Input value={draft(point).location} placeholder="Location, e.g. Kitchen fire exit, ground floor" aria-label="Location"
              className="h-8 text-xs rounded-sm flex-1 min-w-0"
              onChange={e => setEditing(current => ({ ...current, [point.id]: { ...draft(point), location: e.target.value } }))} />
            {changed(point) && (
              <Button variant="outline" size="sm" className="h-8 px-2 text-xs shrink-0" title="Save"
                onClick={() => save(point, { name: editing[point.id].name.trim(), location: editing[point.id].location.trim() || null })}>
                <Check className="w-3.5 h-3.5 mr-1 text-emerald-700" /> Save
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 items-center pl-7 text-[11px] text-muted-foreground">
            <span>{point.lastTestedDate ? `Tested ${format(new Date(point.lastTestedDate), "dd/MM/yyyy")}` : "Not tested yet"}</span>
            <RotationTags point={point} />
            <label className="ml-auto flex items-center gap-1.5 cursor-pointer" title={`The alarm must reach ${SOUND_LEVEL_MIN_DB.bedhead} dB at the bedhead`}>
              <Checkbox checked={!!point.sleepingArea} disabled={updatePoint.isPending} aria-label="Near a sleeping area"
                data-testid={`checkbox-sleeping-area-${point.id}`}
                onCheckedChange={checked => save(point, { sleepingArea: checked === true })} />
              Sleeping area ({SOUND_LEVEL_MIN_DB.bedhead} dB)
            </label>
          </div>
        </div>
      ))}
      <div className="rounded-sm border border-dashed border-border p-2 space-y-1.5">
        <div className="flex gap-2">
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder='Call point, e.g. "CP1"' aria-label="New call point"
            className="h-8 text-sm rounded-sm flex-1 min-w-0" onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <Button variant="outline" size="sm" onClick={add} disabled={!newName.trim() || createPoint.isPending}>
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
          </Button>
        </div>
        <Input value={newLocation} onChange={e => setNewLocation(e.target.value)} placeholder="Location, e.g. Reception, main entrance" aria-label="New call point location"
          className="h-8 text-xs rounded-sm" onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <p className="text-[11px] text-muted-foreground">New call points go to the end of the order.</p>
      </div>
      {archived.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-border">
          <p className="text-xs font-medium text-muted-foreground">Archived (kept on past tests)</p>
          {archived.map(point => (
            <div key={point.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex-1">{callPointLabel(point)}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => save(point, { archived: false })}>
                <RotateCcw className="w-3 h-3 mr-1" /> Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The weekly alarm test rotation on the FireTrack page: which call point is
 * next at each site, and which have fallen behind (never tested, or not
 * within one full round).
 */
function CallPointRotationCard({ siteId, sites, enabled }: {
  siteId: number | undefined; sites: { id: number; name: string }[] | undefined; enabled: boolean;
}) {
  const params = siteId ? { siteId: String(siteId) } : {};
  const { data: points } = useListFireCallPoints(params, { query: { enabled, queryKey: getListFireCallPointsQueryKey(params) } });
  if (!points?.length) return null;
  const groups = new Map<number | null, FireCallPoint[]>();
  for (const point of points) groups.set(point.siteId ?? null, [...(groups.get(point.siteId ?? null) ?? []), point]);
  const showSite = groups.size > 1 || (sites?.length ?? 0) > 1;
  return (
    <Card data-testid="call-point-rotation">
      <CardHeader className="border-b border-border/50 pb-3">
        <div className="flex items-center gap-2">
          <BellRing className="w-4 h-4 text-primary" />
          <CardTitle className="text-base font-display font-bold">Alarm test call points</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-3 text-sm">
        {[...groups.entries()].map(([groupSite, sitePoints]) => {
          const next = sitePoints.find(p => p.nextInTurn);
          const behind = sitePoints.filter(p => p.notTestedThisRound && !p.nextInTurn);
          return (
            <div key={groupSite ?? "none"} className="space-y-0.5">
              {showSite && <p className="text-xs font-semibold text-muted-foreground">{sites?.find(site => site.id === groupSite)?.name ?? "No specific site"}</p>}
              {next && <p><span className="font-medium">Next to test:</span> {callPointLabel(next)} <span className="text-xs text-muted-foreground">({lastTestedText(next)})</span></p>}
              {behind.length > 0 && (
                <p className="text-xs text-amber-800">
                  Waiting longest (not tested in the last {sitePoints.length} alarm tests): {behind.map(p => `${callPointLabel(p)} (${lastTestedText(p)})`).join(", ")}
                </p>
              )}
              {sitePoints.every(p => !p.notTestedThisRound) && (
                <p className="text-xs text-muted-foreground">Every call point has been tested in the last full round.</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

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

function StatusBadge({ status, lastResult }: { status: "ok" | "due_soon" | "overdue" | "never"; lastResult?: string | null }) {
  if (lastResult === "fail") return (
    <Badge variant="outline" className="bg-red-100 text-red-800 border-red-300">
      <XCircle className="w-3 h-3 mr-1" />Failed
    </Badge>
  );
  if (lastResult === "action_required") return (
    <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-300">
      <ShieldAlert className="w-3 h-3 mr-1" />Action needed
    </Badge>
  );
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
  const newRow = useFocusNewRow();
  function add() {
    newRow.expect();
    onChange([...routes, { name: "", status: "clear", note: "" }]);
  }
  function remove(i: number) {
    onChange(routes.filter((_, idx) => idx !== i));
  }
  function update(i: number, patch: Partial<EscapeRoute>) {
    onChange(routes.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }

  return (
    <div ref={newRow.ref} className="space-y-2">
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

function parseJsonRecord(raw: string | undefined | null, fallback: Record<string, number>): Record<string, number> {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : fallback;
  } catch { return fallback; }
}

const DEFAULT_FIRE_FREQUENCIES: Record<string, number> = {
  alarm: 7, emergency_lights: 30, extinguishers: 7, fire_doors: 90,
  fire_drill: 180, fire_walk: 7,
};

type FireProfileState = {
  riskAssessmentReference: string;
  riskAssessmentDate: string;
  nextReviewDate: string;
  responsiblePerson: string;
  ukNation: string;
  evacuationPeepArrangements: string;
  maintenanceEvidenceReference: string;
  defectClosureVerification: string;
};

function FireConfigDialog({ siteId }: { siteId?: number }) {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetFireSafetyConfig(siteId ? { siteId } : undefined);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateFireSafetyConfig();
  const { data: sites } = useListSites();
  const hasSites = (sites?.length ?? 0) > 0;
  const [callPointSite, setCallPointSite] = useState<number | undefined>(siteId);
  useEffect(() => { if (open) setCallPointSite(siteId ?? (sites?.length === 1 ? sites[0].id : undefined)); }, [open, siteId, sites]);

  const [defaultPerformer, setDefaultPerformer] = useState("");
  const [escapeRoutes, setEscapeRoutes] = useState<Array<{ name: string; location: string }>>([]);
  const newRow = useFocusNewRow();
  const [alarmZones, setAlarmZones] = useState<string[]>([]);
  const [extinguisherPoints, setExtinguisherPoints] = useState<string[]>([]);
  const [frequencyDays, setFrequencyDays] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(DEFAULT_FIRE_FREQUENCIES).map(([key, value]) => [key, String(value)])),
  );
  const [profile, setProfile] = useState<FireProfileState>({
    riskAssessmentReference: "", riskAssessmentDate: "", nextReviewDate: "",
    responsiblePerson: "", ukNation: "", evacuationPeepArrangements: "",
    maintenanceEvidenceReference: "", defectClosureVerification: "",
  });

  useEffect(() => {
    if (!config || !open) return;
    setDefaultPerformer(config.fire_default_performer ?? "");
    setEscapeRoutes(parseJsonArray<{ name: string; location: string }>(config.fire_escape_routes));
    setAlarmZones(parseJsonArray<string>(config.fire_alarm_zones));
    setExtinguisherPoints(parseJsonArray<string>(config.fire_extinguisher_points));
    const saved = parseJsonRecord(config.fire_frequency_days, DEFAULT_FIRE_FREQUENCIES);
    const savedProfile = config.controlProfile ?? {};
    setFrequencyDays(Object.fromEntries(Object.keys(DEFAULT_FIRE_FREQUENCIES).map(key => [key, String(savedProfile.frequencyDays?.[key] ?? saved[key] ?? DEFAULT_FIRE_FREQUENCIES[key])])));
    setProfile({
      riskAssessmentReference: savedProfile.riskAssessmentReference ?? "",
      riskAssessmentDate: savedProfile.riskAssessmentDate ?? "",
      nextReviewDate: savedProfile.nextReviewDate ?? "",
      responsiblePerson: savedProfile.responsiblePerson ?? "",
      ukNation: savedProfile.ukNation ?? "",
      evacuationPeepArrangements: savedProfile.evacuationPeepArrangements ?? "",
      maintenanceEvidenceReference: savedProfile.maintenanceEvidenceReference ?? "",
      defectClosureVerification: savedProfile.defectClosureVerification ?? "",
    });
  }, [config, open]);

  const handleSave = () => {
    const numericFrequencies = Object.fromEntries(Object.entries(frequencyDays).map(([key, value]) => [key, Math.max(1, Number(value) || DEFAULT_FIRE_FREQUENCIES[key])]));
    updateConfig.mutate(
      {
        data: {
          fire_default_performer: defaultPerformer,
          fire_escape_routes: JSON.stringify(escapeRoutes.filter(r => r.name || r.location)),
          fire_alarm_zones: JSON.stringify(alarmZones.filter(Boolean)),
          fire_extinguisher_points: JSON.stringify(extinguisherPoints.filter(Boolean)),
          ...(siteId ? { controlProfile: { ...profile, frequencyDays: numericFrequencies } } : { fire_frequency_days: JSON.stringify(numericFrequencies) }),
        } as any,
        params: siteId ? { siteId } : undefined,
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
           <TabsList className="shrink-0 w-full grid grid-cols-3 sm:grid-cols-4 h-auto">
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
            <TabsTrigger value="callpoints" data-testid="tab-fire-call-points">Call points</TabsTrigger>
            <TabsTrigger value="routes">Escape Routes</TabsTrigger>
            <TabsTrigger value="zones">Alarm Zones</TabsTrigger>
            <TabsTrigger value="ext">Extinguishers</TabsTrigger>
             <TabsTrigger value="controls">Controls</TabsTrigger>
             <TabsTrigger value="audit" data-testid="tab-fire-audit">Audit log</TabsTrigger>
          </TabsList>

          <TabsContent value="defaults" className="flex-1 overflow-y-auto space-y-4 pt-4 px-1">
            <div className="space-y-1.5">
              <Label>Default performed by</Label>
              <Input value={defaultPerformer} onChange={e => setDefaultPerformer(e.target.value)}
                placeholder="e.g. Fire Marshal on duty" className="rounded-sm" />
              <p className="text-xs text-muted-foreground">Pre-fills the "Performed by" field on every new check.</p>
            </div>
             <div className="space-y-2">
               <Label>Risk-assessed check frequencies (days)</Label>
               <p className="text-xs text-muted-foreground">These are local control intervals, not universal statutory requirements.</p>
               <div className="grid grid-cols-2 gap-2">
                 {Object.entries(DEFAULT_FIRE_FREQUENCIES).map(([key, fallback]) => (
                   <div key={key} className="space-y-1">
                     <Label className="text-xs">{CHECK_TYPE_LABELS[key as AnyCheckType]}</Label>
                     <Input type="number" min={1} max={3650} value={frequencyDays[key] ?? fallback}
                       onChange={e => setFrequencyDays(current => ({ ...current, [key]: e.target.value }))} className="h-8 rounded-sm" />
                   </div>
                 ))}
               </div>
             </div>
          </TabsContent>
           <TabsContent value="controls" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
             {!siteId && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-sm p-2">Choose a site in the history filter to save a site-specific control profile.</p>}
             <p className="text-xs text-muted-foreground">Record the site evidence references used by the responsible person and inspector.</p>
             {([
               ["riskAssessmentReference", "Fire risk assessment reference"],
               ["riskAssessmentDate", "Assessment date"],
               ["nextReviewDate", "Next review date"],
               ["responsiblePerson", "Responsible person and role"],
               ["evacuationPeepArrangements", "Evacuation / PEEP arrangements"],
               ["maintenanceEvidenceReference", "Maintenance evidence reference"],
               ["defectClosureVerification", "Defect closure verification"],
             ] as const).map(([key, label]) => (
               <div key={key} className="space-y-1">
                 <Label>{label}</Label>
                 {key.toLowerCase().includes("date") ? (
                   <Input type="date" value={profile[key]} disabled={!siteId} onChange={e => setProfile(current => ({ ...current, [key]: e.target.value }))} />
                 ) : (
                   <Textarea rows={key === "evacuationPeepArrangements" || key === "defectClosureVerification" ? 3 : 1} value={profile[key]} disabled={!siteId}
                     onChange={e => setProfile(current => ({ ...current, [key]: e.target.value }))} />
                 )}
               </div>
             ))}
             <div className="space-y-1">
               <Label>UK nation</Label>
               <Select value={profile.ukNation || "none"} disabled={!siteId} onValueChange={value => setProfile(current => ({ ...current, ukNation: value === "none" ? "" : value }))}>
                 <SelectTrigger><SelectValue placeholder="Select nation" /></SelectTrigger>
                 <SelectContent><SelectItem value="none">Not set</SelectItem><SelectItem value="england">England</SelectItem><SelectItem value="northern_ireland">Northern Ireland</SelectItem><SelectItem value="scotland">Scotland</SelectItem><SelectItem value="wales">Wales</SelectItem></SelectContent>
               </Select>
             </div>
           </TabsContent>

          <TabsContent value="routes" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List your named escape routes. They'll be pre-loaded when recording a fire walk so staff just mark each one clear or obstructed.
            </p>
            <div ref={newRow.ref} className="space-y-2">
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
              <Button variant="outline" size="sm" onClick={() => { newRow.expect(); setEscapeRoutes([...escapeRoutes, { name: "", location: "" }]); }}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add route
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="callpoints" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List this site's manual (break glass) call points and where each one is, in the order you want them tested. Each weekly alarm test records the one used, and the next one in your order is picked for you so every call point gets tested in turn.
            </p>
            {hasSites && (
              <Select value={callPointSite ? String(callPointSite) : ""} onValueChange={v => setCallPointSite(Number(v))}>
                <SelectTrigger className="rounded-sm" data-testid="select-call-point-site"><SelectValue placeholder="Choose a site" /></SelectTrigger>
                <SelectContent>
                  {sites!.map(site => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {hasSites && !callPointSite ? (
              <p className="text-xs text-muted-foreground italic">Choose a site to list its call points.</p>
            ) : (
              <>
                <CallPointsEditor key={callPointSite ?? "none"} siteId={callPointSite ?? null} enabled={open} />
                <p className="text-[11px] text-muted-foreground">Changes save straight away. Archived call points stay on the tests that used them.</p>
              </>
            )}
          </TabsContent>

          <TabsContent value="zones" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List your alarm panel zones, for reference (the panel itself is checked on the premises opening and closing checks).
            </p>
            <StringListEditor items={alarmZones} onChange={setAlarmZones} placeholder='e.g. "Zone 1 — Ground floor"' />
          </TabsContent>

          <TabsContent value="ext" className="flex-1 overflow-y-auto space-y-3 pt-4 px-1">
            <p className="text-xs text-muted-foreground">
              List your extinguisher locations. Used as reference during extinguisher visual checks.
            </p>
            <StringListEditor items={extinguisherPoints} onChange={setExtinguisherPoints} placeholder='e.g. "Reception — CO₂"' />
          </TabsContent>
          <TabsContent value="audit" className="flex-1 overflow-y-auto pt-4 px-1"><AuditLog module="fire" /></TabsContent>
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
  preset,
}: {
  siteId?: number;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  defaultCheckType?: AnyCheckType;
  /** Filled in from a scanned QR label: its site, call point or extinguisher location. */
  preset?: { siteId?: number; callPointId?: number; location?: string };
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
  const [staffRosterId, setStaffRosterId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [selectedSite, setSelectedSite] = useState<number | undefined>(siteId);

  // Weekly alarm test: the call point used. Drills: whether night staff took part.
  const [callPointChoice, setCallPointChoice] = useState<{ callPointId: number | null; callPoint: string }>({ callPointId: null, callPoint: "" });
  const [nightStaff, setNightStaff] = useState<NightStaff | null>(null);
  // Drills: the time of the drill, how long the evacuation took and who was there.
  const [drillTime, setDrillTime] = useState("");
  const [evacuation, setEvacuation] = useState<EvacuationValue>(EMPTY_EVACUATION);
  const [staffPresentIds, setStaffPresentIds] = useState<number[]>([]);
  const [soundLevel, setSoundLevel] = useState<SoundLevelValue>(EMPTY_SOUND_LEVEL);
  // A call point near a sleeping area sets the 75 dB bedhead limit.
  const chooseCallPoint = (value: { callPointId: number | null; callPoint: string; sleepingArea?: boolean }) => {
    setCallPointChoice({ callPointId: value.callPointId, callPoint: value.callPoint });
    if (value.sleepingArea !== undefined) setSoundLevel(current => ({ ...current, bedhead: value.sleepingArea! }));
  };
  // A call point belongs to one site, so choosing another site clears it.
  const changeSite = (value: number | undefined) => {
    if (value !== selectedSite) setCallPointChoice({ callPointId: null, callPoint: "" });
    setSelectedSite(value);
  };

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

  useEffect(() => {
    if (!open || !preset) return;
    if (preset.siteId !== undefined) setSelectedSite(preset.siteId);
    if (preset.callPointId) setCallPointChoice({ callPointId: preset.callPointId, callPoint: "" });
    if (preset.location) setLocation(preset.location);
  }, [open, preset]);

  // A business with one site records against it, so its call point list applies.
  useEffect(() => {
    if (open && selectedSite === undefined && sites?.length === 1) setSelectedSite(sites[0].id);
  }, [open, sites]);

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
    setCallPointChoice({ callPointId: null, callPoint: "" }); setNightStaff(null); setSoundLevel(EMPTY_SOUND_LEVEL);
    setDrillTime(""); setEvacuation(EMPTY_EVACUATION); setStaffPresentIds([]);
  }

  const missing = checkType === "alarm" && !callPointChoice.callPointId && !callPointChoice.callPoint.trim()
    ? "Choose the call point tested"
    : checkType === "alarm" && soundLevel.db.trim() && parseSoundLevel(soundLevel.db) === null ? "Enter a sound level between 20 and 140 dB"
    : checkType === "fire_drill" && !drillTime ? "Give the time of the drill"
    : checkType === "fire_drill" && parseEvacuation(evacuation) === null ? "Give the time taken to evacuate"
    : checkType === "fire_drill" && !nightStaff ? "Say whether night staff were included (Yes, No or N/A)"
    : checkType === "fire_drill" && !notes.trim() ? "Write the improvements required, or notes" : null;

  const handleSubmit = async () => {
    const data: CreateFireSafetyCheckRequest & { staffRosterId?: number | null } = {
      checkType: checkType as FireCheckType,
      checkDate,
      result: effectiveResult,
      siteId: selectedSite,
      location: location || undefined,
      performedBy: performedBy || null,
      staffRosterId: staffRosterId,
      notes: buildNotes(),
      ...(checkType === "alarm" ? {
        callPointId: callPointChoice.callPointId,
        callPoint: callPointChoice.callPointId ? null : callPointChoice.callPoint.trim(),
        ...soundLevelRequest(soundLevel),
      } : {}),
      ...(checkType === "fire_drill" ? {
        nightStaff, drillTime, evacuationSeconds: parseEvacuation(evacuation), staffPresentIds,
      } : {}),
    };
    createCheck.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListFireCallPointsQueryKey().slice(0, 1) });
          queryClient.invalidateQueries({ queryKey: getGetFireDrillAttendanceQueryKey().slice(0, 1) });
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
          <DialogTitle className="font-display font-bold">Record Fire Safety Check</DialogTitle>
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
                    {sortByLabel(g.types, k => CHECK_TYPE_LABELS[k]).map(k => (
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
              <StaffPerformerSelect value={performedBy} onChange={setPerformedBy} onRosterIdChange={setStaffRosterId} siteId={selectedSite} includeRoster={false} optional />
            </div>
          </div>

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site <span className="text-muted-foreground text-xs">optional</span></Label>
              <Select value={selectedSite ? String(selectedSite) : "none"} onValueChange={v => changeSite(v === "none" ? undefined : Number(v))}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {checkType === "alarm" && (
            <>
              <CallPointPicker siteId={selectedSite} sites={sites} open={open} callPointId={callPointChoice.callPointId}
                callPoint={callPointChoice.callPoint} onChange={chooseCallPoint} onSiteChange={setSelectedSite} />
              <SoundLevelField value={soundLevel} onChange={setSoundLevel} />
            </>
          )}

          {checkType === "emergency_lights" && <FlickTestGuide />}

          {checkType === "fire_drill" && (
            <>
              <DrillTimingFields drillTime={drillTime} onDrillTimeChange={setDrillTime} evacuation={evacuation} onEvacuationChange={setEvacuation} />
              <NightStaffPicker value={nightStaff} onChange={setNightStaff} />
              <DrillStaffPicker siteId={selectedSite} value={staffPresentIds} onChange={setStaffPresentIds} />
            </>
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

          {checkType !== "fire_walk" && checkType !== "alarm_panel" && checkType !== "alarm" && (
            <div className="space-y-1.5">
              <Label>Location <span className="text-muted-foreground text-xs">optional</span></Label>
              <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Ground floor near kitchen" className="rounded-sm" />
            </div>
          )}

          {checkType === "fire_drill" ? (
            <div className="space-y-1.5">
              <Label htmlFor="drill-notes">{DRILL_NOTES_LABEL}</Label>
              <Textarea id="drill-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="rounded-sm"
                placeholder={DRILL_NOTES_PLACEHOLDER} data-testid="input-drill-notes" />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>{checkType === "fire_walk" || checkType === "alarm_panel" ? "Additional notes" : "Notes"} <span className="text-muted-foreground text-xs">optional</span></Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="rounded-sm" />
            </div>
          )}
        </div>
        <DialogFooter className="items-center">
          {missing && <p className="text-xs text-muted-foreground sm:mr-auto">{missing}</p>}
          <Button variant="outline" onClick={() => { reset(); setOpen(false); }}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={createCheck.isPending || !!missing}>
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
  const [staffRosterId, setStaffRosterId] = useState<number | null>((check as any).staffRosterId ?? null);
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
  const isAlarm = checkType === "alarm";
  const isDrill = checkType === "fire_drill";

  // Records saved before these fields existed may stay blank; a recorded
  // answer can be changed but not removed.
  const [callPointChoice, setCallPointChoice] = useState({ callPointId: check.callPointId ?? null, callPoint: check.callPoint ?? "" });
  const [nightStaff, setNightStaff] = useState<NightStaff | null>((check.nightStaff as NightStaff | null) ?? null);
  const [drillTime, setDrillTime] = useState(check.drillTime ?? "");
  const [evacuation, setEvacuation] = useState<EvacuationValue>(evacuationFromSeconds(check.evacuationSeconds));
  const recordedStaff = useMemo(() => check.staffPresent ?? [], [check.staffPresent]);
  const [staffPresentIds, setStaffPresentIds] = useState<number[]>(
    recordedStaff.flatMap(person => person.staffRosterId != null ? [person.staffRosterId] : []));
  const drillIncomplete = isDrill && (
    (!!check.drillTime && !drillTime)
    || (!evacuationIsBlank(evacuation) && parseEvacuation(evacuation) === null)
    || (check.evacuationSeconds != null && evacuationIsBlank(evacuation))
    || (!!check.notes?.trim() && !notes.trim()));
  const [soundLevel, setSoundLevel] = useState<SoundLevelValue>(check.soundLevelDb == null ? EMPTY_SOUND_LEVEL : {
    db: String(check.soundLevelDb), method: check.soundLevelMethod === "phone" ? "phone" : "meter", bedhead: !!check.soundLevelBedhead,
  });
  const chooseCallPoint = (value: { callPointId: number | null; callPoint: string; sleepingArea?: boolean }) => {
    setCallPointChoice({ callPointId: value.callPointId, callPoint: value.callPoint });
    // Only a call point chosen here changes the limit; the stored one stays as recorded.
    if (value.sleepingArea !== undefined && value.callPointId !== check.callPointId) {
      setSoundLevel(current => ({ ...current, bedhead: value.sleepingArea! }));
    }
  };
  const soundLevelInvalid = isAlarm && !!soundLevel.db.trim() && parseSoundLevel(soundLevel.db) === null;
  const changeSite = (value: number | undefined) => {
    if (value !== selectedSite && callPointChoice.callPointId) setCallPointChoice({ callPointId: null, callPoint: "" });
    setSelectedSite(value);
  };

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
          // null (not undefined) so clearing a field on edit actually clears it
          siteId: selectedSite ?? null, location: location || null,
           performedBy: performedBy || null, staffRosterId: staffRosterId, notes: buildNotes() ?? null,
          ...(isAlarm ? {
            callPointId: callPointChoice.callPointId,
            callPoint: callPointChoice.callPointId ? null : callPointChoice.callPoint.trim() || null,
            ...soundLevelRequest(soundLevel),
          } : {}),
          ...(isDrill ? {
            nightStaff, drillTime: drillTime || null, evacuationSeconds: parseEvacuation(evacuation), staffPresentIds,
          } : {}),
        } as any,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListFireSafetyChecksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetFireSafetyStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListFireCallPointsQueryKey().slice(0, 1) });
          queryClient.invalidateQueries({ queryKey: getGetFireDrillAttendanceQueryKey().slice(0, 1) });
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
          <DialogTitle className="font-display font-bold">
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
              <StaffPerformerSelect value={performedBy} onChange={setPerformedBy} onRosterIdChange={setStaffRosterId} siteId={selectedSite} includeRoster={false} />
            </div>
          </div>

          {sites && sites.length > 0 && (
            <div className="space-y-1.5">
              <Label>Site</Label>
              <Select value={selectedSite ? String(selectedSite) : "none"} onValueChange={v => changeSite(v === "none" ? undefined : Number(v))}>
                <SelectTrigger className="rounded-sm"><SelectValue placeholder="All sites" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific site</SelectItem>
                  {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {isAlarm && (
            <CallPointPicker siteId={selectedSite} sites={sites} open={open} callPointId={callPointChoice.callPointId}
              callPoint={callPointChoice.callPoint} onChange={chooseCallPoint} onSiteChange={setSelectedSite}
              optional={!check.callPoint} keepId={check.callPointId} />
          )}
          {isAlarm && <SoundLevelField value={soundLevel} onChange={setSoundLevel} />}

          {isDrill && (
            <>
              <DrillTimingFields drillTime={drillTime} onDrillTimeChange={setDrillTime} evacuation={evacuation} onEvacuationChange={setEvacuation}
                optional={!check.drillTime && check.evacuationSeconds == null} />
              <NightStaffPicker value={nightStaff} onChange={setNightStaff} optional={!check.nightStaff} />
              <DrillStaffPicker siteId={selectedSite} value={staffPresentIds} onChange={setStaffPresentIds} recorded={recordedStaff} />
            </>
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
              {(!isAlarm || check.location) && (
                <div className="space-y-1.5">
                  <Label>{isAlarm ? "Location / Call Point" : "Location"}</Label>
                  <Input value={location} onChange={e => setLocation(e.target.value)} className="rounded-sm" />
                </div>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <Label>{isDrill ? DRILL_NOTES_LABEL : isFireWalk || isPanel ? "Additional notes" : "Notes"}</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={isDrill ? 3 : 2} className="rounded-sm"
              placeholder={isDrill ? DRILL_NOTES_PLACEHOLDER : undefined} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={updateCheck.isPending || soundLevelInvalid
            || (isAlarm && !!check.callPoint && !callPointChoice.callPointId && !callPointChoice.callPoint.trim())
            || (isDrill && !!check.nightStaff && !nightStaff) || drillIncomplete}>
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
  // Viewers are read-only: recording, editing and deleting checks would 403.
  const canEdit = useCanEdit();
  const hasFiretrack = hasService("firetrack");

  const [filterType, setFilterType] = useState<AnyCheckType | "">("");
  const [filterSite, setFilterSite] = useState<number | undefined>(undefined);
  useSayItSite(filterSite);
  const [recordOpen, setRecordOpen] = useState(false);
  const [quickCheckType, setQuickCheckType] = useState<AnyCheckType | undefined>(undefined);
  const [scanPreset, setScanPreset] = useState<{ siteId?: number; callPointId?: number; location?: string }>();

  // A scanned QR label: a call point opens its weekly alarm test, an
  // extinguisher opens its weekly visual check at that location.
  useEffect(() => {
    const link = takeLinkParams(["open", "callPoint", "siteId", "location"] as const);
    if (!link) return;
    const siteId = Number(link.siteId);
    const site = Number.isSafeInteger(siteId) && siteId > 0 ? siteId : undefined;
    const callPointId = Number(link.callPoint);
    if (link.open === "alarm" && Number.isSafeInteger(callPointId) && callPointId > 0) {
      setScanPreset({ siteId: site, callPointId });
      setQuickCheckType("alarm");
      setRecordOpen(true);
    } else if (link.open === "extinguishers") {
      setScanPreset({ siteId: site, location: link.location?.slice(0, 200) });
      setQuickCheckType("extinguishers");
      setRecordOpen(true);
    }
  }, []);

  const { data: status, isLoading: statusLoading, error: statusError, refetch: refetchStatus } = useGetFireSafetyStatus(
    { siteId: filterSite },
    { query: { enabled: hasFiretrack, retry: (count, err: any) => err?.status !== 403 && count < 3, queryKey: getGetFireSafetyStatusQueryKey({ siteId: filterSite }) } }
  );
  const serverLocked = (statusError as any)?.status === 403;
  const { data: checks, isLoading: checksLoading, isError: checksFailed, refetch: refetchChecks } = useListFireSafetyChecks(
    { checkType: filterType as FireCheckType || undefined, siteId: filterSite },
    { query: { enabled: hasFiretrack, queryKey: getListFireSafetyChecksQueryKey({ checkType: filterType as FireCheckType || undefined, siteId: filterSite }) } }
  );
  const { data: sites } = useListSites({ query: { enabled: hasFiretrack, queryKey: getListSitesQueryKey() } });

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
                <h2 className="text-2xl font-display font-bold text-foreground mb-2">FireTrack</h2>
                <p className="text-muted-foreground mb-1">
                  Digital fire safety logbook — record checks, fire walks, drills and contractor services.
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
              Fire safety logbook: weekly alarm tests by call point, monthly emergency lighting, 6-monthly drills and fire walks, with your contractor services
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canAdmin && <FireConfigDialog siteId={filterSite} />}
            {canEdit && <RecordCheckDialog siteId={filterSite} open={recordOpen} onOpenChange={value => { setRecordOpen(value); if (!value) setScanPreset(undefined); }} defaultCheckType={quickCheckType} preset={scanPreset} />}
          </div>
        </div>

        {/* Status overview — two rows */}
        {statusLoading ? (
          <Card>
            <CardContent className="p-12 flex justify-center">
              <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
            </CardContent>
          </Card>
        ) : statusError ? (
          <LoadError message="Fire check status could not be loaded." onRetry={() => void refetchStatus()} />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {status?.map(item => (
              <Card
                key={item.checkType}
                className={cn(
                  "border-l-4 transition-all hover:shadow-md group",
                  canEdit && "cursor-pointer",
                  item.lastResult === "fail"       ? "border-l-red-600 bg-red-100/60" :
                  item.lastResult === "action_required"
                                             ? "border-l-orange-600 bg-orange-100/60" :
                  item.status === "overdue"  ? "border-l-rose-500 bg-rose-50/50" :
                  item.status === "due_soon" ? "border-l-amber-500 bg-amber-50/50" :
                  item.status === "never"    ? "border-l-slate-400 bg-slate-50/50" :
                                               "border-l-emerald-500 bg-emerald-50/50"
                )}
                onClick={canEdit ? () => { setQuickCheckType(item.checkType as AnyCheckType); setRecordOpen(true); } : undefined}
              >
                <CardHeader className="pb-2 pt-3 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-xs font-medium leading-snug text-foreground">
                      {CHECK_TYPE_LABELS[item.checkType as AnyCheckType] ?? item.checkType}
                    </CardTitle>
                    <StatusBadge status={item.status as any} lastResult={item.lastResult} />
                  </div>
                </CardHeader>
                <CardContent className="pb-3 px-4 space-y-0.5">
                  <div className="text-xs text-muted-foreground">{frequencyLabel(item.frequencyDays)}</div>
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
                  {canEdit && <div className="text-[11px] text-primary opacity-0 group-hover:opacity-100 transition-opacity pt-0.5 font-medium">
                    + Record check →
                  </div>}
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

        {hasFiretrack && <TrackContractorChecks module="fire" siteId={filterSite} />}

        <CallPointRotationCard siteId={filterSite} sites={sites} enabled={hasFiretrack} />
        {hasFiretrack && canEdit && <DrillAttendanceCard siteId={filterSite} />}

        {/* Filters */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-display font-bold">Filter History</CardTitle>
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
                    {[...CHECK_TYPE_GROUPS, RETIRED_CHECK_GROUP].map(g => (
                      <div key={g.label}>
                        <p className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{g.label}</p>
                        {sortByLabel(g.types, k => CHECK_TYPE_LABELS[k]).map(k => <SelectItem key={k} value={k}>{CHECK_TYPE_LABELS[k]}</SelectItem>)}
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
            <CardTitle className="font-display font-bold">Check History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {checksLoading ? (
              <div className="p-12 flex justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
              </div>
            ) : checksFailed ? (
              <div className="p-6">
                <LoadError message="Check history could not be loaded." onRetry={() => void refetchChecks()} />
              </div>
            ) : !checks || checks.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Flame className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">{canEdit ? "No checks recorded yet. Record your first check above." : "No checks recorded yet."}</p>
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
                            <RecordSignedBy recordType="fire_safety_check" recordId={check.id} className="pt-1" />
                            {check.callPoint && <div><span className="font-medium">Call point:</span> {check.callPoint}</div>}
                            {check.location && <div><span className="font-medium">{check.checkType === "alarm" && !check.callPoint ? "Location / Call Point" : "Location"}:</span> {check.location}</div>}
                            {check.soundLevelDb != null && (
                              <div data-testid={`sound-level-${check.id}`}>
                                <span className="font-medium">Sound level:</span> {Math.round(check.soundLevelDb)} dB
                                {check.soundLevelBedhead ? " at a bedhead" : ""}{check.soundLevelMethod === "phone" ? " (phone, rough guide)" : " (sound meter)"}
                                <SoundLevelVerdictText db={check.soundLevelDb} bedhead={check.soundLevelBedhead} method={check.soundLevelMethod} className="text-[11px]" />
                              </div>
                            )}
                            {check.nightStaff && (
                              <div className={cn(check.nightStaff === "not_included" && "text-amber-700")}>
                                <span className="font-medium">Night staff included:</span> {NIGHT_STAFF_LABELS[check.nightStaff as NightStaff] ?? check.nightStaff}
                              </div>
                            )}
                            {check.drillTime && (
                              <div><span className="font-medium">Time of drill:</span> {check.drillTime}</div>
                            )}
                            {check.evacuationSeconds != null && (
                              <div><span className="font-medium">Time taken to evacuate:</span> {formatEvacuation(check.evacuationSeconds)}</div>
                            )}
                            {check.checkType === "fire_drill" && (check.staffPresent?.length ?? 0) > 0 && (
                              <div data-testid={`drill-staff-present-${check.id}`}>
                                <span className="font-medium">Staff present ({check.staffPresent!.length}):</span> {check.staffPresent!.map(person => person.name).join(", ")}
                              </div>
                            )}
                          </div>
                          {/* Structured display */}
                          {structured?._type === "fire_walk" && <FireWalkDisplay data={structured as FireWalkNotes} />}
                          {structured?._type === "alarm_panel" && <AlarmPanelDisplay data={structured as AlarmPanelNotes} />}
                          {/* Plain notes fallback */}
                          {!structured && check.notes && (
                            <div className="text-xs text-muted-foreground"><span className="font-medium">{check.checkType === "fire_drill" ? `${DRILL_NOTES_LABEL}:` : "Notes:"}</span> {check.notes}</div>
                          )}
                          <CheckPhotoUploader entityType="fire_safety_check" entityId={check.id} compact />
                        </div>
                        {canEdit && <div className="flex items-center gap-1 flex-shrink-0">
                          <EditCheckDialog check={check} siteId={filterSite} />
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(check.id)}
                            className="text-destructive hover:bg-destructive/10">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>}
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
