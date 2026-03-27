import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Building2, ToggleLeft, ToggleRight } from "lucide-react";

interface Client {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  active: boolean;
}

function ClientDialog({
  open,
  onClose,
  onSaved,
  client,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  client: Client | null;
}) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    logoUrl: "",
    primaryColor: "#6366f1",
    active: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (client) {
      setForm({
        name: client.name,
        slug: client.slug,
        logoUrl: client.logoUrl ?? "",
        primaryColor: client.primaryColor,
        active: client.active,
      });
    } else {
      setForm({ name: "", slug: "", logoUrl: "", primaryColor: "#6366f1", active: true });
    }
    setError("");
  }, [client, open]);

  function slugify(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = {
        ...form,
        logoUrl: form.logoUrl || null,
      };
      const path = client ? `/clients/${client.id}` : "/clients";
      const method = client ? "PUT" : "POST";
      const res = await apiFetch(path, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Failed to save");
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{client ? "Edit Client" : "Add Client"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label>Company Name</Label>
            <Input
              value={form.name}
              onChange={e => {
                const name = e.target.value;
                setForm(f => ({ ...f, name, slug: client ? f.slug : slugify(name) }));
              }}
              required
              placeholder="Acme Ltd"
            />
          </div>
          <div className="space-y-2">
            <Label>Slug (URL identifier)</Label>
            <Input
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
              required
              pattern="[a-z0-9-]+"
              placeholder="acme-ltd"
            />
            <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens only</p>
          </div>
          <div className="space-y-2">
            <Label>Logo URL (optional)</Label>
            <Input
              value={form.logoUrl}
              onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))}
              placeholder="https://..."
              type="url"
            />
          </div>
          <div className="space-y-2">
            <Label>Brand Colour</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={form.primaryColor}
                onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))}
                className="w-10 h-10 rounded border border-border cursor-pointer"
              />
              <Input
                value={form.primaryColor}
                onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))}
                placeholder="#6366f1"
                className="flex-1"
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : client ? "Save Changes" : "Add Client"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ClientsPage() {
  const { setActiveClientId } = useAuth();
  const [, navigate] = useLocation();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);

  async function load() {
    setLoading(true);
    const res = await apiFetch("/clients");
    if (res.ok) setClients(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function toggleActive(client: Client) {
    await apiFetch(`/clients/${client.id}`, {
      method: "PUT",
      body: JSON.stringify({ active: !client.active }),
    });
    load();
  }

  return (
    <AppLayout title="Clients">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">Manage client organisations</p>
          <Button onClick={() => { setEditingClient(null); setDialogOpen(true); }}>
            <Plus className="w-4 h-4 mr-2" />
            Add Client
          </Button>
        </div>

        {loading ? (
          <div className="text-center py-16 text-muted-foreground">Loading clients...</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map(c => (
              <div
                key={c.id}
                className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${c.primaryColor}20`, border: `2px solid ${c.primaryColor}40` }}
                  >
                    {c.logoUrl ? (
                      <img src={c.logoUrl} alt={c.name} className="w-8 h-8 object-contain rounded" />
                    ) : (
                      <Building2 className="w-5 h-5" style={{ color: c.primaryColor }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm truncate">{c.name}</h3>
                    <p className="text-xs text-muted-foreground">{c.slug}</p>
                  </div>
                  <div className="w-3 h-3 rounded-full flex-shrink-0 mt-1" style={{ backgroundColor: c.primaryColor }} />
                </div>

                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${c.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {c.active ? "Active" : "Inactive"}
                  </span>
                  <div className="flex-1" />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingClient(c); setDialogOpen(true); }} title="Edit">
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleActive(c)} title={c.active ? "Deactivate" : "Activate"}>
                    {c.active ? <ToggleRight className="w-4 h-4 text-green-600" /> : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => { setActiveClientId(c.id); navigate("/"); }}
                  >
                    View
                  </Button>
                </div>
              </div>
            ))}
            {clients.length === 0 && (
              <div className="col-span-full text-center py-16 text-muted-foreground text-sm">
                No clients yet. Add your first client to get started.
              </div>
            )}
          </div>
        )}
      </div>

      <ClientDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={load}
        client={editingClient}
      />
    </AppLayout>
  );
}
