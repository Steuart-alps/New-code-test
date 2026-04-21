import { useState, useMemo } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { useListCategories, useListComplianceItems, type Category } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Trash2, Tags, Plus, Pencil, ChevronRight, ClipboardCheck } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";

interface FormState { name: string; color: string; }
const empty: FormState = { name: "", color: "#6366f1" };

export default function CategoriesPage() {
  const { data: categories = [], isLoading } = useListCategories();
  const { data: items = [] } = useListComplianceItems();
  const { createCategory, updateCategory, deleteCategory } = useAppMutations();
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(empty);

  const checkCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of items) {
      if (i.categoryId == null) continue;
      m.set(i.categoryId, (m.get(i.categoryId) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const openCreate = () => { setEditingId(null); setForm(empty); setIsOpen(true); };
  const openEdit = (c: Category) => { setEditingId(c.id); setForm({ name: c.name, color: c.color }); setIsOpen(true); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const payload = { name: form.name.trim(), color: form.color };
    if (editingId) await updateCategory.mutateAsync({ id: editingId, data: payload });
    else await createCategory.mutateAsync({ data: payload });
    setIsOpen(false);
    setForm(empty);
  };

  return (
    <AppLayout title="Categories">
      <div className="flex justify-between items-center mb-6">
        <p className="text-muted-foreground hidden sm:block">Group your compliance checks into categories like Staff, Fire, or Premises. You decide which checks go in each one.</p>
        <Button onClick={openCreate} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Add Category
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : categories.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
            <Tags className="w-8 h-8 mx-auto mb-3 opacity-20" />
            No categories yet. Add one (e.g. Staff, Fire, Premises) to start grouping your compliance checks.
          </div>
        ) : (
          categories.map(cat => {
            const count = checkCounts.get(cat.id) ?? 0;
            return (
              <Card key={cat.id} className="p-5 bg-card shadow-sm hover:shadow-md transition-shadow flex flex-col">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <Link href={`/categories/${cat.id}`} className="flex items-center gap-3 flex-1 min-w-0 hover:text-primary transition-colors">
                    <div className="w-3 h-3 rounded-full shadow-sm flex-shrink-0" style={{ backgroundColor: cat.color }} />
                    <span className="font-semibold text-lg font-display truncate">{cat.name}</span>
                  </Link>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(cat)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => {
                      if (confirm(`Delete category "${cat.name}"? Checks in this category will become uncategorised.`)) {
                        deleteCategory.mutate({ id: cat.id });
                      }
                    }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm text-muted-foreground flex-1">
                  <ClipboardCheck className="w-3.5 h-3.5 opacity-60" />
                  {count} compliance check{count === 1 ? "" : "s"}
                </div>

                <Link href={`/categories/${cat.id}`} className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline font-medium">
                  View checks <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </Card>
            );
          })
        )}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display">{editingId ? "Edit Category" : "Add Category"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} id="cat-form" className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Category Name</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Staff, Fire, Premises, Electrical" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Color Tag</Label>
              <div className="flex gap-3 items-center">
                <Input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} className="w-12 h-12 p-1 rounded-lg cursor-pointer" />
                <span className="text-sm font-mono text-muted-foreground">{form.color}</span>
              </div>
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)} type="button">Cancel</Button>
            <Button type="submit" form="cat-form" disabled={createCategory.isPending || updateCategory.isPending}>
              {editingId ? "Save Changes" : "Create Category"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
