import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { useListSites, type Site } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, Building2, MapPin, Phone, User, ChevronRight, Search } from "lucide-react";

const NO_DEPT = "__none__";

interface Department {
  id: number;
  name: string;
  clientId: number;
}

interface FormState {
  name: string;
  responsiblePerson: string;
  address: string;
  phone: string;
  seedStarterChecks: boolean;
}
const empty: FormState = { name: "", responsiblePerson: "", address: "", phone: "", seedStarterChecks: true };

export default function SitesPage() {
  const { data: sites = [], isLoading } = useListSites();
  const { createSite, updateSite, deleteSite } = useAppMutations();
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [reassigning, setReassigning] = useState<number | null>(null);

  useEffect(() => {
    apiFetch(`/departments${activeClientId ? `?clientId=${activeClientId}` : ""}`)
      .then(r => r.ok ? r.json() : [])
      .then(setDepartments)
      .catch(() => {});
  }, [activeClientId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sites;
    return sites.filter(s =>
      [s.name, s.address, s.responsiblePerson, s.phone].some(v => v?.toLowerCase().includes(q))
    );
  }, [sites, search]);

  async function reassignSiteDept(siteId: number, value: string) {
    const departmentId = value === NO_DEPT ? null : Number(value);
    setReassigning(siteId);
    try {
      await updateSite.mutateAsync({ id: siteId, data: { departmentId } });
    } finally {
      setReassigning(null);
    }
  }

  const openCreate = () => {
    setEditingId(null);
    setForm(empty);
    setIsOpen(true);
  };

  const openEdit = (s: Site) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      responsiblePerson: s.responsiblePerson ?? "",
      address: s.address ?? "",
      phone: s.phone ?? "",
      seedStarterChecks: false,
    });
    setIsOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const basePayload = {
      name: form.name.trim(),
      responsiblePerson: form.responsiblePerson.trim() || null,
      address: form.address.trim() || null,
      phone: form.phone.trim() || null,
    };
    if (editingId) {
      await updateSite.mutateAsync({ id: editingId, data: basePayload });
    } else {
      await createSite.mutateAsync({
        data: { ...basePayload, seedStarterChecks: form.seedStarterChecks } as any,
      });
    }
    setIsOpen(false);
    setForm(empty);
  };

  return (
    <AppLayout title="Sites">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">Your physical locations — the buildings and premises where compliance checks happen.</p>
        <Button onClick={openCreate} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Add Site
        </Button>
      </div>

      <div className="mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search sites by name, address, person..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-card"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
            <Building2 className="w-8 h-8 mx-auto mb-3 opacity-20" />
            {sites.length === 0 ? "No sites yet. Add your first site to get started." : "No sites match your search."}
          </div>
        ) : (
          filtered.map(site => (
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
                {/* Department indicator — quick-assign for admins, badge for everyone else */}
                <div className="mb-1">
                  {canAdmin ? (
                    <Select
                      value={(site as any).departmentId?.toString() ?? NO_DEPT}
                      onValueChange={val => reassignSiteDept(site.id, val)}
                      disabled={reassigning === site.id}
                    >
                      <SelectTrigger className="h-6 text-xs w-44 border-transparent hover:border-input bg-transparent hover:bg-muted/40 transition-colors px-2 gap-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_DEPT} className="text-xs text-muted-foreground">
                          All departments
                        </SelectItem>
                        {departments.map(d => (
                          <SelectItem key={d.id} value={d.id.toString()} className="text-xs">
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    (() => {
                      const dept = departments.find(d => d.id === (site as any).departmentId);
                      return (
                        <Badge variant="secondary" className="text-xs font-normal">
                          {dept?.name ?? "All departments"}
                        </Badge>
                      );
                    })()
                  )}
                </div>
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
          <form onSubmit={handleSubmit} id="sites-page-form" className="space-y-4 py-2">
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

            {!editingId && (
              <label className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  checked={form.seedStarterChecks}
                  onChange={e => setForm({ ...form, seedStarterChecks: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium">Pre-populate with starter compliance checks</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Adds the standard Fire Safety, Electrical, Staff Training and Premises checks to this site. You can edit or remove any of them afterwards.
                  </span>
                </span>
              </label>
            )}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)} type="button">Cancel</Button>
            <Button type="submit" form="sites-page-form" disabled={createSite.isPending || updateSite.isPending}>
              {editingId ? "Save Changes" : "Create Site"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
