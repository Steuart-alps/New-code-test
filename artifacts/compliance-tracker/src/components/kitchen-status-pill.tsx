import { summarizeKitchenStatuses, type KitchenCheckState, type KitchenStatusSummary } from "@/lib/kitchen-dashboard-status";
import { cn } from "@/lib/utils";

export const KITCHEN_PILL_CLASS: Record<KitchenStatusSummary["tone"], string> = {
  overdue: "bg-rose-100 text-rose-700",
  due_soon: "bg-amber-100 text-amber-700",
  never: "bg-muted text-muted-foreground",
  ok: "bg-emerald-100 text-emerald-700",
};

export function KitchenStatusPill({ statuses }: { statuses: KitchenCheckState[] }) {
  if (!statuses.length) return null;

  const { overdue, dueSoon, ok, never, tone, label } = summarizeKitchenStatuses(statuses);

  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium shrink-0", KITCHEN_PILL_CLASS[tone])}>
        {label}
      </span>
      <span
        className="hidden text-xs text-muted-foreground tabular-nums shrink-0 md:inline"
        aria-label={`${overdue} overdue, ${dueSoon} due soon, ${ok} clear, ${never} never recorded`}
        title="Overdue / due soon / clear / never recorded"
      >
        <span className={overdue > 0 ? "font-semibold text-rose-700" : undefined}>{overdue}</span>
        {" / "}
        <span className={dueSoon > 0 ? "font-semibold text-amber-700" : undefined}>{dueSoon}</span>
        {" / "}
        <span className={ok > 0 ? "font-semibold text-emerald-700" : undefined}>{ok}</span>
        {" / "}
        <span>{never}</span>
      </span>
    </span>
  );
}
