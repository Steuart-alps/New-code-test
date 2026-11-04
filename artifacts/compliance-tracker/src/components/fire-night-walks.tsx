import { useEffect, useState } from "react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetFireEscapeRoutesQueryKey, getListSitesQueryKey, useGetFireEscapeRoutes, useGetNightFireWalks, useListSites,
  useUpdateFireEscapeRoutes, type NightFireWalk, type NightFireWalkSite,
} from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock, Moon, Plus, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { cn } from "@/lib/utils";

export const NIGHT_WALK_TIMES = ["22:00", "02:00", "06:00"] as const;
export type NightWalkTime = (typeof NIGHT_WALK_TIMES)[number];

/** A night walk to record: which site, which day and which of the night's walks. */
export type NightWalkPreset = { siteId: number; date: string; walkTime: NightWalkTime };

/** "Sat 1 Nov" */
function dayLabel(isoDate: string) {
  return format(new Date(`${isoDate}T12:00:00`), "EEE d MMM");
}

/**
 * A site's escape routes, ticked on every escape route sign-off and night
 * fire walk. `routes` is empty until a manager lists them.
 */
export function useSiteEscapeRoutes(siteId: number | undefined, enabled: boolean) {
  const params = siteId ? { siteId } : undefined;
  const { data, isLoading } = useGetFireEscapeRoutes(params, {
    query: { enabled, queryKey: getGetFireEscapeRoutesQueryKey(params) },
  });
  return { routes: data?.routes ?? [], loading: enabled && isLoading };
}

const FIRE_WALK_CHECKLISTS = new Set(["premises_opening", "premises_closing"]);
export const FIRE_WALK_SECTION = "Fire walk (sleeping accommodation)";
type FireWalkItem = { label: string; checked: false; section?: string };

/**
 * A site with sleeping accommodation and no night porter does its fire walk
 * on the premises opening and closing checks: these lines (one per listed
 * escape route) are added to a new checklist there. Empty everywhere else.
 */
export function useFireWalkChecklistItems(type: string, siteId: number | null, enabled: boolean): FireWalkItem[] {
  const wanted = enabled && FIRE_WALK_CHECKLISTS.has(type) && siteId != null;
  const { data: sites } = useListSites({ query: { enabled: wanted, queryKey: getListSitesQueryKey() } });
  const site = wanted ? sites?.find(s => s.id === siteId) : undefined;
  const applies = !!site && site.sleepingAccommodation === true && site.nightPorter === false;
  const { routes } = useSiteEscapeRoutes(siteId ?? undefined, applies);
  if (!applies) return [];
  return [
    { section: FIRE_WALK_SECTION, label: "Fire walk completed: every floor, corridor and sleeping area walked", checked: false },
    { label: "Fire doors closed (not wedged open) and no fire hazards found", checked: false },
    ...routes.map(route => ({ label: `Escape route clear: ${route.name}`, checked: false as const })),
  ];
}

/** The checklist's own lines, then any fire walk line it doesn't already have. */
export function withFireWalkItems<T extends { label: string }>(items: T[], extra: T[]): T[] {
  const have = new Set(items.map(item => item.label.trim().toLowerCase()));
  return [...items, ...extra.filter(item => !have.has(item.label.trim().toLowerCase()))];
}

/**
 * The Template's list of a site's escape routes, e.g. "Final fire exit door
 * route 1" or "Escape stairway 2". Saved with its own button; walks already
 * recorded keep the routes they ticked.
 */
export function EscapeRouteListEditor({ siteId, enabled }: { siteId: number | null; enabled: boolean }) {
  const params = siteId ? { siteId } : undefined;
  const { data, isLoading } = useGetFireEscapeRoutes(params, { query: { enabled, queryKey: getGetFireEscapeRoutesQueryKey(params) } });
  const save = useUpdateFireEscapeRoutes();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const newRow = useFocusNewRow();
  const [rows, setRows] = useState<{ name: string; location: string }[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!data) return;
    setRows(data.routes.map(route => ({ name: route.name, location: route.location ?? "" })));
    setDirty(false);
  }, [data]);
  const change = (next: typeof rows) => { setRows(next); setDirty(true); };
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row!);
    change(next);
  };
  const handleSave = () => {
    const routes = rows.filter(row => row.name.trim()).map(row => ({ name: row.name.trim(), location: row.location.trim() || null }));
    save.mutate({ data: { routes }, params }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetFireEscapeRoutesQueryKey().slice(0, 1) });
        toast({ title: "Escape routes saved", description: `${routes.length} route${routes.length === 1 ? "" : "s"} listed.` });
        setDirty(false);
      },
      onError: (err: any) => toast({ title: "Could not save the routes", description: err?.message, variant: "destructive" }),
    });
  };
  if (isLoading) return <div className="h-16 rounded-sm bg-muted animate-pulse" />;
  return (
    <div className="space-y-2" data-testid="escape-route-list">
      {data?.shared && !dirty && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-sm p-2">
          This site has no list of its own yet, so these are the routes saved for the whole business. Save to keep them for this site.
        </p>
      )}
      <div ref={newRow.ref} className="space-y-2">
        {rows.length === 0 && <p className="text-xs text-muted-foreground italic">No escape routes listed yet.</p>}
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2 items-start">
            <div className="flex-1 space-y-1">
              <Input value={row.name} placeholder='e.g. "Final fire exit door route 1" or "Escape stairway 1"' className="h-8 text-sm rounded-sm"
                aria-label={`Route ${i + 1} name`}
                onChange={e => change(rows.map((r, x) => x === i ? { ...r, name: e.target.value } : r))} />
              <Input value={row.location} placeholder="Where it leads / assembly point (optional)" className="h-7 text-xs rounded-sm"
                aria-label={`Route ${i + 1} location`}
                onChange={e => change(rows.map((r, x) => x === i ? { ...r, location: e.target.value } : r))} />
            </div>
            <div className="flex flex-col">
              <Button variant="ghost" size="sm" className="h-6 w-7 p-0" disabled={i === 0} aria-label="Move up" onClick={() => move(i, -1)}>
                <ChevronUp className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-6 w-7 p-0" disabled={i === rows.length - 1} aria-label="Move down" onClick={() => move(i, 1)}>
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0 mt-0.5" aria-label={`Remove route ${i + 1}`}
              onClick={() => change(rows.filter((_, x) => x !== i))}>
              <X className="w-3.5 h-3.5 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => { newRow.expect(); change([...rows, { name: "", location: "" }]); }}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Add route
        </Button>
        <Button size="sm" onClick={handleSave} disabled={save.isPending || !dirty} data-testid="save-escape-routes">
          {save.isPending ? "Saving…" : "Save routes"}
        </Button>
      </div>
      {dirty && <p className="text-[11px] text-amber-700">Routes are saved with "Save routes", not with the Template's save button.</p>}
    </div>
  );
}

const STATUS_STYLE: Record<NightFireWalk["status"], { label: string; className: string; icon: typeof Clock }> = {
  done: { label: "Done", className: "bg-emerald-50 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
  failed: { label: "Done, issue found", className: "bg-orange-50 text-orange-800 border-orange-300", icon: AlertTriangle },
  due: { label: "Due now", className: "bg-amber-50 text-amber-800 border-amber-300", icon: Clock },
  missed: { label: "Missed", className: "bg-rose-50 text-rose-800 border-rose-300", icon: XCircle },
  upcoming: { label: "Later", className: "bg-slate-50 text-slate-600 border-slate-200", icon: Clock },
  not_needed: { label: "Before night porter", className: "bg-slate-50 text-slate-500 border-slate-200", icon: Clock },
};

/** The walk to offer first when recording: one due now, else the latest missed tonight, else the next. */
export function suggestedNightWalk(site: NightFireWalkSite): NightWalkPreset | null {
  const tonight = site.nights[0]?.walks ?? [];
  const pick = tonight.find(walk => walk.status === "due")
    ?? [...tonight].reverse().find(walk => walk.status === "missed")
    ?? tonight.find(walk => walk.status === "upcoming");
  return pick ? { siteId: site.siteId, date: pick.date, walkTime: pick.time as NightWalkTime } : null;
}

/**
 * Night porter fire walks: tonight's 22:00, 02:00 and 06:00 walks for each
 * site with a night porter, and any missed over the last seven nights.
 * Clicking a walk not yet recorded opens it to record.
 */
export function NightWalksCard({ siteId, enabled, canRecord, onRecord }: {
  siteId?: number; enabled: boolean; canRecord: boolean; onRecord: (preset: NightWalkPreset) => void;
}) {
  const params = siteId ? { siteId } : undefined;
  const { data } = useGetNightFireWalks(params, { query: { enabled, refetchInterval: 5 * 60_000 } as any });
  const sites = Array.isArray(data?.sites) ? data.sites : [];
  if (!sites.length) return null;
  return (
    <Card className="rounded-sm" data-testid="night-walks-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Moon className="w-4 h-4 text-primary" />Night fire walks (night porter)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Three signed fire walks every night at 22:00, 02:00 and 06:00. A walk not recorded within {data?.graceMinutes ?? 60} minutes counts as missed, and missed walks are sent to the site's Managers and the Owners the next morning.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {sites.map(site => {
          const tonight = site.nights[0];
          const missedBefore = site.nights.slice(1).flatMap(night => night.walks.filter(walk => walk.status === "missed"))
            .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
          return (
            <div key={site.siteId} className="space-y-2" data-testid={`night-walks-site-${site.siteId}`}>
              {sites.length > 1 || !siteId ? <p className="text-sm font-medium">{site.siteName}</p> : null}
              {tonight && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Night of {dayLabel(tonight.nightOf)}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {tonight.walks.map(walk => {
                      const style = STATUS_STYLE[walk.status];
                      const Icon = style.icon;
                      const recordable = canRecord && walk.checkId == null && walk.status !== "upcoming" && walk.status !== "not_needed";
                      return (
                        <button key={walk.time} type="button" disabled={!recordable}
                          onClick={() => onRecord({ siteId: site.siteId, date: walk.date, walkTime: walk.time as NightWalkTime })}
                          className={cn("rounded-sm border px-2 py-2 text-left text-xs transition-colors", style.className,
                            recordable ? "hover:shadow-sm cursor-pointer" : "cursor-default")}
                          data-testid={`night-walk-${site.siteId}-${walk.time}`}>
                          <span className="flex items-center gap-1 font-semibold text-sm"><Icon className="w-3.5 h-3.5" />{walk.time}</span>
                          <span className="block">{style.label}</span>
                          {walk.performedBy && <span className="block truncate opacity-80">{walk.performedBy}</span>}
                          {recordable && <span className="block font-medium underline">Record walk</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {missedBefore.length > 0 ? (
                <div className="text-xs text-rose-800">
                  <span className="font-medium">Missed in the last {site.nights.length - 1} nights ({missedBefore.length}):</span>{" "}
                  {missedBefore.map(walk => `${dayLabel(walk.date)} ${walk.time}`).join(", ")}
                </div>
              ) : (
                <p className="text-xs text-emerald-700">No walks missed in the last {site.nights.length - 1} nights.</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
