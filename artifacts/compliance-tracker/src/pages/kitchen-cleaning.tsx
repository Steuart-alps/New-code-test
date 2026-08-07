/**
 * KitchenTrack — Cleaning Schedule tab
 *
 * Configurable cleaning task templates + dated completion logs.
 * Frequencies: Daily | Weekly | Monthly
 */
import { useState, useEffect, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useCanAdmin } from "@/context/auth-context";
import { format, startOfWeek, startOfMonth, parseISO, addWeeks, subWeeks, addMonths, subMonths } from "date-fns";
import {
  CheckSquare, Plus, Trash2, ChevronLeft, ChevronRight, Save,
  Pencil, Settings, CheckCircle2, ClipboardList, CalendarDays, Loader2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Frequency = "daily" | "weekly" | "monthly";

type CleaningTask = {
  id: number;
  area: string;
  task: string;
  frequency: Frequency;
  method: string | null;
  product: string | null;
  responsible: string | null;
  sort_order: number;
};

type CompletionItem = {
  taskId?: number;
  taskArea?: string;
  taskName: string;
  done: boolean;
  doneBy?: string;
  notes?: string;
};

type CleaningLog = {
  id: number;
  log_date: string;
  frequency: string;
  completions: CompletionItem[];
  signed_by: string | null;
  submitted_at: string | null;
};

type HistoryEntry = {
  id: number;
  log_date: string;
  frequency: string;
  signed_by: string | null;
  submitted_at: string | null;
  completed_count: number;
  total_count: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  return format(new Date(), "yyyy-MM-dd");
}

function weekStart(date: Date) {
  return format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

function monthStart(date: Date) {
  return format(startOfMonth(date), "yyyy-MM-dd");
}

function periodLabel(freq: Frequency, dateStr: string) {
  const d = parseISO(dateStr);
  if (freq === "daily")   return format(d, "EEEE d MMMM yyyy");
  if (freq === "weekly")  return `w/c ${format(d, "d MMMM yyyy")}`;
  if (freq === "monthly") return format(d, "MMMM yyyy");
  return dateStr;
}

function freqLabel(f: Frequency) {
  return f === "daily" ? "Daily" : f === "weekly" ? "Weekly" : "Monthly";
}

const FREQ_ICONS: Record<Frequency, typeof CalendarDays> = {
  daily:   CalendarDays,
  weekly:  ClipboardList,
  monthly: CheckSquare,
};

// ── Task manage dialog ────────────────────────────────────────────────────────

type TaskFormState = {
  area: string;
  task: string;
  frequency: Frequency;
  method: string;
  product: string;
  responsible: string;
};

const BLANK_TASK: TaskFormState = {
  area: "", task: "", frequency: "daily", method: "", product: "", responsible: "",
};

function ManageTasksDialog({
  open, onOpenChange, tasks, onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tasks: CleaningTask[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editTask, setEditTask] = useState<CleaningTask | null>(null);
  const [form, setForm]   = useState<TaskFormState>(BLANK_TASK);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  function openAdd() {
    setEditTask(null);
    setForm(BLANK_TASK);
    setShowForm(true);
  }

  function openEdit(t: CleaningTask) {
    setEditTask(t);
    setForm({
      area: t.area, task: t.task, frequency: t.frequency,
      method: t.method ?? "", product: t.product ?? "", responsible: t.responsible ?? "",
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.area.trim() || !form.task.trim()) {
      toast({ title: "Area and task are required", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const body = {
        area: form.area.trim(), task: form.task.trim(), frequency: form.frequency,
        method: form.method.trim() || null, product: form.product.trim() || null,
        responsible: form.responsible.trim() || null,
      };
      if (editTask) {
        await apiFetch(`/kitchen-cleaning/tasks/${editTask.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast({ title: "Task updated" });
      } else {
        await apiFetch("/kitchen-cleaning/tasks", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Task added" });
      }
      setShowForm(false);
      onChanged();
    } catch {
      toast({ title: "Failed to save task", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: CleaningTask) {
    if (!confirm(`Remove "${t.task}" from the cleaning schedule?`)) return;
    try {
      await apiFetch(`/kitchen-cleaning/tasks/${t.id}`, { method: "DELETE" });
      toast({ title: "Task removed" });
      onChanged();
    } catch {
      toast({ title: "Failed to remove task", variant: "destructive" });
    }
  }

  const byFreq = useMemo(() => {
    const groups: Record<string, CleaningTask[]> = { daily: [], weekly: [], monthly: [] };
    for (const t of tasks) groups[t.frequency]?.push(t);
    return groups;
  }, [tasks]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-display">Manage Cleaning Tasks</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 pr-1">
          {(["daily", "weekly", "monthly"] as Frequency[]).map(freq => (
            <div key={freq}>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                {freqLabel(freq)}
              </h3>
              {byFreq[freq].length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No tasks yet.</p>
              ) : (
                <div className="space-y-1">
                  {byFreq[freq].map(t => (
                    <div key={t.id} className="flex items-start gap-2 p-2 rounded-lg border bg-card hover:bg-muted/40 group">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{t.area} — {t.task}</p>
                        {(t.method || t.product) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {[t.method, t.product].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        {t.responsible && (
                          <p className="text-xs text-muted-foreground">{t.responsible}</p>
                        )}
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(t)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => handleDelete(t)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="pt-4 border-t">
          {!showForm ? (
            <Button onClick={openAdd}>
              <Plus className="w-4 h-4 mr-2" /> Add Task
            </Button>
          ) : (
            <div className="w-full space-y-3 border rounded-lg p-4 bg-muted/30">
              <p className="text-sm font-medium">{editTask ? "Edit task" : "New task"}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Area *</Label>
                  <Input placeholder="e.g. Oven, Fridge, Prep surfaces" value={form.area}
                    onChange={e => setForm(f => ({ ...f, area: e.target.value }))} className="h-8 rounded-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Frequency *</Label>
                  <Select value={form.frequency} onValueChange={v => setForm(f => ({ ...f, frequency: v as Frequency }))}>
                    <SelectTrigger className="h-8 rounded-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-xs">Task description *</Label>
                  <Input placeholder="e.g. Clean interior and racks" value={form.task}
                    onChange={e => setForm(f => ({ ...f, task: e.target.value }))} className="h-8 rounded-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Method</Label>
                  <Input placeholder="e.g. Degrease, scrub, rinse" value={form.method}
                    onChange={e => setForm(f => ({ ...f, method: e.target.value }))} className="h-8 rounded-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Chemical / product</Label>
                  <Input placeholder="e.g. Oven Brite" value={form.product}
                    onChange={e => setForm(f => ({ ...f, product: e.target.value }))} className="h-8 rounded-sm" />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-xs">Responsible</Label>
                  <Input placeholder="e.g. Kitchen staff, Supervisor" value={form.responsible}
                    onChange={e => setForm(f => ({ ...f, responsible: e.target.value }))} className="h-8 rounded-sm" />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  {editTask ? "Save changes" : "Add task"}
                </Button>
              </div>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── History panel ─────────────────────────────────────────────────────────────

function HistoryPanel({ history, onSelect }: {
  history: HistoryEntry[];
  onSelect: (e: HistoryEntry) => void;
}) {
  if (!history.length) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-display">Recent Logs</CardTitle>
        <CardDescription>Click a row to view that record</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {history.map(h => (
            <button key={h.id} onClick={() => onSelect(h)}
              className="w-full text-left px-4 py-3 hover:bg-muted/40 transition-colors flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{periodLabel(h.frequency as Frequency, h.log_date)}</p>
                <p className="text-xs text-muted-foreground capitalize">{freqLabel(h.frequency as Frequency)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium">
                  {h.completed_count}/{h.total_count}
                </p>
                <p className="text-xs text-muted-foreground">tasks done</p>
              </div>
              {h.submitted_at ? (
                <Badge variant="outline" className="shrink-0 text-emerald-700 border-emerald-300 bg-emerald-50">Signed off</Badge>
              ) : (
                <Badge variant="outline" className="shrink-0 text-amber-700 border-amber-300 bg-amber-50">Draft</Badge>
              )}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function CleaningScheduleTab() {
  const { user } = useAuth();
  const canAdmin = useCanAdmin();
  const { toast } = useToast();

  const [activeFreq, setActiveFreq]     = useState<Frequency>("daily");
  const [currentDate, setCurrentDate]   = useState(todayIso());          // date for the active period
  const [tasks, setTasks]               = useState<CleaningTask[]>([]);
  const [log, setLog]                   = useState<CleaningLog | null>(null);
  const [completions, setCompletions]   = useState<CompletionItem[]>([]);
  const [signedBy, setSignedBy]         = useState(user?.name ?? "");
  const [history, setHistory]           = useState<HistoryEntry[]>([]);
  const [loading, setLoading]           = useState(false);
  const [saving, setSaving]             = useState(false);
  const [manageOpen, setManageOpen]     = useState(false);

  const submitted = !!log?.submitted_at;

  // ── Period date helpers ──────────────────────────────────────────────────

  const periodDate = useMemo(() => {
    const d = parseISO(currentDate);
    if (activeFreq === "daily")   return currentDate;
    if (activeFreq === "weekly")  return weekStart(d);
    return monthStart(d);
  }, [activeFreq, currentDate]);

  function stepBack() {
    const d = parseISO(currentDate);
    if (activeFreq === "daily")   setCurrentDate(format(new Date(d.getTime() - 86400000), "yyyy-MM-dd"));
    if (activeFreq === "weekly")  setCurrentDate(format(subWeeks(d, 1), "yyyy-MM-dd"));
    if (activeFreq === "monthly") setCurrentDate(format(subMonths(d, 1), "yyyy-MM-dd"));
  }

  function stepForward() {
    const d = parseISO(currentDate);
    const today = todayIso();
    if (activeFreq === "daily") {
      const next = format(new Date(d.getTime() + 86400000), "yyyy-MM-dd");
      if (next <= today) setCurrentDate(next);
    }
    if (activeFreq === "weekly") {
      const next = weekStart(addWeeks(d, 1));
      if (next <= today) setCurrentDate(format(addWeeks(d, 1), "yyyy-MM-dd"));
    }
    if (activeFreq === "monthly") {
      const next = monthStart(addMonths(d, 1));
      if (next <= todayIso()) setCurrentDate(format(addMonths(d, 1), "yyyy-MM-dd"));
    }
  }

  const isCurrentPeriod = useMemo(() => {
    const today = parseISO(todayIso());
    if (activeFreq === "daily")   return periodDate === todayIso();
    if (activeFreq === "weekly")  return periodDate === weekStart(today);
    return periodDate === monthStart(today);
  }, [activeFreq, periodDate]);

  // ── Load tasks ───────────────────────────────────────────────────────────

  async function loadTasks() {
    try {
      const r = await apiFetch("/kitchen-cleaning/tasks");
      if (r.ok) setTasks(await r.json());
    } catch { /* ignore */ }
  }

  // ── Load log and build completions ───────────────────────────────────────

  async function loadLog(freq: Frequency, date: string) {
    setLoading(true);
    try {
      const r = await apiFetch(`/kitchen-cleaning/logs?date=${date}&frequency=${freq}`);
      const savedLog: CleaningLog | null = r.ok ? await r.json() : null;
      setLog(savedLog);
      setSignedBy(savedLog?.signed_by ?? user?.name ?? "");

      // Build completion state — merge tasks with any saved completions
      const freqTasks = tasks.filter(t => t.frequency === freq);
      const savedMap = new Map<number, CompletionItem>(
        (savedLog?.completions ?? []).filter(c => c.taskId != null).map(c => [c.taskId!, c])
      );
      const merged: CompletionItem[] = freqTasks.map(t => {
        const saved = savedMap.get(t.id);
        return {
          taskId: t.id,
          taskArea: t.area,
          taskName: t.task,
          done:   saved?.done   ?? false,
          doneBy: saved?.doneBy ?? user?.name ?? "",
          notes:  saved?.notes  ?? "",
        };
      });
      setCompletions(merged);
    } catch {
      setLog(null);
      setCompletions(tasks.filter(t => t.frequency === freq).map(t => ({
        taskId: t.id, taskArea: t.area, taskName: t.task,
        done: false, doneBy: user?.name ?? "", notes: "",
      })));
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const r = await apiFetch("/kitchen-cleaning/logs/history");
      if (r.ok) setHistory(await r.json());
    } catch { /* ignore */ }
  }

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    loadTasks();
    loadHistory();
  }, []);

  useEffect(() => {
    if (tasks.length >= 0) loadLog(activeFreq, periodDate);
  }, [activeFreq, periodDate, tasks]);

  // ── Save ─────────────────────────────────────────────────────────────────

  async function handleSave(submit: boolean) {
    setSaving(true);
    try {
      const body = {
        logDate:     periodDate,
        frequency:   activeFreq,
        completions,
        signedBy:    signedBy.trim() || null,
        submittedAt: submit ? new Date().toISOString() : (log?.submitted_at ?? null),
      };
      const r = await apiFetch("/kitchen-cleaning/logs", { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) throw new Error();
      const saved = await r.json();
      setLog(saved);
      toast({ title: submit ? "Schedule signed off" : "Draft saved" });
      loadHistory();
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function handleHistorySelect(entry: HistoryEntry) {
    const freq = entry.frequency as Frequency;
    setActiveFreq(freq);
    setCurrentDate(entry.log_date);
  }

  // ── Completion helpers ───────────────────────────────────────────────────

  function toggleDone(idx: number, done: boolean) {
    setCompletions(prev => prev.map((c, i) => i === idx ? { ...c, done } : c));
  }

  function setDoneBy(idx: number, v: string) {
    setCompletions(prev => prev.map((c, i) => i === idx ? { ...c, doneBy: v } : c));
  }

  function setNotes(idx: number, v: string) {
    setCompletions(prev => prev.map((c, i) => i === idx ? { ...c, notes: v } : c));
  }

  // ── Group completions by area ────────────────────────────────────────────

  const byArea = useMemo(() => {
    const groups: { area: string; items: { idx: number; c: CompletionItem }[] }[] = [];
    const seen = new Map<string, number>();
    completions.forEach((c, idx) => {
      const area = c.taskArea ?? "General";
      if (!seen.has(area)) { seen.set(area, groups.length); groups.push({ area, items: [] }); }
      groups[seen.get(area)!].items.push({ idx, c });
    });
    return groups;
  }, [completions]);

  const doneCount = completions.filter(c => c.done).length;
  const totalCount = completions.length;

  // ── Render ───────────────────────────────────────────────────────────────

  const freqTabs: Frequency[] = ["daily", "weekly", "monthly"];

  return (
    <div className="space-y-6">
      {/* ── Frequency selector + admin button ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex gap-1 p-1 bg-muted/50 rounded-xl inline-flex border border-border/50">
          {freqTabs.map(freq => {
            const Icon = FREQ_ICONS[freq];
            return (
              <button key={freq} onClick={() => { setActiveFreq(freq); setCurrentDate(todayIso()); }}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                  activeFreq === freq
                    ? "bg-background shadow text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/60"
                )}>
                <Icon className="w-4 h-4 flex-shrink-0" />
                {freqLabel(freq)}
              </button>
            );
          })}
        </div>
        {canAdmin && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setManageOpen(true)}>
            <Settings className="w-4 h-4 mr-2" /> Manage Tasks
          </Button>
        )}
      </div>

      {/* ── Period navigator ── */}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" onClick={stepBack}><ChevronLeft className="w-4 h-4" /></Button>
        <div className="flex-1 text-center">
          <p className="text-sm font-medium">{periodLabel(activeFreq, periodDate)}</p>
          {!isCurrentPeriod && (
            <button onClick={() => setCurrentDate(todayIso())}
              className="text-xs text-primary hover:underline mt-0.5">Back to current</button>
          )}
        </div>
        <Button variant="outline" size="icon" onClick={stepForward} disabled={isCurrentPeriod}>
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* ── No tasks state ── */}
      {!loading && tasks.filter(t => t.frequency === activeFreq).length === 0 && (
        <Card className="border-dashed">
          <CardContent className="pt-10 pb-10 text-center">
            <CheckSquare className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No {activeFreq} cleaning tasks configured</p>
            {canAdmin && (
              <Button variant="link" size="sm" className="mt-2" onClick={() => setManageOpen(true)}>
                Add tasks
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Task list ── */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : byArea.length > 0 && (
        <div className="space-y-4">
          {/* Progress bar */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  doneCount === totalCount && totalCount > 0 ? "bg-emerald-500" : "bg-primary"
                )}
                style={{ width: totalCount ? `${(doneCount / totalCount) * 100}%` : "0%" }}
              />
            </div>
            <span className="text-sm font-medium shrink-0">{doneCount}/{totalCount} done</span>
            {submitted && (
              <Badge variant="outline" className="text-emerald-700 border-emerald-300 bg-emerald-50 shrink-0">
                <CheckCircle2 className="w-3 h-3 mr-1" /> Signed off
              </Badge>
            )}
          </div>

          {byArea.map(group => (
            <Card key={group.area}>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.area}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                {group.items.map(({ idx, c }) => (
                  <div key={idx}
                    className={cn(
                      "rounded-lg border p-3 transition-colors",
                      c.done ? "bg-emerald-50 border-emerald-200" : "bg-background"
                    )}>
                    {/* Task row */}
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`task-${idx}`}
                        checked={c.done}
                        disabled={submitted}
                        onCheckedChange={v => toggleDone(idx, !!v)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <label htmlFor={`task-${idx}`}
                          className={cn("text-sm font-medium cursor-pointer", c.done && "line-through text-muted-foreground")}>
                          {c.taskName}
                        </label>
                        {/* Method/product hint */}
                        {(() => {
                          const t = tasks.find(t => t.id === c.taskId);
                          return t?.method || t?.product ? (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {[t.method, t.product].filter(Boolean).join(" · ")}
                            </p>
                          ) : null;
                        })()}
                      </div>
                      {/* Done by (inline when checked) */}
                      {c.done && !submitted && (
                        <Input
                          value={c.doneBy ?? ""}
                          onChange={e => setDoneBy(idx, e.target.value)}
                          placeholder="Done by"
                          className="h-7 text-xs w-36 shrink-0 rounded-sm"
                        />
                      )}
                      {c.done && submitted && c.doneBy && (
                        <span className="text-xs text-muted-foreground shrink-0">{c.doneBy}</span>
                      )}
                    </div>
                    {/* Notes (shown when done and not submitted, or if notes exist) */}
                    {c.done && !submitted && (
                      <Textarea
                        value={c.notes ?? ""}
                        onChange={e => setNotes(idx, e.target.value)}
                        placeholder="Notes (optional)"
                        rows={1}
                        className="mt-2 ml-7 text-xs rounded-sm resize-none"
                      />
                    )}
                    {submitted && c.notes && (
                      <p className="mt-1 ml-7 text-xs text-muted-foreground italic">{c.notes}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}

          {/* ── Sign-off ── */}
          {byArea.length > 0 && (
            <Card>
              <CardContent className="pt-4 pb-4 space-y-4">
                <div className="space-y-1.5">
                  <Label>Signed off by</Label>
                  <Input
                    value={signedBy}
                    onChange={e => setSignedBy(e.target.value)}
                    placeholder="Manager name"
                    disabled={submitted}
                    className="max-w-xs rounded-sm"
                  />
                </div>

                {!submitted ? (
                  <div className="flex gap-2 flex-wrap">
                    <Button variant="outline" onClick={() => handleSave(false)} disabled={saving}>
                      {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                      Save draft
                    </Button>
                    <Button onClick={() => handleSave(true)} disabled={saving || !signedBy.trim()}>
                      {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                      Sign off
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    Signed off{log?.submitted_at ? ` on ${format(parseISO(log.submitted_at), "d MMM yyyy 'at' HH:mm")}` : ""}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── History ── */}
      <HistoryPanel history={history} onSelect={handleHistorySelect} />

      {/* ── Manage dialog ── */}
      <ManageTasksDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        tasks={tasks}
        onChanged={() => { loadTasks(); loadHistory(); }}
      />
    </div>
  );
}
