export type ChecklistResult = "pass" | "fail" | "na";

export interface ResultItem { label: string; checked: boolean; notes?: string; result?: ChecklistResult }

/** Older checklists only stored a tick: a ticked item counts as a pass. */
export function itemResult(item: ResultItem): ChecklistResult | undefined {
  return item.result ?? (item.checked ? "pass" : undefined);
}

export function withResult<T extends ResultItem>(item: T, result: ChecklistResult): T {
  return { ...item, result, checked: result !== "fail" };
}

/**
 * A checklist can be submitted only once every item is answered Pass, Fail or
 * N/A and every failed item says what is wrong. The server applies the same rule.
 */
export function checklistProgress(items: ResultItem[]) {
  let answered = 0;
  let failed = 0;
  let missingNotes = 0;
  for (const item of items) {
    const result = itemResult(item);
    if (!result) continue;
    answered += 1;
    if (result === "fail") {
      failed += 1;
      if (!item.notes?.trim()) missingNotes += 1;
    }
  }
  const ready = items.length > 0 && answered === items.length && missingNotes === 0;
  return { answered, failed, missingNotes, remaining: items.length - answered, ready };
}

export function submitHint(progress: ReturnType<typeof checklistProgress>): string | null {
  if (progress.remaining > 0) return `Answer every item to submit (${progress.remaining} left).`;
  if (progress.missingNotes > 0) return `Say what is wrong for each failed item (${progress.missingNotes} left).`;
  return null;
}
