import { Calendar, CheckCircle2, MapPin, User } from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ── Priority board ────────────────────────────────────────────────────────────
// Open FixTrack issues grouped by trade (issueType). Columns are ordered by
// urgency so the most pressing trade is always first when scanning across;
// cards inside a column are ordered by priority, then oldest reported.

export interface BoardIssue {
  id: number;
  title: string;
  issueType: string;
  priority: string;
  status: string;
  reportedDate: string;
  targetDate?: string | null;
  isOverdue: boolean;
  siteName?: string | null;
  contractorName?: string | null;
}

type Meta = { label: string; color: string };

export const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const rank = (priority: string) => PRIORITY_RANK[priority] ?? 99;
const OPEN_STATUSES = new Set(["reported", "in_progress"]);

/** Local midnight of a date-only string ("YYYY-MM-DD…") or a Date. */
export function startOfLocalDay(value: string | Date): Date {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00`) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Whole local calendar days from `from` to `to`. Rounded rather than floored:
 * local days are 23 or 25 hours long across a daylight-saving change, so a
 * floored millisecond difference would lose a day each spring.
 */
export function localCalendarDaysBetween(from: string | Date, to: string | Date): number {
  return Math.round((startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()) / 86_400_000);
}

/** Days an issue has been open (reported age), never negative. */
export function elapsedDays(from: string, to: Date = new Date()): number {
  return Math.max(0, localCalendarDaysBetween(from, to));
}

/**
 * Local calendar days past the target date, or null when there is nothing to
 * show: no target, or the issue is not overdue. The server decides overdue
 * (target before today); a target due today is never "past target".
 */
export function daysPastTarget(issue: Pick<BoardIssue, "targetDate" | "isOverdue">, now: Date = new Date()): number | null {
  if (!issue.targetDate || !issue.isOverdue) return null;
  const days = localCalendarDaysBetween(issue.targetDate, now);
  return days > 0 ? days : null;
}

const byCardOrder = (a: BoardIssue, b: BoardIssue) =>
  rank(a.priority) - rank(b.priority)
  || startOfLocalDay(a.reportedDate).getTime() - startOfLocalDay(b.reportedDate).getTime();

/**
 * Group open issues into trade columns. Columns are ordered by their highest
 * open priority, then by the oldest job at that priority, then by trade key
 * so equally urgent groups keep a stable order whatever order the API
 * returned. Card order within a column is unchanged.
 */
export function buildBoardColumns<T extends BoardIssue>(issues: T[]): Array<{ key: string; items: T[] }> {
  const open = issues.filter(i => OPEN_STATUSES.has(i.status));
  const groups = new Map<string, T[]>();
  for (const issue of open) {
    const list = groups.get(issue.issueType);
    if (list) list.push(issue);
    else groups.set(issue.issueType, [issue]);
  }
  const columns = [...groups].map(([key, items]) => ({ key, items: [...items].sort(byCardOrder) }));
  return columns.sort((a, b) => {
    const [leadA] = a.items;
    const [leadB] = b.items;
    return rank(leadA.priority) - rank(leadB.priority)
      || startOfLocalDay(leadA.reportedDate).getTime() - startOfLocalDay(leadB.reportedDate).getTime()
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

const dayLabel = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export function FixTrackBoard<T extends BoardIssue>({
  issues, onEdit, issueTypeMeta, priorities, statuses, now,
}: {
  issues: T[];
  onEdit: (issue: T) => void;
  issueTypeMeta: (key: string) => Meta;
  priorities: Record<string, Meta>;
  statuses: Record<string, Meta>;
  /** Injectable clock for tests. */
  now?: Date;
}) {
  const columns = buildBoardColumns(issues);
  const today = now ?? new Date();

  if (columns.length === 0) {
    return (
      <div className="py-20 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
        <CheckCircle2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
        <p className="text-sm font-medium">No open issues — nothing to action right now</p>
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map(({ key, items }) => {
        const meta = issueTypeMeta(key);
        return (
          <div key={key} className="flex-shrink-0 w-72" data-testid="board-column" data-trade={key}>
            <div className="flex items-center justify-between mb-2 px-1">
              <span className={cn("inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium", meta.color)}>
                {meta.label}
              </span>
              <span className="text-xs text-muted-foreground font-medium tabular-nums">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map(issue => {
                const priorityMeta = priorities[issue.priority] ?? priorities.medium;
                const statusMeta   = statuses[issue.status] ?? statuses.reported;
                const daysOpen = elapsedDays(issue.reportedDate, today);
                const pastTarget = daysPastTarget(issue, today);
                return (
                  <button
                    key={issue.id}
                    onClick={() => onEdit(issue)}
                    data-testid="board-card"
                    data-issue-id={issue.id}
                    className={cn(
                      "w-full text-left bg-card border rounded-lg p-3 transition-shadow hover:shadow-md",
                      issue.priority === "urgent" ? "border-l-4 border-l-rose-500" : "border-border",
                    )}
                  >
                    <div className="font-medium text-sm mb-1.5 line-clamp-2">{issue.title}</div>
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", priorityMeta.color)}>{priorityMeta.label}</span>
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", statusMeta.color)}>{statusMeta.label}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground space-y-0.5">
                      <div className="truncate flex items-center gap-1">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        <span>{issue.siteName ?? "No site"}</span>
                      </div>
                      <div className="truncate flex items-center gap-1">
                        <User className="w-3 h-3 flex-shrink-0" />
                        <span>{issue.contractorName ?? "Unassigned"}</span>
                      </div>
                      {issue.targetDate && (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 flex-shrink-0" />
                          <span>Target {format(startOfLocalDay(issue.targetDate), "dd/MM/yyyy")}</span>
                        </div>
                      )}
                      {!issue.targetDate && (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 flex-shrink-0" />
                          <span>No target date</span>
                        </div>
                      )}
                      {pastTarget !== null && (
                        <div className="font-medium text-red-700" data-testid="days-past-target">
                          {dayLabel(pastTarget)} past target
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="font-medium text-foreground" data-testid="days-open">{dayLabel(daysOpen)} open</span>
                        {issue.isOverdue && (
                          <Badge className="bg-red-600 text-white hover:bg-red-600">Overdue</Badge>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
