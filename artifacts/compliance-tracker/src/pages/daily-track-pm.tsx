import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useListSites } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckSquare, Square, Sunset, UtensilsCrossed, Building2, Loader2, Lock, RotateCcw, PenLine, Settings2 } from "lucide-react";
import { ChecklistTemplateEditor, type TemplateItem } from "./checklist-template-editor";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChecklistItem { label: string; checked: boolean; notes?: string; section?: string; }

interface Checklist {
  id: number; checklistType: string; checkDate: string;
  siteId?: number | null; items: ChecklistItem[];
  completedBy?: string | null; managerNote?: string | null; submittedAt?: string | null;
}

interface ManagerSignoff {
  id: number; signoffDate: string; siteId?: number | null;
  managerName: string; notes?: string | null; submittedAt?: string | null;
}

// ── Default templates ─────────────────────────────────────────────────────────

const KITCHEN_CLOSING_ITEMS: ChecklistItem[] = [
  // 1. Food Safety & Storage
  { section: "Food Safety & Storage", label: "All prepared food labelled and dated", checked: false },
  { label: "Food stored in suitable, covered containers", checked: false },
  { label: "Raw food stored below ready-to-eat food", checked: false },
  { label: "FIFO (First In, First Out) rotation completed", checked: false },
  { label: "Expired or out-of-date food discarded", checked: false },
  { label: "Cooling foods placed into refrigeration correctly", checked: false },
  { label: "Walk-in fridge temperature recorded on All In One Record", checked: false },
  { label: "Under-counter fridge temperature recorded on All In One Record", checked: false },
  { label: "Freezer temperature recorded on All In One Record", checked: false },
  // 2. Equipment
  { section: "Equipment", label: "Ovens switched off (unless required overnight)", checked: false },
  { label: "Hobs and grills cleaned and turned off", checked: false },
  { label: "Fryers filtered, cleaned and switched off", checked: false },
  { label: "Salamander/griddle cleaned", checked: false },
  { label: "Microwave cleaned", checked: false },
  { label: "Extraction canopy switched off (after cooling period)", checked: false },
  { label: "Dishwashers drained and cleaned", checked: false },
  { label: "Ice machine cleaned externally", checked: false },
  // 3. Cleaning & Sanitising
  { section: "Cleaning & Sanitising", label: "Food preparation surfaces cleaned and sanitised", checked: false },
  { label: "Chopping boards cleaned and sanitised", checked: false },
  { label: "Knives and utensils washed and stored safely", checked: false },
  { label: "Sinks cleaned and sanitised", checked: false },
  { label: "Fridge handles and touch points sanitised", checked: false },
  { label: "Shelving wiped down", checked: false },
  { label: "Floor swept", checked: false },
  { label: "Floor mopped", checked: false },
  { label: "Floor drains cleaned", checked: false },
  { label: "Grease traps emptied (if scheduled)", checked: false },
  { label: "Cleaning cloths removed for laundering", checked: false },
  { label: "Sanitiser bottles refilled", checked: false },
  // 4. Waste Management
  { section: "Waste Management", label: "Kitchen bins emptied", checked: false },
  { label: "External bins secured with lids closed", checked: false },
  { label: "Recycling separated correctly", checked: false },
  { label: "Cardboard removed", checked: false },
  { label: "Waste area left clean", checked: false },
  // 5. Stock & Preparation
  { section: "Stock & Preparation", label: "Next day's thawing stock transferred to fridge (if required)", checked: false },
  { label: "Essential stock replenished", checked: false },
  { label: "Dry stores tidy", checked: false },
  { label: "Deliveries area clean and clear", checked: false },
  // 6. Health & Safety
  { section: "Health & Safety", label: "Gas isolation checked", checked: false },
  { label: "Electrical appliances switched off where appropriate", checked: false },
  { label: "Fire exits clear", checked: false },
  { label: "Fire doors closed", checked: false },
  { label: "First aid kit stocked", checked: false },
  { label: "No slip or trip hazards present", checked: false },
  { label: "Chemicals stored safely away from food", checked: false },
  // 7. Pest Prevention
  { section: "Pest Prevention", label: "No signs of pest activity", checked: false },
  { label: "Food removed from floors", checked: false },
  { label: "Doors and windows secured", checked: false },
  { label: "Fly screens intact (where fitted)", checked: false },
  // 8. Documentation
  { section: "Documentation", label: "Temperature logs completed", checked: false },
  { label: "Cleaning schedule signed", checked: false },
  { label: "Corrective actions recorded", checked: false },
  { label: "Equipment faults reported", checked: false },
  { label: "Maintenance issues logged", checked: false },
  // 9. Security
  { section: "Security", label: "Lights switched off", checked: false },
  { label: "Alarm set", checked: false },
  { label: "Windows locked", checked: false },
  { label: "External doors locked", checked: false },
  { label: "Keys returned to secure location", checked: false },
];

const PREMISES_CLOSING_ITEMS: ChecklistItem[] = [
  // Compliance
  { section: "Compliance", label: "Security walk round has been completed", checked: false },
  { label: "Hot water available", checked: false },
  { label: "All internal escape routes are free from obstructions", checked: false },
  { label: "All internal fire doors open freely and are closed where required", checked: false },
  { label: "Final fire exit doors are unlocked / unbolted and open freely — push bars / pads undamaged", checked: false },
  { label: "External escape routes are clear", checked: false },
  { label: "Fire extinguishers are unobstructed and clearly visible", checked: false },
  { label: "Manual break glass call points are unobstructed and clearly visible", checked: false },
  { label: "Emergency lights are in working order", checked: false },
  { label: "All access to and egress from the premises are free from obstructions or hazards", checked: false },
  { label: "Internal public areas are safe and well maintained", checked: false },
  { label: "Chemicals are stored correctly and chemical storage area is locked", checked: false },
  { label: "Staff and working areas are safe, well maintained and hazard free", checked: false },
  { label: "Work and electrical equipment is in good working order — no trailing or exposed wiring", checked: false },
  { label: "Sufficient means for hand drying — blue roll available in holders", checked: false },
  { label: "Any other maintenance issues noted and reported", checked: false },
  // Operational
  { section: "Operational", label: "Daily banking completed", checked: false },
  { label: "Heating, lighting and sound levels all set for shift", checked: false },
  { label: "Start of day — all tills out", checked: false },
  { label: "Front of house, bar and kitchen set-ups checked and OK", checked: false },
  { label: "Pre-shift meeting held — special events, bookings and allergen requirements discussed", checked: false },
  { label: "Pre-shift walk around completed", checked: false },
  { label: "Toilets clean and sufficiently stocked (toilet paper, soap, hand towels)", checked: false },
  { label: "Lighting levels sufficient", checked: false },
  { label: "Car park clean and tidy", checked: false },
  { label: "All bins emptied (internal and external)", checked: false },
  { label: "External doors unlocked and working when required", checked: false },
  { label: "Daily line counts completed", checked: false },
  { label: "Booking systems checked", checked: false },
  { label: "All customer feedback responded to", checked: false },
  { label: "Defibrillator checked and operational", checked: false },
  // Bar Fridges
  { section: "Bar Fridges", label: "Bar fridge Unit 1 — temperature recorded (PM)", checked: false },
  { label: "Bar fridge Unit 2 — temperature recorded (PM)", checked: false },
  { label: "Bar fridge Unit 3 — temperature recorded (PM)", checked: false },
  { label: "Bar fridge Unit 4 — temperature recorded (PM)", checked: false },
  { label: "Bar fridge Unit 5 — temperature recorded (PM)", checked: false },
  // Today's Tasks
  { section: "Today's Tasks", label: "Duty First Aiders appointed", checked: false },
  { label: "Duty Fire Marshals appointed", checked: false },
];

const TEMPLATES: Record<string, ChecklistItem[]> = {
  kitchen_closing: KITCHEN_CLOSING_ITEMS,
  premises_closing: PREMISES_CLOSING_ITEMS,
};

const CHECKLIST_LABELS: Record<string, string> = {
  kitchen_closing: "Kitchen Closing",
  premises_closing: "Premises Closing",
};

// ── Checklist card ────────────────────────────────────────────────────────────

function ChecklistCard({ type, siteId, siteName, date, existing, onSaved, canAdmin }: {
  type: string; siteId: number | null; siteName?: string; date: string;
  existing?: Checklist; onSaved: () => void; canAdmin: boolean;
}) {
  const [templateItems, setTemplateItems] = useState<ChecklistItem[] | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);

  useEffect(() => {
    if (existing) { setTemplateLoading(false); return; }
    (async () => {
      setTemplateLoading(true);
      const params = new URLSearchParams({ type });
      if (siteId) params.set("siteId", String(siteId));
      const r = await apiFetch(`/checklist-templates?${params}`);
      if (r.ok) {
        const data = await r.json();
        setTemplateItems(data.items ?? null);
      }
      setTemplateLoading(false);
    })();
  }, [type, siteId, existing]);

  const effectiveDefault = templateItems
    ? templateItems.map(i => ({ ...i, checked: false }))
    : (TEMPLATES[type] ?? []);

  const { user } = useAuth();
  const [items, setItems] = useState<ChecklistItem[]>(existing?.items ?? effectiveDefault);
  const [completedBy, setCompletedBy] = useState(existing?.completedBy ?? user?.name ?? "");
  const [managerNote, setManagerNote] = useState(existing?.managerNote ?? "");
  const [saving, setSaving] = useState(false);
  const submitted = !!existing?.submittedAt;

  useEffect(() => {
    setItems(existing?.items ?? effectiveDefault);
    setCompletedBy(existing?.completedBy ?? user?.name ?? "");
    setManagerNote(existing?.managerNote ?? "");
  }, [existing, type, templateItems]);

  const toggle = (i: number) => { if (submitted) return; setItems(prev => prev.map((item, idx) => idx === i ? { ...item, checked: !item.checked } : item)); };
  const setNote = (i: number, note: string) => { if (submitted) return; setItems(prev => prev.map((item, idx) => idx === i ? { ...item, notes: note } : item)); };

  async function save(submit: boolean) {
    setSaving(true);
    const payload: any = { checklistType: type, checkDate: date, siteId: siteId ?? null, items, completedBy: completedBy || null, managerNote: managerNote || null };
    if (submit) payload.submittedAt = new Date().toISOString();
    try {
      if (existing) { await apiFetch(`/daily-track-pm/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) }); }
      else { await apiFetch(`/daily-track-pm`, { method: "POST", body: JSON.stringify(payload) }); }
      onSaved();
    } finally { setSaving(false); }
  }

  const checkedCount = items.filter(i => i.checked).length;
  const Icon = type === "kitchen_closing" ? UtensilsCrossed : Building2;

  return (
    <>
      <Card className="p-5 bg-card shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-primary opacity-80" />
            <h3 className="font-semibold font-display">{CHECKLIST_LABELS[type]}</h3>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && !submitted && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setShowEditor(true)} title="Customise checklist">
                <Settings2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{checkedCount}/{items.length}</span>
            {submitted
              ? <Badge className="bg-emerald-100 text-emerald-800 text-xs"><Lock className="w-3 h-3 mr-1" />Submitted</Badge>
              : checkedCount === items.length && items.length > 0
              ? <Badge className="bg-blue-100 text-blue-800 text-xs">Ready to submit</Badge>
              : <Badge variant="secondary" className="text-xs">In progress</Badge>}
          </div>
        </div>

        {templateLoading && !existing ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-1 mb-4">
            {items.map((item, i) => (
              <div key={i}>
                {item.section && (item.section !== items[i - 1]?.section) && (
                  <p className={`text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 px-1 ${i > 0 ? "mt-3" : ""} mb-1`}>
                    {item.section}
                  </p>
                )}
                <div className={`rounded-lg border p-3 transition-colors ${submitted ? "bg-muted/20 opacity-80" : "hover:bg-muted/20 cursor-pointer"} ${item.checked ? "border-emerald-200 bg-emerald-50/50" : "border-border"}`}>
                  <div className="flex items-start gap-3" onClick={() => toggle(i)}>
                    {item.checked ? <CheckSquare className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" /> : <Square className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />}
                    <span className={`text-sm ${item.checked ? "text-emerald-800 line-through decoration-emerald-400" : ""}`}>{item.label}</span>
                  </div>
                  {!submitted && item.checked && (
                    <div className="mt-2 ml-7">
                      <Input value={item.notes ?? ""} onChange={e => setNote(i, e.target.value)} placeholder="Optional note…" className="h-7 text-xs bg-white" onClick={e => e.stopPropagation()} />
                    </div>
                  )}
                  {submitted && item.notes && <p className="ml-7 mt-1 text-xs text-muted-foreground italic">{item.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        {!submitted && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label className="text-xs">Completed by</Label><Input value={completedBy} onChange={e => setCompletedBy(e.target.value)} placeholder="Name" className="h-8 text-sm" /></div>
              {canAdmin && <div className="space-y-1"><Label className="text-xs">Manager note</Label><Input value={managerNote} onChange={e => setManagerNote(e.target.value)} placeholder="Optional" className="h-8 text-sm" /></div>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={saving} className="flex-1">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save draft"}</Button>
              <Button size="sm" onClick={() => save(true)} disabled={saving || checkedCount === 0} className="flex-1">Submit checklist</Button>
            </div>
          </div>
        )}
        {submitted && existing?.completedBy && <div className="border-t pt-3"><p className="text-xs text-muted-foreground">Completed by: <span className="font-medium">{existing.completedBy}</span></p></div>}
        {existing?.id && (
          <div className="border-t mt-3 pt-3">
            <CheckPhotoUploader entityType="daily_checklist_pm" entityId={existing.id} compact />
          </div>
        )}
      </Card>

      {canAdmin && (
        <ChecklistTemplateEditor
          open={showEditor}
          onOpenChange={setShowEditor}
          type={type}
          typeLabel={CHECKLIST_LABELS[type] ?? type}
          siteId={siteId}
          siteName={siteName}
          defaultItems={TEMPLATES[type] ?? []}
          onSaved={(newItems: TemplateItem[]) => {
            const ci = newItems.map(i => ({ ...i, checked: false })) as ChecklistItem[];
            setTemplateItems(ci);
            if (!existing) setItems(ci);
          }}
        />
      )}
    </>
  );
}

// ── Manager Sign-off card ─────────────────────────────────────────────────────

function ManagerSignoffCard({ siteId, date, existing, onSaved }: {
  siteId: number | null; date: string; existing?: ManagerSignoff; onSaved: () => void;
}) {
  const [managerName, setManagerName] = useState(existing?.managerName ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const submitted = !!existing?.submittedAt;

  useEffect(() => { setManagerName(existing?.managerName ?? ""); setNotes(existing?.notes ?? ""); }, [existing]);

  async function save(submit: boolean) {
    setSaving(true);
    const payload: any = { signoffDate: date, siteId: siteId ?? null, managerName: managerName || "Manager", notes: notes || null };
    if (submit) payload.submittedAt = new Date().toISOString();
    try {
      if (existing) { await apiFetch(`/daily-track-pm/signoffs/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) }); }
      else { await apiFetch(`/daily-track-pm/signoffs`, { method: "POST", body: JSON.stringify(payload) }); }
      onSaved();
    } finally { setSaving(false); }
  }

  return (
    <Card className="p-5 bg-card shadow-sm lg:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <PenLine className="w-4 h-4 text-primary opacity-80" />
          <h3 className="font-semibold font-display">Manager Daily Sign-off</h3>
        </div>
        {submitted
          ? <Badge className="bg-emerald-100 text-emerald-800 text-xs"><Lock className="w-3 h-3 mr-1" />Signed off</Badge>
          : <Badge variant="secondary" className="text-xs">Pending</Badge>}
      </div>

      {submitted ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>Manager: <span className="font-medium text-foreground">{existing?.managerName}</span></p>
          {existing?.notes && <p className="italic">{existing.notes}</p>}
          <p className="text-xs">Signed off at {new Date(existing!.submittedAt!).toLocaleString()}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Confirm all end-of-day checks are complete and the premises are secure.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1"><Label className="text-xs">Manager name *</Label><Input value={managerName} onChange={e => setManagerName(e.target.value)} placeholder="Your name" /></div>
            <div className="space-y-1"><Label className="text-xs">Notes (optional)</Label><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any issues to flag…" /></div>
          </div>
          <Button onClick={() => save(true)} disabled={saving || !managerName.trim()} className="w-full sm:w-auto">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <PenLine className="w-4 h-4 mr-2" />}
            Sign off end of day
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DailyTrackPmPage() {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { data: sites = [] } = useListSites();

  const today = new Date().toISOString().slice(0, 10);
  const _qs = new URLSearchParams(window.location.search);
  const [date, setDate] = useState(_qs.get("date") ?? today);
  const [siteId, setSiteId] = useState<string>(_qs.get("siteId") ?? "__none__");
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [signoff, setSignoff] = useState<ManagerSignoff | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const selectedSiteId = siteId === "__none__" ? null : Number(siteId);
  const selectedSiteName = sites.find(s => s.id === selectedSiteId)?.name;

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ date });
    if (selectedSiteId) params.set("siteId", String(selectedSiteId));
    const [clRes, soRes] = await Promise.all([
      apiFetch(`/daily-track-pm?${params}`),
      apiFetch(`/daily-track-pm/signoffs?${params}`),
    ]);
    if (clRes.ok) setChecklists(await clRes.json());
    if (soRes.ok) { const rows: ManagerSignoff[] = await soRes.json(); setSignoff(rows[0]); }
    setLoading(false);
  }, [date, selectedSiteId, activeClientId]);

  useEffect(() => { load(); }, [load]);

  const getChecklist = (type: string) => checklists.find(c => c.checklistType === type);

  return (
    <AppLayout title="DailyTrack PM">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">End-of-day premises closing checklist and manager sign-off. Kitchen closing checks are in KitchenTrack.</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sunset className="w-4 h-4 text-orange-400" />
          <span>PM Checks</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-6 p-4 bg-card border border-border rounded-xl">
        <div className="space-y-1 flex-1 min-w-[140px]">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1 flex-1 min-w-[180px]">
          <Label className="text-xs">Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select site…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No site filter</SelectItem>
              {sites.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button variant="outline" size="sm" onClick={load} className="h-9 gap-1.5">
            <RotateCcw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(["premises_closing"] as const).map(type => (
            <ChecklistCard key={type} type={type} siteId={selectedSiteId} siteName={selectedSiteName} date={date} existing={getChecklist(type)} onSaved={load} canAdmin={canAdmin} />
          ))}
          <ManagerSignoffCard siteId={selectedSiteId} date={date} existing={signoff} onSaved={load} />
        </div>
      )}
    </AppLayout>
  );
}
