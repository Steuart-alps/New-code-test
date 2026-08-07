import { useMemo, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import { useGetCategory, getGetCategoryQueryKey, useListComplianceItems } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { ArrowLeft, ClipboardCheck, Plus, AlertTriangle, Clock, CheckCircle2, Circle, Loader2, Trash2, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const STATUS_META: Record<string, { label: string; icon: any; className: string }> = {
  overdue: { label: "Overdue", icon: AlertTriangle, className: "bg-rose-50 text-rose-700 border-rose-200" },
  in_progress: { label: "In Progress", icon: Loader2, className: "bg-amber-50 text-amber-700 border-amber-200" },
  pending: { label: "Pending", icon: Clock, className: "bg-slate-50 text-slate-700 border-slate-200" },
  completed: { label: "Completed", icon: CheckCircle2, className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

const PRIORITY_META: Record<string, string> = {
  critical: "bg-rose-100 text-rose-800 border-rose-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-slate-100 text-slate-800 border-slate-200",
};

function formatDate(d: any): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "—"; }
}

export default function CategoryDetailPage() {
  const [, params] = useRoute("/categories/:id");
  const [, navigate] = useLocation();
  const id = params ? Number(params.id) : NaN;
  const { data: category, isLoading: catLoading, error } = useGetCategory(id, { query: { enabled: Number.isFinite(id), queryKey: getGetCategoryQueryKey(id) } });
  const { data: allItems = [], isLoading: itemsLoading } = useListComplianceItems();
  const { deleteItem } = useAppMutations();
  const { toast } = useToast();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);

  const items = useMemo(() => {
    return allItems
      .filter(i => i.categoryId === id)
      .sort((a, b) => {
        const order = { overdue: 0, in_progress: 1, pending: 2, completed: 3 };
        const ao = order[a.status as keyof typeof order] ?? 99;
        const bo = order[b.status as keyof typeof order] ?? 99;
        if (ao !== bo) return ao - bo;
        const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        return ad - bd;
      });
  }, [allItems, id]);

  const allSelected = items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0;

  function toggleSelectMode() {
    setSelectMode(v => !v);
    setSelected(new Set());
  }

  function toggleItem(itemId: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map(i => i.id)));
    }
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!confirm(`Delete ${count} check${count === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        Array.from(selected).map(itemId =>
          deleteItem.mutateAsync({ id: itemId })
        )
      );
      toast({ title: `${count} check${count === 1 ? "" : "s"} deleted` });
      setSelected(new Set());
      setSelectMode(false);
    } catch (err: any) {
      toast({ title: "Some deletes failed", description: err?.message ?? "Please try again.", variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  }

  if (catLoading) {
    return <AppLayout title="Category"><div className="py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div></AppLayout>;
  }
  if (error || !category) {
    return <AppLayout title="Category"><div className="py-12 text-center text-muted-foreground">Category not found.</div></AppLayout>;
  }

  return (
    <AppLayout title={category.name}>
      <Link href="/categories" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Categories
      </Link>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${category.color}25`, color: category.color }}>
            <ClipboardCheck className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display font-bold text-xl">{category.name}</h2>
            <p className="text-xs text-muted-foreground">{items.length} compliance check{items.length === 1 ? "" : "s"}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          {/* Bulk delete controls — only visible in select mode */}
          {selectMode && someSelected && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="gap-1.5"
            >
              {isDeleting ? (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              Delete {selected.size}
            </Button>
          )}

          {items.length > 0 && (
            <Button
              variant={selectMode ? "secondary" : "outline"}
              size="sm"
              onClick={toggleSelectMode}
              className="gap-1.5"
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {selectMode ? "Cancel" : "Select"}
            </Button>
          )}

          <Button
            onClick={() => { setEditingItem(null); setIsFormOpen(true); }}
            className="shadow-lg shadow-primary/20 flex-1 sm:flex-none gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add Check
          </Button>
        </div>
      </div>

      <Card className="bg-card overflow-hidden">
        {itemsLoading ? (
          <div className="py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Circle className="w-8 h-8 mx-auto mb-3 opacity-20" />
            No compliance checks in this category yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {/* Select-all header row */}
            {selectMode && (
              <div className="px-6 py-3 bg-muted/30 flex items-center gap-3 border-b border-border">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
                <span className="text-xs text-muted-foreground">
                  {someSelected ? `${selected.size} of ${items.length} selected` : `Select all ${items.length}`}
                </span>
              </div>
            )}

            {items.map(item => {
              const meta = STATUS_META[item.status] ?? STATUS_META.pending;
              const Icon = meta.icon;
              const isChecked = selected.has(item.id);

              if (selectMode) {
                return (
                  <div
                    key={item.id}
                    onClick={() => toggleItem(item.id)}
                    className={cn(
                      "w-full text-left px-6 py-4 flex items-start sm:items-center gap-4 cursor-pointer transition-colors",
                      isChecked ? "bg-primary/5" : "hover:bg-muted/30"
                    )}
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleItem(item.id)}
                      onClick={e => e.stopPropagation()}
                      aria-label={`Select ${item.title}`}
                    />
                    <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm">{item.title}</div>
                        {item.description && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{item.description}</div>}
                        <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>Due {formatDate(item.dueDate)}</span>
                          {item.siteName && <span>· {item.siteName}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {item.priority && (
                          <span className={cn("text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border", PRIORITY_META[item.priority] ?? PRIORITY_META.medium)}>
                            {item.priority}
                          </span>
                        )}
                        <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border", meta.className)}>
                          <Icon className="w-3 h-3" />
                          {meta.label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  key={item.id}
                  onClick={() => navigate(`/items/${item.id}`)}
                  className="w-full text-left px-6 py-4 flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row hover:bg-muted/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm">{item.title}</div>
                    {item.description && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</div>}
                    <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>Due {formatDate(item.dueDate)}</span>
                      {item.siteName && <span>· {item.siteName}</span>}
                      {item.contractorName && <span>· {item.contractorName}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.priority && (
                      <span className={cn("text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border", PRIORITY_META[item.priority] ?? PRIORITY_META.medium)}>
                        {item.priority}
                      </span>
                    )}
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md border", meta.className)}>
                      <Icon className="w-3 h-3" />
                      {meta.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <ItemFormDialog
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        item={editingItem}
        defaultCategoryId={id}
      />
    </AppLayout>
  );
}
