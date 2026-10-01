import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Calendar, CheckCircle2, MapPin, User } from "lucide-react";

export interface FixTrackBoardIssue {
  id: number;
  title: string;
  issueType: string;
  priority: string;
  status: string;
  reportedDate: string;
  location: string;
  targetDate?: string | null;
  siteName?: string | null;
  contractorName?: string | null;
  isOverdue: boolean;
}

export interface BoardBadgeMeta {
  label: string;
  color: string;
}

export type BoardStatusMeta = BoardBadgeMeta;

export function buildPriorityBoardColumns<Issue extends FixTrackBoardIssue>(issues: Issue[]) {
  const openIssues = issues.filter(issue => issue.status === "reported" || issue.status === "in_progress");
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

  return [...new Set(openIssues.map(issue => issue.issueType))]
    .map(key => ({
      key,
      items: openIssues.filter(issue => issue.issueType === key).sort((a, b) => {
        const priorityDifference = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
        return priorityDifference || new Date(a.reportedDate).getTime() - new Date(b.reportedDate).getTime();
      }),
    }))
    .filter(column => column.items.length > 0);
}

function startOfLocalDay(value: string | Date): Date {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00`) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Count whole local calendar days, never negative, for issue-age labels. */
export function elapsedBoardDays(from: string, to = new Date()): number {
  const dayMs = 86_400_000;
  const localDayOrdinal = (value: string | Date) => {
    const date = startOfLocalDay(value);
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayMs);
  };
  return Math.max(0, localDayOrdinal(to) - localDayOrdinal(from));
}

interface FixTrackBoardProps<Issue extends FixTrackBoardIssue> {
  issues: Issue[];
  onEdit: (issue: Issue) => void;
  issueTypeMeta: (key: string) => BoardBadgeMeta;
  priorities: Record<string, BoardBadgeMeta>;
  statuses: Record<string, BoardStatusMeta>;
  /** An injectable local "today" for deterministic day-age checks. */
  today?: Date;
}

export function FixTrackBoard<Issue extends FixTrackBoardIssue>({
  issues, onEdit, issueTypeMeta, priorities, statuses, today = new Date(),
}: FixTrackBoardProps<Issue>) {
  const columns = buildPriorityBoardColumns(issues);

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
          <div key={key} data-testid={`fix-track-board-column-${key}`} className="flex-shrink-0 w-72">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className={cn("inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium", meta.color)}>
                {meta.label}
              </span>
              <span className="text-xs text-muted-foreground font-medium tabular-nums">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map(issue => {
                const priorityMeta = priorities[issue.priority] ?? priorities.medium;
                const statusMeta = statuses[issue.status] ?? statuses.reported;
                const daysOpen = elapsedBoardDays(issue.reportedDate, today);
                return (
                  <button
                    key={issue.id}
                    type="button"
                    data-testid={`fix-track-board-card-${issue.id}`}
                    onClick={() => onEdit(issue)}
                    className={cn(
                      "w-full text-left bg-card border rounded-lg p-3 transition-shadow hover:shadow-md",
                      issue.priority === "urgent" ? "border-l-4 border-l-rose-500" : "border-border",
                    )}
                  >
                    <div className="font-medium text-sm mb-1.5 line-clamp-2">{issue.title}</div>
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", priorityMeta.color)}>
                        {priorityMeta.label}
                      </span>
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
                      {issue.targetDate ? (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 flex-shrink-0" />
                          <span>Target {format(startOfLocalDay(issue.targetDate), "dd/MM/yyyy")}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 flex-shrink-0" />
                          <span>No target date</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="font-medium text-foreground">
                          {daysOpen} {daysOpen === 1 ? "day" : "days"} open
                        </span>
                        {issue.isOverdue && <Badge className="bg-red-600 text-white hover:bg-red-600">Overdue</Badge>}
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