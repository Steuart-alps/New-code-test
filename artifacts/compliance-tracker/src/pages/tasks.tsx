import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, CheckCircle2, Circle, ListChecks, Pencil, Plus, RotateCcw } from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { MODULE_INFO, formatDay, localToday, moduleLabel, onboardingRequest } from "@/lib/onboarding";
import { TaskItem, describeRecurrence, useTaskClientId, type TaskList, type TaskRow } from "@/components/task-item";

type Assignee = { id: number; name: string; role: string };
type Draft = {
  id?: number; title: string; instruction: string; module: string; siteId: string;
  assignee: string; recurrence: TaskRow["recurrence"]; startsOn: string;
};

const selectClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
function assigneeLabel(task: TaskRow) {
  if (task.assigneeName) return task.assigneeName;
  if (task.assigneeRole === "client_staff") return "All staff";
  if (task.assigneeRole === "managers") return "All managers";
  return "Unassigned";
}

export default function TasksPage() {
  const { user, hasService } = useAuth();
  const clientId = useTaskClientId();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isViewer = user?.role === "client_viewer";
  const isManager = user?.role === "consultant" || user?.role === "client_admin" || user?.role === "client_manager" || (user?.role === "client_staff" && !!user.isDepartmentManager);
  const [tab, setTab] = useState<"mine" | "all">(isManager || isViewer ? "all" : "mine");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const today = localToday();

  const mine = useQuery<TaskList>({
    queryKey: ["tasks", "mine", clientId, today],
    queryFn: () => onboardingRequest(`/tasks?scope=mine&date=${today}`, clientId),
    enabled: !!user && !isViewer,
  });
  const all = useQuery<TaskList>({
    queryKey: ["tasks", "all", clientId, today],
    queryFn: () => onboardingRequest(`/tasks?scope=all&date=${today}`, clientId),
    enabled: !!user && (isManager || isViewer),
  });
  const sites = useQuery<{ id: number; name: string }[]>({
    queryKey: ["tasks-sites", clientId],
    queryFn: () => onboardingRequest("/sites", clientId),
    enabled: isManager,
  });
  const assignees = useQuery<Assignee[]>({
    queryKey: ["tasks-assignees", clientId],
    queryFn: () => onboardingRequest("/tasks/assignees", clientId),
    enabled: isManager,
  });

  useEffect(() => { if (isViewer) setTab("all"); }, [isViewer]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["tasks"] });

  async function complete(task: TaskRow) {
    setBusyId(task.id);
    try {
      await onboardingRequest(`/tasks/${task.id}/complete`, clientId, { method: "POST", body: JSON.stringify({ date: task.occurrenceDate }) });
      toast({ title: "Marked done", description: task.title });
      await refresh();
    } catch (err) {
      toast({ title: "Could not mark done", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function undo(task: TaskRow) {
    setBusyId(task.id);
    try {
      await onboardingRequest(`/tasks/${task.id}/complete?date=${task.occurrenceDate}`, clientId, { method: "DELETE" });
      toast({ title: "Marked not done", description: task.title });
      await refresh();
    } catch (err) {
      toast({ title: "Could not undo", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const [kind, value] = draft.assignee.split(":");
      const body = {
        title: draft.title.trim(), instruction: draft.instruction.trim() || null, module: draft.module || null,
        siteId: draft.siteId ? Number(draft.siteId) : null, recurrence: draft.recurrence, startsOn: draft.startsOn,
        assigneeUserId: kind === "user" ? Number(value) : null, assigneeRole: kind === "role" ? value : null,
      };
      await onboardingRequest(draft.id ? `/tasks/${draft.id}` : "/tasks", clientId, { method: draft.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      toast({ title: draft.id ? "Task updated" : "Task created" });
      setDraft(null);
      await refresh();
    } catch (err) {
      toast({ title: "Could not save task", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function setActive(task: TaskRow, active: boolean) {
    try {
      await onboardingRequest(`/tasks/${task.id}`, clientId, { method: "PATCH", body: JSON.stringify({ active }) });
      await refresh();
    } catch (err) {
      toast({ title: "Could not update task", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  }

  const moduleOptions = useMemo(() => Object.entries(MODULE_INFO).filter(([key]) => key === "compliance" || hasService(key)), [hasService]);
  const allTasks = (all.data?.tasks ?? []).filter((t) => showArchived || t.active);
  const myTasks = mine.data?.tasks ?? [];
  const outstanding = myTasks.filter((t) => !t.completion).length;

  return (
    <AppLayout title="Tasks">
      <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ListChecks className="w-6 h-6 text-primary" /> Tasks</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Routine jobs for your team, one-off or repeating. {formatDay(today)}</p>
          </div>
          {isManager && tab === "all" && !draft && (
            <Button onClick={() => setDraft({ title: "", instruction: "", module: "", siteId: sites.data?.length === 1 ? String(sites.data[0].id) : "", assignee: "role:client_staff", recurrence: "daily", startsOn: today })}>
              <Plus className="w-4 h-4 mr-1" /> New task
            </Button>
          )}
        </div>

        {(isManager || !isViewer) && (
          <div role="tablist" className="inline-flex rounded-lg border p-1 bg-muted/40">
            {!isViewer && (
              <button role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}
                className={`px-3 py-1.5 text-sm rounded-md ${tab === "mine" ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}>
                My tasks today
              </button>
            )}
            {isManager && (
              <button role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}
                className={`px-3 py-1.5 text-sm rounded-md ${tab === "all" ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}>
                All tasks
              </button>
            )}
          </div>
        )}

        {draft && (
          <section className="rounded-xl border bg-card p-5 shadow-sm space-y-4" aria-label={draft.id ? "Edit task" : "New task"}>
            <h2 className="text-lg font-semibold">{draft.id ? "Edit task" : "New task"}</h2>
            <div className="space-y-1.5">
              <Label htmlFor="task-title">Task</Label>
              <Input id="task-title" dictation value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Kitchen opening checklist" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-instruction">Instructions (optional)</Label>
              <Textarea id="task-instruction" rows={2} value={draft.instruction} onChange={(e) => setDraft({ ...draft, instruction: e.target.value })} />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="task-assignee">Assign to</Label>
                <select id="task-assignee" className={selectClass} value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}>
                  <option value="role:client_staff">All staff</option>
                  <option value="role:managers">All managers</option>
                  {(assignees.data ?? []).map((a) => <option key={a.id} value={`user:${a.id}`}>{a.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-site">Site</Label>
                <select id="task-site" className={selectClass} value={draft.siteId} onChange={(e) => setDraft({ ...draft, siteId: e.target.value })}>
                  <option value="">All sites</option>
                  {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-recurrence">Repeats</Label>
                <select id="task-recurrence" className={selectClass} value={draft.recurrence} onChange={(e) => setDraft({ ...draft, recurrence: e.target.value as Draft["recurrence"] })}>
                  <option value="once">Does not repeat</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-date">{draft.recurrence === "once" ? "Due date" : "Starting"}</Label>
                <Input id="task-date" type="date" value={draft.startsOn} onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} />
                {draft.recurrence !== "once" && draft.startsOn && <p className="text-xs text-muted-foreground">{describeRecurrence({ recurrence: draft.recurrence, startsOn: draft.startsOn })}, from {formatDay(draft.startsOn)}</p>}
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="task-module">Link to a module (optional)</Label>
                <select id="task-module" className={selectClass} value={draft.module} onChange={(e) => setDraft({ ...draft, module: e.target.value })}>
                  <option value="">No link</option>
                  {moduleOptions.map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">Staff get a link straight to that module to record the check.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
              <Button onClick={save} disabled={saving || !draft.title.trim() || !draft.startsOn}>{saving ? "Saving…" : "Save task"}</Button>
            </div>
          </section>
        )}

        {tab === "mine" && !isViewer && (
          <section aria-label="My tasks today" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {mine.isLoading ? "Loading…" : myTasks.length === 0 ? "Nothing assigned to you today." : outstanding === 0 ? "All done for today." : `${outstanding} of ${myTasks.length} still to do.`}
            </p>
            {mine.error && <ErrorNote error={mine.error} />}
            <ul className="space-y-2">
              {myTasks.map((t) => <TaskItem key={`${t.id}:${t.occurrenceDate}`} task={t} onDone={complete} onUndo={undo} busy={busyId === t.id} />)}
            </ul>
          </section>
        )}

        {tab === "all" && (
          <section aria-label="All tasks" className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground">{all.isLoading ? "Loading…" : `${allTasks.length} task${allTasks.length === 1 ? "" : "s"}. Status shown for today.`}</p>
              <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <input type="checkbox" className="h-3.5 w-3.5" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
              </label>
            </div>
            {all.error && <ErrorNote error={all.error} />}
            {!all.isLoading && allTasks.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No tasks yet. {isManager ? "Create one, such as “Kitchen opening checklist” every day or “Weekly fire alarm test”." : ""}
              </p>
            )}
            <ul className="space-y-2">
              {allTasks.map((t) => (
                <li key={t.id} className={`rounded-lg border p-3 ${t.active ? "" : "opacity-60"}`}>
                  <div className="flex items-start gap-3">
                    {t.completion ? <CheckCircle2 className="w-5 h-5 mt-0.5 text-emerald-600 shrink-0" aria-label="Done today" />
                      : t.overdue ? <AlertTriangle className="w-5 h-5 mt-0.5 text-rose-600 shrink-0" aria-label="Overdue" />
                        : <Circle className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" aria-hidden />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t.title}{!t.active && <span className="ml-2 text-xs font-normal text-muted-foreground">Archived</span>}</p>
                      <p className="text-xs text-muted-foreground">
                        {[assigneeLabel(t), t.siteName ?? "All sites", describeRecurrence(t), moduleLabel(t.module)].filter(Boolean).join(" · ")}
                      </p>
                      <p className="text-xs mt-0.5">
                        {t.completion ? <span className="text-emerald-700">{t.completion.automatic ? `${t.completion.note ?? "Done automatically"} (${t.completion.completedByName})` : `Done by ${t.completion.completedByName}`}</span>
                          : t.overdue ? <span className="text-rose-700">Overdue</span>
                            : t.dueOnDate ? <span className="text-amber-700">Due today</span>
                              : <span className="text-muted-foreground">Not due today</span>}
                      </p>
                    </div>
                    {t.canManage && !isViewer && (
                      <div className="flex shrink-0 gap-1">
                        {t.active && !t.completion && (t.dueOnDate || t.overdue) && (
                          <Button size="sm" variant="outline" disabled={busyId === t.id} onClick={() => complete(t)}>Mark done</Button>
                        )}
                        {t.completion && t.canUndo && (
                          <Button size="sm" variant="ghost" disabled={busyId === t.id} onClick={() => undo(t)}>Undo</Button>
                        )}
                        <Button size="icon" variant="ghost" aria-label={`Edit ${t.title}`} onClick={() => setDraft({
                          id: t.id, title: t.title, instruction: t.instruction ?? "", module: t.module ?? "", siteId: t.siteId ? String(t.siteId) : "",
                          assignee: t.assigneeUserId ? `user:${t.assigneeUserId}` : `role:${t.assigneeRole ?? "client_staff"}`,
                          recurrence: t.recurrence, startsOn: t.startsOn,
                        })}><Pencil className="w-4 h-4" /></Button>
                        <Button size="icon" variant="ghost" aria-label={t.active ? `Archive ${t.title}` : `Restore ${t.title}`} onClick={() => setActive(t, !t.active)}>
                          {t.active ? <Archive className="w-4 h-4" /> : <RotateCcw className="w-4 h-4" />}
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AppLayout>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  return <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error instanceof Error ? error.message : "Could not load tasks"}</div>;
}
