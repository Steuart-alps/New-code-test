import type { CleaningFrequency } from './cleaning-schedule-logic';

export interface CleaningDraftCompletion {
  taskId?: number;
  taskArea?: string;
  taskName: string;
  done: boolean;
  doneBy?: string;
  notes?: string;
}

export interface CleaningDraftLog {
  completions?: CleaningDraftCompletion[] | null;
  signed_by?: string | null;
}

export interface CleaningDraftTask {
  id: number;
  area: string;
  task: string;
}

export interface HydratedCleaningDraft {
  checked: Record<number, boolean>;
  doneBy: Record<number, string>;
  initials: string;
}

export type CleaningFrequencyChange =
  | { kind: 'ignore' }
  | { kind: 'confirm'; frequency: CleaningFrequency }
  | { kind: 'switch'; frequency: CleaningFrequency };

export type CleaningSiteChange =
  | { kind: 'ignore' }
  | { kind: 'confirm'; siteId: number }
  | { kind: 'switch'; siteId: number };

export interface CleaningLogPayload {
  logDate: string;
  frequency: CleaningFrequency;
  siteId: number | null;
  completions: CleaningDraftCompletion[];
  signedBy: string;
  submittedAt: string | null;
}

/**
 * Returns null for dirty forms so a background query refresh cannot replace
 * edits that have not been saved yet.
 */
export function hydrateCleaningDraft(
  log: CleaningDraftLog | null | undefined,
  userName: string | undefined,
  isDirty: boolean,
): HydratedCleaningDraft | null {
  if (isDirty) return null;

  const checked: Record<number, boolean> = {};
  const doneBy: Record<number, string> = {};
  for (const completion of log?.completions ?? []) {
    if (typeof completion.taskId !== 'number') continue;
    checked[completion.taskId] = !!completion.done;
    if (completion.doneBy) doneBy[completion.taskId] = completion.doneBy;
  }

  return {
    checked,
    doneBy,
    initials: log?.signed_by ?? userName ?? '',
  };
}

export function requestCleaningFrequencyChange(
  currentFrequency: CleaningFrequency,
  nextFrequency: CleaningFrequency,
  isDirty: boolean,
  isSaving: boolean,
): CleaningFrequencyChange {
  if (currentFrequency === nextFrequency || isSaving) return { kind: 'ignore' };
  if (isDirty) return { kind: 'confirm', frequency: nextFrequency };
  return { kind: 'switch', frequency: nextFrequency };
}

export function requestCleaningSiteChange(
  currentSiteId: number | null,
  nextSiteId: number,
  isDirty: boolean,
  isSaving: boolean,
): CleaningSiteChange {
  if (currentSiteId === nextSiteId || isSaving) return { kind: 'ignore' };
  if (isDirty) return { kind: 'confirm', siteId: nextSiteId };
  return { kind: 'switch', siteId: nextSiteId };
}

export function buildCleaningLogPayload(options: {
  logDate: string;
  frequency: CleaningFrequency;
  siteId?: number | null;
  tasks: CleaningDraftTask[];
  checked: Record<number, boolean>;
  doneBy: Record<number, string>;
  staffName: string;
  submit: boolean;
  submittedAt?: string;
}): CleaningLogPayload {
  const staffName = options.staffName.trim();
  const completions = options.tasks.map((task) => ({
    taskId: task.id,
    taskArea: task.area,
    taskName: task.task,
    done: !!options.checked[task.id],
    ...(options.checked[task.id]
      ? { doneBy: options.doneBy[task.id] ?? staffName }
      : {}),
  }));

  return {
    logDate: options.logDate,
    frequency: options.frequency,
    siteId: options.siteId ?? null,
    completions,
    signedBy: staffName,
    submittedAt: options.submit
      ? options.submittedAt ?? new Date().toISOString()
      : null,
  };
}

/**
 * Unsaved ticks kept on the device so closing the app, a crash or a lost
 * connection does not lose them. A draft belongs to one account (client +
 * user) and one schedule (kitchen + frequency + period date): the storage key
 * includes all of them and every read re-checks them, so another account
 * signing in on the same phone never sees it (like the device outboxes, it is
 * isolated rather than erased on sign-out). It is removed once the work is
 * saved to the server or to the device outbox, or explicitly discarded.
 */
export interface CleaningDraftOwner { clientId: number; userId: number }

export interface CleaningDraftScope {
  siteId: number | null;
  frequency: CleaningFrequency;
  logDate: string;
}

export interface CleaningDeviceDraft extends CleaningDraftScope {
  version: 1;
  owner: CleaningDraftOwner;
  checked: Record<number, boolean>;
  doneBy: Record<number, string>;
  initials: string;
  savedAt: string;
}

export interface CleaningDraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const cleaningDraftKey = (owner: CleaningDraftOwner, scope: CleaningDraftScope) =>
  `complytrack:cleaning-draft:v1:${owner.clientId}:${owner.userId}:${scope.siteId ?? 'org'}:${scope.frequency}:${scope.logDate}`;

const isRecordOf = (value: unknown, check: (item: unknown) => boolean) =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value as object).every(([key, item]) => /^\d+$/.test(key) && check(item));

/** The draft if it is well-formed and belongs to this owner and schedule. */
export function parseCleaningDraft(
  raw: string | null, owner: CleaningDraftOwner, scope: CleaningDraftScope,
): CleaningDeviceDraft | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const draft = value as CleaningDeviceDraft;
  if (!draft || typeof draft !== 'object') return null;
  return draft.version === 1
    && draft.owner?.clientId === owner.clientId && draft.owner?.userId === owner.userId
    && draft.siteId === scope.siteId && draft.frequency === scope.frequency && draft.logDate === scope.logDate
    && isRecordOf(draft.checked, (item) => typeof item === 'boolean')
    && isRecordOf(draft.doneBy, (item) => typeof item === 'string')
    && typeof draft.initials === 'string' && typeof draft.savedAt === 'string'
    ? draft : null;
}

export async function loadCleaningDraft(
  storage: CleaningDraftStorage, owner: CleaningDraftOwner, scope: CleaningDraftScope,
): Promise<CleaningDeviceDraft | null> {
  return parseCleaningDraft(await storage.getItem(cleaningDraftKey(owner, scope)), owner, scope);
}

export async function saveCleaningDraft(storage: CleaningDraftStorage, draft: CleaningDeviceDraft): Promise<void> {
  await storage.setItem(cleaningDraftKey(draft.owner, draft), JSON.stringify(draft));
}

export async function discardCleaningDraft(
  storage: CleaningDraftStorage, owner: CleaningDraftOwner, scope: CleaningDraftScope,
): Promise<void> {
  await storage.removeItem(cleaningDraftKey(owner, scope));
}

/** A cleaning-log entry in the device outbox (see lib/checkOutboxCore.ts). */
export interface CleaningOutboxEntry {
  entryId: string;
  kind: string;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  body: Record<string, unknown>;
  createdAt: string;
  error?: string;
}

/** Oldest first. The outbox moves delivered entries to the end of its list,
 *  so list position is not the order the saves were made in. */
const byCreation = <T extends CleaningOutboxEntry>(entries: readonly T[]) =>
  entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.index - b.index)
    .map(({ entry }) => entry);

export function isCleaningEntryFor(entry: CleaningOutboxEntry, scope: CleaningDraftScope): boolean {
  return entry.kind === 'cleaning-log'
    && (entry.body.siteId ?? null) === scope.siteId
    && entry.body.frequency === scope.frequency
    && entry.body.logDate === scope.logDate;
}

/**
 * The newest device save for this schedule that the server has not confirmed
 * yet (queued or sending; a rejected one is listed separately). The screen
 * shows its ticks instead of the older server copy until it is delivered.
 */
export function pendingCleaningEntry<T extends CleaningOutboxEntry>(
  entries: readonly T[], scope: CleaningDraftScope,
): T | null {
  const pending = byCreation(entries).filter((entry) =>
    (entry.state === 'queued' || entry.state === 'sending') && isCleaningEntryFor(entry, scope));
  return pending[pending.length - 1] ?? null;
}

export type CleaningSyncStatus =
  | { kind: 'none' }
  | { kind: 'queued' | 'sending' | 'sent' | 'failed'; signOff: boolean; entryId: string; error?: string };

/** Delivery state of the newest device save for this schedule. */
export function cleaningSyncStatus(
  entries: readonly CleaningOutboxEntry[], scope: CleaningDraftScope,
): CleaningSyncStatus {
  const matching = byCreation(entries).filter((entry) => isCleaningEntryFor(entry, scope));
  const latest = matching[matching.length - 1];
  if (!latest) return { kind: 'none' };
  return {
    kind: latest.state,
    signOff: !!latest.body.submittedAt,
    entryId: latest.entryId,
    ...(latest.error ? { error: latest.error } : {}),
  };
}