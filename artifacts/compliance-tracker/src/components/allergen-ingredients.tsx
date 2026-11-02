import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth, useCanEdit } from "@/context/auth-context";
import { useActiveClientApi } from "@/hooks/use-active-client-api";
import { useToast } from "@/hooks/use-toast";
import { useWorkingSiteId } from "@/hooks/use-working-site";
import { ConfirmDelete, ensureOk, fmtDate, todayIso, useRegisterSites } from "@/components/register-shared";
import { AllergenBadges, AllergenChangeLogDialog, AllergenTicks } from "@/components/allergen-parts";
import { ImportCsvButton } from "@/components/import-csv-dialog";
import {
  CHARTS_PATH, DISHES_PATH, INGREDIENTS_PATH, sameSet, type AllergenIngredient,
} from "@/lib/allergens";

interface IngredientForm {
  siteId: string; // "all" for every site
  name: string;
  supplier: string;
  productCode: string;
  contains: string[];
  mayContain: string[];
  notes: string;
  lastCheckedAt: string;
  checkedBy: string;
  changeReason: string;
}

function emptyForm(checkedBy: string): IngredientForm {
  return {
    siteId: "all", name: "", supplier: "", productCode: "", contains: [], mayContain: [], notes: "",
    lastCheckedAt: todayIso(), checkedBy, changeReason: "",
  };
}

/** The ingredients list: what each bought-in ingredient contains, from its label or specification. */
export function AllergenIngredientsTab({ ingredients, isLoading, error }: {
  ingredients: AllergenIngredient[];
  isLoading: boolean;
  error: Error | null;
}) {
  const { user } = useAuth();
  const canEdit = useCanEdit();
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sites, siteName } = useRegisterSites();
  const workingSiteId = useWorkingSiteId();

  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<AllergenIngredient | null>(null);
  const [form, setForm] = useState<IngredientForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AllergenIngredient | null>(null);
  const [historyItem, setHistoryItem] = useState<AllergenIngredient | null>(null);

  const visible = useMemo(() => ingredients.filter((i) =>
    !q || `${i.name} ${i.supplier ?? ""} ${i.productCode ?? ""}`.toLowerCase().includes(q.toLowerCase())), [ingredients, q]);

  const setsChanged = editing !== null && form !== null
    && (!sameSet(editing.contains, form.contains) || !sameSet(editing.mayContain, form.mayContain));

  function openNew() {
    setEditing(null);
    // A new ingredient starts on the user's working site.
    setForm({ ...emptyForm(user?.name ?? ""), siteId: workingSiteId ? String(workingSiteId) : "all" });
  }

  function openEdit(item: AllergenIngredient) {
    setEditing(item);
    setForm({
      siteId: item.siteId == null ? "all" : String(item.siteId),
      name: item.name,
      supplier: item.supplier ?? "",
      productCode: item.productCode ?? "",
      contains: [...item.contains],
      mayContain: [...item.mayContain],
      notes: item.notes ?? "",
      lastCheckedAt: item.lastCheckedAt ?? "",
      checkedBy: item.checkedBy ?? "",
      changeReason: "",
    });
  }

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/api${INGREDIENTS_PATH}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${DISHES_PATH}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api${CHARTS_PATH}`] }),
    ]);
  }

  async function save() {
    if (!form) return;
    if (!form.name.trim()) { toast({ title: "Enter the ingredient name", variant: "destructive" }); return; }
    if (setsChanged && !form.changeReason.trim()) {
      toast({ title: "Say what changed", description: "For example a new supplier or a changed product.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const response = await ensureOk(await api(editing ? `${INGREDIENTS_PATH}/${editing.id}` : INGREDIENTS_PATH, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          siteId: form.siteId === "all" ? null : Number(form.siteId),
          name: form.name,
          supplier: form.supplier || null,
          productCode: form.productCode || null,
          contains: form.contains,
          mayContain: form.mayContain,
          notes: form.notes || null,
          lastCheckedAt: form.lastCheckedAt || null,
          checkedBy: form.checkedBy || null,
          changeReason: form.changeReason || null,
        }),
      }), "Could not save");
      const saved = await response.json();
      const updated = typeof saved.dishesUpdated === "number" ? saved.dishesUpdated : 0;
      toast({
        title: editing ? "Ingredient updated" : "Ingredient added",
        description: updated > 0 ? `${updated} dish${updated === 1 ? "" : "es"} updated. Check the allergen charts again.` : undefined,
      });
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
      await ensureOk(await api(`${INGREDIENTS_PATH}/${target.id}`, { method: "DELETE" }), "Could not remove");
      toast({ title: "Ingredient removed", description: "The change log keeps a record of it." });
      await refresh();
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  const usedText = (item: AllergenIngredient) => item.usedIn.length === 0
    ? "Not in any dish"
    : `In ${item.usedIn.length} dish${item.usedIn.length === 1 ? "" : "es"}: ${item.usedIn.map((d) => d.name).join(", ")}`;

  const actions = (item: AllergenIngredient) => (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Change log for ${item.name}`} onClick={() => setHistoryItem(item)}>
        <History className="w-4 h-4" />
      </Button>
      {canEdit && (
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${item.name}`} onClick={() => openEdit(item)}>
            <Pencil className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Remove ${item.name}`}
            disabled={item.usedIn.length > 0} title={item.usedIn.length > 0 ? "Take it out of its recipes first" : undefined}
            onClick={() => setDeleteTarget(item)}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input placeholder="Search ingredients…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-xs rounded-sm w-full sm:w-56" />
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {/* Managers: a supplier's allergen sheet (spreadsheet, or a photo or PDF with the AI add-on). */}
            <ImportCsvButton type="allergen-ingredients" label="Import from supplier" className="rounded-sm h-8 text-xs"
              onImported={() => void refresh()} />
            <Button size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={openNew}>
              <Plus className="w-3.5 h-3.5" /> Add ingredient
            </Button>
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {!isLoading && !error && visible.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-muted py-12 px-4 text-center text-sm text-muted-foreground">
          {ingredients.length === 0
            ? "No ingredients yet. Add the ingredients you buy in, with the allergens from their labels, then build dishes from them."
            : "No ingredients match this search."}
        </div>
      )}

      {visible.length > 0 && (
        <div className="space-y-2">
          {visible.map((item) => (
            <div key={item.id} className="rounded-xl border border-border p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium break-words">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[item.supplier, item.productCode, item.siteId == null ? "All sites" : siteName(item.siteId)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {actions(item)}
              </div>
              <AllergenBadges contains={item.contains} mayContain={item.mayContain} />
              <p className="text-xs text-muted-foreground">{usedText(item)}</p>
              <p className="text-xs text-muted-foreground">
                Label checked: {item.lastCheckedAt ? fmtDate(item.lastCheckedAt) : "not recorded"}{item.checkedBy ? ` by ${item.checkedBy}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}

      <Dialog open={form !== null} onOpenChange={(open) => { if (!open) { setForm(null); setEditing(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit ingredient" : "Add ingredient"}</DialogTitle>
            <DialogDescription>Tick the allergens from the product label or the supplier's specification.</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-name">Ingredient *</Label>
                  <Input id="ingredient-name" value={form.name} maxLength={200} placeholder="For example: Sourdough loaf"
                    onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-site">Used at</Label>
                  <Select value={form.siteId} onValueChange={(siteId) => setForm({ ...form, siteId })}>
                    <SelectTrigger id="ingredient-site"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sites</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={String(site.id)}>{site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-supplier">Supplier</Label>
                  <Input id="ingredient-supplier" value={form.supplier} maxLength={200} onChange={(e) => setForm({ ...form, supplier: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-code">Product code</Label>
                  <Input id="ingredient-code" value={form.productCode} maxLength={100} onChange={(e) => setForm({ ...form, productCode: e.target.value })} />
                </div>
              </div>
              <AllergenTicks idPrefix="ingredient" contains={form.contains} mayContain={form.mayContain}
                onChange={(next) => setForm({ ...form, contains: next.contains, mayContain: next.mayContain })} />
              <div className="space-y-1.5">
                <Label htmlFor="ingredient-notes">Notes</Label>
                <Textarea id="ingredient-notes" rows={2} value={form.notes} maxLength={2000} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-checked">Label checked on</Label>
                  <Input id="ingredient-checked" type="date" value={form.lastCheckedAt} onChange={(e) => setForm({ ...form, lastCheckedAt: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-checker">Checked by</Label>
                  <Input id="ingredient-checker" value={form.checkedBy} maxLength={200} onChange={(e) => setForm({ ...form, checkedBy: e.target.value })} />
                </div>
              </div>
              {setsChanged && editing && editing.usedIn.length > 0 && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                  Saving updates the allergens of {editing.usedIn.length} dish{editing.usedIn.length === 1 ? "" : "es"} ({editing.usedIn.map((d) => d.name).join(", ")}),
                  and their allergen charts will need checking again.
                </p>
              )}
              {(setsChanged || !editing) && (
                <div className="space-y-1.5">
                  <Label htmlFor="ingredient-reason">{editing ? "What changed? *" : "Source or note for the change log"}</Label>
                  <Textarea id="ingredient-reason" rows={2} value={form.changeReason} maxLength={1000}
                    placeholder={editing ? "For example: new supplier, loaf now has a sesame crust" : "Optional, for example: from the supplier's spec sheet"}
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
        path={historyItem ? `${INGREDIENTS_PATH}/${historyItem.id}/changes` : null}
        removedText="Removed from the ingredients list"
        normalise={(row) => ({
          id: row.id as number,
          changeType: row.changeType as "created" | "allergens_changed" | "removed",
          before: row.containsBefore as string[] | null,
          after: row.containsAfter as string[] | null,
          mayBefore: row.mayContainBefore as string[] | null,
          mayAfter: row.mayContainAfter as string[] | null,
          reason: row.reason as string | null,
          changedByName: row.changedByName as string | null,
          createdAt: row.createdAt as string,
          dishesUpdated: row.dishesUpdated as number,
        })}
        onClose={() => setHistoryItem(null)}
      />
      <ConfirmDelete
        open={deleteTarget !== null}
        title="Remove this ingredient?"
        description={`"${deleteTarget?.name ?? ""}" will be removed from the ingredients list. The change log keeps a record of it.`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
    </div>
  );
}
