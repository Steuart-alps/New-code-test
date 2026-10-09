export type DiaryScopeChange =
  | { kind: 'ignore' }
  | { kind: 'confirm'; siteId: number | null }
  | { kind: 'switch'; siteId: number | null };

export function shouldHydrateDiaryDraft(isDirty: boolean): boolean {
  return !isDirty;
}

export function requestDiaryScopeChange(
  currentSiteId: number | null,
  nextSiteId: number | null,
  isDirty: boolean,
  isSaving: boolean,
): DiaryScopeChange {
  if (currentSiteId === nextSiteId || isSaving) return { kind: 'ignore' };
  if (isDirty) return { kind: 'confirm', siteId: nextSiteId };
  return { kind: 'switch', siteId: nextSiteId };
}