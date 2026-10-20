import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import { MODULE_INFO, formatDay } from "@/lib/onboarding";

// Shared by the Tasks page (/tasks) and the dashboard "My tasks today" card.
export type TaskRow = {
  id: number; title: string; instruction: string | null; module: string | null;
  siteId: number | null; siteName: string | null; assigneeUserId: number | null; assigneeName: string | null;
  assigneeRole: "client_staff" | "managers" | null; recurrence: "once" | "daily" | "weekly" | "monthly";
  startsOn: string; active: boolean; occurrenceDate: string; dueOnDate: boolean; overdue: boolean;
  completion: { completedByName: string; completedAt: string; note: string | null; automatic?: boolean } | null;
  assignedToMe: boolean; canManage: boolean; canComplete: boolean;
  /** A manual completion this user may take back (mistaken "Mark done"). */
  canUndo?: boolean;
};
export type TaskList = { date: string; today: string; canManage: boolean; tasks: TaskRow[] };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

export function describeRecurrence(task: Pick<TaskRow, "recurrence" | "startsOn">): string {
  const start = new Date(`${task.startsOn}T00:00:00Z`);
  switch (task.recurrence) {
    case "daily": return "Every day";
    case "weekly": return `Every ${WEEKDAYS[start.getUTCDay()]}`;
    case "monthly": return `Monthly on the ${ordinal(start.getUTCDate())}`;
    default: return `Once, due ${formatDay(task.startsOn)}`;
  }
}

/** Shared by the tasks page and the dashboard card. */
export function useTaskClientId() {
  const { user, activeClientId } = useAuth();
  return user?.role === "consultant" ? activeClientId : null;
}

export function TaskItem({ task, onDone, onUndo, busy, readOnly }: {
  task: TaskRow; onDone: (t: TaskRow) => void; onUndo?: (t: TaskRow) => void; busy: boolean; readOnly?: boolean;
}) {
  const done = !!task.completion;
  const module = task.module ? MODULE_INFO[task.module] : null;
  return (
    <li className={`rounded-lg border p-3 flex items-start gap-3 ${done ? "bg-emerald-50/50 border-emerald-200" : task.overdue ? "border-rose-200" : ""}`}>
      {done ? (
        <CheckCircle2 className="w-5 h-5 mt-0.5 text-emerald-600 shrink-0" aria-hidden />
      ) : (
        <Circle className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${done ? "text-muted-foreground" : ""}`}>{task.title}</p>
        <p className="text-xs text-muted-foreground">
          {[task.siteName, task.overdue ? `Overdue since ${formatDay(task.startsOn)}` : describeRecurrence(task)].filter(Boolean).join(" · ")}
        </p>
        {task.instruction && <p className="text-xs mt-1 whitespace-pre-line">{task.instruction}</p>}
        {done && <p className="text-xs text-emerald-700 mt-1">Done by {task.completion!.completedByName} at {new Date(task.completion!.completedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}{task.completion!.note ? ` — ${task.completion!.note}` : ""}</p>}
        {module && !done && (
          <Link href={module.href} className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1">
            Open {module.label} to record it <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
      {!done && !readOnly && task.canComplete && (
        <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={() => onDone(task)}>Mark done</Button>
      )}
      {done && !readOnly && task.canUndo && onUndo && (
        <Button size="sm" variant="ghost" className="shrink-0" disabled={busy} onClick={() => onUndo(task)}>Undo</Button>
      )}
    </li>
  );
}

