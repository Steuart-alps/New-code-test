import type { ChecklistResult } from "./checklist-results";

type AnswerLike = { checked: boolean; notes?: string; result?: ChecklistResult };

/** Unsaved work on a daily checklist card. */
export interface ChecklistDraft<T extends AnswerLike = AnswerLike> {
  items: T[];
  completedBy: string;
  staffRosterId: number | null;
  managerNote: string;
}

/**
 * Where a page keeps each card's unsaved work, so changing the site or date
 * (which reloads, and so remounts, the cards) never throws away ticks made
 * before it. Cleared once that card saves.
 */
export interface ChecklistDraftSlot<T extends AnswerLike = AnswerLike> {
  get(): ChecklistDraft<T> | undefined;
  set(draft: ChecklistDraft<T> | undefined): void;
}

export function createChecklistDraftStore() {
  const drafts = new Map<string, ChecklistDraft<any>>();
  return {
    slot<T extends AnswerLike>(key: string): ChecklistDraftSlot<T> {
      return {
        get: () => drafts.get(key),
        set: (draft) => { if (draft) drafts.set(key, draft); else drafts.delete(key); },
      };
    },
  };
}

export function hasAnswers(items: AnswerLike[]): boolean {
  return items.some(item => item.result || item.checked || item.notes?.trim());
}

const normalise = (key: string) => key.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Copies the answers (Pass/Fail/N/A or tick, and notes) from `answered` onto
 * the matching lines of `target`, matched by wording, as another site's list
 * may be in a different order or have lines of its own. Lines nobody answered
 * keep what `target` already had.
 */
export function carryAnswers<T extends AnswerLike, A extends AnswerLike>(
  target: T[],
  answered: A[],
  keyOf: (item: T | A) => string,
): T[] {
  const byKey = new Map<string, A>();
  for (const item of answered) {
    if (hasAnswers([item])) byKey.set(normalise(keyOf(item)), item);
  }
  if (byKey.size === 0) return target;
  return target.map(item => {
    const from = byKey.get(normalise(keyOf(item)));
    if (!from) return item;
    const next = { ...item };
    if (from.result || from.checked) {
      next.checked = from.checked;
      if (from.result) next.result = from.result; else delete next.result;
    }
    if (from.notes?.trim()) next.notes = from.notes;
    return next;
  });
}
