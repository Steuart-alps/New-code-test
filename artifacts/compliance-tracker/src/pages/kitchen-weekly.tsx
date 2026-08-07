/**
 * KitchenTrack — Weekly Management Review tab
 * Combines CookSafe weekly house-rules check with the ALPS 4-weekly review.
 */
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { format, startOfWeek } from "date-fns";
import { Calendar, CheckCircle2, Save, Plus, Trash2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Data shape ────────────────────────────────────────────────────────────────

type Answer = "yes" | "no" | "na" | "";

type WeeklyRecord = {
  id: number;
  week_commencing: string;
  checks: Record<string, Answer>;
  deviations: { rule?: string; action?: string }[];
  additional: Record<string, any>;
  manager_signature?: string | null;
  submitted_at?: string | null;
};

// ── Check definitions ─────────────────────────────────────────────────────────

const HOUSE_RULES: { key: string; label: string; sublabel?: string }[] = [
  { key: "training",             label: "Training",                   sublabel: "Have the House Rules been followed? (New staff induction, formal training, retraining)" },
  { key: "personalHygiene",      label: "Personal Hygiene",           sublabel: "Hand washing, personal cleanliness, protective clothing, illness/exclusion rules" },
  { key: "cleaning",             label: "Cleaning",                   sublabel: "All specified equipment and areas cleaned as per schedule; cleaning chemicals used correctly" },
  { key: "crossContamination",   label: "Cross Contamination Prevention", sublabel: "Delivery, storage, preparation, cooking and cooling rules" },
  { key: "pestControl",          label: "Pest Control",               sublabel: "Pest proofing, insect screens/fly-killing devices, good housekeeping" },
  { key: "wasteControl",         label: "Waste Control",              sublabel: "Waste in food rooms and waste collection rules" },
  { key: "maintenance",          label: "Maintenance",                sublabel: "Premises structure rules and equipment rules" },
  { key: "stockControl",         label: "Stock Control",              sublabel: "Stock control measures followed" },
  { key: "temperatureControl",   label: "Temperature Control",        sublabel: "Temperature control house rules followed" },
  { key: "recordsComplete",      label: "Records",                    sublabel: "All necessary temperature checks recorded using the correct forms" },
];

const REVIEW_QUESTIONS: { key: string; label: string }[] = [
  { key: "safeMethodsReviewed",         label: "Have you reviewed your safe methods?" },
  { key: "allergensUpdated",            label: "Has allergen information been updated to reflect any menu or ingredient changes?" },
  { key: "methodsOrEquipmentChanged",   label: "Have any methods or equipment changed?" },
  { key: "newSuppliersReviewed",        label: "Have any new suppliers been reviewed and recorded (with contact information)?" },
  { key: "cleaningScheduleNeedsUpdate", label: "Does the cleaning schedule require updating?" },
  { key: "cleaningScheduleCompleted",   label: "Has the cleaning schedule been completed daily?" },
  { key: "newStaffTrained",             label: "Have any new staff received suitable training?" },
  { key: "staffRefresherRequired",      label: "Do any staff require refresher training?" },
  { key: "additionalChecksRequired",    label: "Are additional opening/closing checks required?" },
  { key: "complaintsReceived",          label: "Have any complaints been received?" },
  { key: "complaintsInvestigated",      label: "Have complaints been investigated and, where necessary, changes made?" },
  { key: "extraChecksCompleted",        label: "Have extra checks been completed and recorded weekly?" },
  { key: "proveitChecksCompleted",      label: "Are 'Prove It' checks being completed and regularly recorded?" },
];

// ── YNA toggle ────────────────────────────────────────────────────────────────

function YNAToggle({ value, onChange, disabled, invertColors }: { value: Answer; onChange: (v: Answer) => void; disabled?: boolean; invertColors?: boolean }) {
  const opts: { v: Answer; label: string; cls: string }[] = [
    { v: "yes", label: "Yes", cls: invertColors ? "bg-rose-100 text-rose-800 border-rose-300"    : "bg-emerald-100 text-emerald-800 border-emerald-300" },
    { v: "no",  label: "No",  cls: invertColors ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "bg-rose-100 text-rose-800 border-rose-300" },
    { v: "na",  label: "N/A", cls: "bg-slate-100 text-slate-700 border-slate-300" },
  ];
  return (
    <div className="flex gap-1">
      {opts.map(o => (
        <button
          key={o.v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(value === o.v ? "" : o.v)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded border transition-all",
            value === o.v ? o.cls : "border-border text-muted-foreground bg-background hover:bg-muted/60",
            disabled && "opacity-50 cursor-not-allowed"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Check row ─────────────────────────────────────────────────────────────────

function CheckRow({ q, value, onChange, disabled }: {
  q: { key: string; label: string; sublabel?: string };
  value: Answer;
  onChange: (v: Answer) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{q.label}</p>
        {q.sublabel && <p className="text-xs text-muted-foreground mt-0.5">{q.sublabel}</p>}
      </div>
      <YNAToggle value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WeeklyReviewTab() {
  const { toast } = useToast();
  const today = format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");

  const [selectedWeek, setSelectedWeek] = useState(today);
  const [record, setRecord] = useState<WeeklyRecord | null>(null);
  const [history, setHistory] = useState<Pick<WeeklyRecord, "id" | "week_commencing" | "submitted_at">[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [checks, setChecks] = useState<Record<string, Answer>>({});
  const [deviations, setDeviations] = useState<{ rule?: string; action?: string }[]>([]);
  const [additional, setAdditional] = useState<Record<string, any>>({});
  const [managerSig, setManagerSig] = useState("");

  async function loadHistory() {
    const res = await apiFetch("/kitchen-weekly/weekly");
    if (res.ok) setHistory(await res.json());
  }

  async function loadByWeek(week: string) {
    setLoading(true);
    try {
      const res = await apiFetch(`/kitchen-weekly/weekly/by-date/${week}`);
      if (res.ok) {
        const r: WeeklyRecord = await res.json();
        setRecord(r);
        setChecks(r.checks ?? {});
        setDeviations(r.deviations ?? []);
        setAdditional(r.additional ?? {});
        setManagerSig(r.manager_signature ?? "");
      } else {
        setRecord(null);
        setChecks({});
        setDeviations([]);
        setAdditional({});
        setManagerSig("");
      }
    } finally { setLoading(false); }
  }

  useEffect(() => { loadHistory(); }, []);
  useEffect(() => { loadByWeek(selectedWeek); }, [selectedWeek]);

  async function save(submit = false) {
    if (submit && !managerSig.trim()) {
      toast({ title: "Manager signature required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        weekCommencing: selectedWeek,
        checks,
        deviations,
        additional,
        managerSignature: managerSig || null,
        submittedAt: submit ? new Date().toISOString() : record?.submitted_at ?? null,
      };
      let res: Response;
      if (record) {
        res = await apiFetch(`/kitchen-weekly/weekly/${record.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        res = await apiFetch("/kitchen-weekly/weekly", { method: "POST", body: JSON.stringify(payload) });
        if (res.status === 409) {
          const { id } = await res.json();
          res = await apiFetch(`/kitchen-weekly/weekly/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        }
      }
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      toast({ title: submit ? "Weekly review submitted" : "Draft saved" });
      await loadHistory();
      await loadByWeek(selectedWeek);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  const isSubmitted = !!record?.submitted_at;

  // flag any "no" answers
  const noAnswers = [...HOUSE_RULES, ...REVIEW_QUESTIONS].filter(q => checks[q.key] === "no");

  return (
    <div className="space-y-6">
      {/* Week selector + history */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b border-border/50 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-display">Week Commencing</CardTitle>
                <CardDescription className="text-xs mt-1">Select the Monday for the week being reviewed</CardDescription>
              </div>
              {isSubmitted && (
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Submitted
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Label className="text-sm whitespace-nowrap">Week commencing:</Label>
              <Input type="date" value={selectedWeek} onChange={e => setSelectedWeek(e.target.value)} className="max-w-xs" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="text-base font-display">Recent Reviews</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {history.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No reviews yet.</p>
            ) : (
              <div className="divide-y divide-border max-h-48 overflow-y-auto">
                {history.slice(0, 12).map(r => (
                  <button key={r.id} onClick={() => setSelectedWeek(r.week_commencing)}
                    className="w-full p-3 hover:bg-muted/20 text-left flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{format(new Date(r.week_commencing), "dd MMM yyyy")}</span>
                    {r.submitted_at
                      ? <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 h-5"><CheckCircle2 className="w-2.5 h-2.5 mr-1" />Done</Badge>
                      : <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200 h-5">Draft</Badge>}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* Section 1: House Rules */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">House Rules Review</CardTitle>
              <CardDescription className="text-xs mt-1">
                Has each area followed the house rules this week? Answer Yes / No / N/A for each.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              {HOUSE_RULES.map(q => (
                <CheckRow
                  key={q.key}
                  q={q}
                  value={checks[q.key] as Answer ?? ""}
                  onChange={v => setChecks(prev => ({ ...prev, [q.key]: v }))}
                  disabled={isSubmitted}
                />
              ))}
            </CardContent>
          </Card>

          {/* Deviations table */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">House Rules Deviations Observed</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    If any answer above is "No", record the deviation and corrective action taken
                  </CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setDeviations([...deviations, {}])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Row
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {noAnswers.length > 0 && deviations.length === 0 && !isSubmitted && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2 mb-3">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{noAnswers.map(q => q.label).join(", ")} answered "No" — please record the deviation and action taken below.</span>
                </div>
              )}
              {deviations.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No deviations recorded.</p>
              ) : (
                deviations.map((dev, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <Input
                      placeholder="House rule area / deviation observed"
                      value={dev.rule ?? ""}
                      onChange={e => { const u = [...deviations]; u[i] = { ...u[i], rule: e.target.value }; setDeviations(u); }}
                      disabled={isSubmitted}
                      className="flex-1"
                    />
                    <Input
                      placeholder="Corrective action taken"
                      value={dev.action ?? ""}
                      onChange={e => { const u = [...deviations]; u[i] = { ...u[i], action: e.target.value }; setDeviations(u); }}
                      disabled={isSubmitted}
                      className="flex-1"
                    />
                    {!isSubmitted && (
                      <Button variant="ghost" size="sm" onClick={() => setDeviations(deviations.filter((_, idx) => idx !== i))}>
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Section 2: Review questions */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Management Review Questions</CardTitle>
              <CardDescription className="text-xs mt-1">
                Additional review checks covering allergens, suppliers, complaints, training and ongoing records
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              {REVIEW_QUESTIONS.map(q => (
                <CheckRow
                  key={q.key}
                  q={q}
                  value={checks[q.key] as Answer ?? ""}
                  onChange={v => setChecks(prev => ({ ...prev, [q.key]: v }))}
                  disabled={isSubmitted}
                />
              ))}
            </CardContent>
          </Card>

          {/* Additional info */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Additional Information</CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-4 py-2">
                <p className="text-sm font-medium">Has any issue been recorded 3 or more times?</p>
                <YNAToggle
                  value={additional.issuesThreeTimes ?? ""}
                  onChange={v => setAdditional(prev => ({ ...prev, issuesThreeTimes: v }))}
                  disabled={isSubmitted}
                  invertColors
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">What action has been taken to rectify any recurring issues?</Label>
                <Textarea
                  value={additional.actionTaken ?? ""}
                  onChange={e => setAdditional(prev => ({ ...prev, actionTaken: e.target.value }))}
                  rows={3}
                  placeholder="Describe actions taken to resolve any recurring issues…"
                  disabled={isSubmitted}
                />
              </div>
            </CardContent>
          </Card>

          {/* Sign-off */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Manager / Proprietor Sign-off</CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="space-y-1.5">
                <Label>Manager / Proprietor name (signature)</Label>
                <Input
                  value={managerSig}
                  onChange={e => setManagerSig(e.target.value)}
                  placeholder="Type your name to sign"
                  disabled={isSubmitted}
                  className="max-w-sm"
                />
              </div>
              {isSubmitted ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" />
                  Submitted on {format(new Date(record!.submitted_at!), "dd/MM/yyyy 'at' HH:mm")} by {record!.manager_signature}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Button variant="outline" onClick={() => save(false)} disabled={saving}>
                    <Save className="w-4 h-4 mr-2" /> Save Draft
                  </Button>
                  <Button onClick={() => save(true)} disabled={saving} className="shadow-lg shadow-primary/20">
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    {saving ? "Submitting…" : "Submit & Sign"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
