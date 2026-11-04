import type { ComplianceItem } from "@workspace/api-client-react";

/** A check due within this many days is "due soon" (amber). */
export const DUE_SOON_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ComplianceCheckDueState = "action" | "overdue" | "due_soon";

/**
 * Where a compliance check stands: "action" when its newest certificate is
 * unsatisfactory, has open remedial defects or is still outstanding after a
 * contractor visit (whatever the due date, and even when completed);
 * "overdue"; "due_soon" within DUE_SOON_DAYS; null when it is in date.
 */
export function complianceCheckDueState(
  item: Pick<ComplianceItem, "needsAction" | "status" | "dueDate">,
  now: number,
): ComplianceCheckDueState | null {
  if (item.needsAction) return "action";
  if (item.status === "completed") return null;
  const due = item.dueDate ? new Date(item.dueDate).getTime() : null;
  if (item.status === "overdue" || (due !== null && due < now)) return "overdue";
  if (due !== null && due <= now + DUE_SOON_DAYS * DAY_MS) return "due_soon";
  return null;
}
