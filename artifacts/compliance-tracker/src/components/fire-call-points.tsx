import { useState } from "react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFireCallPoints,
  getListFireCallPointsQueryKey,
  useCreateFireCallPoint,
  useUpdateFireCallPoint,
  useOrderFireCallPoints,
  type FireCallPoint,
} from "@workspace/api-client-react";
import { Archive, Check, ChevronDown, ChevronUp, Footprints, Plus, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { ImportCsvButton } from "@/components/import-csv-dialog";
import { WalkRoundDialog, type WalkRoundPoint } from "@/components/walk-round-dialog";
import { SOUND_LEVEL_MIN_DB } from "@/lib/fire-sound-level";

// FireTrack call points (weekly alarm tests): set up per site under FireTrack
// Template > Call points, in the setup wizard, or from the alarm test form.

/** A call point's name, plus its location when the name does not already say it. */
export function callPointLabel(point: Pick<FireCallPoint, "name" | "location">): string {
  const location = point.location?.trim();
  if (!location || point.name.toLowerCase().includes(location.toLowerCase())) return point.name;
  return `${point.name} – ${location}`;
}

export function lastTestedText(point: FireCallPoint) {
  return point.lastTestedDate ? `last tested ${format(new Date(point.lastTestedDate), "dd/MM/yyyy")}` : "not tested yet";
}

export function callPointSiteParam(siteId: number | undefined | null) {
  return { siteId: siteId ? String(siteId) : "none" };
}

/** "Next in turn" and "not tested this round" tags for a call point in use. */
export function RotationTags({ point }: { point: FireCallPoint }) {
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
export function CallPointsEditor({ siteId, enabled }: { siteId: number | null; enabled: boolean }) {
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
 * Setup wizard: list each site's call points when FireTrack is picked, so the
 * weekly alarm test offers them as a dropdown from the first test.
 */
export function SetupCallPoints({ sites }: { sites: { id: number; name: string }[] }) {
  const [openSite, setOpenSite] = useState<number | null | undefined>(sites.length === 1 ? sites[0].id : undefined);
  const { data: points } = useListFireCallPoints(undefined, { query: { queryKey: getListFireCallPointsQueryKey() } });
  const rows: { id: number | null; name: string }[] = sites.length ? sites : [{ id: null, name: "Your premises" }];
  const count = (siteId: number | null) => (points ?? []).filter(p => !p.archivedAt && (p.siteId ?? null) === siteId).length;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="setup-call-points">
      <div>
        <p className="text-sm font-medium">FireTrack: fire alarm call points</p>
        <p className="text-xs text-muted-foreground">
          List each site's manual (break glass) call points and where they are, e.g. "Call point 1" at "Main entrance",
          in the order you want them tested. The weekly alarm test then picks from a dropdown, with the next one in turn
          chosen for you. Optional now; you can do it later under FireTrack, Template, Call points.
        </p>
      </div>
      {rows.map(site => {
        const open = openSite === site.id;
        const listed = count(site.id);
        return (
          <div key={site.id ?? "none"} className="rounded-md border bg-muted/20">
            <button type="button" onClick={() => setOpenSite(open ? undefined : site.id)} aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
              data-testid={`setup-call-points-site-${site.id ?? "none"}`}>
              <span className="font-medium">{site.name}</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {listed === 0 ? "None listed yet" : `${listed} call point${listed === 1 ? "" : "s"}`}
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </span>
            </button>
            {open && <div className="border-t p-3"><CallPointsEditor siteId={site.id} enabled /></div>}
          </div>
        );
      })}
    </div>
  );
}
