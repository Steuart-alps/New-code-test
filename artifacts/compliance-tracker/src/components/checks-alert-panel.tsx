import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { AlertTriangle, Clock, ChevronDown, ChevronUp, ArrowRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckAlert {
  module: "fire" | "legionella" | "pool";
  moduleLabel: string;
  modulePath: string;
  checkType: string;
  checkLabel: string;
  status: "overdue" | "due_soon" | "never";
  lastDate: string | null;
  dueDate: string | null;
  daysUntilDue: number | null;
  frequencyLabel: string;
}

function daysLabel(a: CheckAlert): string {
  if (a.daysUntilDue === null) return "No record";
  if (a.daysUntilDue < 0) {
    const n = Math.abs(a.daysUntilDue);
    return `${n} day${n !== 1 ? "s" : ""} overdue`;
  }
  if (a.daysUntilDue === 0) return "Due today";
  return `Due in ${a.daysUntilDue} day${a.daysUntilDue !== 1 ? "s" : ""}`;
}

function lastLabel(lastDate: string | null): string {
  if (!lastDate) return "Never completed";
  const d = new Date(`${lastDate}T00:00:00Z`);
  return `Last: ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

interface Props {
  /** If provided, only show alerts for that module. */
  moduleFilter?: "fire" | "legionella" | "pool";
  /** Compact single-row banner instead of expandable card. */
  compact?: boolean;
}

export function ChecksAlertPanel({ moduleFilter, compact = false }: Props) {
  const [alerts, setAlerts] = useState<CheckAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    setLoading(true);
    const r = await apiFetch("/check-reminders");
    if (r.ok) {
      const data: CheckAlert[] = await r.json();
      const visible = moduleFilter ? data.filter(a => a.module === moduleFilter) : data;
      setAlerts(visible.filter(a => a.status === "overdue" || a.status === "due_soon"));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [moduleFilter]);

  if (loading) return null;
  if (alerts.length === 0) return null;

  const overdue = alerts.filter(a => a.status === "overdue");
  const dueSoon = alerts.filter(a => a.status === "due_soon");
  const hasOverdue = overdue.length > 0;

  if (compact) {
    return (
      <div className={cn(
        "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium border",
        hasOverdue
          ? "bg-red-50 border-red-200 text-red-800"
          : "bg-amber-50 border-amber-200 text-amber-800"
      )}>
        {hasOverdue
          ? <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          : <Clock className="w-4 h-4 flex-shrink-0" />}
        <span>
          {hasOverdue
            ? `${overdue.length} check${overdue.length !== 1 ? "s" : ""} overdue`
            : `${dueSoon.length} check${dueSoon.length !== 1 ? "s" : ""} due soon`}
        </span>
        <button
          className="ml-auto text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? "Hide" : "View"}
        </button>
        {expanded && (
          <div className="absolute mt-8 z-50 bg-white border rounded-xl shadow-xl w-80 p-0 overflow-hidden">
            {/* re-use full list below */}
          </div>
        )}
      </div>
    );
  }

  // Full card view
  const sortedAlerts = [...overdue, ...dueSoon];
  const MAX_COLLAPSED = 4;
  const showExpander = sortedAlerts.length > MAX_COLLAPSED;
  const visibleAlerts = expanded ? sortedAlerts : sortedAlerts.slice(0, MAX_COLLAPSED);

  // Group by module for display
  const grouped = new Map<string, { label: string; path: string; alerts: CheckAlert[] }>();
  for (const a of visibleAlerts) {
    if (!grouped.has(a.module)) grouped.set(a.module, { label: a.moduleLabel, path: a.modulePath, alerts: [] });
    grouped.get(a.module)!.alerts.push(a);
  }

  return (
    <div className={cn(
      "rounded-xl border mb-6 overflow-hidden",
      hasOverdue ? "border-red-200 bg-red-50/50" : "border-amber-200 bg-amber-50/50"
    )}>
      {/* Header */}
      <div className={cn(
        "flex items-center gap-3 px-5 py-3.5 border-b",
        hasOverdue ? "bg-red-100/60 border-red-200" : "bg-amber-100/60 border-amber-200"
      )}>
        {hasOverdue
          ? <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
          : <Clock className="w-4 h-4 text-amber-600 flex-shrink-0" />}
        <span className={cn("font-semibold text-sm", hasOverdue ? "text-red-800" : "text-amber-800")}>
          {hasOverdue
            ? `${overdue.length} safety check${overdue.length !== 1 ? "s" : ""} overdue`
            : `${dueSoon.length} safety check${dueSoon.length !== 1 ? "s" : ""} due soon`}
          {overdue.length > 0 && dueSoon.length > 0 &&
            <span className="font-normal opacity-70 ml-1">· {dueSoon.length} more due soon</span>}
        </span>
        <button
          className="ml-auto p-1 opacity-50 hover:opacity-100 rounded"
          onClick={load}
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Alert rows grouped by module */}
      <div className="px-5 py-3 space-y-4">
        {Array.from(grouped.entries()).map(([module, group]) => (
          <div key={module}>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                {group.label}
              </p>
              <Link
                href={group.path}
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                View <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="space-y-1.5">
              {group.alerts.map((a, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-center justify-between rounded-lg px-3 py-2.5 text-sm border",
                    a.status === "overdue"
                      ? "bg-white border-red-200"
                      : "bg-white border-amber-200"
                  )}
                >
                  <div>
                    <p className={cn("font-medium", a.status === "overdue" ? "text-red-900" : "text-amber-900")}>
                      {a.checkLabel}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {lastLabel(a.lastDate)} · {a.frequencyLabel}
                    </p>
                  </div>
                  <div className="text-right ml-4 flex-shrink-0">
                    <span className={cn(
                      "inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full",
                      a.status === "overdue"
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700"
                    )}>
                      {a.status === "overdue"
                        ? <AlertTriangle className="w-3 h-3" />
                        : <Clock className="w-3 h-3" />}
                      {daysLabel(a)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Expand/collapse */}
      {showExpander && (
        <button
          onClick={() => setExpanded(e => !e)}
          className={cn(
            "w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-t",
            hasOverdue
              ? "text-red-700 border-red-200 hover:bg-red-100/60"
              : "text-amber-700 border-amber-200 hover:bg-amber-100/60"
          )}
        >
          {expanded
            ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
            : <><ChevronDown className="w-3.5 h-3.5" /> Show {sortedAlerts.length - MAX_COLLAPSED} more</>}
        </button>
      )}
    </div>
  );
}
