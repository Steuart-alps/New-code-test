import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChecklistSite } from "@/hooks/use-checklist-site";
import { ChecklistSiteSelect } from "@/components/checklist-site-select";
import { ChecklistDueTime } from "@/components/checklist-due-time";
import { createChecklistDraftStore } from "@/lib/checklist-carry";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { ChecklistCard, type Checklist, type ChecklistItem } from "@/pages/daily-track-am";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCheck, Loader2, RotateCcw, Sunrise, Sunset, Tractor, Undo2, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Default shed checklists (each site can edit its own) ──────────────────────

export const SHED_OPENING_ITEMS: ChecklistItem[] = [
  { section: "Security", label: "Shed unlocked and alarm disarmed — no signs of break-in, damage or tampering", checked: false },
  { label: "Gates, fencing, roller doors and windows secure and undamaged", checked: false },
  { label: "All machinery and portable equipment present and accounted for", checked: false },
  { label: "Machinery keys signed out from the locked key cabinet", checked: false },
  { label: "Fuel store and chemical / pesticide store locked and secure — nothing missing", checked: false },
  { label: "CCTV and security lighting working (if fitted)", checked: false },
  { section: "Fire", label: "Fire exits and escape routes clear and unlocked", checked: false },
  { label: "Fire extinguishers in place, unobstructed and in date", checked: false },
  { label: "No smell of fuel or smoke; no leaks or spills from machinery or fuel containers", checked: false },
  { label: "Battery chargers and electrical equipment — no damage, overheating or burning smell", checked: false },
  { label: "No build-up of grass clippings, oily rags or other combustible waste near machines or heat sources", checked: false },
  { section: "Health & safety", label: "Spill kit and first aid kit in place and stocked", checked: false },
  { label: "Workshop and walkways tidy and free of trip hazards", checked: false },
  { label: "Team briefed on the day's work, machine allocation and any hazards (weather, lone working)", checked: false },
];

export const SHED_CLOSING_ITEMS: ChecklistItem[] = [
  { section: "Fire", label: "All machines parked in their bays, engines off and cooling, keys removed", checked: false },
  { label: "Battery chargers isolated — only approved chargers left on, away from combustibles", checked: false },
  { label: "Heaters, kettles, compressors and workshop power tools switched off", checked: false },
  { label: "Hot work (grinding, welding) finished and the area checked for smouldering", checked: false },
  { label: "Fuel containers closed and returned to the fuel store; no fuel left in the workshop", checked: false },
  { label: "Grass clippings, oily rags and combustible waste removed or in a closed metal bin", checked: false },
  { label: "No smoking materials or other ignition sources left in the shed", checked: false },
  { label: "Fire exits and escape routes clear; extinguishers in place", checked: false },
  { section: "Security", label: "Machinery keys returned to the locked key cabinet", checked: false },
  { label: "Strimmers, blowers and other portable equipment locked away", checked: false },
  { label: "Fuel store and chemical / pesticide store locked", checked: false },
  { label: "Windows, roller doors and gates closed and locked", checked: false },
  { label: "Lights off, alarm set and shed locked", checked: false },
  { label: "Any defects, damage or missing items reported", checked: false },
];

const SHED_ENDPOINT = "/green-track/shed-checks";

interface ShedTeam {
  siteId: number;
  departmentId: number | null;
  departmentName: string | null;
  chosen: boolean;
  departments: Array<{ id: number; name: string }>;
}

interface PreStartMachine {
  machineId: number;
  name: string;
  type: string | null;
  siteId: number | null;
  siteName: string | null;
  status: "checked" | "failed" | "not_in_use" | "todo";
  checkId: number | null;
  checkedBy: string | null;
  notInUseId: number | null;
  notInUseReason: string | null;
  markedBy: string | null;
}

interface PreStartDay {
  date: string;
  machines: PreStartMachine[];
  total: number;
  checked: number;
  failed: number;
  notInUse: number;
  todo: number;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new Error(await getApiErrorMessage(response, `Request failed: ${response.status}`));
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

function TeamPicker({ siteId }: { siteId: number }) {
  const canAdmin = useCanAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { activeClientId } = useAuth();
  const key = ["green-shed-team", activeClientId, siteId];
  const { data: team } = useQuery({ queryKey: key, queryFn: () => readJson<ShedTeam>(`/green-track/shed-team?siteId=${siteId}`) });
  const [saving, setSaving] = useState(false);
  if (!team) return null;

  const save = async (value: string) => {
    setSaving(true);
    try {
      const updated = await readJson<ShedTeam>("/green-track/shed-team", {
        method: "PUT",
        body: JSON.stringify({ siteId, departmentId: value === "__auto__" ? null : Number(value) }),
      });
      queryClient.setQueryData(key, updated);
      toast({ title: updated.departmentName ? `Shed checks now go to ${updated.departmentName}` : "Shed checks have no team" });
    } catch (err) {
      toast({ title: "Team not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const summary = team.departmentName
    ? `Done by ${team.departmentName}${team.chosen ? "" : " (matched by name)"}. Their Managers get the reminders.`
    : "No team yet: reminders go to GreenTrack's owner. Choose the greenkeeping department.";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-sm border border-border bg-card px-4 py-3 text-sm" data-testid="green-shed-team">
      <Users className="h-4 w-4 text-muted-foreground" />
      <span className="flex-1 min-w-[200px] text-muted-foreground">{summary}</span>
      {canAdmin && team.departments.length > 0 && (
        <Select value={team.chosen && team.departmentId ? String(team.departmentId) : "__auto__"} onValueChange={save} disabled={saving}>
          <SelectTrigger className="h-8 w-56 rounded-sm text-sm" aria-label="Team that does the shed checks"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__auto__">Match by name ("green")</SelectItem>
            {team.departments.map((d) => <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function statusBadge(machine: PreStartMachine) {
  if (machine.status === "checked") return <Badge className="bg-emerald-100 text-emerald-800 text-xs">Checked</Badge>;
  if (machine.status === "failed") return <Badge className="bg-rose-100 text-rose-800 text-xs">Failed check</Badge>;
  if (machine.status === "not_in_use") return <Badge variant="secondary" className="text-xs">N/A — not in use</Badge>;
  return <Badge className="bg-amber-100 text-amber-800 text-xs">To do</Badge>;
}

function PreStartList({ date, siteId, isToday, onCheck }: {
  date: string; siteId: number | null; isToday: boolean; onCheck: (machineId: number) => void;
}) {
  const { activeClientId } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = new URLSearchParams({ date });
  if (siteId != null) params.set("siteId", String(siteId));
  const { data, isLoading, error } = useQuery({
    queryKey: ["green-pre-start", activeClientId, date, siteId],
    queryFn: () => readJson<PreStartDay>(`/green-track/pre-start?${params}`),
  });
  const [busy, setBusy] = useState<number | null>(null);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["green-pre-start"] });
    queryClient.invalidateQueries({ queryKey: ["green-status"] });
  };
  const markNotInUse = async (machine: PreStartMachine) => {
    setBusy(machine.machineId);
    try {
      await readJson("/green-track/pre-start/not-in-use", { method: "POST", body: JSON.stringify({ machineId: machine.machineId, checkDate: date }) });
      refresh();
    } catch (err) {
      toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally { setBusy(null); }
  };
  const undo = async (machine: PreStartMachine) => {
    if (machine.notInUseId == null) return;
    setBusy(machine.machineId);
    try {
      await readJson(`/green-track/pre-start/not-in-use/${machine.notInUseId}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      toast({ title: "Not changed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally { setBusy(null); }
  };
  const markRest = async () => {
    for (const machine of data?.machines.filter((m) => m.status === "todo") ?? []) await markNotInUse(machine);
  };

  return (
    <Card className="p-5 shadow-sm" data-testid="green-pre-start">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Tractor className="h-4 w-4 text-primary opacity-80" />
          <h3 className="font-bold font-display">Machine pre-start checks</h3>
        </div>
        {data && (
          <span className="text-xs text-muted-foreground">
            {data.checked}/{data.total} checked · {data.notInUse} not in use
            {data.todo > 0 && <span className="font-medium text-amber-700"> · {data.todo} to do</span>}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Every machine needs a pre-start check before use. If a machine isn't being used today, mark it N/A.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p role="alert" className="text-sm text-rose-700">Couldn't load the machines: {(error as Error).message}</p>
      ) : !data || data.total === 0 ? (
        <p className="text-sm text-muted-foreground">No active machines{siteId != null ? " at this site" : ""}. Add them on the Fleet tab.</p>
      ) : (
        <>
          <ul className="divide-y divide-border/60">
            {data.machines.map((machine) => (
              <li key={machine.machineId} className="flex flex-wrap items-center gap-2 py-2" data-testid={`pre-start-${machine.machineId}`}>
                <div className="min-w-[160px] flex-1">
                  <p className="text-sm font-medium">{machine.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[machine.type?.replace(/_/g, " "), siteId == null ? machine.siteName : null,
                      machine.checkedBy ? `by ${machine.checkedBy}` : null,
                      machine.status === "not_in_use" && machine.markedBy ? `marked by ${machine.markedBy}` : null]
                      .filter(Boolean).join(" · ")}
                  </p>
                </div>
                {statusBadge(machine)}
                {machine.status === "todo" && (
                  <>
                    {isToday && (
                      <Button size="sm" className="h-7 gap-1 rounded-sm px-2 text-xs" onClick={() => onCheck(machine.machineId)}>
                        <CheckCheck className="h-3.5 w-3.5" /> Do check
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-7 rounded-sm px-2 text-xs" disabled={busy === machine.machineId}
                      onClick={() => markNotInUse(machine)}>
                      N/A — not in use
                    </Button>
                  </>
                )}
                {machine.status === "not_in_use" && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 rounded-sm px-2 text-xs" disabled={busy === machine.machineId}
                    onClick={() => undo(machine)}>
                    <Undo2 className="h-3.5 w-3.5" /> In use after all
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {data.todo > 1 && (
            <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" disabled={busy !== null} onClick={markRest}>
              Mark the {data.todo} remaining as not in use
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * GreenTrack's Daily checks tab: the greenkeeping shed opening and closing
 * checklists for a site and day, and every machine's pre-start check or
 * "not in use" mark.
 */
export function GreenDailyChecksTab({ initialSiteId, onCheckMachine }: {
  initialSiteId?: number | null;
  onCheckMachine: (machineId: number) => void;
}) {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  // A checklist saved with no site never counts for a site, so the tab
  // starts on one: the machine's site when opened from one, else the user's
  // working site (see useChecklistSite).
  const checklistSite = useChecklistSite();
  const sites = checklistSite.sites;
  const [machineSiteId, setMachineSiteId] = useState<number | null>(initialSiteId ?? null);
  useEffect(() => {
    if (initialSiteId != null) setMachineSiteId(initialSiteId);
  }, [initialSiteId]);
  const selectedSiteId = machineSiteId ?? checklistSite.siteId;
  const setSiteId = (id: number | null) => { setMachineSiteId(null); checklistSite.setSiteId(id); };
  const siteReady = machineSiteId != null || checklistSite.ready;
  const today = format(new Date(), "yyyy-MM-dd");
  const [date, setDate] = useState(today);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(false);
  // Unsaved ticks per checklist, kept while the site or date changes.
  const [drafts] = useState(createChecklistDraftStore);
  const loadSeq = useRef(0);

  const selectedSiteName = sites.find((s) => s.id === selectedSiteId)?.name;

  const load = useCallback(async () => {
    if (!siteReady) return;
    // A slower answer for the previous site or date must not replace this one.
    const seq = ++loadSeq.current;
    setLoading(true);
    const params = new URLSearchParams({ date });
    if (selectedSiteId) params.set("siteId", String(selectedSiteId));
    let rows: Checklist[] = [];
    try {
      rows = await readJson<Checklist[]>(`${SHED_ENDPOINT}?${params}`);
    } catch { /* shown as not started */ }
    if (seq !== loadSeq.current) return;
    setChecklists(rows);
    setLoading(false);
  }, [date, selectedSiteId, siteReady, activeClientId]);

  useEffect(() => { load(); }, [load]);

  const getChecklist = (type: string) => checklists.find((c) => c.checklistType === type && (c.siteId ?? null) === selectedSiteId);

  return (
    <div className="space-y-4" data-testid="green-daily-checks">
      <div className="flex flex-wrap gap-3 rounded-sm border border-border bg-card p-4">
        <div className="min-w-[140px] flex-1 space-y-1">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} className="h-9" />
        </div>
        <ChecklistSiteSelect sites={sites} value={selectedSiteId} onChange={setSiteId} />
        <div className="flex items-end">
          <Button variant="outline" size="sm" onClick={load} className="h-9 gap-1.5">
            <RotateCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      {selectedSiteId != null && <TeamPicker siteId={selectedSiteId} />}

      {!loading && siteReady && (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          <ChecklistDueTime site={sites.find((s) => s.id === selectedSiteId)} period="opening" date={date}
            done={Boolean(getChecklist("greenkeeping_opening")?.submittedAt)} />
          <ChecklistDueTime site={sites.find((s) => s.id === selectedSiteId)} period="closing" date={date}
            done={Boolean(getChecklist("greenkeeping_closing")?.submittedAt)} />
        </div>
      )}

      {loading || !siteReady ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChecklistCard
            key={`greenkeeping_opening-${selectedSiteId}-${date}`}
            type="greenkeeping_opening" label="Shed opening checks" icon={Sunrise}
            defaultItems={SHED_OPENING_ITEMS} endpoint={SHED_ENDPOINT}
            siteId={selectedSiteId} siteName={selectedSiteName} date={date}
            existing={getChecklist("greenkeeping_opening")} onSaved={load} canAdmin={canAdmin}
            draft={drafts.slot("greenkeeping_opening")}
          />
          <ChecklistCard
            key={`greenkeeping_closing-${selectedSiteId}-${date}`}
            type="greenkeeping_closing" label="Shed closing checks" icon={Sunset}
            defaultItems={SHED_CLOSING_ITEMS} endpoint={SHED_ENDPOINT}
            siteId={selectedSiteId} siteName={selectedSiteName} date={date}
            existing={getChecklist("greenkeeping_closing")} onSaved={load} canAdmin={canAdmin}
            draft={drafts.slot("greenkeeping_closing")}
          />
        </div>
      )}

      <PreStartList date={date} siteId={selectedSiteId} isToday={date === today} onCheck={onCheckMachine} />
    </div>
  );
}
