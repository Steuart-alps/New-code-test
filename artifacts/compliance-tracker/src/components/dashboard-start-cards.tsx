import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ListChecks, Sparkles } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { localToday, onboardingRequest } from "@/lib/onboarding";
import { TaskItem, useTaskClientId, type TaskList, type TaskRow } from "@/components/task-item";

type SetupSummary = { needsSetup: boolean; canManage: boolean; deferredAt?: string | null };

/**
 * Top-of-dashboard cards: the setup wizard banner for admins of a business
 * that has not finished setup (sending them to /setup once per session until
 * they choose "Finish later"), and "My tasks today" for staff.
 */
export function DashboardStartCards() {
  const { user } = useAuth();
  if (!user) return null;
  if (user.role === "consultant" || user.role === "client_admin") return <SetupBanner />;
  if (user.role === "client_staff") return <MyTasksTodayCard />;
  return null;
}

function SetupBanner() {
  const clientId = useTaskClientId();
  const { activeClientId } = useAuth();
  const [, navigate] = useLocation();
  const [state, setState] = useState<SetupSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    onboardingRequest<SetupSummary>("/setup/state", clientId)
      .then((data) => {
        if (cancelled) return;
        setState(data);
        if (!data.needsSetup || data.deferredAt) return;
        const key = `complytrack:setup-redirected:${activeClientId ?? "own"}`;
        try {
          if (sessionStorage.getItem(key)) return;
          sessionStorage.setItem(key, "1");
        } catch { /* storage unavailable: still redirect once per load */ }
        navigate("/setup");
      })
      .catch(() => { /* the dashboard works without setup state */ });
    return () => { cancelled = true; };
  }, [clientId, activeClientId]);

  if (!state?.needsSetup || !state.canManage) return null;
  return (
    <Link href="/setup" className="flex items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4 transition-colors hover:bg-primary/10">
      <div className="flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-primary shrink-0" />
        <div>
          <p className="font-semibold text-sm">Continue the setup wizard</p>
          <p className="text-xs text-muted-foreground">Pick your business type, first site, modules and the checks that apply, so this dashboard shows what matters to you.</p>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">Continue <ArrowRight className="h-4 w-4" /></span>
    </Link>
  );
}

function MyTasksTodayCard() {
  const clientId = useTaskClientId();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const today = localToday();
  const [busyId, setBusyId] = useState<number | null>(null);
  const { data, isLoading } = useQuery<TaskList>({
    queryKey: ["tasks", "mine", clientId, today],
    queryFn: () => onboardingRequest(`/tasks?scope=mine&date=${today}`, clientId),
  });
  const tasks = data?.tasks ?? [];
  const outstanding = tasks.filter((t) => !t.completion);

  async function complete(task: TaskRow) {
    setBusyId(task.id);
    try {
      await onboardingRequest(`/tasks/${task.id}/complete`, clientId, { method: "POST", body: JSON.stringify({ date: task.occurrenceDate }) });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    } catch (err) {
      toast({ title: "Could not mark done", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm space-y-3" aria-label="My tasks today">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold flex items-center gap-2"><ListChecks className="w-5 h-5 text-primary" /> My tasks today</h2>
        <Link href="/tasks" className="text-sm text-primary hover:underline">All my tasks</Link>
      </div>
      {isLoading ? <div className="h-12 rounded-md bg-muted animate-pulse" />
        : tasks.length === 0 ? <p className="text-sm text-muted-foreground">Nothing assigned to you today.</p>
          : outstanding.length === 0 ? <p className="text-sm text-emerald-700">All done for today.</p>
            : (
              <ul className="space-y-2">
                {outstanding.slice(0, 5).map((t) => <TaskItem key={`${t.id}:${t.occurrenceDate}`} task={t} onDone={complete} busy={busyId === t.id} />)}
                {outstanding.length > 5 && <li className="text-xs text-muted-foreground">and {outstanding.length - 5} more on the Tasks page.</li>}
              </ul>
            )}
    </section>
  );
}
