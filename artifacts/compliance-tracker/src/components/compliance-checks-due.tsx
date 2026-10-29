import { Link } from "wouter";
import { AlertTriangle, ArrowRight, CalendarClock, Clock } from "lucide-react";
import { useListComplianceItems, type ComplianceItem } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { needsActionLabel } from "@/components/badges";
import { complianceCheckDueState as dueState, DUE_SOON_DAYS, type ComplianceCheckDueState as DueState } from "@/lib/compliance-check-state";

const MAX_ROWS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_RANK: Record<DueState, number> = { action: 0, overdue: 1, due_soon: 2 };

function dueLabel(item: ComplianceItem, now: number): string {
  if (item.needsAction) return needsActionLabel(item);
  if (!item.dueDate) return "Overdue";
  const days = Math.round((new Date(item.dueDate).getTime() - now) / DAY_MS);
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Dashboard card for compliance checks (gas safety, EICR, LOLER and other
 * contractor checks) that are overdue or due within 30 days, plus open
 * checks that still have no due date. Renders nothing when all are in date.
 */
export function ComplianceChecksDue({ siteId = null }: { siteId?: number | null }) {
  const { data: items = [], isLoading } = useListComplianceItems(siteId ? { siteId } : {});
  if (isLoading) return null;

  const now = Date.now();
  const flagged = items
    .map((item) => ({ item, state: dueState(item, now) }))
    .filter((row): row is { item: ComplianceItem; state: DueState } => row.state !== null)
    .sort((a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      (a.item.dueDate ? new Date(a.item.dueDate).getTime() : 0) - (b.item.dueDate ? new Date(b.item.dueDate).getTime() : 0));
  const actionNeeded = flagged.filter((row) => row.state === "action").length;
  const overdue = flagged.filter((row) => row.state === "overdue").length;
  const dueSoon = flagged.length - overdue - actionNeeded;
  const noDueDate = items.filter((item) => item.status !== "completed" && item.status !== "overdue" && !item.dueDate).length;

  if (flagged.length === 0 && noDueDate === 0) return null;
  const hasOverdue = overdue > 0 || actionNeeded > 0;

  return (
    <section
      aria-label="Compliance checks due"
      className={cn(
        "rounded-xl border overflow-hidden",
        hasOverdue ? "border-red-200 bg-red-50/50" : flagged.length ? "border-amber-200 bg-amber-50/50" : "border-border bg-card",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-inherit">
        {hasOverdue
          ? <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
          : <CalendarClock className="w-4 h-4 text-amber-600 flex-shrink-0" />}
        <p className={cn("font-semibold text-sm", hasOverdue ? "text-red-800" : flagged.length ? "text-amber-800" : "text-foreground")}>
          {flagged.length === 0
            ? "Compliance checks need due dates"
            : [
                actionNeeded ? `${actionNeeded} need${actionNeeded === 1 ? "s" : ""} remedial action` : "",
                overdue ? `${overdue} compliance check${overdue === 1 ? "" : "s"} overdue` : "",
                dueSoon ? `${dueSoon} due in the next ${DUE_SOON_DAYS} days` : "",
              ].filter(Boolean).join(" · ")}
        </p>
        <Link href="/external-checks" className="ml-auto text-xs text-primary hover:underline flex items-center gap-0.5 shrink-0">
          View all <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {flagged.length > 0 && (
        <ul className="px-4 py-3 space-y-1.5">
          {flagged.slice(0, MAX_ROWS).map(({ item, state }) => (
            <li key={item.id}>
              <Link
                href={`/items/${item.id}`}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm border bg-white hover:bg-muted/30 transition-colors",
                  state !== "due_soon" ? "border-red-200" : "border-amber-200",
                )}
              >
                <div className="min-w-0">
                  <p className={cn("font-medium truncate", state !== "due_soon" ? "text-red-900" : "text-amber-900")}>{item.title}</p>
                  {(item.siteName || item.categoryName) && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {[item.siteName, item.categoryName].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                <span className={cn(
                  "inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full shrink-0",
                  state !== "due_soon" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700",
                )}>
                  {state !== "due_soon" ? <AlertTriangle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                  {dueLabel(item, now)}
                </span>
              </Link>
            </li>
          ))}
          {flagged.length > MAX_ROWS && (
            <li className="px-1 pt-1">
              <Link href="/external-checks" className="text-xs text-primary hover:underline">
                and {flagged.length - MAX_ROWS} more
              </Link>
            </li>
          )}
        </ul>
      )}

      {noDueDate > 0 && (
        <Link href="/external-checks" className="block px-4 py-2.5 text-xs text-muted-foreground border-t border-inherit hover:text-foreground hover:underline">
          {noDueDate} open compliance check{noDueDate === 1 ? " has" : "s have"} no due date yet. Set each one from the last service or inspection date so reminders work.
        </Link>
      )}
    </section>
  );
}
