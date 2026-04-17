import { useState } from "react";
import { Link, useRoute } from "wouter";
import { AppLayout } from "@/components/layout";
import { useGetCategory, useListSites, type Site } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Building2, Plus, Pencil, Trash2, MapPin, Phone, User, ChevronRight } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";

interface FormState {
  name: string;
  responsiblePerson: string;
  address: string;
  phone: string;
}
const empty: FormState = { name: "", responsiblePerson: "", address: "", phone: "" };

export default function CategoryDetailPage() {
  const [, params] = useRoute("/categories/:id");
  const id = params ? Number(params.id) : NaN;
  const { data: category, isLoading: catLoading, error } = useGetCategory(id, { query: { enabled: Number.isFinite(id) } });
  const { data: sites = [], isLoading: sitesLoading } = useListSites({ categoryId: id }, { query: { enabled: Number.isFinite(id) } });
  const { createSite, updateSite, deleteSite } = useAppMutations();

  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(empty);

  const openCreate = () => { setEditingId(null); setForm(empty); setIsOpen(true); };
  const openEdit = (s: Site) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
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
      categoryId: id,
      responsiblePerson: form.responsiblePerson.trim() || null,
      address: form.address.trim() || null,
      phone: form.phone.trim() || null,
    };
    if (editingId) await updateSite.mutateAsync({ id: editingId, data: payload });
    else await createSite.mutateAsync({ data: payload });
    setIsOpen(false);
    setForm(empty);
  };

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
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display font-bold text-xl">{category.name}</h2>
            <p className="text-xs text-muted-foreground">{sites.length} site{sites.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <Button onClick={openCreate} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Add Site
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sitesLoading ? (
          <div className="col-span-full py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : sites.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
            <Building2 className="w-8 h-8 mx-auto mb-3 opacity-20" />
            No sites in this category yet.
          </div>
        ) : (
          sites.map(site => (
            <Card key={site.id} className="p-5 bg-card shadow-sm hover:shadow-md transition-shadow flex flex-col">
              <div className="flex items-start justify-between gap-3 mb-3">
                <Link href={`/sites/${site.id}`} className="flex items-center gap-3 flex-1 min-w-0 hover:text-primary transition-colors">
                  <Building2 className="w-4 h-4 flex-shrink-0 opacity-70" />
                  <span className="font-semibold text-lg font-display truncate">{site.name}</span>
                </Link>
                <div className="flex gap-1 flex-shrink-0">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(site)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => {
                    if (confirm(`Delete site "${site.name}"? Compliance checks will become unassigned.`)) {
                      deleteSite.mutate({ id: site.id });
                    }
                  }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5 text-sm text-muted-foreground flex-1">
                {site.responsiblePerson && <div className="flex items-center gap-2"><User className="w-3.5 h-3.5 opacity-60" />{site.responsiblePerson}</div>}
                {site.address && <div className="flex items-start gap-2"><MapPin className="w-3.5 h-3.5 opacity-60 mt-0.5" /><span className="line-clamp-2">{site.address}</span></div>}
                {site.phone && <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 opacity-60" />{site.phone}</div>}
                {!site.responsiblePerson && !site.address && !site.phone && <p className="italic text-xs opacity-60">No site details set yet.</p>}
              </div>
              <Link href={`/sites/${site.id}`} className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline font-medium">
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
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)} type="button">Cancel</Button>
            <Button type="submit" form="site-form" disabled={createSite.isPending || updateSite.isPending}>
              {editingId ? "Save Changes" : "Create Site"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
