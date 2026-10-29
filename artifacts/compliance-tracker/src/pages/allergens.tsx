import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Download, History, Info, Lock, Pencil, Plus, Printer, Search, Trash2, UtensilsCrossed, Wheat, X,
} from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth, useCanAdmin, useCanEdit } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { printHtmlDocument } from "@/lib/download";
import { cn } from "@/lib/utils";
import {
  ConfirmDelete, SiteFilter, SiteSelect, downloadCsv, ensureOk, fmtDate, todayIso,
  useRegisterList, useRegisterSites,
} from "@/components/register-shared";
import { AllergenBadges, AllergenChangeLogDialog, AllergenTicks } from "@/components/allergen-parts";
import { AllergenIngredientsTab } from "@/components/allergen-ingredients";
import { AllergenChartsTab, chartDishes } from "@/components/allergen-charts";
import {
  ALLERGENS, CHARTS_PATH, DISHES_PATH, INGREDIENTS_PATH, MENUS_PATH,
  chartTitle, combineIngredients, renderChartHtml, sameSet,
  type AllergenChart, type AllergenIngredient, type AllergenItem, type AllergenMenu,
} from "@/lib/allergens";
import { useFocusNewRow } from "@/hooks/use-focus-new-row";
import { useSiteFilter } from "@/hooks/use-own-site";

interface LineForm {
  ingredientId: string;
  quantity: string;
  unit: string;
}

interface FormState {
  siteId: string;
  name: string;
  description: string;
  mode: "recipe" | "hand";
  lines: LineForm[];
  allergens: string[];
  mayContain: string[];
  menuIds: number[];
  ppds: boolean;
  lastReviewedAt: string;
  reviewedBy: string;
  changeReason: string;
}

function emptyForm(siteId: string, reviewer: string, hasIngredients: boolean): FormState {
  return {
    siteId, name: "", description: "", mode: hasIngredients ? "recipe" : "hand", lines: [],
    allergens: [], mayContain: [], menuIds: [], ppds: false,
    lastReviewedAt: todayIso(), reviewedBy: reviewer, changeReason: "",
  };
}

export default function AllergensPage() {
  const { hasService, user, client } = useAuth();
  const canEdit = useCanEdit();
  const canAdmin = useCanAdmin();
  const enabled = hasService("kitchentrack");
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { siteName } = useRegisterSites();

  const [tab, setTab] = useState("dishes");
  const [siteFilter, setSiteFilter] = useSiteFilter("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<AllergenItem | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const newRow = useFocusNewRow();
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AllergenItem | null>(null);
  const [historyItem, setHistoryItem] = useState<AllergenItem | null>(null);

  const { data: items = [], isLoading, error } = useRegisterList<AllergenItem>(DISHES_PATH, enabled);
  const ingredientsQuery = useRegisterList<AllergenIngredient>(INGREDIENTS_PATH, enabled);
  const menusQuery = useRegisterList<AllergenMenu>(MENUS_PATH, enabled);
  const chartsQuery = useRegisterList<AllergenChart>(CHARTS_PATH, enabled);
  const ingredients = ingredientsQuery.data ?? [];
  const menus = menusQuery.data ?? [];
  const charts = chartsQuery.data ?? [];

  const visible = useMemo(() => items.filter((item) =>
    (siteFilter === "all" || String(item.siteId) === siteFilter)
    && (!q || `${item.name} ${item.description ?? ""} ${item.ingredients.map((i) => i.name).join(" ")}`.toLowerCase().includes(q.toLowerCase())),
  ), [items, siteFilter, q]);

  // Ingredients usable for the dish's site: every-site ones and that site's own.
  const formIngredients = useMemo(() => form
    ? ingredients.filter((i) => i.siteId === null || String(i.siteId) === form.siteId)
    : [], [ingredients, form]);
  const formMenus = useMemo(() => form ? menus.filter((m) => String(m.siteId) === form.siteId) : [], [menus, form]);

  // What the dish will contain once saved.
  const preview = useMemo(() => {
    if (!form) return { contains: [] as string[], mayContain: [] as string[] };
    if (form.mode === "hand") return { contains: form.allergens, mayContain: form.mayContain.filter((k) => !form.allergens.includes(k)) };
    const chosen = form.lines.map((line) => ingredients.find((i) => String(i.id) === line.ingredientId)).filter((i): i is AllergenIngredient => !!i);
    return combineIngredients(chosen);
  }, [form, ingredients]);

  const recipeEmpty = form?.mode === "recipe" && form.lines.filter((l) => l.ingredientId).length === 0;
  const setsChanged = editing !== null && form !== null && !recipeEmpty
    && (!sameSet(editing.allergens, preview.contains) || !sameSet(editing.mayContain ?? [], preview.mayContain));

  if (!enabled) {
    return (
      <AppLayout title="Allergen records">
        <div className="max-w-xl mx-auto mt-12 rounded-xl border-2 border-primary/20 bg-primary/5 p-8 text-center space-y-4">
          <Lock className="w-8 h-8 text-primary mx-auto" />
          <h2 className="text-xl font-bold">Allergen records are part of KitchenTrack</h2>
          {canAdmin
            ? <Link href="/settings"><Button>Enable KitchenTrack</Button></Link>
            : <p className="text-sm text-muted-foreground">Ask your account admin to enable KitchenTrack.</p>}
        </div>
      </AppLayout>
    );
  }

  function openNew() {
    setEditing(null);
    setForm(emptyForm(siteFilter !== "all" ? siteFilter : "", user?.name ?? "", ingredients.length > 0));
  }

  function openEdit(item: AllergenItem) {
    setEditing(item);
    setForm({
      siteId: item.siteId == null ? "" : String(item.siteId),
      name: item.name,
      description: item.description ?? "",
      mode: item.ingredients.length > 0 ? "recipe" : "hand",
      lines: item.ingredients.map((line) => ({
        ingredientId: String(line.ingredientId),
        quantity: line.quantity == null ? "" : String(line.quantity),
        unit: line.unit ?? "",
      })),
      allergens: [...item.allergens],
      mayContain: [...(item.mayContain ?? [])],
      menuIds: [...item.menuIds],
      ppds: item.ppds,
      lastReviewedAt: item.lastReviewedAt ?? "",
      reviewedBy: item.reviewedBy ?? "",
      changeReason: "",
    });
  }

  function updateLine(index: number, patch: Partial<LineForm>) {
    setForm((prev) => prev && ({ ...prev, lines: prev.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) }));
  }

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/api${DISHES_PATH}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${INGREDIENTS_PATH}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${CHARTS_PATH}`] }),
    ]);
  }

  async function save() {
    if (!form) return;
    if (!form.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    if (!form.name.trim()) { toast({ title: "Enter the dish or product name", variant: "destructive" }); return; }
    const lines = form.mode === "recipe" ? form.lines.filter((line) => line.ingredientId) : [];
    if (form.mode === "recipe" && lines.length === 0) {
      toast({ title: "Add the ingredients", description: "Or choose \"Tick allergens by hand\".", variant: "destructive" });
      return;
    }
    if (new Set(lines.map((l) => l.ingredientId)).size !== lines.length) {
      toast({ title: "Each ingredient once", description: "An ingredient is listed twice.", variant: "destructive" });
      return;
    }
    if (setsChanged && !form.changeReason.trim()) {
      toast({ title: "Say what changed", description: "Give the recipe or supplier change behind the new allergens.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        siteId: Number(form.siteId),
        name: form.name,
        description: form.description || null,
        allergens: form.mode === "hand" ? form.allergens : [],
        mayContain: form.mode === "hand" ? form.mayContain : [],
        ingredients: lines.map((line) => ({
          ingredientId: Number(line.ingredientId),
          quantity: line.quantity.trim() && Number(line.quantity) > 0 ? Number(line.quantity) : null,
          unit: line.unit.trim() || null,
        })),
        // Only menus at the chosen site.
        menuIds: form.menuIds.filter((id) => formMenus.some((m) => m.id === id)),
        ppds: form.ppds,
        lastReviewedAt: form.lastReviewedAt || null,
        reviewedBy: form.reviewedBy || null,
        changeReason: form.changeReason || null,
      };
      await ensureOk(await api(editing ? `${DISHES_PATH}/${editing.id}` : DISHES_PATH, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(body),
      }), "Could not save");
      toast({ title: editing ? "Allergen record updated" : "Allergen record added" });
      setForm(null);
      setEditing(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await ensureOk(await api(`${DISHES_PATH}/${target.id}`, { method: "DELETE" }), "Could not remove");
      toast({ title: "Removed from the register", description: "The change log keeps a record of it." });
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  // Whole-site charts for the chosen site(s), with their sign-off status.
  function printSiteCharts() {
    const siteCharts = charts.filter((c) => c.menuId === null && (siteFilter === "all" || String(c.siteId) === siteFilter));
    const printable = siteCharts
      .map((chart) => ({ title: chartTitle(chart), items: chartDishes(chart, items), status: chart }))
      .filter((chart) => chart.items.length > 0);
    if (printable.length === 0) { toast({ title: "Nothing to print", description: "Add dishes or products first." }); return; }
    printHtmlDocument(renderChartHtml(printable, client?.name ?? ""));
  }

  function exportCsv() {
    downloadCsv(`allergen-records-${todayIso()}.csv`,
      ["Site", "Dish / product", "Description", "Ingredients", ...ALLERGENS.map((a) => a.label), "Prepacked for direct sale", "Last reviewed", "Reviewed by"],
      visible.map((item) => [
        siteName(item.siteId), item.name, item.description ?? "", item.ingredients.map((i) => i.name).join("; "),
        ...ALLERGENS.map((a) => (item.allergens.includes(a.key) ? "Contains" : (item.mayContain ?? []).includes(a.key) ? "May contain" : "")),
        item.ppds ? "Yes" : "No", fmtDate(item.lastReviewedAt), item.reviewedBy ?? "",
      ]));
  }

  const menuNames = (item: AllergenItem) => item.menuIds.map((id) => menus.find((m) => m.id === id)?.name).filter(Boolean).join(", ");

  const actions = (item: AllergenItem) => (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Change log for ${item.name}`} onClick={() => setHistoryItem(item)}>
        <History className="w-4 h-4" />
      </Button>
      {canEdit && (
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${item.name}`} onClick={() => openEdit(item)}>
            <Pencil className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Remove ${item.name}`} onClick={() => setDeleteTarget(item)}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );

  const needsCheck = charts.filter((c) => c.dishCount > 0 && (!c.lastSignoff || c.changedSinceCheck)).length;

  return (
    <AppLayout title="Allergen records">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-sm bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
              <Wheat className="w-4 h-4 text-amber-700" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Allergen records</h1>
              <p className="text-xs text-muted-foreground">Ingredients, dishes and allergen charts for the 14 regulated allergens</p>
            </div>
          </div>
          <Link href="/kitchen">
            <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5">
              <UtensilsCrossed className="w-3.5 h-3.5" /> KitchenTrack
            </Button>
          </Link>
        </div>

        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            These records support your allergen controls under the Food Information Regulations 2014. Add your
            ingredients from their labels, build dishes from them, and sign off each chart before it goes on display.
            Food that is prepacked for direct sale (PPDS) also needs a label with the name and full ingredients list,
            with the 14 allergens emphasised (Natasha's Law). Review the records whenever a recipe or supplier changes.
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="dishes">Dishes ({items.length})</TabsTrigger>
            <TabsTrigger value="ingredients">Ingredients ({ingredients.length})</TabsTrigger>
            <TabsTrigger value="charts">
              Charts{needsCheck > 0 && <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-[10px] border-amber-300 bg-amber-50 text-amber-800">{needsCheck} to check</Badge>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dishes" className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
              <div className="flex flex-col sm:flex-row gap-2">
                <SiteFilter value={siteFilter} onChange={setSiteFilter} />
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <Input placeholder="Search dishes…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-xs rounded-sm w-full sm:w-48" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={printSiteCharts}>
                  <Printer className="w-3.5 h-3.5" /> Print chart
                </Button>
                <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={exportCsv} disabled={visible.length === 0}>
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </Button>
                {canEdit && (
                  <Button size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={openNew}>
                    <Plus className="w-3.5 h-3.5" /> Add dish or product
                  </Button>
                )}
              </div>
            </div>

            {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
            {!isLoading && !error && visible.length === 0 && (
              <div className="rounded-xl border-2 border-dashed border-muted py-12 text-center text-sm text-muted-foreground">
                {items.length === 0 ? "No dishes or products recorded yet." : "No records match this filter."}
              </div>
            )}

            {visible.length > 0 && (
              <>
                {/* Matrix (tablet and desktop) */}
                <div className="hidden md:block border border-border rounded-xl overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left font-medium p-2 min-w-[180px]">Dish / product</th>
                        {ALLERGENS.map((a) => (
                          <th key={a.key} className="p-1 align-bottom font-medium text-[11px] w-9" title={a.label}>
                            <span className="inline-block [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">{a.short}</span>
                          </th>
                        ))}
                        <th className="text-left font-medium p-2">Reviewed</th>
                        <th className="p-2"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((item) => (
                        <tr key={item.id} className="border-t border-border">
                          <td className="p-2 align-top">
                            <p className="font-medium">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{siteName(item.siteId)}{menuNames(item) ? ` · ${menuNames(item)}` : ""}</p>
                            {item.ingredients.length > 0 && (
                              <p className="text-[11px] text-muted-foreground mt-0.5">From recipe: {item.ingredients.map((i) => i.name).join(", ")}</p>
                            )}
                            {item.ppds && <Badge variant="outline" className="mt-1 text-[10px] border-amber-300 bg-amber-50 text-amber-800">PPDS: full label needed</Badge>}
                          </td>
                          {ALLERGENS.map((a) => {
                            const contains = item.allergens.includes(a.key);
                            const may = !contains && (item.mayContain ?? []).includes(a.key);
                            return (
                              <td key={a.key} className={cn("text-center", contains && "bg-red-50 text-red-700 font-bold", may && "bg-amber-50 text-amber-800 font-semibold")}>
                                {contains ? <span aria-label={`Contains ${a.label}`}>✓</span> : may ? <span aria-label={`May contain ${a.label}`}>M</span> : ""}
                              </td>
                            );
                          })}
                          <td className="p-2 text-xs text-muted-foreground align-top whitespace-nowrap">
                            {item.lastReviewedAt ? fmtDate(item.lastReviewedAt) : "Not recorded"}
                            {item.reviewedBy && <div>{item.reviewedBy}</div>}
                          </td>
                          <td className="p-2 align-top">{actions(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-muted-foreground p-2 border-t border-border">✓ contains · M may contain traces</p>
                </div>

                {/* Cards (phones) */}
                <div className="md:hidden space-y-3">
                  {visible.map((item) => (
                    <div key={item.id} className="rounded-xl border border-border p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium break-words">{item.name}</p>
                          <p className="text-xs text-muted-foreground">{siteName(item.siteId)}{menuNames(item) ? ` · ${menuNames(item)}` : ""}</p>
                        </div>
                        {actions(item)}
                      </div>
                      <AllergenBadges contains={item.allergens} mayContain={item.mayContain ?? []} />
                      {item.ingredients.length > 0 && (
                        <p className="text-xs text-muted-foreground">Made with: {item.ingredients.map((i) => i.name).join(", ")}</p>
                      )}
                      {item.ppds && <Badge variant="outline" className="text-[10px] border-amber-300 bg-amber-50 text-amber-800">PPDS: full label needed</Badge>}
                      <p className="text-xs text-muted-foreground">
                        Reviewed: {item.lastReviewedAt ? fmtDate(item.lastReviewedAt) : "not recorded"}{item.reviewedBy ? ` by ${item.reviewedBy}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="ingredients">
            <AllergenIngredientsTab ingredients={ingredients} isLoading={ingredientsQuery.isLoading} error={ingredientsQuery.error as Error | null} />
          </TabsContent>

          <TabsContent value="charts">
            <AllergenChartsTab charts={charts} menus={menus} dishes={items}
              isLoading={chartsQuery.isLoading} error={chartsQuery.error as Error | null} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={form !== null} onOpenChange={(open) => { if (!open) { setForm(null); setEditing(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit allergen record" : "Add dish or product"}</DialogTitle>
            <DialogDescription>Build the dish from your ingredients, or tick its allergens by hand.</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SiteSelect value={form.siteId} onChange={(siteId) => setForm({ ...form, siteId })} />
                <div className="space-y-1.5">
                  <Label htmlFor="allergen-name">Dish or product *</Label>
                  <Input id="allergen-name" value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="allergen-description">Description</Label>
                <Textarea id="allergen-description" rows={2} value={form.description} maxLength={2000} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>

              <div className="space-y-2">
                <Label>How are the allergens worked out?</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {([["recipe", "From the ingredients"], ["hand", "Tick allergens by hand"]] as const).map(([mode, label]) => (
                    <Button key={mode} type="button" variant={form.mode === mode ? "default" : "outline"} size="sm"
                      onClick={() => setForm({ ...form, mode })}>{label}</Button>
                  ))}
                </div>
              </div>

              {form.mode === "recipe" ? (
                <div ref={newRow.ref} className="space-y-2">
                  {formIngredients.length === 0 && (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                      No ingredients for this site yet. Add them on the Ingredients tab first.
                    </p>
                  )}
                  {form.lines.map((line, index) => (
                    <div key={index} className="flex flex-wrap sm:flex-nowrap items-end gap-2">
                      <div className="space-y-1 flex-1 min-w-[180px]">
                        {index === 0 && <Label className="text-xs">Ingredient</Label>}
                        <Select value={line.ingredientId} onValueChange={(ingredientId) => updateLine(index, { ingredientId })}>
                          <SelectTrigger aria-label={`Ingredient ${index + 1}`}><SelectValue placeholder="Choose an ingredient" /></SelectTrigger>
                          <SelectContent>
                            {formIngredients.map((i) => (
                              <SelectItem key={i.id} value={String(i.id)}>{i.name}{i.supplier ? ` (${i.supplier})` : ""}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1 w-20">
                        {index === 0 && <Label className="text-xs">Amount</Label>}
                        <Input inputMode="decimal" aria-label={`Amount ${index + 1}`} value={line.quantity} placeholder="Optional"
                          onChange={(e) => updateLine(index, { quantity: e.target.value })} />
                      </div>
                      <div className="space-y-1 w-20">
                        {index === 0 && <Label className="text-xs">Unit</Label>}
                        <Input aria-label={`Unit ${index + 1}`} value={line.unit} maxLength={20} placeholder="g, ml…"
                          onChange={(e) => updateLine(index, { unit: e.target.value })} />
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Remove ingredient ${index + 1}`}
                        onClick={() => setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) })}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={formIngredients.length === 0}
                    onClick={() => { newRow.expect(); setForm({ ...form, lines: [...form.lines, { ingredientId: "", quantity: "", unit: "" }] }); }}>
                    <Plus className="w-3.5 h-3.5" /> Add ingredient
                  </Button>
                  <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1">
                    <p className="text-xs font-medium">This dish will show</p>
                    <AllergenBadges contains={preview.contains} mayContain={preview.mayContain}
                      emptyText={recipeEmpty ? "Add ingredients to see the allergens" : "None of the 14 allergens"} />
                  </div>
                </div>
              ) : (
                <AllergenTicks idPrefix="dish" contains={form.allergens} mayContain={form.mayContain}
                  onChange={(next) => setForm({ ...form, allergens: next.contains, mayContain: next.mayContain })} />
              )}

              {formMenus.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">On these menus</legend>
                  <div className="flex flex-wrap gap-2">
                    {formMenus.map((menu) => (
                      <label key={menu.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm cursor-pointer">
                        <Checkbox checked={form.menuIds.includes(menu.id)}
                          onCheckedChange={(checked) => setForm({
                            ...form,
                            menuIds: checked === true ? [...form.menuIds.filter((id) => id !== menu.id), menu.id] : form.menuIds.filter((id) => id !== menu.id),
                          })} />
                        {menu.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="allergen-ppds">Prepacked for direct sale (PPDS)</Label>
                  <Switch id="allergen-ppds" checked={form.ppds} onCheckedChange={(ppds) => setForm({ ...form, ppds })} />
                </div>
                {form.ppds && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                    PPDS food needs a label showing the name of the food and a full ingredients list with the allergens
                    emphasised (for example in bold). Check the label matches these allergens.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="allergen-reviewed">Last reviewed</Label>
                  <Input id="allergen-reviewed" type="date" value={form.lastReviewedAt} onChange={(e) => setForm({ ...form, lastReviewedAt: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="allergen-reviewer">Reviewed by</Label>
                  <Input id="allergen-reviewer" value={form.reviewedBy} maxLength={200} onChange={(e) => setForm({ ...form, reviewedBy: e.target.value })} />
                </div>
              </div>
              {(setsChanged || !editing) && (
                <div className="space-y-1.5">
                  <Label htmlFor="allergen-reason">
                    {editing ? "What changed? (recipe or supplier) *" : "Source or note for the change log"}
                  </Label>
                  <Textarea id="allergen-reason" rows={2} value={form.changeReason} maxLength={1000}
                    placeholder={editing ? "For example: new supplier for the bread, now contains sesame" : "Optional"}
                    onChange={(e) => setForm({ ...form, changeReason: e.target.value })} />
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setForm(null); setEditing(null); }} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AllergenChangeLogDialog
        title={historyItem?.name ?? null}
        path={historyItem ? `${DISHES_PATH}/${historyItem.id}/changes` : null}
        removedText="Removed from the register"
        normalise={(row) => ({
          id: row.id as number,
          changeType: row.changeType as "created" | "allergens_changed" | "removed",
          before: row.allergensBefore as string[] | null,
          after: row.allergensAfter as string[] | null,
          mayBefore: row.mayContainBefore as string[] | null,
          mayAfter: row.mayContainAfter as string[] | null,
          reason: row.reason as string | null,
          changedByName: row.changedByName as string | null,
          createdAt: row.createdAt as string,
        })}
        onClose={() => setHistoryItem(null)}
      />
      <ConfirmDelete
        open={deleteTarget !== null}
        title="Remove this dish or product?"
        description={`"${deleteTarget?.name ?? ""}" will be removed from the register and its allergen charts. The change log keeps a record of it.`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
    </AppLayout>
  );
}
