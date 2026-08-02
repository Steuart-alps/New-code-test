import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListSites } from "@workspace/api-client-react";
import { Plus, Pencil, Trash2, Search, FileText, ClipboardList, BookMarked } from "lucide-react";
import { SignaturePad } from "@/components/signature-pad";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RiskAssessment { id: number; title: string; description?: string | null; assessedBy?: string | null; reviewDate?: string | null; status: string; version: string; siteId?: number | null; createdAt: string; }
interface Sop { id: number; title: string; scope?: string | null; content?: string | null; version: string; publishedAt?: string | null; siteId?: number | null; createdAt: string; }
interface Handbook { id: number; title: string; section?: string | null; content?: string | null; version: string; publishedAt?: string | null; siteId?: number | null; createdAt: string; }

const RA_STATUS_COLORS: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  under_review: "bg-blue-100 text-blue-800",
};

// ── Generic list table ────────────────────────────────────────────────────────

function ListTable({ headers, rows, onEdit, onDelete, canAdmin }: {
  headers: string[];
  rows: { id: number; cells: React.ReactNode[] }[];
  onEdit?: (id: number) => void;
  onDelete: (id: number) => void;
  canAdmin: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full">
        <thead className="bg-muted/50">
          <tr>
            {headers.map(h => <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">{h}</th>)}
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(r => (
            <tr key={r.id} className="hover:bg-muted/30 transition-colors">
              {r.cells.map((c, i) => <td key={i} className="px-4 py-3 text-sm">{c}</td>)}
              {canAdmin && (
                <td className="px-4 py-3">
                  <div className="flex gap-1 justify-end">
                    {onEdit && <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(r.id)}><Pencil className="w-3.5 h-3.5" /></Button>}
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => onDelete(r.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Shared site picker ────────────────────────────────────────────────────────

function SiteSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: sites = [] } = useListSites();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder="All sites" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">All sites (no assignment)</SelectItem>
        {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SafeTrackPage() {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { data: sites = [] } = useListSites();

  const [tab, setTab] = useState("risk");
  const [search, setSearch] = useState("");

  // Data
  const [ras, setRas] = useState<RiskAssessment[]>([]);
  const [sops, setSops] = useState<Sop[]>([]);
  const [handbook, setHandbook] = useState<Handbook[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  const base = "/safe-track";

  async function load() {
    setLoading(true);
    try {
      const [r1, r2, r3] = await Promise.all([
        apiFetch(`${base}/risk-assessments`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/sops`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/handbook`).then(r => r.ok ? r.json() : []),
      ]);
      setRas(r1); setSops(r2); setHandbook(r3);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [activeClientId]);

  function siteName(id?: number | null) {
    if (!id) return null;
    return sites.find(s => s.id === id)?.name ?? null;
  }

  function openCreate() { setEditing(null); setForm({}); setDialogOpen(true); }
  function openEdit(item: any) { setEditing(item); setForm({ ...item, siteId: item.siteId ? String(item.siteId) : "__none__" }); setDialogOpen(true); }

  async function handleDelete(sub: string, id: number) {
    if (!confirm("Delete this record?")) return;
    await apiFetch(`${base}/${sub}/${id}`, { method: "DELETE" });
    load();
  }

  async function handleSave(sub: string) {
    setSaving(true);
    const payload = { ...form, siteId: form.siteId && form.siteId !== "__none__" ? Number(form.siteId) : null };
    delete payload.id; delete payload.clientId; delete payload.createdBy; delete payload.createdAt; delete payload.updatedAt;
    try {
      if (editing) {
        await apiFetch(`${base}/${sub}/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch(`${base}/${sub}`, { method: "POST", body: JSON.stringify(payload) });
      }
      setDialogOpen(false);
      load();
    } finally { setSaving(false); }
  }

  const q = search.trim().toLowerCase();

  // ── Risk Assessments tab ──────────────────────────────────────────────────
  const raRows = ras
    .filter(r => !q || [r.title, r.assessedBy, r.status].some(v => v?.toLowerCase().includes(q)))
    .map(r => ({
      id: r.id,
      cells: [
        <span className="font-medium">{r.title}</span>,
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${RA_STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-700"}`}>{r.status.replace("_", " ")}</span>,
        <span className="text-muted-foreground">{r.assessedBy ?? "—"}</span>,
        <span className="text-muted-foreground">{r.reviewDate ?? "—"}</span>,
        <span className="text-muted-foreground">{siteName(r.siteId) ?? "All sites"}</span>,
      ],
    }));

  // ── SOPs tab ─────────────────────────────────────────────────────────────
  const sopRows = sops
    .filter(s => !q || [s.title, s.scope].some(v => v?.toLowerCase().includes(q)))
    .map(s => ({
      id: s.id,
      cells: [
        <span className="font-medium">{s.title}</span>,
        s.publishedAt ? <Badge className="bg-emerald-100 text-emerald-800 text-xs font-normal">Published</Badge> : <Badge variant="secondary" className="text-xs font-normal">Draft</Badge>,
        <span className="text-muted-foreground">v{s.version}</span>,
        <span className="text-muted-foreground">{s.scope ? s.scope.slice(0, 60) + (s.scope.length > 60 ? "…" : "") : "—"}</span>,
        <span className="text-muted-foreground">{siteName(s.siteId) ?? "All sites"}</span>,
      ],
    }));

  // ── Staff Handbook tab ────────────────────────────────────────────────────
  const handbookRows = handbook
    .filter(h => !q || [h.title, h.section].some(v => v?.toLowerCase().includes(q)))
    .map(h => ({
      id: h.id,
      cells: [
        <span className="font-medium">{h.title}</span>,
        h.publishedAt ? <Badge className="bg-emerald-100 text-emerald-800 text-xs font-normal">Published</Badge> : <Badge variant="secondary" className="text-xs font-normal">Draft</Badge>,
        <span className="text-muted-foreground">v{h.version}</span>,
        <span className="text-muted-foreground">{h.section ?? "—"}</span>,
        <span className="text-muted-foreground">{siteName(h.siteId) ?? "All sites"}</span>,
      ],
    }));

  const tabConfig = {
    risk: { label: "Risk Assessments", icon: FileText, sub: "risk-assessments", headers: ["Title", "Status", "Assessed By", "Review Date", "Site"], rows: raRows },
    sops: { label: "SOPs", icon: ClipboardList, sub: "sops", headers: ["Title", "Status", "Version", "Scope", "Site"], rows: sopRows },
    handbook: { label: "Staff Handbook", icon: BookMarked, sub: "handbook", headers: ["Title", "Status", "Version", "Section", "Site"], rows: handbookRows },
  } as const;

  type TabKey = keyof typeof tabConfig;
  const currentTab = tabConfig[tab as TabKey];

  return (
    <AppLayout title="SafeTrack">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">Risk assessments and standard operating procedures.</p>
        {canAdmin && (
          <Button onClick={openCreate} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
            <Plus className="w-4 h-4 mr-2" /> Add Record
          </Button>
        )}
      </div>

      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-card" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex-wrap h-auto gap-1">
          {Object.entries(tabConfig).map(([key, cfg]) => (
            <TabsTrigger key={key} value={key} className="gap-1.5 text-xs">
              <cfg.icon className="w-3.5 h-3.5" />{cfg.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {Object.keys(tabConfig).map(key => {
          const cfg = tabConfig[key as TabKey];
          return (
            <TabsContent key={key} value={key}>
              {loading ? (
                <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
              ) : cfg.rows.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
                  <cfg.icon className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  No {cfg.label.toLowerCase()} yet.{canAdmin && " Click 'Add Record' to create one."}
                </div>
              ) : (
                <ListTable
                  headers={cfg.headers as unknown as string[]}
                  rows={cfg.rows}
                  onEdit={canAdmin ? id => openEdit((tab === "risk" ? ras : tab === "sops" ? sops : handbook).find((r: any) => r.id === id)) : undefined}
                  onDelete={id => handleDelete(cfg.sub, id)}
                  canAdmin={canAdmin}
                />
              )}
            </TabsContent>
          );
        })}
      </Tabs>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">
              {editing ? "Edit" : "Add"} {currentTab?.label.slice(0, -1)}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {tab === "risk" && <RaForm form={form} setForm={setForm} />}
            {tab === "sops" && <SopForm form={form} setForm={setForm} />}
            {tab === "handbook" && <HandbookForm form={form} setForm={setForm} />}
            <div className="space-y-1.5">
              <Label>Site (optional)</Label>
              <SiteSelect value={form.siteId ?? "__none__"} onChange={v => setForm({ ...form, siteId: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} type="button">Cancel</Button>
            <Button onClick={() => handleSave(currentTab.sub)} disabled={saving}>
              {editing ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

function RaForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Title *"><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Manual Handling Assessment" autoFocus /></F>
    <F label="Description"><Textarea value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} /></F>
    <F label="Assessed By"><Input value={form.assessedBy ?? ""} onChange={e => setForm({ ...form, assessedBy: e.target.value })} placeholder="Name" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Review Date"><Input type="date" value={form.reviewDate ?? ""} onChange={e => setForm({ ...form, reviewDate: e.target.value })} /></F>
      <F label="Version"><Input value={form.version ?? "1.0"} onChange={e => setForm({ ...form, version: e.target.value })} placeholder="1.0" /></F>
    </div>
    <F label="Status">
      <Select value={form.status ?? "draft"} onValueChange={v => setForm({ ...form, status: v })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="draft">Draft</SelectItem>
          <SelectItem value="published">Published</SelectItem>
          <SelectItem value="under_review">Under Review</SelectItem>
        </SelectContent>
      </Select>
    </F>
    <SignaturePad label="Assessor Signature" value={form.signature ?? null} onChange={sig => setForm({ ...form, signature: sig })} />
  </>;
}

function SopForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Title *"><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Food Allergen Control Procedure" autoFocus /></F>
    <F label="Scope"><Input value={form.scope ?? ""} onChange={e => setForm({ ...form, scope: e.target.value })} placeholder="Who this applies to" /></F>
    <F label="Content"><Textarea value={form.content ?? ""} onChange={e => setForm({ ...form, content: e.target.value })} rows={6} placeholder="Step-by-step procedure…" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Version"><Input value={form.version ?? "1.0"} onChange={e => setForm({ ...form, version: e.target.value })} /></F>
      <F label="Published">
        <Select value={form.publishedAt ? "yes" : "no"} onValueChange={v => setForm({ ...form, publishedAt: v === "yes" ? new Date().toISOString() : null })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="no">Draft</SelectItem>
            <SelectItem value="yes">Published</SelectItem>
          </SelectContent>
        </Select>
      </F>
    </div>
    <SignaturePad label="Manager Signature" value={form.signature ?? null} onChange={sig => setForm({ ...form, signature: sig })} />
  </>;
}

function HandbookForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Title *"><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Health & Safety Policy" autoFocus /></F>
    <F label="Section"><Input value={form.section ?? ""} onChange={e => setForm({ ...form, section: e.target.value })} placeholder="e.g. Chapter 3 — Fire Safety" /></F>
    <F label="Content"><Textarea value={form.content ?? ""} onChange={e => setForm({ ...form, content: e.target.value })} rows={8} placeholder="Handbook content…" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Version"><Input value={form.version ?? "1.0"} onChange={e => setForm({ ...form, version: e.target.value })} /></F>
      <F label="Status">
        <Select value={form.publishedAt ? "yes" : "no"} onValueChange={v => setForm({ ...form, publishedAt: v === "yes" ? new Date().toISOString() : null })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="no">Draft</SelectItem>
            <SelectItem value="yes">Published</SelectItem>
          </SelectContent>
        </Select>
      </F>
    </div>
    <SignaturePad label="Staff Signature" value={form.signature ?? null} onChange={sig => setForm({ ...form, signature: sig })} />
  </>;
}
