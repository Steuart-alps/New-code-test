import { useState } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { useListCategories, type Category } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Trash2, Building2, Plus, Pencil, MapPin, Phone, User, ChevronRight } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";

interface FormState {
  name: string;
  color: string;
  responsiblePerson: string;
  address: string;
  phone: string;
}

const empty: FormState = { name: "", color: "#6366f1", responsiblePerson: "", address: "", phone: "" };

export default function CategoriesPage() {
  const { data: sites = [], isLoading } = useListCategories();
  const { createCategory, updateCategory, deleteCategory } = useAppMutations();
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(empty);

  const openCreate = () => {
    setEditingId(null);
    setForm(empty);
    setIsOpen(true);
  };

  const openEdit = (s: Category) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      color: s.color,
      responsiblePerson: s.responsiblePerson ?? "",
      address: s.address ?? "",
      phone: s.phone ?? "",
    });
    setIsOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      color: form.color,
      responsiblePerson: form.responsiblePerson.trim() || null,
      address: form.address.trim() || null,
      phone: form.phone.trim() || null,
    };
    if (editingId) {
      await updateCategory.mutateAsync({ id: editingId, data: payload });
    } else {
      await createCategory.mutateAsync({ data: payload });
    }
    setIsOpen(false);
    setForm(empty);
  };

  return (
    <AppLayout title="Sites">
      <div className="flex justify-between items-center mb-6">
        <p className="text-muted-foreground hidden sm:block">Manage the sites and locations across your business.</p>
        <Button onClick={openCreate} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Add Site
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : sites.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
            <Building2 className="w-8 h-8 mx-auto mb-3 opacity-20" />
            No sites added yet.
          </div>
        ) : (
          sites.map(site => (
            <Card key={site.id} className="p-5 bg-card shadow-sm hover:shadow-md transition-shadow flex flex-col">
              <div className="flex items-start justify-between gap-3 mb-3">
                <Link href={`/categories/${site.id}`} className="flex items-center gap-3 flex-1 min-w-0 hover:text-primary transition-colors">
                  <div className="w-3 h-3 rounded-full shadow-sm flex-shrink-0" style={{ backgroundColor: site.color }} />
                  <span className="font-semibold text-lg font-display truncate">{site.name}</span>
                </Link>
                <div className="flex gap-1 flex-shrink-0">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(site)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => {
                    if (confirm(`Delete site "${site.name}"? This will also remove its compliance checks.`)) {
                      deleteCategory.mutate({ id: site.id });
                    }
                  }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5 text-sm text-muted-foreground flex-1">
                {site.responsiblePerson && (
                  <div className="flex items-center gap-2"><User className="w-3.5 h-3.5 opacity-60" />{site.responsiblePerson}</div>
                )}
                {site.address && (
                  <div className="flex items-start gap-2"><MapPin className="w-3.5 h-3.5 opacity-60 mt-0.5" /><span className="line-clamp-2">{site.address}</span></div>
                )}
                {site.phone && (
                  <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 opacity-60" />{site.phone}</div>
                )}
                {!site.responsiblePerson && !site.address && !site.phone && (
                  <p className="italic text-xs opacity-60">No site details set yet.</p>
                )}
              </div>

              <Link href={`/categories/${site.id}`} className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline font-medium">
                View checks <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            </Card>
          ))
        )}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="font-display">{editingId ? "Edit Site" : "Add Site"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} id="site-form" className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Site Name</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Manchester Warehouse" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Responsible Person</Label>
              <Input value={form.responsiblePerson} onChange={e => setForm({ ...form, responsiblePerson: e.target.value })} placeholder="e.g. Jane Smith" />
            </div>
            <div className="space-y-1.5">
              <Label>Site Address</Label>
              <Textarea value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="Street, town, postcode" rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label>Site Telephone</Label>
              <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="e.g. 0161 496 1234" />
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
            <Button type="submit" form="site-form" disabled={createCategory.isPending || updateCategory.isPending}>
              {editingId ? "Save Changes" : "Create Site"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
