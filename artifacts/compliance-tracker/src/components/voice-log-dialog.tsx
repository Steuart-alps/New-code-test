import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { CheckCircle2, ClipboardList, FileInput, Flame, Loader2, Mic, Snowflake, Square, Thermometer, Droplets, Wrench, XCircle } from "lucide-react";
import {
  assessKitchenTemperatures, kitchenFailureValue, kitchenHoldRequirement, parseKitchenTemperatureRules,
  temperatureRangeLabel, useListSites, type KitchenTemperatureRules,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dictationSupported } from "@/components/dictation-button";
import { useDictation } from "@/hooks/use-dictation";
import { useToast } from "@/hooks/use-toast";
import { useWorkingSiteId } from "@/hooks/use-working-site";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { parseColdUnits, parseStringArray, type ColdUnit } from "@/lib/kitchen-state";
import {
  defaultColdSlot, limitsLabel, localDate, localTimestamp, readSpokenReading, withinLimits,
  type CallPointOption, type KitchenCoreSection, type OutletOption, type VoiceCatalogue, type VoiceReading,
} from "@/lib/voice-log";
import {
  SAY_IT_TRACKS, actionTracks, guessTrack, looksLikeProblem, readSpokenAction, sayItTrack, trackForPath, type ActionSeverity, type SayItTrack,
} from "@/lib/voice-actions";
import { FORM_EXAMPLES, FORM_TRACKS, OPEN_FORM_TRACKS, readSayItForm, type SayItFormReading } from "@/lib/voice-forms";
import { sendSayItFill } from "@/lib/say-it-fill";
import { cn } from "@/lib/utils";

type Outlet = OutletOption & { siteId: number | null; checkTypeForOutlet: string };
type Limits = { min?: number | null; max?: number | null };
type Catalogue = VoiceCatalogue & {
  kitchenRules?: KitchenTemperatureRules;
  coldUnitList?: ColdUnit[];
  outletList?: Outlet[];
  waterLimits?: Record<string, Limits>;
};

/** What the card shows and saves. Built from what was heard, then edited. */
type Draft =
  | { kind: "cold_unit"; unit: string; slot: "am" | "pm"; temperature: string; action: string }
  | { kind: "kitchen_core"; section: KitchenCoreSection; item: string; temperature: string; hold: string; action: string }
  | { kind: "fire_alarm"; callPointId: number | null; result: "pass" | "fail" | null; notes: string }
  | { kind: "water_outlet"; outletId: number | null; temperature: string; notes: string }
  | { kind: "track_action"; module: string; title: string; severity: ActionSeverity }
  | { kind: "track_form"; form: SayItFormReading }
  | { kind: "unknown"; reason: string };

const SEVERITY_LABEL: Record<ActionSeverity, string> = { monitor: "Monitor", action_required: "Action required", urgent: "Urgent" };

const SECTION_LABEL: Record<KitchenCoreSection, string> = {
  hotTemperature: "Cooking", reheating: "Reheating", hotHolding: "Hot holding",
};
// Legionella checks that are temperature readings (outlets for flushing are not).
const WATER_TEMPERATURE_CHECKS = /_temp$/;
const TMV_OUTLET_MAX_C = 44;
const CALORIFIER_RETURN_MIN_C = 50;

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Could not save (${res.status})`;
}

function draftFrom(reading: VoiceReading): Draft {
  switch (reading.kind) {
    case "cold_unit":
      return {
        kind: "cold_unit", unit: reading.matches.length === 1 ? reading.matches[0].name : "",
        slot: reading.slot ?? defaultColdSlot(), temperature: reading.temperature === null ? "" : String(reading.temperature), action: "",
      };
    case "kitchen_core":
      return {
        kind: "kitchen_core", section: reading.section, item: reading.item,
        temperature: reading.temperature === null ? "" : String(reading.temperature),
        hold: reading.holdSeconds === null ? "" : String(reading.holdSeconds), action: "",
      };
    case "fire_alarm":
      return { kind: "fire_alarm", callPointId: reading.matches.length === 1 ? reading.matches[0].id : null, result: reading.result, notes: "" };
    case "water_outlet":
      return {
        kind: "water_outlet", outletId: reading.matches.length === 1 ? reading.matches[0].id : null,
        temperature: reading.temperature === null ? "" : String(reading.temperature), notes: "",
      };
    default:
      return reading;
  }
}

/** A spoken problem as an action: on this page's track, else the track the
 *  words point to, else the only track there is (or the person chooses). */
function actionDraft(heard: string, tracks: SayItTrack[], pageTrack: string | null | undefined): Draft {
  const { title, severity } = readSpokenAction(heard);
  const onPage = tracks.find((track) => track.key === pageTrack)?.key;
  const module = onPage ?? guessTrack(heard, tracks) ?? (tracks.length === 1 ? tracks[0].key : "");
  return { kind: "track_action", module, title, severity };
}

/** A problem said with no reading ("fridge 2 door seal is broken") is
 *  raised as an action rather than logged as a reading with no value. */
function soundsLikeAction(reading: VoiceReading, heard: string): boolean {
  if (!looksLikeProblem(heard)) return false;
  if (reading.kind === "unknown") return true;
  return (reading.kind === "cold_unit" || reading.kind === "water_outlet" || reading.kind === "kitchen_core") && reading.temperature === null;
}

/**
 * A phrase for a track's own form: on that track's page ("pH 7.4 chlorine
 * 1.5" on AquaTrack), or, on a page with no track, a phrase whose words name
 * the track ("mouse droppings in the dry store"). Forms that take any words
 * (incidents, inspections, repairs) come after the readings Say it saves.
 */
function formFor(heard: string, reading: VoiceReading, pageTrack: string | null | undefined, formTracks: SayItTrack[], openFormsFirst: boolean): SayItFormReading | null {
  const onPage = formTracks.find((track) => track.key === pageTrack)?.key;
  if (onPage) {
    if (OPEN_FORM_TRACKS.has(onPage) && !openFormsFirst && reading.kind !== "unknown") return null;
    return readSayItForm(heard, onPage);
  }
  if (pageTrack) return null;
  return readSayItForm(heard, guessTrack(heard, formTracks));
}

const isNumber = (value: string) => /^-?\d+(?:\.\d+)?$/.test(value.trim());
const outletLabel = (o: { name: string; location?: string | null }) => o.name + (o.location ? ` — ${o.location}` : "");

/**
 * "Say it": speak one reading and ComplyTrack works out the track, the item
 * and the value, then shows them on a card to check. Nothing is saved until
 * the person taps Save. Saved readings go into the normal records, marked as
 * spoken, and failures follow each track's usual rules.
 */
export function VoiceLogDialog({ open, onClose, defaultSiteId, pageTrack }: {
  open: boolean;
  onClose: () => void;
  defaultSiteId?: number | null;
  /** The track of the page Say it was opened on (track_actions.module). */
  pageTrack?: string | null;
}) {
  const { user, hasService } = useAuth();
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sites = [] } = useListSites();
  const workingSiteId = useWorkingSiteId();
  const hasKitchen = hasService("kitchentrack");
  const hasFire = hasService("firetrack");
  const hasWater = hasService("legionellatrack");
  const tracks = useMemo(() => actionTracks(hasService, user?.role), [hasService, user?.role]);
  const formTracks = useMemo(() => user && user.role !== "client_viewer"
    ? SAY_IT_TRACKS.filter((track) => FORM_TRACKS.includes(track.key) && track.services.some(hasService)) : [],
  [hasService, user]);
  const hasFixTrack = hasService("fixtrack") && user?.role !== "client_viewer";

  const [siteId, setSiteId] = useState<number | null>(null);
  const [heard, setHeard] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reading, setReading] = useState<VoiceReading | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setHeard(""); setDraft(null); setReading(null); setSaved([]);
    setSiteId(defaultSiteId ?? workingSiteId ?? (sites.length === 1 ? sites[0].id : null));
  }, [open]);
  useEffect(() => {
    if (!open || siteId !== null) return;
    if (workingSiteId) setSiteId(workingSiteId);
    else if (sites.length === 1) setSiteId(sites[0].id);
  }, [open, sites, siteId, workingSiteId]);

  const needsSite = sites.length > 1 && siteId === null;
  const siteQuery = siteId === null ? "" : `?siteId=${siteId}`;
  const catalogueQuery = useQuery({
    queryKey: ["voice-log-catalogue", siteId, hasKitchen, hasFire, hasWater],
    enabled: open && !needsSite,
    queryFn: async (): Promise<Catalogue> => {
      const catalogue: Catalogue = {};
      const jobs: Promise<void>[] = [];
      if (hasKitchen) jobs.push(getJson<Record<string, string>>(`/food-safety/config${siteQuery}`).then((config) => {
        const rules = parseKitchenTemperatureRules(config.food_temperature_rules);
        catalogue.kitchenRules = rules;
        catalogue.coldUnitList = parseColdUnits(config);
        catalogue.coldUnits = catalogue.coldUnitList.map((u) => ({ name: u.name, type: u.type }));
        catalogue.kitchenItems = [...new Set([
          ...parseStringArray(config.food_default_hot_items), ...parseStringArray(config.food_default_holding_items),
          ...rules.items.cooking.map((i) => i.item),
        ])];
      }));
      if (hasFire) jobs.push(getJson<Array<CallPointOption & { archivedAt: string | null }>>(
        `/fire-safety/call-points?siteId=${siteId ?? "none"}`,
      ).then((points) => {
        catalogue.callPoints = points.filter((p) => !p.archivedAt)
          .map((p) => ({ id: p.id, name: p.name, location: p.location ?? null }));
      }));
      if (hasWater) {
        jobs.push(getJson<Outlet[]>("/legionella/outlet-status").then((outlets) => {
          catalogue.outletList = outlets.filter((o) => (o.siteId ?? null) === siteId && WATER_TEMPERATURE_CHECKS.test(o.checkTypeForOutlet));
          catalogue.outlets = catalogue.outletList.map((o) => ({ id: o.id, name: o.name, location: o.location, type: o.type }));
        }));
        jobs.push(getJson<{ effectiveTemperatureLimits?: Record<string, Limits> }>(`/legionella/config${siteQuery}`).then((config) => {
          catalogue.waterLimits = config.effectiveTemperatureLimits ?? {};
        }));
      }
      await Promise.all(jobs);
      return catalogue;
    },
  });
  const catalogue = catalogueQuery.data;

  // Each new phrase (or edit of the words) is read again from scratch.
  useEffect(() => {
    if (!catalogue || !heard.trim()) { setReading(null); setDraft(null); return; }
    const next = readSpokenReading(heard, catalogue);
    setReading(next);
    const form = formFor(heard, next, pageTrack, formTracks, soundsLikeAction(next, heard) || next.kind === "unknown");
    setDraft(form ? { kind: "track_form", form }
      : tracks.length && soundsLikeAction(next, heard) ? actionDraft(heard, tracks, pageTrack) : draftFrom(next));
  }, [heard, catalogue]);
  const raiseAsAction = () => { if (heard.trim()) setDraft(actionDraft(heard, tracks, pageTrack)); };
  const reportInFixTrack = () => {
    const title = draft?.kind === "track_action" ? draft.title : readSpokenAction(heard).title;
    const params = new URLSearchParams({ report: "1", title: title.slice(0, 200) });
    const place = draft?.kind === "track_form" && draft.form.form === "fix-report" ? draft.form.values.location : undefined;
    if (typeof place === "string") params.set("location", place.slice(0, 300));
    if (siteId !== null) params.set("siteId", String(siteId));
    stop();
    onClose();
    setLocation(`/fix-track?${params}`);
  };

  const { listening, interim, toggle, stop } = useDictation((spoken) => {
    setHeard(spoken.trim());
    stop();
  });
  useEffect(() => { if (!open) stop(); }, [open, stop]);

  // ── Pass / fail against the track's limits ──────────────────────────────────
  const check = useMemo((): { pass: boolean | null; limit: string; problem?: string; holdRequired?: { unit: string; limit: number } | null } => {
    if (!draft || !catalogue) return { pass: null, limit: "" };
    if (draft.kind === "cold_unit" || draft.kind === "kitchen_core") {
      const rules = catalogue.kitchenRules;
      if (!rules || !isNumber(draft.temperature)) return { pass: null, limit: "" };
      try {
        if (draft.kind === "cold_unit") {
          const unit = catalogue.coldUnitList?.find((u) => u.name === draft.unit);
          if (!unit) return { pass: null, limit: "" };
          const rule = unit.type === "freezer" ? rules.freezer : rules.fridge;
          const failures = assessKitchenTemperatures(null, {
            coldFood: [{ unit: unit.name, [draft.slot === "am" ? "tempAm" : "tempPm"]: draft.temperature.trim(), correctiveAction: "x" }],
          }, rules, catalogue.coldUnitList ?? []);
          return { pass: failures.length === 0, limit: temperatureRangeLabel(rule) };
        }
        const hold = kitchenHoldRequirement(rules, draft.section, draft.item);
        const key = draft.item.trim().toLowerCase();
        const override = draft.section === "hotTemperature" ? rules.items.cooking.find((i) => i.item.trim().toLowerCase() === key) : undefined;
        const rule = draft.section === "hotTemperature" ? (override ? { min: override.min, max: rules.cooking.max } : rules.cooking)
          : draft.section === "reheating" ? rules.reheating : rules.hotHolding;
        const failures = assessKitchenTemperatures(null, {
          [draft.section]: [{ item: draft.item, coreTemp: draft.temperature.trim(), ...(hold ? { holdSeconds: draft.hold.trim() } : {}), correctiveAction: "x" }],
        }, rules);
        const limit = (rule.min === null && rule.max === null) ? "no limit set" : temperatureRangeLabel(rule);
        return {
          pass: failures.length === 0, limit: hold ? `${limit}, held ${hold.limit} ${hold.unit}` : limit,
          holdRequired: hold ? { unit: hold.unit, limit: hold.limit } : null,
          problem: failures.find((f) => f.field === hold?.field) ? `Held ${kitchenFailureValue(failures.find((f) => f.field === hold?.field)!)}` : undefined,
        };
      } catch (error) {
        const hold = draft.kind === "kitchen_core" ? kitchenHoldRequirement(rules, draft.section, draft.item) : null;
        return { pass: null, limit: "", problem: error instanceof Error ? error.message : String(error), holdRequired: hold ? { unit: hold.unit, limit: hold.limit } : null };
      }
    }
    if (draft.kind === "water_outlet") {
      const outlet = catalogue.outletList?.find((o) => o.id === draft.outletId);
      if (!outlet || !isNumber(draft.temperature)) return { pass: null, limit: "" };
      const label = outletLabel(outlet);
      const limits: Limits | undefined = outlet.type === "tmv" ? { max: TMV_OUTLET_MAX_C }
        : outlet.checkTypeForOutlet === "calorifier_temp" && /\breturn\b/i.test(label) ? { min: CALORIFIER_RETURN_MIN_C, ...pick(catalogue.waterLimits?.calorifier_temp, "max") }
          : catalogue.waterLimits?.[outlet.checkTypeForOutlet];
      return { pass: withinLimits(Number(draft.temperature), limits), limit: limitsLabel(limits) };
    }
    if (draft.kind === "fire_alarm") return { pass: draft.result === null ? null : draft.result === "pass", limit: "" };
    return { pass: null, limit: "" };
  }, [draft, catalogue]);

  const update = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } as Draft : current));

  const missing = ((): string | null => {
    if (!draft || draft.kind === "unknown") return "Say or type a reading first.";
    if (draft.kind === "cold_unit") {
      if (!draft.unit) return "Choose the fridge or freezer.";
      if (!isNumber(draft.temperature)) return "Enter the temperature.";
      if (check.pass === false && !draft.action.trim()) return "Say what action was taken for this failed reading.";
    }
    if (draft.kind === "kitchen_core") {
      if (!draft.item.trim()) return "Enter the food item.";
      if (!isNumber(draft.temperature)) return "Enter the core temperature.";
      if (check.holdRequired && !/^\d+$/.test(draft.hold.trim())) return `Enter how long it was held, in ${check.holdRequired.unit}.`;
      if (check.problem && check.pass === null) return check.problem;
      if (check.pass === false && !draft.action.trim()) return "Say what action was taken for this failed reading.";
    }
    if (draft.kind === "fire_alarm") {
      if (draft.callPointId === null) return "Choose the call point.";
      if (draft.result === null) return "Tap Pass or Fail.";
    }
    if (draft.kind === "water_outlet") {
      if (draft.outletId === null) return "Choose the outlet.";
      if (!isNumber(draft.temperature)) return "Enter the temperature.";
    }
    if (draft.kind === "track_action") {
      if (!draft.module) return "Choose the track.";
      if (!draft.title.trim()) return "Say or type what needs doing.";
    }
    return null;
  })();

  // A track's form opens filled in, on its own page, to check and save there.
  const fillForm = (form: SayItFormReading) => {
    if (form.form === "fix-report") { reportInFixTrack(); return; }
    stop();
    sendSayItFill({ form: form.form, item: form.item, values: form.values, siteId, text: heard.trim() });
    onClose();
    if (trackForPath(location) !== form.track && !location.startsWith(form.path)) setLocation(form.path);
  };

  async function save() {
    if (!draft || missing || !catalogue) return;
    if (draft.kind === "track_form") { fillForm(draft.form); return; }
    stop();
    setSaving(true);
    const spoken = heard.trim().slice(0, 500);
    const voiceNote = `Logged by voice: "${spoken}"`;
    const performedBy = user?.name ?? null;
    let res: Response | null = null;
    let summary = "";
    try {
      if (draft.kind === "cold_unit") {
        res = await apiFetch(`/food-safety/cold-reading${siteQuery}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recordDate: localDate(), unit: draft.unit, slot: draft.slot, temperature: Number(draft.temperature),
            correctiveAction: check.pass === false ? draft.action.trim() : undefined,
            recordedAt: localTimestamp(), spoken,
          }),
        });
        summary = `KitchenTrack: ${draft.unit} ${draft.slot.toUpperCase()} ${draft.temperature}°C`;
      } else if (draft.kind === "kitchen_core") {
        const time = localTimestamp().slice(11, 16);
        const row: Record<string, string> = { item: draft.item.trim(), coreTemp: draft.temperature.trim() };
        if (draft.section === "hotHolding") row.timeOfCheck = time;
        else { row.timeStart = ""; row.timeFinish = time; }
        if (check.holdRequired) row.holdSeconds = draft.hold.trim();
        if (check.pass === false) row.correctiveAction = draft.action.trim();
        res = await apiFetch(`/food-safety/append${siteQuery}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recordDate: localDate(), section: draft.section, row, recordedAt: localTimestamp(), spoken,
            entryId: `voice-${crypto.randomUUID()}`,
          }),
        });
        summary = `KitchenTrack ${SECTION_LABEL[draft.section].toLowerCase()}: ${draft.item.trim()} ${draft.temperature}°C`;
      } else if (draft.kind === "fire_alarm") {
        const point = catalogue.callPoints?.find((p) => p.id === draft.callPointId);
        res = await apiFetch("/fire-safety", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkType: "alarm", checkDate: localDate(), result: draft.result, siteId, callPointId: draft.callPointId,
            performedBy, notes: [voiceNote, draft.notes.trim()].filter(Boolean).join("\n"),
          }),
        });
        summary = `FireTrack: alarm test at ${point?.name ?? "call point"} (${draft.result})`;
      } else if (draft.kind === "water_outlet") {
        const outlet = catalogue.outletList!.find((o) => o.id === draft.outletId)!;
        res = await apiFetch("/legionella", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkType: outlet.checkTypeForOutlet, checkDate: localDate(), result: check.pass === false ? "fail" : "pass",
            temperature: Number(draft.temperature), location: outletLabel(outlet), performedBy,
            notes: [voiceNote, draft.notes.trim()].filter(Boolean).join("\n"),
            siteId: outlet.siteId ?? undefined, outletId: outlet.id,
          }),
        });
        summary = `Legionella: ${outlet.name} ${draft.temperature}°C`;
      } else if (draft.kind === "track_action") {
        res = await apiFetch("/track-actions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            module: draft.module, title: draft.title.trim(), severity: draft.severity, siteId,
            instruction: `Raised by voice: "${spoken}"`,
          }),
        });
        summary = `${sayItTrack(draft.module)?.label ?? "Track"} action: ${draft.title.trim()}`;
      }
      if (!res) return;
      if (!res.ok) {
        toast({ title: "Not saved", description: await errorMessage(res), variant: "destructive" });
        return;
      }
      const result = check.pass === false ? "fail" : "pass";
      const outcome = draft.kind === "fire_alarm" ? "" : draft.kind === "track_action" ? ` (${SEVERITY_LABEL[draft.severity].toLowerCase()})` : ` (${result})`;
      setSaved((list) => [`${summary}${outcome}`, ...list]);
      toast({ title: "Saved", description: summary });
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string"
          && /\/(food-safety|fire-safety|legionella|dashboard|track-actions|compliance)/.test(query.queryKey[0]),
      });
      queryClient.invalidateQueries({ queryKey: ["voice-log-catalogue"] });
      if (draft.kind === "track_action") window.dispatchEvent(new Event("track-actions-changed"));
      setHeard("");
    } finally {
      setSaving(false);
    }
  }

  const noTracks = !hasKitchen && !hasFire && !hasWater && !tracks.length;
  const examples = sayItExamples({
    hasKitchen, hasFire, hasWater, pageTrack, actionTrack: tracks.find((t) => t.key === pageTrack) ?? (tracks.length ? tracks[0] : undefined),
    formExample: formTracks.some((t) => t.key === pageTrack) ? FORM_EXAMPLES[pageTrack!] : undefined,
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) { stop(); onClose(); } }}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto" data-testid="voice-log-dialog">
        <DialogHeader>
          <DialogTitle>Say it</DialogTitle>
          <DialogDescription>
            {dictationSupported
              ? `Tap the microphone and say one thing, for example ${examples}. Check the card, then tap Save.`
              : `This browser can't listen, so type it instead, for example ${examples}. Check the card, then tap Save.`}
          </DialogDescription>
        </DialogHeader>

        {noTracks ? (
          <p className="text-sm text-muted-foreground">Say it works with the tracks your business uses. None is switched on yet.</p>
        ) : (
          <div className="space-y-4">
            {sites.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="voice-log-site">Site</Label>
                <Select value={siteId === null ? "" : String(siteId)} onValueChange={(value) => { setSiteId(Number(value)); }}>
                  <SelectTrigger id="voice-log-site"><SelectValue placeholder="Choose the site" /></SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {dictationSupported && (
              <Button type="button" size="lg" variant={listening ? "destructive" : "default"} className="w-full gap-2 h-14 text-base"
                disabled={needsSite || saving} onClick={toggle} data-testid="voice-log-mic">
                {listening ? <Square className="h-5 w-5 fill-current" /> : <Mic className="h-5 w-5" />}
                {listening ? "Listening… tap to stop" : saved.length ? "Say the next reading" : "Tap and speak"}
              </Button>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="voice-log-heard">What was heard</Label>
              <Input id="voice-log-heard" value={heard} disabled={needsSite} maxLength={500}
                onChange={(event) => setHeard(event.target.value)}
                placeholder={needsSite ? "Choose the site first" : /"([^"]+)"/.exec(examples)?.[1] ?? ""} />
              {listening && <p aria-live="polite" className="text-xs italic text-muted-foreground">{interim || "Listening…"}</p>}
              {heard && <p className="text-xs text-muted-foreground">Misheard? Fix the words here, or change the card below.</p>}
            </div>

            {catalogueQuery.isLoading && !needsSite && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading your lists…</p>
            )}
            {catalogueQuery.isError && (
              <p className="text-sm text-destructive">Your lists couldn't be loaded. Close this and try again.</p>
            )}

            {draft && reading && catalogue && (
              <ReadingCard draft={draft} reading={reading} catalogue={catalogue} check={check} update={update}
                tracks={tracks} onRaiseAction={tracks.length ? raiseAsAction : undefined}
                onFixTrack={hasFixTrack ? reportInFixTrack : undefined} />
            )}

            {saved.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Saved just now</p>
                <ul className="space-y-0.5 text-xs" data-testid="voice-log-saved">
                  {saved.map((line, index) => (
                    <li key={index} className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={() => { stop(); onClose(); }}>Done</Button>
          {!noTracks && (
            <Button type="button" disabled={!!missing || saving} onClick={save} title={missing ?? undefined} data-testid="voice-log-save">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{draft?.kind === "track_form" ? "Fill in the form" : "Save"}
            </Button>
          )}
        </DialogFooter>
        {draft && draft.kind !== "unknown" && missing && (
          <p className="text-right text-xs text-muted-foreground" data-testid="voice-log-missing">{missing}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What to suggest saying: readings for the page's track, or for every
 *  reading track on pages without one, then something to raise as an action. */
function sayItExamples({ hasKitchen, hasFire, hasWater, pageTrack, actionTrack, formExample }: {
  hasKitchen: boolean; hasFire: boolean; hasWater: boolean; pageTrack?: string | null; actionTrack?: SayItTrack; formExample?: string;
}): string {
  if (formExample) {
    return OPEN_FORM_TRACKS.has(pageTrack ?? "") || !actionTrack ? `"${formExample}"` : `"${formExample}" or "${actionTrack.example}"`;
  }
  const readings: string[] = [];
  const all = !pageTrack;
  if (hasKitchen && (all || pageTrack === "kitchen")) readings.push("\"fridge 1 is 4 degrees\"", "\"chicken core temp 78\"");
  if (hasFire && (all || pageTrack === "fire")) readings.push("\"testing call point 1\"");
  if (hasWater && (all || pageTrack === "legionella")) readings.push("\"hot tap ladies toilet 55 degrees\"");
  const action = actionTrack ? `"${actionTrack.example}"` : null;
  const list = [...readings, ...(action ? [action] : [])];
  if (!list.length) return "\"fridge 1 is 4 degrees\"";
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
}

function pick(limits: Limits | undefined, key: "min" | "max"): Limits {
  return limits && limits[key] != null ? { [key]: limits[key] } : {};
}

/** The card to check before saving: track, item, reading, pass or fail. */
function ReadingCard({ draft, reading, catalogue, check, update, tracks, onRaiseAction, onFixTrack }: {
  draft: Draft;
  reading: VoiceReading;
  catalogue: Catalogue;
  check: { pass: boolean | null; limit: string; problem?: string; holdRequired?: { unit: string; limit: number } | null };
  update: (patch: Partial<Draft>) => void;
  tracks: SayItTrack[];
  onRaiseAction?: () => void;
  onFixTrack?: () => void;
}) {
  if (draft.kind === "unknown") {
    return (
      <div className="space-y-2">
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="voice-log-unknown">{draft.reason}</p>
        {(onRaiseAction || onFixTrack) && (
          <div className="flex flex-wrap gap-2">
            {onRaiseAction && (
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={onRaiseAction} data-testid="voice-log-raise-action">
                <ClipboardList className="h-4 w-4" />Raise it as an action
              </Button>
            )}
            {onFixTrack && (
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={onFixTrack} data-testid="voice-log-fixtrack">
                <Wrench className="h-4 w-4" />Report it in FixTrack
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }
  if (draft.kind === "track_form") {
    const { form } = draft;
    return (
      <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="voice-log-card">
        <p className="flex items-center gap-2 text-sm font-semibold"><FileInput className="h-4 w-4" />
          {sayItTrack(form.track)?.label ?? "Track"} · {form.label}
        </p>
        <ul className="space-y-1 text-sm" data-testid="voice-log-form-fields">
          {form.summary.map((line) => <li key={line} className="flex items-start gap-1.5"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />{line}</li>)}
        </ul>
        <p className="text-xs text-muted-foreground">
          {form.form === "fix-report" ? "FixTrack's report form opens with this filled in." : `The ${form.label} form opens with this filled in.`} Check it there, add anything else, then save.
        </p>
        {onRaiseAction && form.form !== "fix-report" && (
          <button type="button" className="text-xs font-medium text-muted-foreground underline underline-offset-2" onClick={onRaiseAction}
            data-testid="voice-log-raise-action">
            Not right? Raise it as an action instead
          </button>
        )}
      </div>
    );
  }
  if (draft.kind === "track_action") {
    return (
      <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="voice-log-card">
        <p className="flex items-center gap-2 text-sm font-semibold"><ClipboardList className="h-4 w-4" />
          {sayItTrack(draft.module)?.label ?? "Track"} · action to follow up
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="voice-log-action-title">What needs doing</Label>
          <Input id="voice-log-action-title" value={draft.title} maxLength={500} onChange={(e) => update({ title: e.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="voice-log-action-track">Track</Label>
            <Select value={draft.module} onValueChange={(module) => update({ module })}>
              <SelectTrigger id="voice-log-action-track" data-testid="voice-log-action-track"><SelectValue placeholder="Choose the track" /></SelectTrigger>
              <SelectContent>
                {tracks.map((track) => <SelectItem key={track.key} value={track.key}>{track.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>How urgent</Label>
            <div className="flex gap-1">
              {(Object.keys(SEVERITY_LABEL) as ActionSeverity[]).map((severity) => (
                <Button key={severity} type="button" size="sm" className="flex-1 px-1.5 text-xs"
                  variant={draft.severity === severity ? (severity === "urgent" ? "destructive" : "default") : "outline"}
                  aria-pressed={draft.severity === severity} onClick={() => update({ severity })} data-testid={`voice-log-severity-${severity}`}>
                  {severity === "action_required" ? "Action" : SEVERITY_LABEL[severity]}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">It's added to the track's actions list for someone to sign off, marked as raised by voice.</p>
        {onFixTrack && (
          <button type="button" className="text-xs font-medium underline underline-offset-2" onClick={onFixTrack} data-testid="voice-log-fixtrack">
            Needs a repair? Report it in FixTrack instead
          </button>
        )}
      </div>
    );
  }
  const track = draft.kind === "fire_alarm" ? "FireTrack · weekly alarm test"
    : draft.kind === "water_outlet" ? "Legionella · outlet temperature"
      : draft.kind === "cold_unit" ? "KitchenTrack · fridge and freezer reading" : `KitchenTrack · ${SECTION_LABEL[draft.section].toLowerCase()}`;
  const Icon = draft.kind === "fire_alarm" ? Flame : draft.kind === "water_outlet" ? Droplets : draft.kind === "cold_unit" ? Snowflake : Thermometer;
  const choices = (reading.kind === "cold_unit" || reading.kind === "fire_alarm" || reading.kind === "water_outlet") ? reading.matches : [];

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="voice-log-card">
      <p className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4" />{track}</p>

      {draft.kind === "cold_unit" && (
        <>
          <ItemPicker label="Fridge or freezer" value={draft.unit} spoken={reading.kind === "cold_unit" ? reading.spokenItem : ""}
            matches={(choices as Array<{ name: string }>).map((u) => ({ value: u.name, label: u.name }))}
            options={(catalogue.coldUnits ?? []).map((u) => ({ value: u.name, label: u.name }))}
            onChange={(unit) => update({ unit })} />
          <div className="grid grid-cols-2 gap-3">
            <TemperatureInput value={draft.temperature} onChange={(temperature) => update({ temperature })} />
            <div className="space-y-1.5">
              <Label>Reading</Label>
              <div className="flex gap-1">
                {(["am", "pm"] as const).map((slot) => (
                  <Button key={slot} type="button" size="sm" variant={draft.slot === slot ? "default" : "outline"} className="flex-1"
                    onClick={() => update({ slot })}>{slot.toUpperCase()}</Button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {draft.kind === "kitchen_core" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="voice-log-item">Food</Label>
              <Input id="voice-log-item" value={draft.item} maxLength={200} dictation={false} onChange={(e) => update({ item: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Check</Label>
              <Select value={draft.section} onValueChange={(section) => update({ section: section as KitchenCoreSection })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SECTION_LABEL) as KitchenCoreSection[]).map((key) => <SelectItem key={key} value={key}>{SECTION_LABEL[key]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TemperatureInput value={draft.temperature} onChange={(temperature) => update({ temperature })} label="Core temperature (°C)" />
            {check.holdRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="voice-log-hold">Held for ({check.holdRequired.unit})</Label>
                <Input id="voice-log-hold" inputMode="numeric" value={draft.hold} onChange={(e) => update({ hold: e.target.value })} />
              </div>
            )}
          </div>
        </>
      )}

      {draft.kind === "fire_alarm" && (
        <>
          <ItemPicker label="Call point" value={draft.callPointId === null ? "" : String(draft.callPointId)}
            spoken={reading.kind === "fire_alarm" ? reading.spokenItem : ""}
            matches={(choices as CallPointOption[]).map((p) => ({ value: String(p.id), label: outletLabel(p) }))}
            options={(catalogue.callPoints ?? []).map((p) => ({ value: String(p.id), label: outletLabel(p) }))}
            empty="This site has no call points listed yet. Add them in FireTrack's template first."
            onChange={(id) => update({ callPointId: Number(id) })} />
          <div className="space-y-1.5">
            <Label>Did the alarm sound?</Label>
            <div className="flex gap-2">
              <Button type="button" variant={draft.result === "pass" ? "default" : "outline"} className={cn("flex-1 gap-1", draft.result === "pass" && "bg-emerald-600 hover:bg-emerald-700")}
                onClick={() => update({ result: "pass" })} data-testid="voice-log-pass"><CheckCircle2 className="h-4 w-4" />Pass</Button>
              <Button type="button" variant={draft.result === "fail" ? "destructive" : "outline"} className="flex-1 gap-1"
                onClick={() => update({ result: "fail" })} data-testid="voice-log-fail"><XCircle className="h-4 w-4" />Fail</Button>
            </div>
          </div>
          {draft.result === "fail" && (
            <div className="space-y-1.5">
              <Label htmlFor="voice-log-notes">What was wrong?</Label>
              <Textarea id="voice-log-notes" rows={2} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
            </div>
          )}
        </>
      )}

      {draft.kind === "water_outlet" && (
        <>
          <ItemPicker label="Outlet" value={draft.outletId === null ? "" : String(draft.outletId)}
            spoken={reading.kind === "water_outlet" ? reading.spokenItem : ""}
            matches={(choices as OutletOption[]).map((o) => ({ value: String(o.id), label: `${outletLabel(o)} (${o.type})` }))}
            options={(catalogue.outletList ?? []).map((o) => ({ value: String(o.id), label: `${outletLabel(o)} (${o.type})` }))}
            empty="This site has no outlets listed yet. Add them in Legionella first."
            onChange={(id) => update({ outletId: Number(id) })} />
          <TemperatureInput value={draft.temperature} onChange={(temperature) => update({ temperature })} />
        </>
      )}

      {check.pass !== null && draft.kind !== "fire_alarm" && (
        <p className={cn("flex items-center gap-1.5 text-sm font-medium", check.pass ? "text-emerald-700" : "text-destructive")} data-testid="voice-log-result">
          {check.pass ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {check.pass ? "Pass" : "Fail"}{check.limit ? ` · limit ${check.limit}` : ""}{check.problem && !check.pass ? ` · ${check.problem}` : ""}
        </p>
      )}
      {check.pass === null && check.problem && draft.kind === "kitchen_core" && !check.holdRequired && (
        <p className="text-sm text-destructive">{check.problem}</p>
      )}

      {check.pass === false && (draft.kind === "cold_unit" || draft.kind === "kitchen_core") && (
        <div className="space-y-1.5">
          <Label htmlFor="voice-log-action">Action taken (required)</Label>
          <Textarea id="voice-log-action" rows={2} value={draft.action} onChange={(e) => update({ action: e.target.value })}
            placeholder={draft.kind === "cold_unit" ? "Moved food to fridge 2, called the engineer" : "Cooked for longer and probed again"} />
          <p className="text-xs text-muted-foreground">A follow-up action is raised for a manager to sign off, as with any failed reading.</p>
        </div>
      )}
      {check.pass === false && draft.kind === "water_outlet" && (
        <p className="text-xs text-muted-foreground">A failed reading opens an action automatically, as it does when logged from the outlet list.</p>
      )}
      {onRaiseAction && (
        <button type="button" className="text-xs font-medium text-muted-foreground underline underline-offset-2" onClick={onRaiseAction}
          data-testid="voice-log-raise-action">
          Not a reading? Raise it as an action instead
        </button>
      )}
    </div>
  );
}

function TemperatureInput({ value, onChange, label = "Temperature (°C)" }: { value: string; onChange: (value: string) => void; label?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="voice-log-temperature">{label}</Label>
      <Input id="voice-log-temperature" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} data-testid="voice-log-temperature" />
    </div>
  );
}

/** One heard match is chosen for you; several are shown to tap; none: pick from the list. */
function ItemPicker({ label, value, spoken, matches, options, empty, onChange }: {
  label: string;
  value: string;
  spoken: string;
  matches: Array<{ value: string; label: string }>;
  options: Array<{ value: string; label: string }>;
  empty?: string;
  onChange: (value: string) => void;
}) {
  if (!options.length) return <p className="text-sm text-amber-800">{empty ?? "Nothing is listed for this site yet."}</p>;
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {matches.length > 1 && !value && (
        <div className="flex flex-wrap gap-1.5" data-testid="voice-log-choices">
          <p className="w-full text-xs text-muted-foreground">More than one matches. Tap the right one:</p>
          {matches.map((match) => (
            <Button key={match.value} type="button" size="sm" variant="outline" onClick={() => onChange(match.value)}>{match.label}</Button>
          ))}
        </div>
      )}
      {matches.length === 0 && !value && spoken && (
        <p className="text-xs text-amber-800">Nothing on the list matches "{spoken}". Choose it below.</p>
      )}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger data-testid="voice-log-item"><SelectValue placeholder={`Choose the ${label.toLowerCase()}`} /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
