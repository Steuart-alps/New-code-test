/**
 * FireTrack call point rotation. Each site lists its manual call points in the
 * order the manager wants them tested; the weekly alarm test suggests the next
 * one after the call point tested last (by test date), wrapping round to the
 * first and skipping archived ones. A call point counts as "not tested this
 * round" when it has never been tested, or not within one full round (number
 * of call points in use x the site's alarm test frequency).
 *
 * Pure so it can be unit tested without a database.
 */

export interface RotationPoint {
  id: number;
  siteId: number | null;
  sortOrder: number;
  archived: boolean;
  /** YYYY-MM-DD of the latest alarm test that used it. */
  lastTestedDate: string | null;
}

export interface Rotation {
  /** The call point next in turn at each site (one per site). */
  nextIds: Set<number>;
  notTestedThisRound: Set<number>;
}

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000);
const byOrder = (a: RotationPoint, b: RotationPoint) => a.sortOrder - b.sortOrder || a.id - b.id;

export function callPointRotation(
  points: RotationPoint[],
  /** Site -> the call point used on its most recent alarm test. */
  lastTestedBySite: Map<number | null, number>,
  alarmFrequencyDays: (siteId: number | null) => number,
  today: string,
): Rotation {
  const nextIds = new Set<number>();
  const notTestedThisRound = new Set<number>();
  const bySite = new Map<number | null, RotationPoint[]>();
  for (const point of points) bySite.set(point.siteId, [...(bySite.get(point.siteId) ?? []), point]);

  for (const [siteId, sitePoints] of bySite) {
    const active = sitePoints.filter(point => !point.archived).sort(byOrder);
    if (!active.length) continue;
    const last = sitePoints.find(point => point.id === lastTestedBySite.get(siteId));
    const next = last ? active.find(point => byOrder(point, last) > 0) ?? active[0] : active[0];
    nextIds.add(next.id);

    const roundDays = active.length * Math.max(1, alarmFrequencyDays(siteId));
    const todayDay = dayNumber(today);
    for (const point of active) {
      if (!point.lastTestedDate || todayDay - dayNumber(point.lastTestedDate) > roundDays) notTestedThisRound.add(point.id);
    }
  }
  return { nextIds, notTestedThisRound };
}

/**
 * What an alarm test records as the call point used: its name, plus its
 * location when the name does not already say it.
 */
export function callPointLabel(point: { name: string; location?: string | null }): string {
  const name = point.name.trim();
  const location = point.location?.trim();
  if (!location || name.toLocaleLowerCase("en-GB").includes(location.toLocaleLowerCase("en-GB"))) return name;
  return `${name} – ${location}`;
}
