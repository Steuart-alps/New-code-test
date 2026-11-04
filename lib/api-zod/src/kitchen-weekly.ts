/**
 * KitchenTrack weekly review: which answers count against the week.
 *
 * Most questions ask whether good practice was followed, so "no" is the
 * answer that needs attention. A few ask whether something needs doing, where
 * "yes" is the one that needs attention, and a few only record a change whose
 * follow-up question carries the result (a complaint received is followed by
 * "Have complaints been investigated?"). The API computes the stored result
 * from this, and the web and phone forms flag the same answers.
 */

export type KitchenWeeklyAnswer = "yes" | "no" | "na";

/** "Yes" means something still needs doing. */
export const KITCHEN_WEEKLY_YES_NEEDS_ATTENTION: readonly string[] = [
  "cleaningScheduleNeedsUpdate",
  "staffRefresherRequired",
];

/** Either answer is fine; the follow-up question named alongside carries the result. */
export const KITCHEN_WEEKLY_NEUTRAL: readonly string[] = [
  "methodsOrEquipmentChanged", // safeMethodsReviewed
  "additionalChecksRequired",  // extraChecksCompleted
  "complaintsReceived",        // complaintsInvestigated
];

/** The answer to this question that needs attention, or null when neither does. */
export function kitchenWeeklyAttentionAnswer(key: string): "yes" | "no" | null {
  if (KITCHEN_WEEKLY_NEUTRAL.includes(key)) return null;
  return KITCHEN_WEEKLY_YES_NEEDS_ATTENTION.includes(key) ? "yes" : "no";
}

export function kitchenWeeklyNeedsAttention(key: string, answer: unknown): boolean {
  const attention = kitchenWeeklyAttentionAnswer(key);
  return attention !== null && answer === attention;
}

/** A submitted review fails when any answer needs attention. */
export function kitchenWeeklyResult(checks: Record<string, unknown>): "pass" | "fail" {
  return Object.entries(checks).some(([key, answer]) => kitchenWeeklyNeedsAttention(key, answer)) ? "fail" : "pass";
}
