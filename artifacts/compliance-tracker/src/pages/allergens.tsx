import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Download, History, Info, Lock, Pencil, Plus, Printer, Search, Trash2, UtensilsCrossed, Wheat,
} from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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

// The 14 allergens in Schedule 1 of the Food Information Regulations 2014
// (retained Regulation (EU) 1169/2011, Annex II). Keys match the API.
export const ALLERGENS = [
  { key: "celery", label: "Celery", short: "Celery" },
  { key: "gluten", label: "Cereals containing gluten", short: "Gluten" },
  { key: "crustaceans", label: "Crustaceans", short: "Crustaceans" },
  { key: "eggs", label: "Eggs", short: "Eggs" },
  { key: "fish", label: "Fish", short: "Fish" },
  { key: "lupin", label: "Lupin", short: "Lupin" },
  { key: "milk", label: "Milk", short: "Milk" },
  { key: "molluscs", label: "Molluscs", short: "Molluscs" },
  { key: "mustard", label: "Mustard", short: "Mustard" },
  { key: "tree_nuts", label: "Tree nuts", short: "Tree nuts" },
  { key: "peanuts", label: "Peanuts", short: "Peanuts" },
  { key: "sesame", label: "Sesame", short: "Sesame" },
  { key: "soya", label: "Soya", short: "Soya" },
  { key: "sulphites", label: "Sulphur dioxide / sulphites (over 10 mg/kg or litre)", short: "Sulphites" },
] as const;

const LABEL: Record<string, string> = Object.fromEntries(ALLERGENS.map((a) => [a.key, a.label]));
const SHORT: Record<string, string> = Object.fromEntries(ALLERGENS.map((a) => [a.key, a.short]));

interface AllergenItem {
  id: number;
  siteId: number | null;
  name: string;
  description: string | null;
  allergens: string[];
  ppds: boolean;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
}

interface AllergenChange {
  id: number;
  changeType: "created" | "allergens_changed" | "removed";
  allergensBefore: string[] | null;
  allergensAfter: string[] | null;
  reason: string | null;
  changedByName: string | null;
  createdAt: string;
}

interface FormState {
  siteId: string;
  name: string;
  description: string;
  allergens: string[];
  ppds: boolean;
  lastReviewedAt: string;
  reviewedBy: string;
  changeReason: string;
}

const LIST_PATH = "/registers/allergens";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/** Printable front-of-house allergen matrix, one table per site. */
function renderMatrixHtml(groups: { site: string; items: AllergenItem[] }[], businessName: string): string {
  const head = ALLERGENS.map((a) => `<th class="allergen"><span>${escapeHtml(a.short)}</span></th>`).join("");
  const sections = groups.map(({ site, items }) => {
    const rows = items.map((item) => {
      const cells = ALLERGENS.map((a) => item.allergens.includes(a.key)
        ? `<td class="yes" aria-label="Contains ${escapeHtml(a.label)}">&#10004;</td>`
        : `<td></td>`).join("");
      const ppds = item.ppds ? `<div class="ppds">Prepacked for direct sale: see full ingredients label</div>` : "";
      return `<tr><td class="dish"><strong>${escapeHtml(item.name)}</strong>${item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : ""}${ppds}</td>${cells}</tr>`;
    }).join("");
    return `<section><h2>${escapeHtml(site)}</h2><table><thead><tr><th class="dish">Dish / product</th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join("");
  const reviewed = groups.flatMap((g) => g.items).map((i) => i.lastReviewedAt).filter(Boolean).sort().pop();
  return `<!doctype html><html><head><title>Allergen information</title>
    <style>
      @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;margin:0;font-size:10pt}
      h1{font-size:18pt;margin:0 0 2px}h2{font-size:12pt;margin:14px 0 6px}.sub{margin:0 0 8px;color:#52606d}
      table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #7b8794;padding:4px;text-align:center;vertical-align:middle}
      th.dish,td.dish{text-align:left;width:24%}th.allergen{height:96px;vertical-align:bottom;font-size:8.5pt;padding:2px}
      th.allergen span{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap}
      td.yes{font-weight:bold;font-size:12pt;background:#fde2e1;color:#8a1c1c}.desc{font-size:8pt;color:#52606d}
      .ppds{font-size:8pt;color:#8a4b00;margin-top:2px}.notice{border:2px solid #172033;padding:8px;margin:10px 0;font-weight:bold}
      .foot{margin-top:10px;font-size:8pt;color:#52606d}tr{break-inside:avoid}section{break-inside:auto}
      @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
    </style></head><body>
    <h1>Allergen information${businessName ? ` &ndash; ${escapeHtml(businessName)}` : ""}</h1>
    <p class="sub">A tick means the dish or product contains that allergen as an ingredient.</p>
    <div class="notice">If you have a food allergy or intolerance, please speak to a member of staff before you order.</div>
    ${sections}
    <p class="foot">Printed ${escapeHtml(format(new Date(), "d MMM yyyy"))}${reviewed ? ` &middot; last reviewed ${escapeHtml(fmtDate(reviewed))}` : ""}. Recipes and suppliers can change: check this sheet is current.</p>
    </body></html>`;
}

function emptyForm(siteId: string, reviewer: string): FormState {
  return { siteId, name: "", description: "", allergens: [], ppds: false, lastReviewedAt: todayIso(), reviewedBy: reviewer, changeReason: "" };
}

function ChangeHistoryDialog({ item, onClose }: { item: AllergenItem | null; onClose: () => void }) {
  const api = useActiveClientApi();
  const { activeClientId } = useAuth();
  const { data: changes = [], isLoading, error } = useQuery<AllergenChange[]>({
    queryKey: [`/api${LIST_PATH}/${item?.id}/changes`, activeClientId],
    enabled: item !== null,
    queryFn: async () => (await ensureOk(await api(`${LIST_PATH}/${item!.id}/changes`), "Could not load the change log")).json(),
  });
  const describe = (change: AllergenChange) => {
    if (change.changeType === "created") return `Added with: ${(change.allergensAfter ?? []).map((k) => SHORT[k] ?? k).join(", ") || "no allergens"}`;
    if (change.changeType === "removed") return "Removed from the register";
    const before = change.allergensBefore ?? [];
    const after = change.allergensAfter ?? [];
    const added = after.filter((k) => !before.includes(k)).map((k) => SHORT[k] ?? k);
    const removed = before.filter((k) => !after.includes(k)).map((k) => SHORT[k] ?? k);
    return [added.length ? `Added: ${added.join(", ")}` : "", removed.length ? `Removed: ${removed.join(", ")}` : ""].filter(Boolean).join(" · ");
  };
  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Change log: {item?.name}</DialogTitle>
          <DialogDescription>Each allergen change is kept with the recipe or supplier reason given.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
          {changes.map((change) => (
            <div key={change.id} className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{format(new Date(change.createdAt), "d MMM yyyy, HH:mm")}</span>
                <span>{change.changedByName ?? "Unknown user"}</span>
              </div>
              <p className="font-medium">{describe(change)}</p>
              {change.reason && <p className="text-muted-foreground">Reason: {change.reason}</p>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AllergensPage() {
  const { hasService, user, client } = useAuth();
  const canEdit = useCanEdit();
  const canAdmin = useCanAdmin();
  const enabled = hasService("kitchentrack");
  const api = useActiveClientApi();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sites, siteName } = useRegisterSites();

  const [siteFilter, setSiteFilter] = useState("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<AllergenItem | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AllergenItem | null>(null);
  const [historyItem, setHistoryItem] = useState<AllergenItem | null>(null);

  const { data: items = [], isLoading, error } = useRegisterList<AllergenItem>(LIST_PATH, enabled);
  const visible = useMemo(() => items.filter((item) =>
    (siteFilter === "all" || String(item.siteId) === siteFilter)
    && (!q || `${item.name} ${item.description ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  ), [items, siteFilter, q]);

  const ticksChanged = editing !== null && form !== null
    && (editing.allergens.length !== form.allergens.length || editing.allergens.some((k) => !form.allergens.includes(k)));

  if (!enabled) {
    return (
      <AppLayout title="Allergen records">
        <div className="max-w-xl mx-auto mt-12 rounded-xl border-2 border-primary/20 bg-primary/5 p-8 text-center space-y-4">
          <Lock className="w-8 h-8 text-primary mx-auto" />
          <h2 className="text-xl font-medium">Allergen records are part of KitchenTrack</h2>
          {canAdmin
            ? <Link href="/settings"><Button>Enable KitchenTrack</Button></Link>
            : <p className="text-sm text-muted-foreground">Ask your account admin to enable KitchenTrack.</p>}
        </div>
      </AppLayout>
    );
  }

  function openNew() {
    setEditing(null);
    setForm(emptyForm(siteFilter !== "all" ? siteFilter : sites.length === 1 ? String(sites[0].id) : "", user?.name ?? ""));
  }

  function openEdit(item: AllergenItem) {
    setEditing(item);
    setForm({
      siteId: item.siteId == null ? "" : String(item.siteId),
      name: item.name,
      description: item.description ?? "",
      allergens: [...item.allergens],
      ppds: item.ppds,
      lastReviewedAt: item.lastReviewedAt ?? "",
      reviewedBy: item.reviewedBy ?? "",
      changeReason: "",
    });
  }

  function toggleAllergen(key: string, checked: boolean) {
    setForm((prev) => prev && ({
      ...prev,
      allergens: checked ? [...prev.allergens.filter((k) => k !== key), key] : prev.allergens.filter((k) => k !== key),
    }));
  }

  async function save() {
    if (!form) return;
    if (!form.siteId) { toast({ title: "Choose a site", variant: "destructive" }); return; }
    if (!form.name.trim()) { toast({ title: "Enter the dish or product name", variant: "destructive" }); return; }
    if (ticksChanged && !form.changeReason.trim()) {
      toast({ title: "Say what changed", description: "Give the recipe or supplier change behind the new allergen ticks.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        siteId: Number(form.siteId),
        name: form.name,
        description: form.description || null,
        allergens: form.allergens,
        ppds: form.ppds,
        lastReviewedAt: form.lastReviewedAt || null,
        reviewedBy: form.reviewedBy || null,
        changeReason: form.changeReason || null,
      };
      await ensureOk(await api(editing ? `${LIST_PATH}/${editing.id}` : LIST_PATH, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(body),
      }), "Could not save");
      toast({ title: editing ? "Allergen record updated" : "Allergen record added" });
      setForm(null);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: [`/api${LIST_PATH}`] });
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
      await ensureOk(await api(`${LIST_PATH}/${target.id}`, { method: "DELETE" }), "Could not remove");
      toast({ title: "Removed from the register", description: "The change log keeps a record of it." });
      await queryClient.invalidateQueries({ queryKey: [`/api${LIST_PATH}`] });
    } catch (err) {
      toast({ title: "Could not remove", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  function groupsForPrint() {
    const bySite = new Map<string, AllergenItem[]>();
    for (const item of visible) {
      const name = siteName(item.siteId);
      bySite.set(name, [...(bySite.get(name) ?? []), item]);
    }
    return [...bySite.entries()].map(([site, list]) => ({ site, items: list }));
  }

  function printMatrix() {
    if (visible.length === 0) { toast({ title: "Nothing to print", description: "Add dishes or products first." }); return; }
    printHtmlDocument(renderMatrixHtml(groupsForPrint(), client?.name ?? ""));
  }

  function exportCsv() {
    downloadCsv(`allergen-records-${todayIso()}.csv`,
      ["Site", "Dish / product", "Description", ...ALLERGENS.map((a) => a.label), "Prepacked for direct sale", "Last reviewed", "Reviewed by"],
      visible.map((item) => [
        siteName(item.siteId), item.name, item.description ?? "",
        ...ALLERGENS.map((a) => (item.allergens.includes(a.key) ? "Yes" : "")),
        item.ppds ? "Yes" : "No", fmtDate(item.lastReviewedAt), item.reviewedBy ?? "",
      ]));
  }

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

  return (
    <AppLayout title="Allergen records">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-sm bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
              <Wheat className="w-4 h-4 text-amber-700" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Allergen records</h1>
              <p className="text-xs text-muted-foreground">The 14 regulated allergens for each dish or product, by site</p>
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
            These records support your allergen controls under the Food Information Regulations 2014. Food that is
            prepacked for direct sale (PPDS) also needs a label with the name and full ingredients list, with the
            14 allergens emphasised (Natasha's Law). Review the records whenever a recipe or supplier changes.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <div className="flex flex-col sm:flex-row gap-2">
            <SiteFilter value={siteFilter} onChange={setSiteFilter} />
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input placeholder="Search dishes…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-xs rounded-sm w-full sm:w-48" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="rounded-sm h-8 text-xs gap-1.5" onClick={printMatrix}>
              <Printer className="w-3.5 h-3.5" /> Print matrix
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
                        <p className="text-xs text-muted-foreground">{siteName(item.siteId)}</p>
                        {item.ppds && <Badge variant="outline" className="mt-1 text-[10px] border-amber-300 bg-amber-50 text-amber-800">PPDS: full label needed</Badge>}
                      </td>
                      {ALLERGENS.map((a) => (
                        <td key={a.key} className={cn("text-center", item.allergens.includes(a.key) && "bg-red-50 text-red-700 font-bold")}>
                          {item.allergens.includes(a.key) ? <span aria-label={`Contains ${a.label}`}>✓</span> : ""}
                        </td>
                      ))}
                      <td className="p-2 text-xs text-muted-foreground align-top whitespace-nowrap">
                        {item.lastReviewedAt ? fmtDate(item.lastReviewedAt) : "Not recorded"}
                        {item.reviewedBy && <div>{item.reviewedBy}</div>}
                      </td>
                      <td className="p-2 align-top">{actions(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards (phones) */}
            <div className="md:hidden space-y-3">
              {visible.map((item) => (
                <div key={item.id} className="rounded-xl border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{siteName(item.siteId)}</p>
                    </div>
                    {actions(item)}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {item.allergens.length === 0
                      ? <span className="text-xs text-muted-foreground">None of the 14 allergens</span>
                      : item.allergens.map((k) => <Badge key={k} variant="outline" className="text-[11px] border-red-200 bg-red-50 text-red-700">{SHORT[k] ?? k}</Badge>)}
                  </div>
                  {item.ppds && <Badge variant="outline" className="text-[10px] border-amber-300 bg-amber-50 text-amber-800">PPDS: full label needed</Badge>}
                  <p className="text-xs text-muted-foreground">
                    Reviewed: {item.lastReviewedAt ? fmtDate(item.lastReviewedAt) : "not recorded"}{item.reviewedBy ? ` by ${item.reviewedBy}` : ""}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Dialog open={form !== null} onOpenChange={(open) => { if (!open) { setForm(null); setEditing(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit allergen record" : "Add dish or product"}</DialogTitle>
            <DialogDescription>Tick every allergen the dish or product contains as an ingredient.</DialogDescription>
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
                <Label htmlFor="allergen-description">Description or recipe notes</Label>
                <Textarea id="allergen-description" rows={2} value={form.description} maxLength={2000} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Contains</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ALLERGENS.map((a) => (
                    <label key={a.key} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm cursor-pointer hover:bg-muted/40">
                      <Checkbox checked={form.allergens.includes(a.key)} onCheckedChange={(checked) => toggleAllergen(a.key, checked === true)} className="mt-0.5" />
                      <span>{a.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="allergen-ppds">Prepacked for direct sale (PPDS)</Label>
                  <Switch id="allergen-ppds" checked={form.ppds} onCheckedChange={(ppds) => setForm({ ...form, ppds })} />
                </div>
                {form.ppds && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                    PPDS food needs a label showing the name of the food and a full ingredients list with the allergens
                    emphasised (for example in bold). Check the label matches these ticks.
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
              {(ticksChanged || !editing) && (
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

      <ChangeHistoryDialog item={historyItem} onClose={() => setHistoryItem(null)} />
      <ConfirmDelete
        open={deleteTarget !== null}
        title="Remove this dish or product?"
        description={`"${deleteTarget?.name ?? ""}" will be removed from the register and the printed matrix. The change log keeps a record of it.`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
    </AppLayout>
  );
}
