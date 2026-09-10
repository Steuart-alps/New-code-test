export type CleaningFrequency = 'daily' | 'weekly' | 'monthly';

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function cleaningPeriodDate(
  frequency: CleaningFrequency,
  now: Date = new Date(),
): string {
  const period = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (frequency === 'weekly') {
    const daysSinceMonday = (period.getDay() + 6) % 7;
    period.setDate(period.getDate() - daysSinceMonday);
  } else if (frequency === 'monthly') {
    period.setDate(1);
  }

  return localIsoDate(period);
}