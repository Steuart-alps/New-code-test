/**
 * Reusable safety-area summary page.
 *
 * Used for both Fire Safety and Water Safety. Finds all categories whose name
 * matches the given keyword, fetches their compliance items, and groups them by
 * status — prominently flagging overdue and action-required items.
 */
import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Circle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

interface Category {
  id: number;
  name: string;
  color: string;
}

interface ComplianceItem {
  id: number;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "completed" | "overdue";
  priority: "low" | "medium" | "high" | "critical";
  dueDate: string | null;
  categoryId: number | null;
  siteName: string | null;
  assignedTo: string | null;
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function statusLabel(status: ComplianceItem["status"]) {
  return {
    pending: "Pending",
    in_progress: "In Progress",
    completed: "Compliant",
    overdue: "Overdue — Action Required",
  }[status];
}

function StatusBadge({ status }: { status: ComplianceItem["status"] }) {
  const cfg = {
    pending: { cls: "border-border text-muted-foreground bg-muted/30", Icon: Circle },
    in_progress: { cls: "border-amber-300 text-amber-700 bg-amber-50", Icon: Clock },
    completed: { cls: "border-emerald-200 text-emerald-700 bg-emerald-50", Icon: CheckCircle2 },
    overdue: { cls: "border-red-300 text-red-700 bg-red-50", Icon: AlertTriangle },
  }[status];
  const { cls, Icon } = cfg;
  return (
    <Badge variant="outline" className={`text-xs gap-1 ${cls}`}>
      <Icon className="w-3 h-3" />
      {statusLabel(status)}
    </Badge>
  );
}

function priorityDot(p: ComplianceItem["priority"]) {
  const cls = {
    low: "bg-slate-300",
    medium: "bg-sky-400",
    high: "bg-amber-400",
    critical: "bg-red-500",
  }[p];
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} title={`${p} priority`} />;
}

function fmt(iso: string | null | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── Item card ─────────────────────────────────────────────────────────────────

function ItemRow({ item }: { item: ComplianceItem }) {
  const isActionRequired = item.status === "overdue" || item.status === "in_progress";
  return (
    <div
      className={`flex items-start gap-3 px-5 py-4 ${
        isActionRequired && item.status === "overdue"
          ? "bg-red-50/60"
          : item.status === "in_progress"
          ? "bg-amber-50/60"
          : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {priorityDot(item.priority)}
          <span className="text-sm font-medium">{item.title}</span>
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-xs text-muted-foreground">
          {item.siteName && <span>Site: {item.siteName}</span>}
          {item.assignedTo && <span>Assigned to: {item.assignedTo}</span>}
          {item.dueDate && (
            <span className={item.status === "overdue" ? "text-red-600 font-medium" : ""}>
              Due: {fmt(item.dueDate)}
            </span>
          )}
        </div>
      </div>
      <StatusBadge status={item.status} />
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: "danger" | "warning" | "success" | "neutral";
}) {
  const styles = {
    danger: "bg-red-50 border-red-200 text-red-700",
    warning: "bg-amber-50 border-amber-200 text-amber-700",
    success: "bg-emerald-50 border-emerald-200 text-emerald-700",
    neutral: "bg-muted/30 border-border text-muted-foreground",
  }[variant];
  return (
    <div className={`rounded-xl border p-4 ${styles}`}>
      <p className="text-2xl font-bold">{count}</p>
      <p className="text-xs mt-0.5 font-medium">{label}</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface SafetySummaryProps {
  title: string;
  categoryKeyword: string;
  emptyMessage?: string;
}

export function SafetySummaryPage({ title, categoryKeyword, emptyMessage }: SafetySummaryProps) {
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Load categories and items in parallel
      const [catRes, itemRes] = await Promise.all([
        apiFetch("/categories"),
        apiFetch("/compliance-items"),
      ]);

      if (!catRes.ok || !itemRes.ok) {
        setError("Failed to load data");
        return;
      }

      const cats: Category[] = await catRes.json();
      const allItems: ComplianceItem[] = await itemRes.json();

      // Match categories by keyword (case-insensitive)
      const kw = categoryKeyword.toLowerCase();
      const matchedIds = new Set(cats.filter(c => c.name.toLowerCase().includes(kw)).map(c => c.id));

      if (matchedIds.size === 0) {
        setItems(allItems); // fallback: show all if no category match
      } else {
        setItems(allItems.filter(i => i.categoryId != null && matchedIds.has(i.categoryId)));
      }
    } finally {
      setLoading(false);
    }
  }, [categoryKeyword]);

  useEffect(() => { load(); }, [load]);

  const overdue = items.filter(i => i.status === "overdue");
  const inProgress = items.filter(i => i.status === "in_progress");
  const completed = items.filter(i => i.status === "completed");
  const pending = items.filter(i => i.status === "pending");

  const actionRequired = [...overdue, ...inProgress];
  const allGood = actionRequired.length === 0 && items.length > 0;

  return (
    <AppLayout title={title}>
      <div className="space-y-5 max-w-3xl">
        {/* Overall status banner */}
        {!loading && items.length > 0 && (
          <div
            className={`rounded-xl border p-4 flex items-center gap-3 ${
              overdue.length > 0
                ? "bg-red-50 border-red-200"
                : inProgress.length > 0
                ? "bg-amber-50 border-amber-200"
                : "bg-emerald-50 border-emerald-200"
            }`}
          >
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                overdue.length > 0
                  ? "bg-red-100"
                  : inProgress.length > 0
                  ? "bg-amber-100"
                  : "bg-emerald-100"
              }`}
            >
              {allGood ? (
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
              ) : (
                <ShieldAlert
                  className={`w-5 h-5 ${
                    overdue.length > 0 ? "text-red-600" : "text-amber-600"
                  }`}
                />
              )}
            </div>
            <div>
              <p
                className={`font-semibold text-sm ${
                  overdue.length > 0
                    ? "text-red-800"
                    : inProgress.length > 0
                    ? "text-amber-800"
                    : "text-emerald-800"
                }`}
              >
                {allGood
                  ? "All checks are up to date"
                  : overdue.length > 0
                  ? `${overdue.length} check${overdue.length !== 1 ? "s" : ""} overdue — immediate action required`
                  : `${inProgress.length} check${inProgress.length !== 1 ? "s" : ""} in progress`}
              </p>
              <p
                className={`text-xs mt-0.5 ${
                  overdue.length > 0
                    ? "text-red-700"
                    : inProgress.length > 0
                    ? "text-amber-700"
                    : "text-emerald-700"
                }`}
              >
                {items.length} total checks · {completed.length} compliant · {overdue.length} overdue · {inProgress.length} in progress
              </p>
            </div>
          </div>
        )}

        {/* Summary stats grid */}
        {!loading && items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryCard label="Overdue" count={overdue.length} variant="danger" />
            <SummaryCard label="In Progress" count={inProgress.length} variant="warning" />
            <SummaryCard label="Compliant" count={completed.length} variant="success" />
            <SummaryCard label="Pending" count={pending.length} variant="neutral" />
          </div>
        )}

        {/* Action-required section */}
        {!loading && actionRequired.length > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center gap-2 bg-muted/30">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <span className="font-semibold text-sm">Action Required ({actionRequired.length})</span>
            </div>
            <div className="divide-y divide-border">
              {actionRequired.map(item => <ItemRow key={item.id} item={item} />)}
            </div>
          </div>
        )}

        {/* Compliant items */}
        {!loading && completed.length > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span className="font-medium text-sm">Compliant ({completed.length})</span>
            </div>
            <div className="divide-y divide-border">
              {completed.map(item => <ItemRow key={item.id} item={item} />)}
            </div>
          </div>
        )}

        {/* Pending items */}
        {!loading && pending.length > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
              <Circle className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium text-sm text-muted-foreground">Pending ({pending.length})</span>
            </div>
            <div className="divide-y divide-border">
              {pending.map(item => <ItemRow key={item.id} item={item} />)}
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
        )}

        {/* Error state */}
        {error && (
          <div className="text-center py-16 text-destructive text-sm">{error}</div>
        )}

        {/* Empty state */}
        {!loading && !error && items.length === 0 && (
          <div className="text-center py-16 border border-dashed border-border rounded-xl">
            <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {emptyMessage ?? `No ${title.toLowerCase()} compliance items found.`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Add items under a "{categoryKeyword}" category to see them here.
            </p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

// ── Exported page variants ────────────────────────────────────────────────────

export default function FireSafetyPage() {
  return (
    <SafetySummaryPage
      title="Fire Safety"
      categoryKeyword="fire"
      emptyMessage="No fire safety compliance items found."
    />
  );
}

export function WaterSafetyPage() {
  return (
    <SafetySummaryPage
      title="Water Safety"
      categoryKeyword="water"
      emptyMessage="No water safety or legionella compliance items found."
    />
  );
}
