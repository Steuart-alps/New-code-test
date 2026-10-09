import type { ColdReading } from './kitchen-temperature-form-logic';

/**
 * Unfinished KitchenTrack temperature forms, kept on the device so an
 * accidental close does not lose readings that were never saved.
 *
 * A draft belongs to one account (client + user) and one diary (site + date).
 * Drafts for any other account are invisible: the storage key includes the
 * owner and every read re-checks it. A draft also records a fingerprint of the
 * diary it was entered against, so a diary that changed in the meantime is
 * flagged for review instead of being silently overwritten; the server still
 * applies its own baseline (expected*) checks and record locks on save.
 */

export interface KitchenDraftOwner { clientId: number; userId: number }

export interface KitchenFormRow { [field: string]: string }

export interface KitchenFormValues {
  coldFood: ColdReading[];
  delivery: KitchenFormRow;
  hotHolding: KitchenFormRow;
  cooking: KitchenFormRow;
  cooling: KitchenFormRow;
  reheating: KitchenFormRow;
  correctives: string;
}

export interface KitchenFormDraft {
  version: 1;
  owner: KitchenDraftOwner;
  siteId: number | null;
  recordDate: string;
  values: KitchenFormValues;
  /** Fingerprint of the diary the values were entered against; null when the
   *  draft came from a rejected device entry and must always be reviewed. */
  baseline: string | null;
  origin: 'form' | 'restored';
  /** The rejected device entry a restored draft came from. */
  restoredFrom?: string;
  savedAt: string;
}

export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const kitchenFormDraftKey = (owner: KitchenDraftOwner, siteId: number | null, recordDate: string) =>
  `complytrack:kitchen-form-draft:v1:${owner.clientId}:${owner.userId}:${siteId ?? 'org'}:${recordDate}`;

const sorted = (value: unknown): unknown => Array.isArray(value)
  ? value.map(sorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value as object).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
    : value;

/** Stable fingerprint of a loaded diary (or of "no diary yet"). */
export function diaryFingerprint(record: unknown): string {
  return JSON.stringify(sorted(record ?? null));
}

const isRow = (value: unknown): value is KitchenFormRow =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value as object).every(field => typeof field === 'string');

function isDraft(value: unknown, owner: KitchenDraftOwner, siteId: number | null, recordDate: string): value is KitchenFormDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as KitchenFormDraft;
  return draft.version === 1
    && draft.owner?.clientId === owner.clientId && draft.owner?.userId === owner.userId
    && draft.siteId === siteId && draft.recordDate === recordDate
    && (draft.baseline === null || typeof draft.baseline === 'string')
    && (draft.origin === 'form' || draft.origin === 'restored')
    && typeof draft.savedAt === 'string'
    && !!draft.values && Array.isArray(draft.values.coldFood) && draft.values.coldFood.every(isRow)
    && ['delivery', 'hotHolding', 'cooking', 'cooling', 'reheating'].every(key => isRow((draft.values as unknown as Record<string, unknown>)[key]))
    && typeof draft.values.correctives === 'string';
}

export async function saveKitchenDraft(storage: DraftStorage, draft: KitchenFormDraft): Promise<void> {
  await storage.setItem(kitchenFormDraftKey(draft.owner, draft.siteId, draft.recordDate), JSON.stringify(draft));
}

/** The owner's draft for this diary, or null. Anything unreadable or
 *  belonging to someone else is treated as absent (never shown). */
export async function loadKitchenDraft(
  storage: DraftStorage, owner: KitchenDraftOwner, siteId: number | null, recordDate: string,
): Promise<KitchenFormDraft | null> {
  const raw = await storage.getItem(kitchenFormDraftKey(owner, siteId, recordDate));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isDraft(parsed, owner, siteId, recordDate) ? parsed : null;
  } catch {
    return null;
  }
}

/** All of this owner's drafts (any diary), for surfacing ones the form
 *  cannot open, such as an earlier day's. Other accounts' drafts are skipped. */
export async function listKitchenDrafts(
  storage: DraftStorage & { getAllKeys(): Promise<readonly string[]> }, owner: KitchenDraftOwner,
): Promise<KitchenFormDraft[]> {
  const prefix = `complytrack:kitchen-form-draft:v1:${owner.clientId}:${owner.userId}:`;
  const drafts: KitchenFormDraft[] = [];
  for (const key of await storage.getAllKeys()) {
    if (!key.startsWith(prefix)) continue;
    const [site, recordDate] = key.slice(prefix.length).split(':');
    const siteId = site === 'org' ? null : Number(site);
    if (siteId !== null && !Number.isSafeInteger(siteId)) continue;
    const draft = await loadKitchenDraft(storage, owner, siteId, recordDate);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export async function discardKitchenDraft(
  storage: DraftStorage, owner: KitchenDraftOwner, siteId: number | null, recordDate: string,
): Promise<void> {
  await storage.removeItem(kitchenFormDraftKey(owner, siteId, recordDate));
}

export type DraftReview =
  /** Same diary as when entered: restore into the form as-is. */
  | { kind: 'restore' }
  /** The diary changed (or the draft came from a rejected entry): restore on
   *  top of the latest diary and controls, and ask the user to review. */
  | { kind: 'review' }
  /** Not today's diary: the form cannot edit it, so it can only be viewed or discarded. */
  | { kind: 'other-date' };

export function reviewKitchenDraft(draft: KitchenFormDraft, freshFingerprint: string, today: string): DraftReview {
  if (draft.recordDate !== today) return { kind: 'other-date' };
  if (draft.baseline === null || draft.baseline !== freshFingerprint) return { kind: 'review' };
  return { kind: 'restore' };
}

/**
 * Lay draft cold-unit readings over the latest configured units: units still
 * configured keep the draft's values; units that no longer exist are dropped;
 * new units start blank (from the fresh rows).
 */
export function mergeColdReadings(freshRows: readonly ColdReading[], draftRows: readonly ColdReading[]): ColdReading[] {
  return freshRows.map(row => {
    const draft = draftRows.find(candidate => candidate.unit === row.unit);
    return draft ? { ...row, tempAm: draft.tempAm ?? '', tempPm: draft.tempPm ?? '', correctiveAction: draft.correctiveAction ?? '' } : row;
  });
}

const firstRow = (value: unknown): KitchenFormRow => {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return {};
  return Object.fromEntries(Object.entries(row as object)
    .filter(([, field]) => typeof field === 'string' || typeof field === 'number')
    .map(([key, field]) => [key, String(field)]));
};

/** Form values from a device entry's payload, in either shape the form sends
 *  (a new diary, or an update carried in mobileTemperatureLog). */
export function formValuesFromEntryBody(body: Record<string, unknown>): KitchenFormValues {
  const log = (body.mobileTemperatureLog ?? body) as Record<string, unknown>;
  const cold = Array.isArray(log.coldFood) ? log.coldFood : [];
  return {
    coldFood: cold.map(row => {
      const reading = firstRow(row);
      return { unit: reading.unit ?? '', tempAm: reading.tempAm ?? '', tempPm: reading.tempPm ?? '', correctiveAction: reading.correctiveAction ?? '' };
    }).filter(row => row.unit),
    delivery: firstRow(log.delivery ?? log.deliveries),
    hotHolding: firstRow(log.hotHolding),
    cooking: firstRow(log.hotTemperature),
    cooling: firstRow(log.cooling),
    reheating: firstRow(log.reheating),
    correctives: typeof log.correctives === 'string' ? log.correctives : '',
  };
}

/** Same-screen notifications when a draft is written elsewhere (e.g. a
 *  rejected entry restored from the delivery panel). */
const listeners = new Set<(key: string) => void>();
export const onKitchenDraftChanged = (listener: (key: string) => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const notifyKitchenDraftChanged = (key: string) => listeners.forEach(listener => listener(key));
