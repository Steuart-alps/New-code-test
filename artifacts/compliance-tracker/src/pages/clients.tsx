import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Building2, ToggleLeft, ToggleRight, TicketPercent, Copy, Check } from "lucide-react";

interface Client {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  active: boolean;
}

type PendingDeletion = {
  id: number;
  client_id: number;
  client_name: string;
  requested_at: string;
  earliest_deletion_at: string;
  notification_state: string;
  status: "pending" | "approved";
  review_note: string | null;
};

function PendingDeletionRequests() {
  const [requests, setRequests] = useState<PendingDeletion[]>([]);
  const [error, setError] = useState("");
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const load = async () => {
    const res = await apiFetch("/admin/data-deletion-requests");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not load deletion requests");
    setRequests(data as PendingDeletion[]);
  };
  useEffect(() => {
    load().catch(err => setError(err.message));
  }, []);
  const review = async (id: number, decision: "approved" | "refused") => {
    setError("");
    setSaving(true);
    try {
      const res = await apiFetch(`/admin/data-deletion-requests/${id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ decision, note: reviewNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save review");
      await load();
      setReviewId(null);
      setReviewNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save review");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="rounded-xl border border-amber-200 bg-card p-5" aria-label="Pending data deletion requests">
      <h2 className="font-semibold">Pending data deletion requests</h2>
      <p className="mt-1 text-xs text-muted-foreground">Review legal retention requirements before approval. Approval schedules deletion no earlier than 30 days after the request; legal holds still block it.</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      {!error && requests.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No pending requests.</p>}
      {requests.map(request => (
        <div key={request.id} className="mt-3 rounded-md border p-3 text-sm">
          <strong>{request.client_name}</strong> (ID {request.client_id}) · Requested {new Date(request.requested_at).toLocaleDateString("en-GB", { timeZone: "Europe/London" })}
          <div className="text-muted-foreground">Earliest deletion: {new Date(request.earliest_deletion_at).toLocaleDateString("en-GB", { timeZone: "Europe/London" })} · {request.status === "approved" ? "Approved — awaiting deletion" : "Awaiting review"} · Notification {request.notification_state === "sent" ? "sent" : "pending"}</div>
          {request.review_note && <p className="mt-2 text-muted-foreground">Review note: {request.review_note}</p>}
          {request.status === "pending" && (reviewId === request.id ? (
            <div className="mt-3 space-y-2">
              <label className="block text-sm font-medium" htmlFor={`deletion-review-${request.id}`}>Review note</label>
              <textarea id={`deletion-review-${request.id}`} className="w-full rounded-md border bg-background p-2" rows={3} maxLength={2000} value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="Document your legal retention review (at least 10 characters)" />
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={saving || reviewNote.trim().length < 10} onClick={() => review(request.id, "approved")}>Approve after review</Button>
                <Button type="button" size="sm" variant="outline" disabled={saving || reviewNote.trim().length < 10} onClick={() => review(request.id, "refused")}>Refuse request</Button>
                <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setReviewId(null)}>Cancel</Button>
              </div>
            </div>
          ) : <Button className="mt-2" type="button" size="sm" variant="outline" onClick={() => { setReviewId(request.id); setReviewNote(""); }}>Review request</Button>)}
        </div>
      ))}
    </section>
  );
}

export function LockedClientsPage() {
  return (
    <AppLayout title="Clients">
      <div className="max-w-4xl"><PendingDeletionRequests /></div>
    </AppLayout>
  );
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
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
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

interface DiscountStatus {
  status: "none" | "available" | "reserved" | "redeemed";
  hint: string | null;
  issuedAt: string | null;
  redeemedAt: string | null;
}

const DISCOUNT_STATUS_COPY: Record<DiscountStatus["status"], { label: string; className: string; desc: string }> = {
  none: {
    label: "No code issued",
    className: "bg-gray-100 text-gray-600",
    desc: "This client has no discount code yet. Generate one and share it with them privately.",
  },
  available: {
    label: "Code available",
    className: "bg-blue-100 text-blue-700",
    desc: "A code has been issued but not used yet. For security the full code is only shown once, when generated — replacing it invalidates the old one.",
  },
  reserved: {
    label: "Checkout in progress",
    className: "bg-amber-100 text-amber-700",
    desc: "The client has started a checkout using their code. It can't be replaced until the checkout completes or expires.",
  },
  redeemed: {
    label: "Discount redeemed",
    className: "bg-green-100 text-green-700",
    desc: "The 50% discount has been applied to this client's subscription. Each client can only redeem one discount.",
  },
};

function DiscountCodeDialog({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const [status, setStatus] = useState<DiscountStatus | null>(null);
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setStatus(null);
    setFreshCode(null);
    setError("");
    setCopied(false);
    if (!client) return;
    (async () => {
      const res = await apiFetch(`/billing/discount-code?clientId=${client.id}`);
      if (res.ok) setStatus(await res.json());
      else setError((await res.json().catch(() => ({}))).error ?? "Could not load discount status");
    })();
  }, [client?.id]);

  async function generate() {
    if (!client) return;
    setWorking(true);
    setError("");
    try {
      const res = await apiFetch(`/billing/discount-code?clientId=${client.id}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not generate code");
      setFreshCode(data.code);
      const statusRes = await apiFetch(`/billing/discount-code?clientId=${client.id}`);
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not generate code");
    } finally {
      setWorking(false);
    }
  }

  async function copyCode() {
    if (!freshCode) return;
    try {
      await navigator.clipboard.writeText(freshCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the code remains visible for manual copy.
    }
  }

  const s = status ? DISCOUNT_STATUS_COPY[status.status] : null;
  const canGenerate = status && (status.status === "none" || status.status === "available");

  return (
    <Dialog open={!!client} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Discount code — {client?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {!status && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
          {s && status && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.className}`}>{s.label}</span>
                {status.hint && status.status !== "none" && (
                  <span className="text-xs text-muted-foreground">Code ending …{status.hint}</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{s.desc}</p>
              {status.issuedAt && (
                <p className="text-xs text-muted-foreground">Issued {new Date(status.issuedAt).toLocaleDateString()}</p>
              )}
              {status.redeemedAt && (
                <p className="text-xs text-muted-foreground">Redeemed {new Date(status.redeemedAt).toLocaleDateString()}</p>
              )}
            </div>
          )}

          {freshCode && (
            <div className="border-2 border-dashed border-primary/40 bg-primary/5 rounded-lg p-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Copy this code now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-sm break-all select-all">{freshCode}</code>
                <Button size="icon" variant="outline" className="h-8 w-8 flex-shrink-0" onClick={copyCode} title="Copy code">
                  {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            {canGenerate && (
              <Button onClick={generate} disabled={working}>
                {working
                  ? "Generating…"
                  : status?.status === "available"
                    ? "Replace code"
                    : "Generate code"}
              </Button>
            )}
          </div>
        </div>
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
  const [discountClient, setDiscountClient] = useState<Client | null>(null);

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
        <PendingDeletionRequests />
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
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDiscountClient(c)} title="Discount code">
                    <TicketPercent className="w-3.5 h-3.5 text-muted-foreground" />
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
      <DiscountCodeDialog client={discountClient} onClose={() => setDiscountClient(null)} />
    </AppLayout>
  );
}
