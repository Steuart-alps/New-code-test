/** null selects the organisation diary, not an aggregate of site diaries. */
export const DEFAULT_DIARY_SITE: number | null = null;

export function kitchenDiaryScope(siteId: number | null, date: string) {
  const site = siteId === null ? '' : `?siteId=${siteId}`;
  return {
    configUrl: `/api/food-safety/config${site}`,
    recordUrl: `/api/food-safety?date=${encodeURIComponent(date)}${siteId === null ? '' : `&siteId=${siteId}`}`,
    configKey: ['food-safety', 'config', siteId] as const,
    recordKey: ['food-safety', 'today', siteId, date] as const,
    saveUrl: (recordId: number | null) =>
      `/api/food-safety${recordId === null ? '' : `/${recordId}`}${site}`,
  };
}