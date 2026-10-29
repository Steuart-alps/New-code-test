import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { getApiErrorMessage } from "@/lib/api";
import { readSpreadsheet, spreadsheetTabNames } from "@/lib/spreadsheet";
import { TRACK_SETUP, describeItems, planTrackSetup, type PlanGroup, type TrackSetupPlan } from "@/lib/track-setup";

type Site = { id: number; name: string };
type ColdUnit = { id?: string; name: string; type: "fridge" | "freezer" };

const groupKey = (group: PlanGroup) => `${group.kind}|${group.source}|${group.siteName ?? ""}`;

/** The site a group belongs to: matched by name; a blank site is the whole business. */
function siteFor(group: PlanGroup, sites: Site[]): Site | null | undefined {
  if (!group.siteName) return null;
  return sites.find((site) => site.name.trim().toLowerCase() === group.siteName!.toLowerCase());
}

/**
 * "Set up tracks from this workbook": shows what a setup workbook's track
 * lists and counts would add (KitchenTrack fridges and freezers, outlets,
 * hot tubs, bikes, call points), each group ticked, and adds the ticked ones
 * through each track's own API. A site's fridges and freezers become the
 * workbook's list; everything else is added alongside what is there already,
 * skipping names already in use.
 */
export function TrackSetupDialog({ file, sites, open, onClose, onDone }: {
  file: File; sites: Site[]; open: boolean; onClose: () => void; onDone: () => void;
}) {
  const { hasService } = useAuth();
  const clientApiFetch = useActiveClientApi();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<TrackSetupPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const tabs = await Promise.all((await spreadsheetTabNames(file)).map(async (name) => ({ name, ...(await readSpreadsheet(file, { sheet: name })) })));
        const read = planTrackSetup(tabs);
        const groups = read.groups.filter((group) => hasService(TRACK_SETUP[group.kind].service));
        if (cancelled) return;
        setPlan({ ...read, groups });
        setTicked(new Set(groups.filter((group) => siteFor(group, sites) !== undefined).map(groupKey)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "This workbook could not be read");
      }
    })();
    return () => { cancelled = true; };
  }, [file, open, sites, hasService]);

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await clientApiFetch(path, init);
    if (!response.ok) throw new Error(await getApiErrorMessage(response, `Request failed (${response.status})`));
    return response.json() as Promise<T>;
  }

  async function apply(group: PlanGroup, site: Site | null): Promise<string> {
    const where = site ? ` at ${site.name}` : "";
    const siteQuery = site ? `?siteId=${site.id}` : "";
    if (group.kind === "cold-units") {
      // The workbook's list becomes the site's fridges and freezers; a unit
      // with the same name keeps its id, so its QR label keeps working.
      const config = await json<Record<string, string>>(`/food-safety/config${siteQuery}`);
      let current: ColdUnit[] = [];
      try { current = JSON.parse(config.food_cold_units || "[]"); } catch { current = []; }
      // Numbers from Counts per site never replace fridges and freezers
      // someone has already named (from a KitchenTrack list or the kitchen page).
      const numbered = /^(fridge|freezer|display fridge) \d+$/i;
      if (group.source === "count" && current.some((unit) => !numbered.test(unit.name.trim()))) {
        return `kept the fridges and freezers already named${where} (${current.map((unit) => unit.name).join(", ")})`;
      }
      const units = group.items.slice(0, 30).map((item) => {
        const same = current.find((unit) => unit.name.toLowerCase() === item.name.toLowerCase());
        return { ...(same?.id ? { id: same.id } : {}), name: item.name, type: item.type as ColdUnit["type"] };
      });
      await json(`/food-safety/config${siteQuery}`, { method: "PUT", body: JSON.stringify({ food_cold_units: JSON.stringify(units) }) });
      return `${units.length} fridges and freezers${where}${group.items.length > 30 ? " (the first 30; KitchenTrack holds up to 30 a site)" : ""}`;
    }
    if (group.kind === "call-points") {
      const result = await json<{ summary?: { create?: number; update?: number } }>("/imports/fire-call-points", {
        method: "POST",
        body: JSON.stringify({ headers: ["Call point", "Site"], rows: group.items.map((item) => [item.name, site?.name ?? ""]), preview: false, siteId: site?.id ?? null }),
      });
      return `${result.summary?.create ?? 0} call points added${where}`;
    }
    const existing = group.kind === "outlets"
      ? (await json<Array<{ name: string; site_id?: number | null; siteId?: number | null }>>("/legionella/outlets")).map((row) => ({ name: row.name, siteId: row.site_id ?? row.siteId ?? null }))
      : group.kind === "hot-tubs"
        ? (await json<Array<{ name: string; site_id?: number | null; siteId?: number | null }>>("/hot-tub/tubs")).map((row) => ({ name: row.name, siteId: row.site_id ?? row.siteId ?? null }))
        : (await json<Array<{ ref: string; siteId: number | null }>>("/bike-track/bikes")).map((row) => ({ name: row.ref, siteId: row.siteId }));
    const taken = new Set(existing.filter((row) => group.kind === "bikes" || row.siteId === (site?.id ?? null)).map((row) => row.name.toLowerCase()));
    let added = 0;
    for (const item of group.items) {
      if (taken.has(item.name.toLowerCase())) continue;
      if (group.kind === "outlets") {
        await json("/legionella/outlets", { method: "POST", body: JSON.stringify({ name: item.name, type: item.type, location: item.location ?? null, siteId: site?.id ?? null }) });
      } else if (group.kind === "hot-tubs") {
        await json("/hot-tub/tubs", { method: "POST", body: JSON.stringify({ name: item.name, description: item.description ?? null, siteId: site?.id ?? null }) });
      } else {
        const body = { ref: item.name, name: item.description ?? null, siteId: site?.id ?? null };
        // A bike type not on the business's list falls back to its default type.
        const response = await clientApiFetch("/bike-track/bikes", { method: "POST", body: JSON.stringify(item.type ? { ...body, type: item.type } : body) });
        if (!response.ok && item.type) await json("/bike-track/bikes", { method: "POST", body: JSON.stringify(body) });
        else if (!response.ok) throw new Error(await getApiErrorMessage(response, "A bike could not be added"));
      }
      taken.add(item.name.toLowerCase());
      added++;
    }
    const skippedCount = group.items.length - added;
    return `${added} ${TRACK_SETUP[group.kind].noun} added${where}${skippedCount ? ` (${skippedCount} already there)` : ""}`;
  }

  async function addTicked() {
    if (!plan) return;
    setBusy(true);
    const lines: string[] = [];
    for (const group of plan.groups.filter((g) => ticked.has(groupKey(g)))) {
      const site = siteFor(group, sites);
      if (site === undefined) continue;
      try {
        lines.push(`${TRACK_SETUP[group.kind].label}: ${await apply(group, site)}`);
      } catch (err) {
        lines.push(`${TRACK_SETUP[group.kind].label}${site ? ` at ${site.name}` : ""}: not added. ${err instanceof Error ? err.message : ""}`);
      }
    }
    setResults(lines);
    setBusy(false);
    void queryClient.invalidateQueries();
    onDone();
  }

  const toggle = (key: string) => setTicked((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="track-setup-dialog">
        <DialogHeader><DialogTitle>Set up your tracks from {file.name}</DialogTitle></DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!plan && !error && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
        {plan && !results && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Tick what to add. A site's fridges and freezers become the list below; everything else is added next to what you have, skipping names already in use.
            </p>
            {plan.groups.length === 0 && <p className="text-sm">There is nothing in this workbook for your tracks to add.</p>}
            <ul className="divide-y rounded-lg border">
              {plan.groups.map((group) => {
                const key = groupKey(group);
                const site = siteFor(group, sites);
                return (
                  <li key={key} className="flex gap-3 p-3" data-testid={`track-setup-group-${group.kind}`}>
                    <input type="checkbox" className="mt-1 h-4 w-4" disabled={site === undefined} checked={ticked.has(key)} onChange={() => toggle(key)}
                      aria-label={`${TRACK_SETUP[group.kind].label}${group.siteName ? ` at ${group.siteName}` : ""}`} />
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">{TRACK_SETUP[group.kind].label}{group.siteName ? ` at ${group.siteName}` : ""}</p>
                      <p className="text-muted-foreground">{describeItems(group.items)}{group.source === "count" ? " (from Counts per site)" : ""}</p>
                      {group.kind === "outlets" && group.source === "count" && (
                        <p className="text-xs text-muted-foreground">Showers are added as little-used outlets (flushed weekly). Change any that are used every day.</p>
                      )}
                      {site === undefined && (
                        <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> No site called "{group.siteName}". Add the site first, or correct the name in the workbook.</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {plan.skipped.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">Left out</p>
                <ul className="list-disc pl-4">{plan.skipped.map((line) => <li key={line}>{line}</li>)}</ul>
              </div>
            )}
          </div>
        )}
        {results && (
          <ul className="space-y-1 text-sm" data-testid="track-setup-results">
            {results.map((line) => <li key={line} className="flex gap-2"><CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />{line}</li>)}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{results ? "Close" : "Cancel"}</Button>
          {plan && !results && (
            <Button onClick={() => void addTicked()} disabled={busy || ticked.size === 0} data-testid="button-track-setup-add">
              {busy ? "Adding…" : "Add to ComplyTrack"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
