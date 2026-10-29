import { useState, useEffect, useCallback, useRef } from "react";
import { format } from "date-fns";
import { AppLayout } from "@/components/layout";
import { apiFetch, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { ChecklistItemRow } from "@/components/checklist-item-row";
import { checklistProgress, submitHint, withResult, itemResult, type ChecklistResult } from "@/lib/checklist-results";
import { fetchMobileChecklistSubmission, MobileChecklistSubmissionCard, type MobileChecklistSubmission } from "@/components/mobile-checklist-submission-card";
import { CheckPhotoUploader } from "@/components/check-photo-uploader";
import { StaffPerformerSelect } from "@/components/staff-performer-select";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { useChecklistSite } from "@/hooks/use-checklist-site";
import { ChecklistSiteSelect } from "@/components/checklist-site-select";
import { carryAnswers, createChecklistDraftStore, hasAnswers, type ChecklistDraftSlot } from "@/lib/checklist-carry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sunrise, UtensilsCrossed, Building2, Loader2, Lock, RotateCcw, Settings2 } from "lucide-react";
import { ChecklistTemplateEditor, type TemplateItem } from "./checklist-template-editor";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChecklistItem { label: string; checked: boolean; notes?: string; section?: string; result?: ChecklistResult; }

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

export function ChecklistCard({
  type, siteId, siteName, date, existing, onSaved, canAdmin, draft,
}: {
  type: string;
  siteId: number | null;
  siteName?: string;
  date: string;
  existing?: Checklist;
  onSaved: () => void;
  canAdmin: boolean;
  draft?: ChecklistDraftSlot<ChecklistItem>;
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

  const { user } = useAuth();
  const { toast } = useToast();
  const submitted = !!existing?.submittedAt;
  // Ticks made before the site or date was changed (or before a reload) are
  // carried onto this card, unless this one is already submitted.
  const carried = submitted ? undefined : draft?.get();
  const startItems = () => {
    const base = existing?.items ?? effectiveDefault;
    return carried ? carryAnswers(base, carried.items, item => item.label) : base;
  };
  const [items, setItems] = useState<ChecklistItem[]>(startItems);
  const [completedBy, setCompletedBy] = useState(carried?.completedBy || (existing?.completedBy ?? user?.name ?? ""));
  const [staffRosterId, setStaffRosterId] = useState<number | null>(carried ? carried.staffRosterId : (existing as any)?.staffRosterId ?? null);
  const [managerNote, setManagerNote] = useState(carried?.managerNote || (existing?.managerNote ?? ""));
  const [saving, setSaving] = useState(false);
  const touched = useRef(false);

  useEffect(() => {
    setItems(startItems());
    setCompletedBy(carried?.completedBy || (existing?.completedBy ?? user?.name ?? ""));
    setStaffRosterId(carried ? carried.staffRosterId : (existing as any)?.staffRosterId ?? null);
    setManagerNote(carried?.managerNote || (existing?.managerNote ?? ""));
  }, [existing, type, templateItems]);

  useEffect(() => {
    if (touched.current && !submitted) draft?.set({ items, completedBy, staffRosterId, managerNote });
  }, [items, completedBy, staffRosterId, managerNote]);

  const edit = <T,>(set: (value: T) => void) => (value: T) => { touched.current = true; set(value); };
  const setResult = (i: number, result: ChecklistResult) => { if (submitted) return; touched.current = true; setItems(prev => prev.map((item, idx) => idx === i ? withResult(item, result) : item)); };
  const passRemaining = () => { if (submitted) return; touched.current = true; setItems(prev => prev.map(item => itemResult(item) ? item : withResult(item, "pass"))); };

  const setNote = (i: number, note: string) => {
    if (submitted) return;
    touched.current = true;
    setItems(prev => prev.map((item, idx) => idx === i ? { ...item, notes: note } : item));
  };

  async function save(submit: boolean) {
    setSaving(true);
    const payload: any = {
      checklistType: type, checkDate: date, siteId: siteId ?? null,
       items, completedBy: completedBy || null, staffRosterId, managerNote: managerNote || null,
    };
    if (submit) payload.submittedAt = new Date().toISOString();
    const failedTitle = submit ? "Checklist not submitted" : "Draft not saved";
    try {
      const res = existing
        ? await apiFetch(`/daily-track-am/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiFetch(`/daily-track-am`, { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        // Keep the user's ticks; only a 409 (already submitted elsewhere)
        // reloads, to show the stored submitted copy.
        toast({ title: failedTitle, description: await getApiErrorMessage(res, "Please try again."), variant: "destructive" });
        if (res.status === 409) onSaved();
        return;
      }
      toast({ title: submit ? "Checklist submitted" : "Draft saved" });
      touched.current = false;
      draft?.set(undefined);
      onSaved();
    } catch {
      toast({ title: failedTitle, description: "Check your connection and try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  const progress = checklistProgress(items);
  const hint = submitHint(progress);
  const Icon = type === "kitchen_opening" ? UtensilsCrossed : Building2;

  return (
    <>
      <Card className="p-5 bg-card shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-primary opacity-80" />
            <h3 className="font-bold font-display">{CHECKLIST_LABELS[type]}</h3>
          </div>
          <div className="flex items-center gap-2">
            {canAdmin && !submitted && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setShowEditor(true)} title="Customise checklist">
                <Settings2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{progress.answered}/{items.length}{progress.failed > 0 && <span className="text-red-600 font-medium"> · {progress.failed} failed</span>}</span>
            {submitted
              ? <Badge className="bg-emerald-100 text-emerald-800 text-xs"><Lock className="w-3 h-3 mr-1" />Submitted</Badge>
              : progress.ready
              ? <Badge className="bg-blue-100 text-blue-800 text-xs">Ready to submit</Badge>
              : <Badge variant="secondary" className="text-xs">In progress</Badge>}
          </div>
        </div>

        {carried && hasAnswers(carried.items) && !touched.current && (
          <p className="text-xs text-blue-700 mb-3">Your unsaved ticks are filled in below. Save or submit to keep them.</p>
        )}

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
                <ChecklistItemRow item={item} submitted={submitted} onResult={result => setResult(i, result)} onNote={note => setNote(i, note)} />
              </div>
            ))}
          </div>
        )}

        {!submitted && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <StaffPerformerSelect label="Completed by" value={completedBy} onChange={edit(setCompletedBy)} onRosterIdChange={edit(setStaffRosterId)} />
              </div>
              {canAdmin && (
                <div className="space-y-1">
                  <Label className="text-xs">Manager note</Label>
                  <Input value={managerNote} onChange={e => edit(setManagerNote)(e.target.value)} placeholder="Optional" className="h-8 text-sm" />
                </div>
              )}
            </div>
            {progress.remaining > 0 && progress.answered > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={passRemaining}>Mark the {progress.remaining} remaining as Pass</Button>
            )}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={saving} className="flex-1">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save draft"}
              </Button>
              <Button size="sm" onClick={() => save(true)} disabled={saving || !progress.ready} className="flex-1">
                Submit checklist
              </Button>
            </div>
          </div>
        )}

        {submitted && draft?.get() && hasAnswers(draft.get()!.items) && (
          <p className="text-xs text-amber-700 mb-3">This checklist is already submitted. Your unsaved ticks are kept: choose another site or date to use them.</p>
        )}

        {submitted && (
          <div className="border-t pt-3 space-y-1">
            {existing?.completedBy && <p className="text-xs text-muted-foreground">Completed by: <span className="font-medium">{existing.completedBy}</span></p>}
            {existing?.managerNote && <p className="text-xs text-muted-foreground">Manager note: <span className="italic">{existing.managerNote}</span></p>}
          </div>
        )}
        {existing?.id && (
          <div className="border-t mt-3 pt-3">
            <CheckPhotoUploader entityType="daily_checklist" entityId={existing.id} compact />
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
  const { activeClientId, hasService } = useAuth();
  const canAdmin = useCanAdmin();
  const { sites, siteId: selectedSiteId, setSiteId, ready: siteReady } = useChecklistSite();
  // Unsaved ticks per checklist, kept while the site or date changes.
  const [drafts] = useState(createChecklistDraftStore);
  const loadSeq = useRef(0);

  const today = format(new Date(), "yyyy-MM-dd");
  const _qs = new URLSearchParams(window.location.search);
  const [date, setDate] = useState(_qs.get("date") ?? today);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [mobileSubmission, setMobileSubmission] = useState<MobileChecklistSubmission | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedSiteName = sites.find(s => s.id === selectedSiteId)?.name;
  const hasStandaloneDailyTrack = hasService("dailytrack_am");
  const visibleTypes = [
    ...(hasStandaloneDailyTrack || hasService("kitchentrack") ? ["kitchen_opening" as const] : []),
    ...(hasStandaloneDailyTrack || hasService("premisestrack") ? ["premises_opening" as const] : []),
  ];

  const load = useCallback(async () => {
    if (!siteReady) return;
    // A slower answer for the previous site or date must not replace this one.
    const seq = ++loadSeq.current;
    setLoading(true);
    const params = new URLSearchParams({ date });
    if (selectedSiteId) params.set("siteId", String(selectedSiteId));
    const [r, mobile] = await Promise.all([
      apiFetch(`/daily-track-am?${params}`),
      hasStandaloneDailyTrack ? fetchMobileChecklistSubmission(selectedSiteId, date, "am") : Promise.resolve(null),
    ]);
    const rows = r.ok ? await r.json() : null;
    if (seq !== loadSeq.current) return;
    if (rows) setChecklists(rows);
    setMobileSubmission(mobile);
    setLoading(false);
  }, [date, selectedSiteId, siteReady, activeClientId, hasStandaloneDailyTrack]);

  useEffect(() => { load(); }, [load]);

  // Without a site filter the list holds every site's rows; match the card's
  // own slot so it never edits another site's checklist.
  const getChecklist = (type: string) => checklists.find(c => c.checklistType === type && (c.siteId ?? null) === selectedSiteId);

  return (
    <AppLayout title="DailyTrack AM">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <p className="text-muted-foreground hidden sm:block">Morning opening checklists for the services enabled on your account.</p>
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
        <ChecklistSiteSelect sites={sites} value={selectedSiteId} onChange={setSiteId} />
        <div className="flex items-end">
          <Button variant="outline" size="sm" onClick={load} className="h-9 gap-1.5">
            <RotateCcw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {loading || !siteReady ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {mobileSubmission && <MobileChecklistSubmissionCard submission={mobileSubmission} />}
          {visibleTypes.map(type => (
            <ChecklistCard
              key={type}
              type={type}
              siteId={selectedSiteId}
              siteName={selectedSiteName}
              date={date}
              existing={getChecklist(type)}
              onSaved={load}
              canAdmin={canAdmin}
              draft={drafts.slot(type)}
            />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
