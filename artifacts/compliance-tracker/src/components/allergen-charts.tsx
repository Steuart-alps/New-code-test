import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, ClipboardCheck, History, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth, useCanEdit } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { printHtmlDocument } from "@/lib/download";
import { ConfirmDelete, SiteSelect, ensureOk } from "@/components/register-shared";
import {
  CHARTS_PATH, DISHES_PATH, MENUS_PATH, chartTitle, renderChartHtml,
  type AllergenChart, type AllergenItem, type AllergenMenu, type ChartSignoff,
} from "@/lib/allergens";

/** The dishes a chart shows: every dish at the site, or the menu's dishes. */
export function chartDishes(chart: Pick<AllergenChart, "siteId" | "menuId">, dishes: AllergenItem[]) {
  return dishes.filter((dish) => chart.menuId === null ? dish.siteId === chart.siteId : dish.menuIds.includes(chart.menuId));
}

function ChartStatus({ chart }: { chart: AllergenChart }) {
  if (!chart.lastSignoff) {
    return <Badge variant="outline" className="text-[11px] border-amber-300 bg-amber-50 text-amber-800 gap-1"><AlertTriangle className="w-3 h-3" />Not checked yet</Badge>;
  }
  const when = format(new Date(chart.lastSignoff.createdAt), "d MMM yyyy");
  if (chart.changedSinceCheck) {
    return (
      <Badge variant="outline" className="text-[11px] border-red-300 bg-red-50 text-red-700 gap-1">
        <AlertTriangle className="w-3 h-3" />Changed since checked by {chart.lastSignoff.checkedByName} on {when}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[11px] border-green-300 bg-green-50 text-green-800 gap-1">
      <CheckCircle2 className="w-3 h-3" />Checked by {chart.lastSignoff.checkedByName} on {when}
    </Badge>
  );
}

function SignoffHistoryDialog({ chart, onClose }: { chart: AllergenChart | null; onClose: () => void }) {
  const api = useActiveClientApi();
  const { activeClientId } = useAuth();
  const path = chart ? `${CHARTS_PATH}/signoffs?siteId=${chart.siteId}${chart.menuId ? `&menuId=${chart.menuId}` : ""}` : null;
  const { data: rows = [], isLoading, error } = useQuery<ChartSignoff[]>({
    queryKey: [`/api${path}`, activeClientId],
    enabled: path !== null,
    queryFn: async () => (await ensureOk(await api(path!), "Could not load the sign-offs")).json(),
  });
  return (
    <Dialog open={chart !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign-offs: {chart ? chartTitle(chart) : ""}</DialogTitle>
          <DialogDescription>Every time someone checked this chart and signed it off.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
          {!isLoading && rows.length === 0 && <p className="text-sm text-muted-foreground">Not signed off yet.</p>}
          {rows.map((row) => (
            <div key={row.id} className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{row.checkedByName}</span>
                <span className="text-xs text-muted-foreground">{format(new Date(row.createdAt), "d MMM yyyy, HH:mm")}</span>
              </div>
              <p className="text-xs text-muted-foreground">{row.dishCount} dish{row.dishCount === 1 ? "" : "es"} on the chart</p>
              {row.note && <p className="text-muted-foreground">{row.note}</p>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Charts for each site and menu, with sign-off, printing and the menus themselves. */
export function AllergenChartsTab({ charts, menus, dishes, isLoading, error }: {
  charts: AllergenChart[];
  menus: AllergenMenu[];
  dishes: AllergenItem[];
  isLoading: boolean;
  error: Error | null;
}) {
  const { user, client } = useAuth();
  const canEdit = useCanEdit();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [signing, setSigning] = useState<AllergenChart | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyChart, setHistoryChart] = useState<AllergenChart | null>(null);
  const [menuForm, setMenuForm] = useState<{ id: number | null; siteId: string; name: string } | null>(null);
  const [deleteMenu, setDeleteMenu] = useState<AllergenMenu | null>(null);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/api${CHARTS_PATH}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${MENUS_PATH}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${DISHES_PATH}`] }),
    ]);
  }

  function print(chart: AllergenChart) {
    const items = chartDishes(chart, dishes);
    if (items.length === 0) { toast({ title: "Nothing to print", description: "Add dishes to this chart first." }); return; }
    printHtmlDocument(renderChartHtml([{ title: chartTitle(chart), items, status: chart }], client?.name ?? ""));
  }

  async function signOff() {
    if (!signing) return;
    if (!confirmed) { toast({ title: "Tick the box to confirm you checked every dish", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await ensureOk(await api(`${CHARTS_PATH}/signoffs`, {
        method: "POST",
        body: JSON.stringify({ siteId: signing.siteId, menuId: signing.menuId, confirmed: true, note: note || null }),
      }), "Could not sign off");
      toast({ title: "Chart signed off", description: `Recorded as checked by ${user?.name ?? "you"}.` });
      setSigning(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not sign off", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function saveMenu() {
    if (!menuForm) return;
    if (!menuForm.name.trim()) { toast({ title: "Enter the menu name", variant: "destructive" }); return; }
    if (menuForm.id === null && !menuForm.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await ensureOk(await api(menuForm.id === null ? MENUS_PATH : `${MENUS_PATH}/${menuForm.id}`, {
        method: menuForm.id === null ? "POST" : "PUT",
        body: JSON.stringify(menuForm.id === null ? { siteId: Number(menuForm.siteId), name: menuForm.name } : { name: menuForm.name }),
      }), "Could not save the menu");
      toast({ title: menuForm.id === null ? "Menu added" : "Menu renamed", description: menuForm.id === null ? "Put dishes on it from the Dishes tab." : undefined });
      setMenuForm(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not save the menu", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function removeMenu() {
    const target = deleteMenu;
    setDeleteMenu(null);
    if (!target) return;
    try {
      await ensureOk(await api(`${MENUS_PATH}/${target.id}`, { method: "DELETE" }), "Could not remove the menu");
      toast({ title: "Menu removed" });
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove the menu", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  const bySite = new Map<number, AllergenChart[]>();
  for (const chart of charts) bySite.set(chart.siteId, [...(bySite.get(chart.siteId) ?? []), chart]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p>
          ComplyTrack works out each dish's allergens from the ingredients and ticks you enter. It does not check your
          recipes or your suppliers' labels. Before a chart goes on display, someone who knows the dishes should check
          every row and sign it off. The printed chart shows who checked it and when.
        </p>
      </div>

      <div className="flex justify-end">
        {canEdit && (
          <Button size="sm" variant="outline" className="rounded-sm h-8 text-xs gap-1.5" onClick={() => setMenuForm({ id: null, siteId: "", name: "" })}>
            <Plus className="w-3.5 h-3.5" /> Add menu
          </Button>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {!isLoading && !error && charts.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-muted py-12 px-4 text-center text-sm text-muted-foreground">
          No charts yet. Each site with dishes gets a chart, and each menu you add gets its own.
        </div>
      )}

      {[...bySite.entries()].map(([siteId, siteCharts]) => (
        <section key={siteId} className="space-y-2">
          <h3 className="text-sm font-bold">{siteCharts[0].siteName}</h3>
          {siteCharts.map((chart) => {
            const menu = chart.menuId === null ? null : menus.find((m) => m.id === chart.menuId) ?? null;
            return (
              <div key={`${chart.siteId}-${chart.menuId ?? "all"}`} className="rounded-xl border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{chart.menuName ?? "All dishes at this site"}</p>
                    <p className="text-xs text-muted-foreground">{chart.dishCount} dish{chart.dishCount === 1 ? "" : "es"}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={() => print(chart)}>
                      <Printer className="w-3.5 h-3.5" /> Print
                    </Button>
                    {canEdit && (
                      <Button size="sm" className="rounded-sm h-8 text-xs gap-1.5" disabled={chart.dishCount === 0}
                        onClick={() => { setSigning(chart); setConfirmed(false); setNote(""); }}>
                        <ClipboardCheck className="w-3.5 h-3.5" /> Sign off
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Sign-off history for ${chartTitle(chart)}`} onClick={() => setHistoryChart(chart)}>
                      <History className="w-4 h-4" />
                    </Button>
                    {canEdit && menu && (
                      <>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Rename ${menu.name}`}
                          onClick={() => setMenuForm({ id: menu.id, siteId: String(menu.siteId ?? ""), name: menu.name })}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Remove ${menu.name}`} onClick={() => setDeleteMenu(menu)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <ChartStatus chart={chart} />
              </div>
            );
          })}
        </section>
      ))}

      <Dialog open={signing !== null} onOpenChange={(open) => { if (!open) setSigning(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign off: {signing ? chartTitle(signing) : ""}</DialogTitle>
            <DialogDescription>
              Print the chart or open the Dishes tab, and check every dish against the current recipe and the labels or
              specifications of the ingredients you are using now.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm cursor-pointer">
              <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} className="mt-0.5" />
              <span>
                I have checked all {signing?.dishCount ?? 0} dishes on this chart against the current recipes and ingredient
                labels, and the allergen information is correct.
              </span>
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="signoff-note">Note (optional)</Label>
              <Textarea id="signoff-note" rows={2} maxLength={1000} value={note} placeholder="For example: checked with the head chef"
                onChange={(e) => setNote(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">This is recorded as checked by {user?.name ?? "you"}, today.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSigning(null)} disabled={busy}>Cancel</Button>
            <Button onClick={signOff} disabled={busy || !confirmed}>{busy ? "Saving…" : "Sign off"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={menuForm !== null} onOpenChange={(open) => { if (!open) setMenuForm(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{menuForm?.id === null ? "Add menu" : "Rename menu"}</DialogTitle>
            <DialogDescription>A menu gets its own allergen chart. Put dishes on it from the Dishes tab.</DialogDescription>
          </DialogHeader>
          {menuForm && (
            <div className="space-y-3">
              {menuForm.id === null && (
                <SiteSelect id="menu-site" value={menuForm.siteId} onChange={(siteId) => setMenuForm({ ...menuForm, siteId })} />
              )}
              <div className="space-y-1.5">
                <Label htmlFor="menu-name">Menu name *</Label>
                <Input id="menu-name" value={menuForm.name} maxLength={100} placeholder="For example: Lunch, Bar menu, Sunday carvery"
                  onChange={(e) => setMenuForm({ ...menuForm, name: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMenuForm(null)} disabled={busy}>Cancel</Button>
            <Button onClick={saveMenu} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SignoffHistoryDialog chart={historyChart} onClose={() => setHistoryChart(null)} />
      <ConfirmDelete
        open={deleteMenu !== null}
        title="Remove this menu?"
        description={`"${deleteMenu?.name ?? ""}" and its chart will be removed. The dishes stay, and past sign-offs are kept for the record.`}
        onCancel={() => setDeleteMenu(null)}
        onConfirm={removeMenu}
      />
    </div>
  );
}
