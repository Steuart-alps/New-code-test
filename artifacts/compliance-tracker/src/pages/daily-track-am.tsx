import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useListSites } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckSquare, Square, Sunrise, UtensilsCrossed, Building2, Loader2, Lock, RotateCcw, Settings2 } from "lucide-react";
import { ChecklistTemplateEditor, type TemplateItem } from "./checklist-template-editor";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChecklistItem { label: string; checked: boolean; notes?: string; section?: string; }

interface Checklist {
  id: number;
  checklistType: string;
  checkDate: string;
  siteId?: number | null;
  items: ChecklistItem[];
  completedBy?: string | null;
  managerNote?: string | null;
  submittedAt?: string | null;
}

// ── Default templates ─────────────────────────────────────────────────────────

const KITCHEN_OPENING_ITEMS: ChecklistItem[] = [
  // 1. Security & Safety
  { section: "Security & Safety", label: "Unlock premises and disarm alarm", checked: false },
  { label: "Check for signs of break-in or damage", checked: false },
  { label: "Ensure emergency exits are clear and unlocked", checked: false },
  { label: "Check fire exits, extinguishers and fire blanket are accessible", checked: false },
  { label: "Switch on lights and ventilation/extraction", checked: false },
  // 2. Food Safety
  { section: "Food Safety", label: "Wash hands before starting work", checked: false },
  { label: "Put on clean uniform and PPE (if required)", checked: false },
  { label: "Check soap, sanitiser and paper towels are stocked", checked: false },
  { label: "Ensure cleaning chemicals are labelled and stored correctly", checked: false },
  // 3. Temperature Checks
  { section: "Temperature Checks", label: "Walk-in fridge temperature checked (target 0–5°C)", checked: false },
  { label: "Under-counter fridge temperature checked (target 0–5°C)", checked: false },
  { label: "Freezer temperature checked (target -18°C or below)", checked: false },
  { label: "Display fridge temperature checked (target 0–5°C, if applicable)", checked: false },
  { label: "Any temperature outside safe limits reported", checked: false },
  // 4. Equipment Checks
  { section: "Equipment Checks", label: "Ovens turned on", checked: false },
  { label: "Grills turned on", checked: false },
  { label: "Fryers turned on", checked: false },
  { label: "Extraction system operating correctly", checked: false },
  { label: "Hot holding equipment turned on", checked: false },
  { label: "Refrigeration displays turned on", checked: false },
  { label: "Dishwasher reaches correct wash/rinse temperatures", checked: false },
  { label: "Probe thermometer tested and sanitised before use", checked: false },
  // 5. Food Preparation
  { section: "Food Preparation", label: "Overnight deliveries checked", checked: false },
  { label: "Stock rotated (FIFO)", checked: false },
  { label: "Use-by dates checked", checked: false },
  { label: "Expired food discarded", checked: false },
  { label: "All prepared food labelled with date/time", checked: false },
  { label: "Required stock removed from storage", checked: false },
  { label: "Prep list completed", checked: false },
  // 6. Cleaning
  { section: "Cleaning", label: "All food contact surfaces sanitised", checked: false },
  { label: "Chopping boards cleaned", checked: false },
  { label: "Knives and utensils cleaned", checked: false },
  { label: "Bins emptied if required and fitted with clean liners", checked: false },
  { label: "Any spills mopped", checked: false },
  { label: "Sinks clean and ready for use", checked: false },
  // 7. Service Readiness
  { section: "Service Readiness", label: "Cooking stations set up", checked: false },
  { label: "Ingredients stocked", checked: false },
  { label: "Sauces and seasonings refilled", checked: false },
  { label: "Garnishes prepared", checked: false },
  { label: "Disposable items stocked (if applicable)", checked: false },
  { label: "Ticket printer/POS checked and working", checked: false },
  { label: "Team briefing held (menu changes, allergens, bookings)", checked: false },
  // 8. Documentation
  { section: "Documentation", label: "Fridge/freezer temperatures recorded", checked: false },
  { label: "Probe calibration recorded (if scheduled)", checked: false },
  { label: "Any maintenance issues recorded", checked: false },
  { label: "Checklist signed and dated", checked: false },
];

const PREMISES_OPENING_ITEMS: ChecklistItem[] = [
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
  { label: "End of day — all tills in", checked: false },
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
  { section: "Bar Fridges", label: "Bar fridge Unit 1 — temperature recorded (AM)", checked: false },
  { label: "Bar fridge Unit 2 — temperature recorded (AM)", checked: false },
  { label: "Bar fridge Unit 3 — temperature recorded (AM)", checked: false },
  { label: "Bar fridge Unit 4 — temperature recorded (AM)", checked: false },
  { label: "Bar fridge Unit 5 — temperature recorded (AM)", checked: false },
  // Today's Tasks
  { section: "Today's Tasks", label: "Duty First Aiders appointed", checked: false },
  { label: "Duty Fire Marshals appointed", checked: false },
];

const TEMPLATES: Record<string, ChecklistItem[]> = {
  kitchen_opening: KITCHEN_OPENING_ITEMS,
  premises_opening: PREMISES_OPENING_ITEMS,
};

const CHECKLIST_LABELS: Record<string, string> = {
  kitchen_opening: "Kitchen Opening",
  premises_opening: "Premises Opening",
};

// ── Checklist card ────────────────────────────────────────────────────────────

function ChecklistCard({
  type, siteId, siteName, date, existing, onSaved, canAdmin,
}: {
  type: string;
  siteId: number | null;
  siteName?: string;
  date: string;
  existing?: Checklist;
  onSaved: () => void;
  canAdmin: boolean;
}) {
  const [templateItems, setTemplateItems] = useState<ChecklistItem[] | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);

  // Fetch custom template on mount / when type or siteId changes
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

  const [items, setItems] = useState<ChecklistItem[]>(existing?.items ?? effectiveDefault);
  const [completedBy, setCompletedBy] = useState(existing?.completedBy ?? "");
  const [managerNote, setManagerNote] = useState(existing?.managerNote ?? "");
  const [saving, setSaving] = useState(false);
  const submitted = !!existing?.submittedAt;

  useEffect(() => {
    setItems(existing?.items ?? effectiveDefault);
    setCompletedBy(existing?.completedBy ?? "");
    setManagerNote(existing?.managerNote ?? "");
  }, [existing, type, templateItems]);

  const toggle = (i: number) => {
    if (submitted) return;
    setItems(prev => prev.map((item, idx) => idx === i ? { ...item, checked: !item.checked } : item));
  };

  const setNote = (i: number, note: string) => {
    if (submitted) return;
    setItems(prev => prev.map((item, idx) => idx === i ? { ...item, notes: note } : item));
  };

  async function save(submit: boolean) {
    setSaving(true);
    const payload: any = {
      checklistType: type, checkDate: date, siteId: siteId ?? null,
      items, completedBy: completedBy || null, managerNote: managerNote || null,
    };
    if (submit) payload.submittedAt = new Date().toISOString();
    try {
      if (existing) {
        await apiFetch(`/daily-track-am/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch(`/daily-track-am`, { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } finally { setSaving(false); }
  }

  const checkedCount = items.filter(i => i.checked).length;
  const Icon = type === "kitchen_opening" ? UtensilsCrossed : Building2;

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
                    {item.checked
                      ? <CheckSquare className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                      : <Square className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />}
                    <span className={`text-sm ${item.checked ? "text-emerald-800 line-through decoration-emerald-400" : ""}`}>{item.label}</span>
                  </div>
                  {!submitted && item.checked && (
                    <div className="mt-2 ml-7">
                      <Input
                        value={item.notes ?? ""}
                        onChange={e => setNote(i, e.target.value)}
                        placeholder="Optional note…"
                        className="h-7 text-xs bg-white"
                        onClick={e => e.stopPropagation()}
                      />
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
              <div className="space-y-1">
                <Label className="text-xs">Completed by</Label>
                <Input value={completedBy} onChange={e => setCompletedBy(e.target.value)} placeholder="Name" className="h-8 text-sm" />
              </div>
              {canAdmin && (
                <div className="space-y-1">
                  <Label className="text-xs">Manager note</Label>
                  <Input value={managerNote} onChange={e => setManagerNote(e.target.value)} placeholder="Optional" className="h-8 text-sm" />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={saving} className="flex-1">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save draft"}
              </Button>
              <Button size="sm" onClick={() => save(true)} disabled={saving || checkedCount === 0} className="flex-1">
                Submit checklist
              </Button>
            </div>
          </div>
        )}

        {submitted && (
          <div className="border-t pt-3 space-y-1">
            {existing?.completedBy && <p className="text-xs text-muted-foreground">Completed by: <span className="font-medium">{existing.completedBy}</span></p>}
            {existing?.managerNote && <p className="text-xs text-muted-foreground">Manager note: <span className="italic">{existing.managerNote}</span></p>}
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DailyTrackAmPage() {
  const { activeClientId } = useAuth();
  const canAdmin = useCanAdmin();
  const { data: sites = [] } = useListSites();

  const today = new Date().toISOString().slice(0, 10);
  const _qs = new URLSearchParams(window.location.search);
  const [date, setDate] = useState(_qs.get("date") ?? today);
  const [siteId, setSiteId] = useState<string>(_qs.get("siteId") ?? "__none__");
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedSiteId = siteId === "__none__" ? null : Number(siteId);
  const selectedSiteName = sites.find(s => s.id === selectedSiteId)?.name;

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ date });
    if (selectedSiteId) params.set("siteId", String(selectedSiteId));
    const r = await apiFetch(`/daily-track-am?${params}`);
    if (r.ok) setChecklists(await r.json());
    setLoading(false);
  }, [date, selectedSiteId, activeClientId]);

  useEffect(() => { load(); }, [load]);

  const getChecklist = (type: string) => checklists.find(c => c.checklistType === type);

  return (
    <AppLayout title="DailyTrack AM">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">Morning opening checklists — kitchen and premises readiness.</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sunrise className="w-4 h-4 text-amber-500" />
          <span>AM Checks</span>
        </div>
      </div>

      {/* Controls */}
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
          {(["kitchen_opening", "premises_opening"] as const).map(type => (
            <ChecklistCard
              key={type}
              type={type}
              siteId={selectedSiteId}
              siteName={selectedSiteName}
              date={date}
              existing={getChecklist(type)}
              onSaved={load}
              canAdmin={canAdmin}
            />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
