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
import { Plus, Pencil, Trash2, Search, GraduationCap, FileText, ClipboardList, Users, CheckSquare } from "lucide-react";

// ── Induction checklist template (ALPS H&S Induction Form) ───────────────────

const INDUCTION_SECTIONS = [
  { key: "accident_hazard",       label: "Accident & Hazard Reporting" },
  { key: "asbestos",              label: "Asbestos Log" },
  { key: "coshh",                 label: "COSHH" },
  { key: "communication_hs",      label: "Communication & Consultation on H&S" },
  { key: "dse",                   label: "Display Screen Equipment (DSE)" },
  { key: "fire_emergency",        label: "Fire & Emergency Procedures" },
  { key: "first_aid",             label: "First Aid Provision" },
  { key: "hs_policy",             label: "Health & Safety Policy Statement" },
  { key: "housekeeping_fire",     label: "Housekeeping — Fire Safety" },
  { key: "housekeeping_elec",     label: "Housekeeping — Electrical Safety" },
  { key: "housekeeping_general",  label: "Housekeeping — General Workplace Safety" },
  { key: "infection_control",     label: "Infection Control" },
  { key: "manual_handling",       label: "Manual Handling" },
  { key: "vehicle_movement",      label: "Vehicle Movement" },
  { key: "falls_height",          label: "Falls from Height" },
  { key: "work_equipment",        label: "Work Equipment" },
  { key: "working_at_height",     label: "Working at Height" },
  { key: "lone_working",          label: "Lone Working / Personal Safety" },
  { key: "medicines",             label: "Medicines" },
  { key: "mobile_phone",          label: "Mobile Phone Use" },
  { key: "ppe",                   label: "Personal Protective Equipment (PPE)" },
  { key: "risk_assessments",      label: "Risk Assessments" },
  { key: "wellbeing",             label: "Wellbeing" },
  { key: "workplace_facilities",  label: "Workplace Facilities" },
] as const;

type SectionKey = typeof INDUCTION_SECTIONS[number]["key"];

interface ChecklistItem {
  key: SectionKey;
  status: "yes" | "no" | "na" | "";
  comments: string;
}

interface InductionChecklist {
  jobTitle: string;
  department: string;
  items: ChecklistItem[];
}

function defaultChecklist(): InductionChecklist {
  return {
    jobTitle: "",
    department: "",
    items: INDUCTION_SECTIONS.map(s => ({ key: s.key, status: "", comments: "" })),
  };
}

function parseChecklist(raw?: string | null): InductionChecklist {
  if (!raw) return defaultChecklist();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.items?.length) return parsed as InductionChecklist;
  } catch { /* fall through */ }
  return defaultChecklist();
}

function checklistProgress(raw?: string | null): string {
  const cl = parseChecklist(raw);
  const answered = cl.items.filter(i => i.status !== "").length;
  return `${answered}/${cl.items.length}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface RiskAssessment { id: number; title: string; description?: string | null; assessedBy?: string | null; reviewDate?: string | null; status: string; version: string; siteId?: number | null; createdAt: string; }
interface Sop { id: number; title: string; scope?: string | null; content?: string | null; version: string; publishedAt?: string | null; siteId?: number | null; createdAt: string; }
interface TrainingRecord { id: number; staffName: string; trainingType: string; completedAt: string; expiryDate?: string | null; notes?: string | null; siteId?: number | null; createdAt: string; }
interface Induction { id: number; staffName: string; startDate: string; completedAt?: string | null; checklist?: string | null; notes?: string | null; siteId?: number | null; createdAt: string; }
interface CompetencySignoff { id: number; staffName: string; taskName: string; signedOffBy: string; signedOffAt: string; notes?: string | null; siteId?: number | null; createdAt: string; }

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
  const [training, setTraining] = useState<TrainingRecord[]>([]);
  const [inductions, setInductions] = useState<Induction[]>([]);
  const [competency, setCompetency] = useState<CompetencySignoff[]>([]);
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
      const [r1, r2, r3, r4, r5] = await Promise.all([
        apiFetch(`${base}/risk-assessments`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/sops`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/training-records`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/inductions`).then(r => r.ok ? r.json() : []),
        apiFetch(`${base}/competency`).then(r => r.ok ? r.json() : []),
      ]);
      setRas(r1); setSops(r2); setTraining(r3); setInductions(r4); setCompetency(r5);
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

  // ── Training Records tab ──────────────────────────────────────────────────
  const trRows = training
    .filter(t => !q || [t.staffName, t.trainingType].some(v => v?.toLowerCase().includes(q)))
    .map(t => ({
      id: t.id,
      cells: [
        <span className="font-medium">{t.staffName}</span>,
        <span>{t.trainingType}</span>,
        <span className="text-muted-foreground">{t.completedAt}</span>,
        t.expiryDate
          ? <span className={new Date(t.expiryDate) < new Date() ? "text-destructive font-medium" : "text-muted-foreground"}>{t.expiryDate}</span>
          : <span className="text-muted-foreground">—</span>,
        <span className="text-muted-foreground">{siteName(t.siteId) ?? "All sites"}</span>,
      ],
    }));

  // ── Inductions tab ────────────────────────────────────────────────────────
  const indRows = inductions
    .filter(i => !q || i.staffName.toLowerCase().includes(q))
    .map(i => {
      const cl = parseChecklist(i.checklist);
      const answered = cl.items.filter(x => x.status !== "").length;
      const total = cl.items.length;
      const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
      return {
        id: i.id,
        cells: [
          <span className="font-medium">{i.staffName}</span>,
          <span className="text-muted-foreground text-xs">{cl.jobTitle || "—"}{cl.department ? ` · ${cl.department}` : ""}</span>,
          <span className="text-muted-foreground">{i.startDate}</span>,
          i.completedAt
            ? <Badge className="bg-emerald-100 text-emerald-800 text-xs font-normal">Complete</Badge>
            : <Badge variant="secondary" className="text-xs font-normal">In progress</Badge>,
          <div className="flex items-center gap-2 min-w-[100px]">
            <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{answered}/{total}</span>
          </div>,
          <span className="text-muted-foreground">{siteName(i.siteId) ?? "All sites"}</span>,
        ],
      };
    });

  // ── Competency tab ────────────────────────────────────────────────────────
  const compRows = competency
    .filter(c => !q || [c.staffName, c.taskName, c.signedOffBy].some(v => v?.toLowerCase().includes(q)))
    .map(c => ({
      id: c.id,
      cells: [
        <span className="font-medium">{c.staffName}</span>,
        <span>{c.taskName}</span>,
        <span className="text-muted-foreground">{c.signedOffBy}</span>,
        <span className="text-muted-foreground">{c.signedOffAt}</span>,
        <span className="text-muted-foreground">{siteName(c.siteId) ?? "All sites"}</span>,
      ],
    }));

  const tabConfig = {
    risk: { label: "Risk Assessments", icon: FileText, sub: "risk-assessments", headers: ["Title", "Status", "Assessed By", "Review Date", "Site"], rows: raRows },
    sops: { label: "SOPs", icon: ClipboardList, sub: "sops", headers: ["Title", "Status", "Version", "Scope", "Site"], rows: sopRows },
    training: { label: "Training Records", icon: GraduationCap, sub: "training-records", headers: ["Staff", "Training Type", "Completed", "Expiry", "Site"], rows: trRows },
    inductions: { label: "Inductions", icon: Users, sub: "inductions", headers: ["Staff", "Role / Dept", "Start Date", "Status", "Progress", "Site"], rows: indRows },
    competency: { label: "Competency", icon: CheckSquare, sub: "competency", headers: ["Staff", "Task", "Signed Off By", "Date", "Site"], rows: compRows },
  } as const;

  type TabKey = keyof typeof tabConfig;
  const currentTab = tabConfig[tab as TabKey];

  return (
    <AppLayout title="SafeTrack">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">Training records, risk assessments, SOPs, inductions and competency sign-offs.</p>
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
                  onEdit={canAdmin ? id => openEdit((tab === "risk" ? ras : tab === "sops" ? sops : tab === "training" ? training : tab === "inductions" ? inductions : competency).find((r: any) => r.id === id)) : undefined}
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
            {tab === "training" && <TrainingForm form={form} setForm={setForm} />}
            {tab === "inductions" && <InductionForm form={form} setForm={setForm} />}
            {tab === "competency" && <CompetencyForm form={form} setForm={setForm} />}
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
  </>;
}

function TrainingForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Staff Name *"><Input value={form.staffName ?? ""} onChange={e => setForm({ ...form, staffName: e.target.value })} placeholder="Full name" autoFocus /></F>
    <F label="Training Type *"><Input value={form.trainingType ?? ""} onChange={e => setForm({ ...form, trainingType: e.target.value })} placeholder="e.g. Food Hygiene Level 2, Manual Handling" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Completed *"><Input type="date" value={form.completedAt ?? ""} onChange={e => setForm({ ...form, completedAt: e.target.value })} /></F>
      <F label="Expiry Date"><Input type="date" value={form.expiryDate ?? ""} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></F>
    </div>
    <F label="Notes"><Textarea value={form.notes ?? ""} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} /></F>
  </>;
}

function InductionForm({ form, setForm }: { form: any; setForm: any }) {
  const cl = parseChecklist(form.checklist);

  function updateMeta(field: "jobTitle" | "department", value: string) {
    const next = { ...cl, [field]: value };
    setForm({ ...form, checklist: JSON.stringify(next) });
  }

  function updateItem(key: SectionKey, field: "status" | "comments", value: string) {
    const next = {
      ...cl,
      items: cl.items.map(i => i.key === key ? { ...i, [field]: value } : i),
    };
    setForm({ ...form, checklist: JSON.stringify(next) });
  }

  const STATUS_OPTS: { value: "yes" | "no" | "na" | ""; label: string; active: string }[] = [
    { value: "yes", label: "Yes", active: "bg-emerald-600 text-white border-emerald-600" },
    { value: "no",  label: "No",  active: "bg-red-500 text-white border-red-500" },
    { value: "na",  label: "N/A", active: "bg-slate-400 text-white border-slate-400" },
  ];

  return <>
    <F label="Staff Name *">
      <Input value={form.staffName ?? ""} onChange={e => setForm({ ...form, staffName: e.target.value })} placeholder="Full name" autoFocus />
    </F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Job Title">
        <Input value={cl.jobTitle} onChange={e => updateMeta("jobTitle", e.target.value)} placeholder="e.g. Kitchen Assistant" />
      </F>
      <F label="Department">
        <Input value={cl.department} onChange={e => updateMeta("department", e.target.value)} placeholder="e.g. Kitchen" />
      </F>
    </div>
    <div className="grid grid-cols-2 gap-4">
      <F label="Start Date *">
        <Input type="date" value={form.startDate ?? ""} onChange={e => setForm({ ...form, startDate: e.target.value })} />
      </F>
      <F label="Completed Date">
        <Input type="date" value={form.completedAt ?? ""} onChange={e => setForm({ ...form, completedAt: e.target.value })} />
      </F>
    </div>

    {/* Induction checklist */}
    <div className="space-y-1.5">
      <Label>H&S Induction Checklist</Label>
      <p className="text-xs text-muted-foreground">Mark each item as covered (Yes), not applicable (N/A), or not yet covered (No). Add comments where needed.</p>
      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border mt-2">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_auto] gap-2 bg-muted/50 px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Topic</span>
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Covered?</span>
        </div>
        {cl.items.map(item => {
          const section = INDUCTION_SECTIONS.find(s => s.key === item.key);
          return (
            <div key={item.key} className="px-3 py-3 space-y-2 bg-card">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium text-foreground leading-snug pt-0.5">{section?.label}</span>
                <div className="flex gap-1 flex-shrink-0">
                  {STATUS_OPTS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updateItem(item.key, "status", item.status === opt.value ? "" : opt.value)}
                      className={`px-2.5 py-1 text-xs border rounded transition-colors ${
                        item.status === opt.value ? opt.active : "border-border text-muted-foreground hover:border-foreground/40"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                value={item.comments}
                onChange={e => updateItem(item.key, "comments", e.target.value)}
                placeholder="Comments…"
                className="h-7 text-xs bg-background"
              />
            </div>
          );
        })}
      </div>
    </div>

    <F label="Notes / Sign-off Comments">
      <Textarea value={form.notes ?? ""} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Manager sign-off notes…" />
    </F>
  </>;
}

function CompetencyForm({ form, setForm }: { form: any; setForm: any }) {
  return <>
    <F label="Staff Name *"><Input value={form.staffName ?? ""} onChange={e => setForm({ ...form, staffName: e.target.value })} placeholder="Full name" autoFocus /></F>
    <F label="Task / Skill *"><Input value={form.taskName ?? ""} onChange={e => setForm({ ...form, taskName: e.target.value })} placeholder="e.g. Safe use of industrial oven" /></F>
    <div className="grid grid-cols-2 gap-4">
      <F label="Signed Off By *"><Input value={form.signedOffBy ?? ""} onChange={e => setForm({ ...form, signedOffBy: e.target.value })} /></F>
      <F label="Date *"><Input type="date" value={form.signedOffAt ?? ""} onChange={e => setForm({ ...form, signedOffAt: e.target.value })} /></F>
    </div>
    <F label="Notes"><Textarea value={form.notes ?? ""} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} /></F>
  </>;
}
