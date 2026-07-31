/**
 * KitchenTrack — Monthly Probe Calibration Check tab
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
import { format } from "date-fns";
import { CheckCircle2, XCircle, Save, Plus, Trash2, Thermometer } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type ProbeRow = {
  name?: string;
  serialNo?: string;
  iceTemp?: string;      // measured temp at 0°C ice point
  boilingTemp?: string;  // measured temp at 100°C boiling point
  accurateIce?: boolean;
  accurateBoiling?: boolean;
  notes?: string;
};

type ProbeRecord = {
  id: number;
  check_date: string;
  probes: ProbeRow[];
  overall_result?: string | null;
  checked_by?: string | null;
  signature?: string | null;
  notes?: string | null;
  submitted_at?: string | null;
};

type HistoryItem = Pick<ProbeRecord, "id" | "check_date" | "overall_result" | "checked_by" | "submitted_at">;

// ── Empty probe ───────────────────────────────────────────────────────────────

function emptyProbe(): ProbeRow {
  return { name: "", serialNo: "", iceTemp: "", boilingTemp: "", accurateIce: undefined, accurateBoiling: undefined, notes: "" };
}

// ── Probe row component ───────────────────────────────────────────────────────

function ProbeRowFields({ row, idx, onChange, onRemove, disabled }: {
  row: ProbeRow;
  idx: number;
  onChange: (row: ProbeRow) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  function set<K extends keyof ProbeRow>(k: K, v: ProbeRow[K]) {
    onChange({ ...row, [k]: v });
  }
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-muted-foreground">Probe {idx + 1}</p>
        {!disabled && (
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10" onClick={onRemove}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Probe Name / ID</Label>
          <Input value={row.name ?? ""} onChange={e => set("name", e.target.value)} placeholder="e.g. Probe 1, Checktemp" disabled={disabled} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Serial Number</Label>
          <Input value={row.serialNo ?? ""} onChange={e => set("serialNo", e.target.value)} placeholder="Optional" disabled={disabled} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Ice Point Reading (°C)</Label>
          <div className="space-y-1.5">
            <Input value={row.iceTemp ?? ""} onChange={e => set("iceTemp", e.target.value)} placeholder="e.g. 0.4" disabled={disabled} />
            <div className="flex gap-2">
              {[true, false].map(v => (
                <button
                  key={String(v)}
                  type="button"
                  disabled={disabled}
                  onClick={() => set("accurateIce", row.accurateIce === v ? undefined : v)}
                  className={cn(
                    "flex-1 text-xs py-1.5 rounded border font-medium transition-all",
                    row.accurateIce === true && v === true  ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
                    row.accurateIce === false && v === false ? "bg-rose-100 text-rose-800 border-rose-300" :
                    "border-border text-muted-foreground hover:bg-muted/60",
                    disabled && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {v ? "✓ Accurate" : "✗ Inaccurate"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Must read within ±1°C of 0°C</p>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Boiling Point Reading (°C)</Label>
          <div className="space-y-1.5">
            <Input value={row.boilingTemp ?? ""} onChange={e => set("boilingTemp", e.target.value)} placeholder="e.g. 99.7" disabled={disabled} />
            <div className="flex gap-2">
              {[true, false].map(v => (
                <button
                  key={String(v)}
                  type="button"
                  disabled={disabled}
                  onClick={() => set("accurateBoiling", row.accurateBoiling === v ? undefined : v)}
                  className={cn(
                    "flex-1 text-xs py-1.5 rounded border font-medium transition-all",
                    row.accurateBoiling === true && v === true  ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
                    row.accurateBoiling === false && v === false ? "bg-rose-100 text-rose-800 border-rose-300" :
                    "border-border text-muted-foreground hover:bg-muted/60",
                    disabled && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {v ? "✓ Accurate" : "✗ Inaccurate"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Must read within ±1°C of 100°C</p>
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Notes / Action Taken</Label>
        <Input value={row.notes ?? ""} onChange={e => set("notes", e.target.value)} placeholder="e.g. Probe adjusted, replaced, or decommissioned" disabled={disabled} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProbeCheckTab() {
  const { toast } = useToast();
  const today = format(new Date(), "yyyy-MM-dd");

  const [selectedDate, setSelectedDate] = useState(today);
  const [record, setRecord] = useState<ProbeRecord | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [probes, setProbes] = useState<ProbeRow[]>([emptyProbe()]);
  const [overallResult, setOverallResult] = useState<"pass" | "fail" | "">("");
  const [checkedBy, setCheckedBy] = useState("");
  const [signature, setSignature] = useState("");
  const [notes, setNotes] = useState("");

  async function loadHistory() {
    const res = await apiFetch("/kitchen-weekly/probe");
    if (res.ok) setHistory(await res.json());
  }

  async function loadByDate(date: string) {
    setLoading(true);
    try {
      const res = await apiFetch(`/kitchen-weekly/probe/by-date/${date}`);
      if (res.ok) {
        const r: ProbeRecord = await res.json();
        setRecord(r);
        setProbes(r.probes?.length ? r.probes : [emptyProbe()]);
        setOverallResult((r.overall_result as any) ?? "");
        setCheckedBy(r.checked_by ?? "");
        setSignature(r.signature ?? "");
        setNotes(r.notes ?? "");
      } else {
        setRecord(null);
        setProbes([emptyProbe()]);
        setOverallResult("");
        setCheckedBy("");
        setSignature("");
        setNotes("");
      }
    } finally { setLoading(false); }
  }

  useEffect(() => { loadHistory(); }, []);
  useEffect(() => { loadByDate(selectedDate); }, [selectedDate]);

  // Auto-compute overall result from probe answers
  useEffect(() => {
    const answered = probes.filter(p => p.accurateIce !== undefined || p.accurateBoiling !== undefined);
    if (answered.length === 0) return;
    const anyFail = probes.some(p => p.accurateIce === false || p.accurateBoiling === false);
    setOverallResult(anyFail ? "fail" : "pass");
  }, [probes]);

  async function save(submit = false) {
    if (submit && !signature.trim()) {
      toast({ title: "Signature required to submit", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        checkDate: selectedDate,
        probes,
        overallResult: overallResult || null,
        checkedBy: checkedBy || null,
        signature: signature || null,
        notes: notes || null,
        submittedAt: submit ? new Date().toISOString() : record?.submitted_at ?? null,
      };

      let res: Response;
      if (record) {
        res = await apiFetch(`/kitchen-weekly/probe/${record.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        res = await apiFetch("/kitchen-weekly/probe", { method: "POST", body: JSON.stringify(payload) });
      }
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      toast({ title: submit ? "Probe check submitted" : "Draft saved" });
      await loadHistory();
      await loadByDate(selectedDate);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  function updateProbe(idx: number, row: ProbeRow) {
    setProbes(prev => { const u = [...prev]; u[idx] = row; return u; });
  }

  function removeProbe(idx: number) {
    setProbes(prev => prev.filter((_, i) => i !== idx));
  }

  const isSubmitted = !!record?.submitted_at;

  return (
    <div className="space-y-6">
      {/* Date selector + history */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b border-border/50 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-display">Probe Check Date</CardTitle>
                <CardDescription className="text-xs mt-1">
                  Probes should be calibrated at least once every 4 weeks (monthly). Test using ice-point (0°C) and boiling-point (100°C) methods. Acceptable range: ±1°C.
                </CardDescription>
              </div>
              {isSubmitted && (
                <Badge variant="outline" className={cn("", overallResult === "pass" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200")}>
                  {overallResult === "pass" ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  {overallResult === "pass" ? "Pass" : "Fail"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Label className="text-sm whitespace-nowrap">Check date:</Label>
              <Input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} className="max-w-xs" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="text-base font-display">Probe Check History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {history.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No probe checks yet.</p>
            ) : (
              <div className="divide-y divide-border max-h-48 overflow-y-auto">
                {history.slice(0, 12).map(r => (
                  <button key={r.id} onClick={() => setSelectedDate(r.check_date)}
                    className="w-full p-3 hover:bg-muted/20 text-left flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{format(new Date(r.check_date), "dd MMM yyyy")}</span>
                    <div className="flex items-center gap-1">
                      {r.overall_result === "pass" && (
                        <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 h-5">Pass</Badge>
                      )}
                      {r.overall_result === "fail" && (
                        <Badge variant="outline" className="text-xs bg-rose-50 text-rose-700 border-rose-200 h-5">Fail</Badge>
                      )}
                      {r.submitted_at
                        ? <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 h-5"><CheckCircle2 className="w-2.5 h-2.5 mr-1" />Done</Badge>
                        : <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200 h-5">Draft</Badge>}
                    </div>
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
          {/* Overall result banner */}
          {overallResult && (
            <div className={cn(
              "flex items-center gap-3 p-4 rounded-lg border",
              overallResult === "pass" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"
            )}>
              {overallResult === "pass"
                ? <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
                : <XCircle className="w-5 h-5 flex-shrink-0" />}
              <div>
                <p className="font-semibold text-sm">Overall result: {overallResult === "pass" ? "PASS" : "FAIL"}</p>
                <p className="text-xs mt-0.5">
                  {overallResult === "pass"
                    ? "All probes tested accurate to ±1°C. No action required."
                    : "One or more probes failed accuracy test. Inaccurate probes must be adjusted, recalibrated, or replaced before use."}
                </p>
              </div>
            </div>
          )}

          {/* Probe rows */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-display">Probe Calibration Results</CardTitle>
                  <CardDescription className="text-xs mt-1">Record each probe's ice-point and boiling-point readings</CardDescription>
                </div>
                {!isSubmitted && (
                  <Button variant="outline" size="sm" onClick={() => setProbes(p => [...p, emptyProbe()])}>
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Probe
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {probes.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No probes added.</p>
              ) : (
                probes.map((row, i) => (
                  <ProbeRowFields
                    key={i}
                    row={row}
                    idx={i}
                    onChange={r => updateProbe(i, r)}
                    onRemove={() => removeProbe(i)}
                    disabled={isSubmitted}
                  />
                ))
              )}
            </CardContent>
          </Card>

          {/* General notes */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">General Notes</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <Textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Any additional observations, actions taken, or probes decommissioned…"
                disabled={isSubmitted}
              />
            </CardContent>
          </Card>

          {/* Sign-off */}
          <Card>
            <CardHeader className="border-b border-border/50 pb-4">
              <CardTitle className="text-base font-display">Sign-off</CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Checked By</Label>
                  <Input value={checkedBy} onChange={e => setCheckedBy(e.target.value)} placeholder="Staff name" disabled={isSubmitted} />
                </div>
                <div className="space-y-1.5">
                  <Label>Signature (type name)</Label>
                  <Input value={signature} onChange={e => setSignature(e.target.value)} placeholder="Type name to sign" disabled={isSubmitted} />
                </div>
              </div>

              {isSubmitted ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" />
                  Submitted on {format(new Date(record!.submitted_at!), "dd/MM/yyyy 'at' HH:mm")} by {record!.signature ?? record!.checked_by}
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
