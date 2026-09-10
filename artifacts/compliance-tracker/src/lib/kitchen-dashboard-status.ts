export type KitchenCheckState = "ok" | "due_soon" | "overdue" | "never";

export interface KitchenStatusSummary {
  overdue: number;
  dueSoon: number;
  ok: number;
  never: number;
  tone: "overdue" | "due_soon" | "never" | "ok";
  label: string;
}

export function summarizeKitchenStatuses(statuses: KitchenCheckState[]): KitchenStatusSummary {
  const overdue = statuses.filter((status) => status === "overdue").length;
  const dueSoon = statuses.filter((status) => status === "due_soon").length;
  const ok = statuses.filter((status) => status === "ok").length;
  const never = statuses.filter((status) => status === "never").length;

  if (overdue > 0) {
    return { overdue, dueSoon, ok, never, tone: "overdue", label: `${overdue} overdue` };
  }
  if (dueSoon > 0) {
    return { overdue, dueSoon, ok, never, tone: "due_soon", label: `${dueSoon} due soon` };
  }
  if (never > 0) {
    return { overdue, dueSoon, ok, never, tone: "never", label: `${never} never recorded` };
  }
  return { overdue, dueSoon, ok, never, tone: "ok", label: "All clear" };
}